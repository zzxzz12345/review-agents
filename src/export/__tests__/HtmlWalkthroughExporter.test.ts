import { describe, expect, it, vi } from 'vitest';
import type { ReviewContextPack, ReviewTarget } from '../../context/types';
import type { ReviewNoteDraft } from '../../shared/protocol';
import {
  buildWalkthroughExportBundle,
  renderStandaloneWalkthroughHtml,
} from '../HtmlWalkthroughExporter';

describe('HtmlWalkthroughExporter', () => {
  it('bundles synchronized audio, read-only file copies, L1->L2 diagrams, SVG assets, and recalibrated highlights', async () => {
    const pySource = [
      'from __future__ import annotations',
      '',
      'import argparse',
      'from typing import TypedDict',
      '',
      'from backtest_framework.entity.enums import (',
      '    MarketEvent,',
      '    OrderType,',
      '    PriceType,',
      ')',
      '',
      'class V84Strategy:',
      '    def run(self):',
      '        return "</script><div>safe</div>"',
      ...Array.from({ length: 175 }, (_, i) => `    # line ${i + 15}`),
    ].join('\n');

    const extraTsSource = 'export const extraHelper = () => 42;\n';

    const target: ReviewTarget = {
      kind: 'local-diff',
      repoRoot: '/tmp/repo',
      baseRef: 'main',
      effectiveBaseRef: 'main',
      headRef: 'HEAD',
      title: 'PR #101: Strategy Split Handling',
      subtitle: 'feat/split -> main',
    };

    const contextPack: ReviewContextPack = {
      target,
      generatedAt: '2026-11-24T00:00:00Z',
      commits: ['abc1234 feat: handle split events'],
      totalFilesChanged: 2,
      includedFilesCount: 2,
      ignoredFilesCount: 0,
      totalAdditions: 15,
      totalDeletions: 2,
      moduleClusters: [],
      chapters: [],
      files: [
        {
          path: 'libs/strategy/v84.py',
          status: 'M',
          additions: 12,
          deletions: 2,
          isBinary: false,
          isIgnored: false,
          moduleGroup: 'libs',
          hunkHeaders: ['@@ -175,4 +179,8 @@ class V84Strategy'],
          touchedSymbols: ['def run (L13)'],
          compactDiff: '',
        },
        {
          path: 'libs/strategy/extra_helper.ts',
          status: 'M',
          additions: 3,
          deletions: 0,
          isBinary: false,
          isIgnored: false,
          moduleGroup: 'libs',
          hunkHeaders: ['@@ -1,1 +1,1 @@'],
          compactDiff: '',
        },
      ],
    };

    const notes: ReviewNoteDraft[] = [
      {
        id: 'note-1',
        file: 'libs/strategy/v84.py',
        line: 180,
        severity: 'action',
        body: 'Verify split ratio zero guard',
        createdAt: '2026-11-24T06:00:00Z',
      },
    ];

    const renderDiagramsMock = vi.fn(async (diags: Array<{ key: string; mermaidCode: string }>) => {
      const out: Record<string, string> = {};
      for (const d of diags) {
        out[d.key] = `<svg data-key="${d.key}"><g id="flowchart-V84-1"></g></svg>`;
      }
      return out;
    });

    const bundle = await buildWalkthroughExportBundle({
      target,
      contextPack,
      reviewMode: 'walkthrough',
      notes,
      loadFileContent: async (relPath) => {
        if (relPath === 'libs/strategy/v84.py') return pySource;
        if (relPath === 'libs/strategy/extra_helper.ts') return extraTsSource;
        return null;
      },
      renderDiagrams: renderDiagramsMock,
      timeline: [
        {
          index: 0,
          groupId: 1,
          groupTitle: 'L1 Overview',
          payload: {
            audioBase64: Buffer.from('audio-1').toString('base64'),
            mimeType: 'audio/mpeg',
            ttsRate: 1.2,
            segment: {
              turnId: 1,
              segmentId: 't1-s1',
              spokenText: '首先看全局链路。',
              directivesBefore: [
                { type: 'chapter', index: 1, total: 2, title: 'L1 Overview' },
                {
                  type: 'wb_render',
                  id: 'overview',
                  title: '全局架构',
                  mode: 'replace',
                  mermaidCode: 'flowchart LR\n  A[Entry] --> V84[V84Strategy]',
                  nodeCodeMap: { V84: 'libs/strategy/v84.py:179-185' },
                },
                { type: 'wb_focus', id: 'V84' },
                {
                  type: 'code_goto',
                  file: 'libs/strategy/v84.py',
                  lines: { start: 1, end: 8 },
                  label: 'V84 入口逻辑',
                },
              ],
              directivesAfter: [],
            },
          },
        },
        {
          index: 1,
          groupId: 2,
          groupTitle: 'L2 V84Strategy',
          payload: {
            audioBase64: '',
            mimeType: 'audio/mpeg',
            ttsRate: 1.2,
            fallbackTextOnly: true,
            segment: {
              turnId: 1,
              segmentId: 't1-s2',
              spokenText: '接着深入 V84 策略处理。',
              directivesBefore: [
                { type: 'chapter', index: 2, total: 2, title: 'L2 V84Strategy' },
                {
                  type: 'wb_render',
                  id: 'v84_detail',
                  title: 'V84 细节',
                  mode: 'push',
                  parentId: 'overview',
                  mermaidCode: 'flowchart TD\n  Run[run]',
                },
                {
                  type: 'call_chain',
                  title: 'Split Flow',
                  activeIndex: 0,
                  nodes: [
                    {
                      id: 'n1',
                      symbol: 'V84Strategy.run',
                      file: 'libs/strategy/v84.py',
                      line: 13,
                      role: 'Execute',
                    },
                  ],
                },
              ],
              directivesAfter: [],
            },
          },
        },
      ],
    });

    expect(bundle.steps).toHaveLength(2);
    expect(bundle.checkpoints).toEqual([
      { startIndex: 0, segmentCount: 1, title: 'L1 Overview' },
      { startIndex: 1, segmentCount: 1, title: 'L2 V84Strategy' },
    ]);

    // Step 0 requested lines 1-8 on pure import header -> recalibrated to non-import hunk 179-186
    expect(bundle.steps[0].code).toEqual({
      file: 'libs/strategy/v84.py',
      lines: { start: 179, end: 186 },
      label: 'V84 入口逻辑',
    });
    expect(bundle.steps[1].breadcrumbs.map((b) => b.id)).toEqual(['overview', 'v84_detail']);

    // Read-only copies include both directly referenced file and extra modified file from contextPack
    expect(bundle.files['libs/strategy/v84.py'].content).toContain('</script>');
    expect(bundle.files['libs/strategy/extra_helper.ts'].content).toBe(extraTsSource);

    // SVGs attached once per unique diagram
    expect(renderDiagramsMock).toHaveBeenCalledTimes(1);
    const diagKeys = Object.keys(bundle.diagrams);
    expect(diagKeys.length).toBe(2);
    expect(bundle.diagrams[diagKeys[0]].svg).toContain('<svg');

    // Verify rendered HTML escapes </script> and compiles cleanly as valid JS
    const html = renderStandaloneWalkthroughHtml(bundle);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('monaco-editor@0.52.2/min');
    expect(html).toContain('readOnly: true');
    expect(html).toContain('domReadOnly: true');
    expect(html).toContain('只读副本');
    expect(html).toContain('e.ctrlKey || e.metaKey');
    expect(html).toContain('panX -= e.deltaX');
    expect(html).toContain('panY -= e.deltaY');
    expect(html).not.toContain('return "</script>');
    expect(html).toContain('\\u003c/script\\u003e');

    // Extract the inline player <script> block and assert it parses with zero JS syntax errors
    const dataScriptMarker = '<script id="ra-export-data" type="application/json">';
    const dataIdx = html.indexOf(dataScriptMarker);
    const playerScriptStart = html.indexOf('<script>', dataIdx);
    const playerScriptEnd = html.lastIndexOf('</script>');
    expect(playerScriptStart).toBeGreaterThan(dataIdx);
    expect(playerScriptEnd).toBeGreaterThan(playerScriptStart);
    const playerScript = html.slice(playerScriptStart + '<script>'.length, playerScriptEnd);
    expect(() => new Function(playerScript)).not.toThrow();
  });

  it('gracefully exports even when renderDiagrams rejects', async () => {
    const bundle = await buildWalkthroughExportBundle({
      target: {
        kind: 'branch-explore',
        repoRoot: '/tmp/repo',
        branchName: 'main',
        baseRef: 'HEAD',
        effectiveBaseRef: 'HEAD',
        headRef: 'HEAD',
        title: 'Branch Review',
        subtitle: 'main',
        startMode: 'auto-overview',
      },
      reviewMode: 'branch-explore',
      notes: [],
      loadFileContent: async () => null,
      renderDiagrams: async () => {
        throw new Error('mermaid unavailable');
      },
      timeline: [
        {
          index: 0,
          groupId: 1,
          groupTitle: 'Overview',
          payload: {
            audioBase64: '',
            mimeType: 'audio/mpeg',
            ttsRate: 1,
            segment: {
              turnId: 1,
              segmentId: 's1',
              spokenText: '全局说明。',
              directivesBefore: [
                {
                  type: 'wb_render',
                  id: 'ov',
                  title: 'Overview',
                  mode: 'replace',
                  mermaidCode: 'flowchart LR\n  A --> B',
                },
              ],
              directivesAfter: [],
            },
          },
        },
      ],
    });

    expect(bundle.steps).toHaveLength(1);
    const diag = Object.values(bundle.diagrams)[0];
    expect(diag.svg).toBeUndefined();
    const html = renderStandaloneWalkthroughHtml(bundle);
    expect(html).toContain('Branch Review');
  });
});
