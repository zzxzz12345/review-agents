import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import {
  calibrateNodeLineFromContent,
  extractShortSymbolName,
  isNoiseCallerPath,
} from '../orchestrator/callChainUtils';
import type {
  CallChainNode,
  CallChainState,
  IncomingCallerItem,
} from '../shared/protocol';

const execFileAsync = promisify(execFile);

export class CallChainResolver {
  public async calibrateCallChain(
    nodes: CallChainNode[],
    repoRoot: string
  ): Promise<CallChainNode[]> {
    return Promise.all(
      nodes.map(async (node) => {
        if (!node.file) {
          return node;
        }
        const cleanRel = node.file.replace(/\\/g, '/').replace(/^\/+/, '');
        const fullPath = path.join(repoRoot, cleanRel);
        try {
          const content = await fs.readFile(fullPath, 'utf8');
          const { line, verified } = calibrateNodeLineFromContent(
            content,
            node.symbol,
            node.line
          );
          let endLine = node.endLine;
          if (verified && endLine !== undefined && endLine >= node.line) {
            const span = endLine - node.line;
            endLine = line + span;
          }
          return {
            ...node,
            file: cleanRel,
            line,
            endLine,
            verified,
          };
        } catch {
          return node;
        }
      })
    );
  }

  public async findIncomingCallers(
    file: string,
    line: number,
    symbol: string,
    repoRoot: string
  ): Promise<{
    callers: IncomingCallerItem[];
    source: 'lsp' | 'scan' | 'none';
    note?: string;
  }> {
    const cleanRel = file.replace(/\\/g, '/').replace(/^\/+/, '');
    const fullPath = path.join(repoRoot, cleanRel);
    const shortIdent = extractShortSymbolName(symbol);

    // 1. Primary: VS Code Language Server Call Hierarchy
    try {
      const uri = vscode.Uri.file(fullPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const pos = findIdentifierPosition(doc, line, shortIdent);
      const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        uri,
        pos
      );

      if (items && items.length > 0) {
        const incoming = await vscode.commands.executeCommand<
          vscode.CallHierarchyIncomingCall[]
        >('vscode.provideIncomingCalls', items[0]);

        if (incoming && incoming.length > 0) {
          const allMapped: IncomingCallerItem[] = [];
          const seen = new Set<string>();

          for (const call of incoming) {
            const fromUri = call.from.uri;
            const relFrom = toRelPath(repoRoot, fromUri);
            if (!relFrom) {
              continue;
            }
            const firstRange = call.fromRanges[0] ?? call.from.selectionRange;
            const callLine = firstRange.start.line + 1;
            const dedupeKey = `${relFrom}:${callLine}`;
            if (seen.has(dedupeKey)) {
              continue;
            }
            seen.add(dedupeKey);

            allMapped.push({
              id: `caller-${allMapped.length}`,
              symbol: call.from.name,
              file: relFrom,
              line: callLine,
              detail: call.from.detail || undefined,
              source: 'lsp',
            });
          }

          const filtered = allMapped.filter((c) => !isNoiseCallerPath(c.file));
          if (filtered.length > 0) {
            return {
              callers: filtered.slice(0, 10),
              source: 'lsp',
              note:
                filtered.length < allMapped.length
                  ? `已自动过滤 ${allMapped.length - filtered.length} 处测试/噪音调用`
                  : undefined,
            };
          }

          if (allMapped.length > 0) {
            return {
              callers: allMapped.slice(0, 4),
              source: 'lsp',
              note: '主业务路径暂无直接调用方（仅发现以下测试/辅助引用）',
            };
          }
        }
      }
    } catch {
      // Fall through to bounded git grep fallback
    }

    // 2. Fallback: Bounded workspace symbol reference scan via git grep
    if (shortIdent && shortIdent.length >= 3) {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['grep', '-n', '-I', '-F', '--', shortIdent],
          { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }
        );
        const callers: IncomingCallerItem[] = [];
        const seen = new Set<string>();

        for (const rawLine of stdout.split(/\r?\n/)) {
          if (!rawLine) {
            continue;
          }
          const match = rawLine.match(/^([^:]+):(\d+):(.*)$/);
          if (!match) {
            continue;
          }
          const rel = match[1].replace(/\\/g, '/');
          const hitLine = Number.parseInt(match[2], 10) || 1;
          const snippet = match[3].trim();

          if (rel === cleanRel && Math.abs(hitLine - line) <= 1) {
            continue;
          }
          if (isNoiseCallerPath(rel)) {
            continue;
          }
          const dedupeKey = `${rel}:${hitLine}`;
          if (seen.has(dedupeKey)) {
            continue;
          }
          seen.add(dedupeKey);

          callers.push({
            id: `scan-${callers.length}`,
            symbol: snippet.length > 48 ? `${snippet.slice(0, 48)}...` : snippet,
            file: rel,
            line: hitLine,
            source: 'scan',
          });
          if (callers.length >= 8) {
            break;
          }
        }

        if (callers.length > 0) {
          return {
            callers,
            source: 'scan',
            note: 'LSP 不可用，已通过文本索引检索非测试引用',
          };
        }
      } catch {
        // git grep exits 1 when no matches exist or not a git repo
      }
    }

    return {
      callers: [],
      source: 'none',
      note: '未检索到非测试直接调用方（可能是顶层入口或动态派发）',
    };
  }

  public async buildLspFallbackChain(
    file: string,
    line: number,
    repoRoot: string
  ): Promise<CallChainState | null> {
    const cleanRel = file.replace(/\\/g, '/').replace(/^\/+/, '');
    const fullPath = path.join(repoRoot, cleanRel);

    try {
      const uri = vscode.Uri.file(fullPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const clampedLine = Math.max(0, Math.min(doc.lineCount - 1, line - 1));

      // Identify enclosing symbol name for clean card display
      let rootSymbolName = path.basename(cleanRel);
      let rootSymbolLine = line;
      try {
        const docSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider',
          uri
        );
        const enclosing = findEnclosingSymbol(docSymbols ?? [], clampedLine);
        if (enclosing) {
          rootSymbolName = enclosing.qualifiedName;
          rootSymbolLine = enclosing.selectionLine;
        }
      } catch {
        // fallback to filename
      }

      const nodesReversed: CallChainNode[] = [
        {
          id: 'lsp-0',
          symbol: rootSymbolName,
          file: cleanRel,
          line: rootSymbolLine,
          role: '当前定位方法',
          verified: true,
        },
      ];

      const ident = extractShortSymbolName(rootSymbolName);
      const startPos = findIdentifierPosition(doc, rootSymbolLine, ident);
      let currentItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        uri,
        startPos
      );

      const visited = new Set<string>([`${cleanRel}:${rootSymbolLine}`]);
      for (let hop = 1; hop <= 3 && currentItems && currentItems.length > 0; hop++) {
        const incoming = await vscode.commands.executeCommand<
          vscode.CallHierarchyIncomingCall[]
        >('vscode.provideIncomingCalls', currentItems[0]);

        const primary = (incoming ?? []).find((c) => {
          const rel = toRelPath(repoRoot, c.from.uri);
          if (!rel || isNoiseCallerPath(rel)) {
            return false;
          }
          const callLine = (c.fromRanges[0] ?? c.from.selectionRange).start.line + 1;
          return !visited.has(`${rel}:${callLine}`);
        });

        if (!primary) {
          break;
        }

        const rel = toRelPath(repoRoot, primary.from.uri)!;
        const callLine = (primary.fromRanges[0] ?? primary.from.selectionRange).start.line + 1;
        visited.add(`${rel}:${callLine}`);

        nodesReversed.push({
          id: `lsp-${hop}`,
          symbol: primary.from.name,
          file: rel,
          line: callLine,
          role: primary.from.detail ? `LSP 上游 (${primary.from.detail})` : 'LSP 上游调用方',
          verified: true,
        });

        currentItems = [primary.from];
      }

      const topDownNodes = nodesReversed.reverse().map((n, idx) => ({
        ...n,
        id: `lsp-${idx}`,
      }));

      return {
        title: `LSP 逆向调用链：${rootSymbolName}`,
        nodes: topDownNodes,
        activeIndex: topDownNodes.length - 1,
        source: 'lsp',
      };
    } catch {
      return null;
    }
  }
}

function findIdentifierPosition(
  doc: vscode.TextDocument,
  oneBasedLine: number,
  ident: string
): vscode.Position {
  const baseLine = Math.max(0, Math.min(doc.lineCount - 1, oneBasedLine - 1));
  if (ident) {
    const escaped = ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`);
    const offsets = [0, -1, 1, -2, 2, -3, 3];
    for (const offset of offsets) {
      const idx = baseLine + offset;
      if (idx < 0 || idx >= doc.lineCount) {
        continue;
      }
      const m = re.exec(doc.lineAt(idx).text);
      if (m) {
        return new vscode.Position(idx, m.index);
      }
    }
  }
  const lineText = doc.lineAt(baseLine).text;
  const firstNonSpace = Math.max(0, lineText.search(/\S/));
  return new vscode.Position(baseLine, firstNonSpace);
}

function findEnclosingSymbol(
  symbols: vscode.DocumentSymbol[],
  zeroBasedLine: number,
  parentPrefix = ''
): { qualifiedName: string; selectionLine: number } | undefined {
  for (const sym of symbols) {
    if (
      zeroBasedLine >= sym.range.start.line &&
      zeroBasedLine <= sym.range.end.line
    ) {
      const qualified = parentPrefix ? `${parentPrefix}.${sym.name}` : sym.name;
      const deeper = findEnclosingSymbol(sym.children, zeroBasedLine, qualified);
      if (deeper) {
        return deeper;
      }
      return {
        qualifiedName: qualified,
        selectionLine: sym.selectionRange.start.line + 1,
      };
    }
  }
  return undefined;
}

function toRelPath(repoRoot: string, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== 'file') {
    return undefined;
  }
  const rel = path.relative(repoRoot, uri.fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel.replace(/\\/g, '/');
}
