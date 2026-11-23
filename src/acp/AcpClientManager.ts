import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveBinary } from '../speech/resolveBinary';
import { evaluatePermission } from './PermissionGuard';
import type {
  AcpConfigOption,
  AcpInitializeResult,
  AcpModelInfo,
  AcpModelResolution,
  AcpProfile,
  AcpPromptCallbacks,
  AcpPromptResult,
  AcpReadTextFileParams,
  AcpSessionNewResult,
  AcpToolActivityInfo,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types';

export interface AcpConnectOptions {
  cwd: string;
  profile: AcpProfile;
  systemPromptAppend?: string;
  thoughtLevel?: 'low' | 'medium' | 'high';
  preferredModel?: string;
  allowMutations?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export class AcpClientManager {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private stdoutBuffer = '';
  private stderrLines: string[] = [];
  private sessionId: string | null = null;
  private cwd = '';
  private allowMutations = false;
  private supportsSystemPromptAppend = false;
  private fallbackSystemPrompt: string | null = null;
  private fallbackPromptConsumed = false;
  private activePromptCallbacks: AcpPromptCallbacks | null = null;
  private disposed = false;

  public get currentSessionId(): string | null {
    return this.sessionId;
  }

  public get isConnected(): boolean {
    return this.proc !== null && !this.proc.killed && this.sessionId !== null;
  }

  public get recentStderr(): string {
    return this.stderrLines.join('\n');
  }

  public async connect(options: AcpConnectOptions): Promise<{
    initResult: AcpInitializeResult;
    sessionResult: AcpSessionNewResult;
    configOptions: AcpConfigOption[];
    modelResolution: AcpModelResolution;
  }> {
    this.dispose();
    this.disposed = false;
    this.cwd = path.resolve(options.cwd);
    this.allowMutations = Boolean(options.allowMutations);
    this.fallbackSystemPrompt = null;
    this.fallbackPromptConsumed = false;
    this.stderrLines = [];
    this.stdoutBuffer = '';

    const resolvedCommand =
      (await resolveBinary([options.profile.command])) ?? options.profile.command;
    const child = spawn(resolvedCommand, options.profile.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    });
    this.proc = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.proc !== child) {
        return;
      }
      this.handleStdoutChunk(chunk);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (this.proc !== child) {
        return;
      }
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) {
          this.stderrLines.push(trimmed);
          if (this.stderrLines.length > 50) {
            this.stderrLines.shift();
          }
        }
      }
    });

    child.on('error', (err) => {
      if (this.proc !== child) {
        return;
      }
      this.rejectAllPending(
        new Error(
          `Failed to start ACP process "${options.profile.command}": ${err.message}`
        )
      );
    });

    child.on('exit', (code, signal) => {
      if (this.proc !== child) {
        return;
      }
      const detail = this.stderrLines.slice(-5).join(' | ');
      this.rejectAllPending(
        new Error(
          `ACP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})${
            detail ? `: ${detail}` : ''
          }`
        )
      );
      this.proc = null;
      this.sessionId = null;
    });

    const initResult = (await this.sendRequest(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: false,
          },
        },
        clientInfo: {
          name: 'review-agents',
          version: '0.1.0',
        },
      },
      15000
    )) as AcpInitializeResult;

    this.supportsSystemPromptAppend = Boolean(
      initResult.agentCapabilities?._meta?.antigravity?.systemPrompt?.append
    );

    const newSessionParams: Record<string, unknown> = {
      cwd: this.cwd,
      mcpServers: [],
    };

    if (options.systemPromptAppend) {
      if (this.supportsSystemPromptAppend) {
        newSessionParams._meta = {
          antigravity: {
            systemPrompt: {
              append: options.systemPromptAppend,
            },
          },
        };
      } else {
        this.fallbackSystemPrompt = options.systemPromptAppend;
      }
    }

    const sessionResult = (await this.sendRequest(
      'session/new',
      newSessionParams,
      20000
    )) as AcpSessionNewResult;

    this.sessionId = sessionResult.sessionId;
    let configOptions = sessionResult.configOptions ?? [];

    const desiredThoughtLevel = options.thoughtLevel ?? 'low';
    const requestedModel = options.preferredModel?.trim() || undefined;
    const availableModelInfos = sessionResult.models?.availableModels ?? [];

    let resolvedModel =
      sessionResult.models?.currentModelId ??
      configOptions.find((opt) => opt.category === 'model' || opt.id === 'model')
        ?.currentValue ??
      'default';
    let matchedRequestedModel = !requestedModel;
    let matchedCandidate: string | undefined;

    // 1. Select preferred model (supports comma-separated fallback candidates) BEFORE setting thought_level
    if (requestedModel) {
      const candidates = requestedModel
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const modelOption = configOptions.find(
        (opt) => opt.category === 'model' || opt.id === 'model'
      );

      for (const candidate of candidates) {
        const matchedOpt = matchModelConfigOption(
          modelOption?.options,
          candidate,
          desiredThoughtLevel
        );

        if (modelOption && matchedOpt) {
          matchedRequestedModel = true;
          matchedCandidate = candidate;
          resolvedModel = matchedOpt.name || matchedOpt.value;
          if (modelOption.currentValue !== matchedOpt.value) {
            const updated = (await this.sendRequest(
              'session/set_config_option',
              {
                sessionId: this.sessionId,
                configId: modelOption.id,
                value: matchedOpt.value,
              },
              10000
            )) as { configOptions?: AcpConfigOption[] } | null;
            if (updated?.configOptions) {
              configOptions = updated.configOptions;
            }
          }
          break;
        }

        const matchedAvail = matchAvailableModel(
          availableModelInfos,
          candidate,
          desiredThoughtLevel
        );
        if (matchedAvail) {
          matchedRequestedModel = true;
          matchedCandidate = candidate;
          resolvedModel = matchedAvail.name || matchedAvail.modelId;
          if (sessionResult.models?.currentModelId !== matchedAvail.modelId) {
            try {
              await this.sendRequest(
                'session/set_model',
                {
                  sessionId: this.sessionId,
                  modelId: matchedAvail.modelId,
                },
                10000
              );
            } catch {
              // Fallback if harness does not implement session/set_model
              resolvedModel =
                sessionResult.models?.currentModelId ??
                modelOption?.currentValue ??
                resolvedModel;
              matchedRequestedModel = false;
              matchedCandidate = undefined;
            }
          }
          if (matchedRequestedModel) {
            break;
          }
        }
      }
    }

    // 2. Enforce thought_level (e.g. 'low') after model resolution
    const thoughtOption = configOptions.find(
      (opt) => opt.category === 'thought_level' || opt.id === 'thought_level'
    );
    if (
      thoughtOption &&
      thoughtOption.currentValue !== desiredThoughtLevel &&
      thoughtOption.options?.some((o) => o.value === desiredThoughtLevel)
    ) {
      const updated = (await this.sendRequest(
        'session/set_config_option',
        {
          sessionId: this.sessionId,
          configId: thoughtOption.id,
          value: desiredThoughtLevel,
        },
        10000
      )) as { configOptions?: AcpConfigOption[] } | null;
      if (updated?.configOptions) {
        configOptions = updated.configOptions;
      }
    }

    const finalThoughtLevel =
      configOptions.find(
        (opt) => opt.category === 'thought_level' || opt.id === 'thought_level'
      )?.currentValue ?? desiredThoughtLevel;

    const availableModelsList =
      availableModelInfos.length > 0
        ? availableModelInfos.map((m) => m.modelId)
        : (configOptions
            .find((opt) => opt.category === 'model' || opt.id === 'model')
            ?.options?.map((o) => o.name || o.value) ?? []);

    const modelResolution: AcpModelResolution = {
      requestedModel,
      matchedCandidate,
      requestedThoughtLevel: desiredThoughtLevel,
      resolvedModel,
      resolvedThoughtLevel: finalThoughtLevel,
      matchedRequestedModel,
      availableModels: availableModelsList,
    };

    return { initResult, sessionResult, configOptions, modelResolution };
  }

  public async sendPrompt(
    text: string,
    callbacks: AcpPromptCallbacks
  ): Promise<AcpPromptResult> {
    if (!this.sessionId || !this.proc) {
      throw new Error('ACP session is not connected.');
    }

    let effectivePrompt = text;
    if (this.fallbackSystemPrompt && !this.fallbackPromptConsumed) {
      effectivePrompt = `<system_instructions>\n${this.fallbackSystemPrompt}\n</system_instructions>\n\n${text}`;
      this.fallbackPromptConsumed = true;
    }

    this.activePromptCallbacks = callbacks;
    try {
      const result = (await this.sendRequest(
        'session/prompt',
        {
          sessionId: this.sessionId,
          prompt: [{ type: 'text', text: effectivePrompt }],
        },
        0
      )) as AcpPromptResult;
      return result ?? {};
    } finally {
      if (this.activePromptCallbacks === callbacks) {
        this.activePromptCallbacks = null;
      }
    }
  }

  public cancel(): void {
    if (!this.proc || !this.sessionId) {
      return;
    }
    this.sendNotification('session/cancel', {
      sessionId: this.sessionId,
    });
  }

  public dispose(): void {
    this.disposed = true;
    this.activePromptCallbacks = null;
    this.rejectAllPending(new Error('ACP client disposed.'));
    if (this.proc) {
      try {
        this.proc.stdin.end();
      } catch {
        // ignore
      }
      try {
        this.proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.proc = null;
    }
    this.sessionId = null;
  }

  private sendRequest(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<unknown> {
    if (!this.proc || this.disposed) {
      return Promise.reject(new Error('ACP process is not running.'));
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP request "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.pending.set(id, { method, resolve, reject, timer });
      this.writeJsonLine(payload);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const payload: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.writeJsonLine(payload);
  }

  private sendResponse(
    id: number | string,
    result?: unknown,
    error?: { code: number; message: string }
  ): void {
    const payload: JsonRpcResponse = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result: result ?? null };
    this.writeJsonLine(payload);
  }

  private writeJsonLine(msg: unknown): void {
    if (!this.proc || !this.proc.stdin.writable) {
      return;
    }
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleJsonLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleJsonLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
    const hasMethod = typeof msg.method === 'string';

    if (hasId && !hasMethod) {
      const id = msg.id as number | string;
      const entry = this.pending.get(id);
      if (!entry) {
        return;
      }
      this.pending.delete(id);
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      const errObj = msg.error as { code?: number; message?: string } | undefined;
      if (errObj) {
        entry.reject(
          new Error(
            `ACP "${entry.method}" error (${errObj.code ?? -1}): ${
              errObj.message ?? 'Unknown error'
            }`
          )
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (hasId && hasMethod) {
      const id = msg.id as number | string;
      const method = msg.method as string;
      void this.handleIncomingRequest(id, method, msg.params);
      return;
    }

    if (!hasId && hasMethod) {
      this.handleNotification(msg.method as string, msg.params);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update' || !params || typeof params !== 'object') {
      return;
    }

    const p = params as {
      sessionId?: string;
      update?: {
        sessionUpdate?: string;
        content?: unknown;
        toolCallId?: string;
        title?: string;
        kind?: string;
        status?: string;
        locations?: Array<{ path?: string; line?: number }>;
        rawInput?: unknown;
      };
    };

    if (p.sessionId && this.sessionId && p.sessionId !== this.sessionId) {
      return;
    }

    const update = p.update;
    if (!update || !this.activePromptCallbacks) {
      return;
    }

    if (update.sessionUpdate === 'agent_message_chunk') {
      const text = extractContentText(update.content);
      if (text) {
        this.activePromptCallbacks.onTextDelta(text);
      }
    } else if (update.sessionUpdate === 'agent_thought_chunk') {
      const text = extractContentText(update.content);
      if (text && this.activePromptCallbacks.onThoughtDelta) {
        this.activePromptCallbacks.onThoughtDelta(text);
      }
    } else if (
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      this.activePromptCallbacks.onToolActivity?.(
        extractToolActivity(update, this.cwd)
      );
    }
  }

  private async handleIncomingRequest(
    id: number | string,
    method: string,
    params: unknown
  ): Promise<void> {
    try {
      if (method === 'session/request_permission') {
        const decision = evaluatePermission(
          (params ?? {}) as Parameters<typeof evaluatePermission>[0],
          this.allowMutations
        );
        if (decision.optionId) {
          this.sendResponse(id, {
            outcome: {
              outcome: 'selected',
              optionId: decision.optionId,
            },
          });
        } else {
          this.sendResponse(id, {
            outcome: {
              outcome: 'cancelled',
            },
          });
        }
        return;
      }

      if (method === 'fs/read_text_file') {
        const readParams = (params ?? {}) as AcpReadTextFileParams;
        const relPath = readParams.path
          ? normalizeToolFilePath(readParams.path, this.cwd)
          : '';
        const toolCallId = `fs-read-${id}`;
        this.activePromptCallbacks?.onToolActivity?.({
          toolCallId,
          kind: 'read',
          status: 'in_progress',
          title: `Read ${relPath || readParams.path || 'file'}`,
          filePath: relPath || readParams.path,
          line: readParams.line,
          limit: readParams.limit,
        });
        try {
          const content = await this.readWorkspaceFile(readParams);
          this.activePromptCallbacks?.onToolActivity?.({
            toolCallId,
            kind: 'read',
            status: 'completed',
            title: `Read ${relPath || readParams.path || 'file'}`,
            filePath: relPath || readParams.path,
            line: readParams.line,
            limit: readParams.limit,
          });
          this.sendResponse(id, { content });
        } catch (readErr) {
          this.activePromptCallbacks?.onToolActivity?.({
            toolCallId,
            kind: 'read',
            status: 'failed',
            title: `Read ${relPath || readParams.path || 'file'}`,
            filePath: relPath || readParams.path,
            line: readParams.line,
            limit: readParams.limit,
          });
          throw readErr;
        }
        return;
      }

      if (method === 'fs/write_text_file') {
        if (!this.allowMutations) {
          this.sendResponse(id, undefined, {
            code: -32001,
            message: 'Write operations are disabled during read-only review.',
          });
          return;
        }
      }

      this.sendResponse(id, undefined, {
        code: -32601,
        message: `Unsupported client RPC method: ${method}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendResponse(id, undefined, {
        code: -32000,
        message,
      });
    }
  }

  private async readWorkspaceFile(params: AcpReadTextFileParams): Promise<string> {
    if (!params.path) {
      throw new Error('fs/read_text_file missing path');
    }
    const resolved = path.isAbsolute(params.path)
      ? path.resolve(params.path)
      : path.resolve(this.cwd, params.path);
    const relative = path.relative(this.cwd, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Access denied outside workspace root: ${params.path}`);
    }

    const raw = await fs.readFile(resolved, 'utf8');
    if (params.line === undefined && params.limit === undefined) {
      return raw;
    }

    const lines = raw.split(/\r?\n/);
    const startIdx = Math.max(0, (params.line ?? 1) - 1);
    const endIdx =
      params.limit !== undefined && params.limit > 0
        ? Math.min(lines.length, startIdx + params.limit)
        : lines.length;
    return lines.slice(startIdx, endIdx).join('\n');
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.reject(err);
      this.pending.delete(id);
    }
  }
}

function extractContentText(content: unknown): string {
  if (!content) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => extractContentText(item)).join('');
  }
  if (typeof content === 'object') {
    const rec = content as Record<string, unknown>;
    if (typeof rec.text === 'string') {
      return rec.text;
    }
  }
  return '';
}

function normalizeToolFilePath(rawPath: string, cwd: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return '';
  }
  if (!cwd || !path.isAbsolute(trimmed)) {
    return trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
  }
  const rel = path.relative(path.resolve(cwd), path.resolve(trimmed));
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.replace(/\\/g, '/');
  }
  return trimmed.replace(/\\/g, '/');
}

function parseOptionalNumber(val: unknown): number | undefined {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
    return Number.parseInt(val.trim(), 10);
  }
  return undefined;
}

function extractToolActivity(
  update: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    locations?: Array<{ path?: string; line?: number }>;
    rawInput?: unknown;
  },
  cwd: string
): AcpToolActivityInfo {
  const rawRec =
    update.rawInput && typeof update.rawInput === 'object'
      ? (update.rawInput as Record<string, unknown>)
      : undefined;

  const firstLoc = update.locations?.[0];
  let rawFile = typeof firstLoc?.path === 'string' ? firstLoc.path : undefined;
  if (!rawFile && rawRec) {
    for (const key of [
      'path',
      'file_path',
      'filePath',
      'AbsolutePath',
      'TargetFile',
      'SearchPath',
      'DirectoryPath',
    ]) {
      const candidate = rawRec[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        rawFile = candidate;
        break;
      }
    }
  }

  const filePath = rawFile ? normalizeToolFilePath(rawFile, cwd) : undefined;

  const line =
    parseOptionalNumber(firstLoc?.line) ??
    (rawRec
      ? parseOptionalNumber(rawRec.line ?? rawRec.StartLine ?? rawRec.start_line)
      : undefined);

  const endLine = rawRec
    ? parseOptionalNumber(rawRec.EndLine ?? rawRec.end_line)
    : undefined;

  let limit = rawRec ? parseOptionalNumber(rawRec.limit) : undefined;
  if (limit === undefined && line !== undefined && endLine !== undefined && endLine >= line) {
    limit = endLine - line + 1;
  }

  let detail: string | undefined;
  if (rawRec) {
    for (const key of ['query', 'Query', 'command', 'CommandLine']) {
      const candidate = rawRec[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        detail = candidate.trim().slice(0, 100);
        break;
      }
    }
  }
  if (!detail && filePath) {
    detail = filePath;
  }

  return {
    toolCallId: update.toolCallId,
    title: update.title,
    kind: update.kind,
    status: update.status,
    filePath,
    line,
    limit,
    detail,
  };
}

export function normalizeModelKey(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchModelConfigOption(
  options: AcpConfigOption['options'],
  requested: string,
  thoughtLevel: string
) {
  if (!options || options.length === 0) {
    return undefined;
  }
  const exact = options.find((o) => o.value === requested || o.name === requested);
  if (exact) {
    return exact;
  }
  const normReq = normalizeModelKey(requested);
  const normEffort = normalizeModelKey(thoughtLevel);

  const normExact = options.find(
    (o) => normalizeModelKey(o.value) === normReq || normalizeModelKey(o.name) === normReq
  );
  if (normExact) {
    return normExact;
  }

  const substrings = options.filter(
    (o) =>
      normalizeModelKey(o.value).includes(normReq) ||
      normalizeModelKey(o.name).includes(normReq)
  );
  if (substrings.length === 0) {
    return undefined;
  }
  return (
    substrings.find(
      (o) =>
        normalizeModelKey(o.value).includes(normEffort) ||
        normalizeModelKey(o.name).includes(normEffort)
    ) ?? substrings[0]
  );
}

function matchAvailableModel(
  models: AcpModelInfo[],
  requested: string,
  thoughtLevel: string
): AcpModelInfo | undefined {
  if (models.length === 0) {
    return undefined;
  }
  const exact = models.find((m) => m.modelId === requested || m.name === requested);
  if (exact) {
    return exact;
  }
  const normReq = normalizeModelKey(requested);
  const normEffort = normalizeModelKey(thoughtLevel);

  const normExactWithEffort = models.find(
    (m) =>
      normalizeModelKey(m.modelId) === `${normReq} ${normEffort}` ||
      normalizeModelKey(m.name) === `${normReq} ${normEffort}`
  );
  if (normExactWithEffort) {
    return normExactWithEffort;
  }

  const normExact = models.find(
    (m) =>
      normalizeModelKey(m.modelId) === normReq || normalizeModelKey(m.name) === normReq
  );
  if (normExact) {
    return normExact;
  }

  const substrings = models.filter(
    (m) =>
      normalizeModelKey(m.modelId).includes(normReq) ||
      normalizeModelKey(m.name).includes(normReq)
  );
  if (substrings.length === 0) {
    return undefined;
  }
  return (
    substrings.find(
      (m) =>
        normalizeModelKey(m.modelId).includes(normEffort) ||
        normalizeModelKey(m.name).includes(normEffort)
    ) ?? substrings[0]
  );
}
