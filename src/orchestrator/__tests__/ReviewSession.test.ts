import { describe, expect, it, vi } from 'vitest';
import type { AcpPromptCallbacks, AcpPromptResult } from '../../acp/types';
import type {
  BranchExploreTarget,
  ReviewContextPack,
  ReviewTarget,
} from '../../context/types';
import type {
  CodeGotoDirective,
  HostToWebviewMessage,
  ReviewNoteDraft,
  UtteranceSegment,
} from '../../shared/protocol';
import {
  buildAutoContinuePrompt,
  buildBranchExploreInitialPrompt,
  buildBranchExploreSystemPrompt,
  buildCorePathLineReviewInitialPrompt,
  buildCorePathLineReviewSystemPrompt,
  buildInitialWalkthroughPrompt,
  buildInterruptionPrompt,
  buildUserFollowUpPrompt,
  buildWalkthroughSystemPrompt,
  detectActionNoteIntent,
} from '../PromptTemplates';
import { formatContextPackForPrompt } from '../../context/ContextPackBuilder';
import {
  calibrateNodeLineFromContent,
  isNoiseCallerPath,
  matchActiveCallChainNode,
} from '../callChainUtils';
import {
  resolveCodeGotoView,
  ReviewSession,
  type ReviewSessionRuntimeConfig,
} from '../ReviewSession';
import { clampHighlightRange } from '../../vscode-ui/highlightRange';

const BASE_CONFIG: ReviewSessionRuntimeConfig = {
  acpProfile: { id: 'agy', displayName: 'Antigravity', command: 'agy', args: ['acp'] },
  thoughtLevel: 'low',
  ttsVoice: 'zh-CN-XiaoxiaoNeural',
  ttsRate: 1.1,
  sttLocale: 'zh-CN',
  voiceMode: 'vad',
  vadBargeInMs: 300,
  vadSilenceMs: 900,
  maxContextChars: 12000,
  ignorePatterns: [],
  autoContinue: false,
};

const SAMPLE_TARGET: ReviewTarget = {
  kind: 'local-diff',
  repoRoot: '/tmp/repo',
  baseRef: 'main',
  effectiveBaseRef: 'main',
  headRef: 'HEAD',
  title: 'HEAD vs main',
  subtitle: 'Local Diff',
};

const SAMPLE_PACK: ReviewContextPack = {
  target: SAMPLE_TARGET,
  generatedAt: '2026-11-20T00:00:00.000Z',
  commits: ['abc123 feat: auth lock'],
  totalFilesChanged: 1,
  includedFilesCount: 1,
  ignoredFilesCount: 0,
  totalAdditions: 10,
  totalDeletions: 2,
  files: [
    {
      path: 'src/auth.ts',
      status: 'M',
      additions: 10,
      deletions: 2,
      isBinary: false,
      isIgnored: false,
      moduleGroup: 'src',
      hunkHeaders: ['@@ -10,2 +10,10 @@ refreshToken'],
      compactDiff: '@@ -10,2 +10,10 @@\n+const lock = true;',
    },
  ],
  chapters: [
    {
      index: 1,
      title: '总览',
      moduleGroup: 'overview',
      files: ['src/auth.ts'],
      summary: '概览',
    },
  ],
  moduleClusters: [
    {
      moduleGroup: 'src',
      fileCount: 1,
      additions: 10,
      deletions: 2,
      files: ['src/auth.ts'],
    },
  ],
};

describe('ReviewSession orchestration & exact barge-in', () => {
  it('enqueues TTS in strict order and injects exact interruption context on barge-in', async () => {
    const sentMessages: HostToWebviewMessage[] = [];
    const navigatedCalls: CodeGotoDirective[] = [];
    const savedNotes: ReviewNoteDraft[] = [];
    const promptsReceived: string[] = [];

    let cancelCount = 0;
    let promptIdx = 0;

    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's1' },
            configOptions: [],
          }),
          sendPrompt: vi.fn(async (text: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
            promptsReceived.push(text);
            promptIdx += 1;
            if (promptIdx === 1) {
              cb.onTextDelta(
                '<chapter index="1" total="2" title="整体总览"/>' +
                  '<wb_render id="ov" title="Auth Flow" mode="replace">flowchart LR\n  GW["GW"] --> Auth["Auth"]\n</wb_render>' +
                  '第一句讲解整体架构。' +
                  '<wb_focus id="Auth"/>' +
                  '<code_goto file="src/auth.ts" lines="10-25" view="diff" label="并发锁"/>' +
                  '第二句进入具体代码讲解并发刷新锁逻辑，这里故意写长一点以便测试中途打断。' +
                  '第三句是后续还没讲到的总结。'
              );
            } else {
              cb.onTextDelta(
                '<wb_render id="detail" title="并发锁细节" mode="push">flowchart TD\n  Lock["Mutex"]\n</wb_render>' +
                  '<review_note file="src/auth.ts" line="18" severity="warning">异常分支未释放锁</review_note>' +
                  '好的，已经帮你记录了锁释放问题。'
              );
            }
            return { stopReason: 'end_turn' };
          }),
          cancel: vi.fn(() => {
            cancelCount += 1;
          }),
          dispose: vi.fn(),
        },
        contextPackBuilder: {
          build: vi.fn().mockResolvedValue(SAMPLE_PACK),
        },
        speech: {
          // Make segment 1 synthesize SLOWER than segment 2 to verify strict ordering
          synthesizeWithFallback: vi.fn(async (text: string) => {
            const delay = text.includes('第一句') ? 45 : 5;
            await new Promise((r) => setTimeout(r, delay));
            return { audioBase64: Buffer.from(text).toString('base64'), mimeType: 'audio/mpeg' };
          }),
          transcribe: vi.fn().mockResolvedValue('这里异常分支是不是没释放锁，帮我记一下'),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn(async (cmd) => {
            navigatedCalls.push(cmd);
            return { file: cmd.file, lines: cmd.lines, view: cmd.view ?? 'diff', label: cmd.label };
          }),
          toggleViewMode: vi.fn().mockResolvedValue('diff'),
          getCurrentViewMode: () => 'diff',
          getCurrentLocation: () =>
            navigatedCalls.length > 0
              ? {
                  file: navigatedCalls[navigatedCalls.length - 1].file,
                  lines: navigatedCalls[navigatedCalls.length - 1].lines,
                  view: 'diff',
                }
              : undefined,
        },
        comments: {
          addDraft: vi.fn((note) => {
            const d: ReviewNoteDraft = {
              id: `note-${savedNotes.length + 1}`,
              file: note.file,
              line: note.line,
              severity: note.severity,
              body: note.body,
              createdAt: '2026-11-20T00:00:00Z',
            };
            savedNotes.push(d);
            return d;
          }),
          listDrafts: () => savedNotes,
          clear: () => {
            savedNotes.length = 0;
          },
        },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    await session.start(SAMPLE_TARGET);
    // Allow ordered synthesis drainer to flush all 3 segments
    await new Promise((r) => setTimeout(r, 80));

    const enqueued = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment);

    expect(enqueued.length).toBe(3);
    expect(enqueued[0].spokenText).toContain('第一句');
    expect(enqueued[1].spokenText).toContain('第二句');
    expect(enqueued[2].spokenText).toContain('第三句');

    // Simulate Webview starting and finishing segment 1, then starting segment 2 (triggers code_goto)
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: enqueued[0] });
    await session.handleWebviewMessage({ type: 'playback:segmentEnded', segment: enqueued[0] });
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: enqueued[1] });

    expect(navigatedCalls.length).toBe(1);
    expect(navigatedCalls[0].file).toBe('src/auth.ts');

    // User barges in mid-way through segment 2!
    await session.handleWebviewMessage({
      type: 'voice:bargeIn',
      cutoff: {
        turnId: enqueued[1].turnId,
        segmentId: enqueued[1].segmentId,
        spokenCharOffset: 10,
      },
      diagramState: {
        diagramId: 'ov',
        focusedNodeId: 'Auth',
        stackPath: 'Auth Flow',
      },
    });

    // Since the mock ACP stream already finished before barge-in, no spurious session/cancel is sent
    expect(cancelCount).toBe(0);
    expect(sentMessages.some((m) => m.type === 'audio:clear')).toBe(true);

    // User finishes speaking -> STT + interruption prompt sent to ACP
    await session.handleWebviewMessage({
      type: 'voice:utteranceAudio',
      audioWavBase64: Buffer.from('fakewav').toString('base64'),
      selectedNodeId: 'Auth',
    });

    expect(promptsReceived.length).toBe(2);
    const secondPrompt = promptsReceived[1];
    expect(secondPrompt).toContain('<interruption_context>');
    expect(secondPrompt).toContain('第一句讲解整体架构。');
    expect(secondPrompt).toContain('<unspoken_cut_off>');
    expect(secondPrompt).toContain('第三句是后续还没讲到的总结。');
    expect(secondPrompt).toContain('focused_node="Auth"');
    expect(secondPrompt).toContain('file="src/auth.ts" lines="10-25"');

    // Allow turn 2 audio enqueue and start segment to trigger review_note draft
    await new Promise((r) => setTimeout(r, 40));
    const turn2Enqueued = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment)
      .filter((s: UtteranceSegment) => s.turnId > enqueued[1].turnId);

    expect(turn2Enqueued.length).toBe(1);
    await session.handleWebviewMessage({
      type: 'playback:segmentStarted',
      segment: turn2Enqueued[0],
    });
    expect(savedNotes.length).toBe(1);
    expect(savedNotes[0].body).toBe('异常分支未释放锁');
  });

  it('calls acpClient.cancel() and drops late stale chunks on mid-stream barge-in', async () => {
    const sentMessages: HostToWebviewMessage[] = [];
    let cancelCount = 0;
    let resolveTurn1!: (res: AcpPromptResult) => void;
    let turn1Callback!: AcpPromptCallbacks;
    let callNum = 0;

    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's-live' },
            configOptions: [],
          }),
          sendPrompt: vi.fn((_text: string, cb: AcpPromptCallbacks) => {
            callNum += 1;
            if (callNum === 1) {
              turn1Callback = cb;
              cb.onTextDelta('先介绍第一部分核心模块。');
              return new Promise<AcpPromptResult>((resolve) => {
                resolveTurn1 = resolve;
              });
            }
            cb.onTextDelta('这是打断后的全新回答。');
            return Promise.resolve({ stopReason: 'end_turn' });
          }),
          cancel: vi.fn(() => {
            cancelCount += 1;
            resolveTurn1?.({ stopReason: 'cancelled' });
          }),
          dispose: vi.fn(),
        },
        contextPackBuilder: {
          build: vi.fn().mockResolvedValue(SAMPLE_PACK),
        },
        speech: {
          synthesizeWithFallback: vi.fn(async (text: string) => ({
            audioBase64: Buffer.from(text).toString('base64'),
            mimeType: 'audio/mpeg',
          })),
          transcribe: vi.fn().mockResolvedValue('打断提问一下'),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn(async (cmd) => ({
            file: cmd.file,
            lines: cmd.lines,
            view: cmd.view ?? 'diff',
          })),
          toggleViewMode: vi.fn().mockResolvedValue('diff'),
          getCurrentViewMode: () => 'diff',
          getCurrentLocation: () => undefined,
        },
        comments: {
          addDraft: vi.fn(),
          listDrafts: () => [],
          clear: vi.fn(),
        },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    const startPromise = session.start(SAMPLE_TARGET);
    await new Promise((r) => setTimeout(r, 30));

    const firstBatch = sentMessages.filter((m) => m.type === 'audio:enqueue');
    expect(firstBatch.length).toBe(1);
    const seg1 = (firstBatch[0] as Extract<HostToWebviewMessage, { type: 'audio:enqueue' }>).payload.segment;

    // Trigger barge-in WHILE sendPrompt is still pending!
    await session.handleWebviewMessage({
      type: 'voice:bargeIn',
      cutoff: {
        turnId: seg1.turnId,
        segmentId: seg1.segmentId,
        spokenCharOffset: 4,
      },
      diagramState: { stackPath: '' },
    });

    expect(cancelCount).toBe(1);

    // Simulate a late stray chunk arriving from the cancelled turn 1
    turn1Callback.onTextDelta('这段迟到文本绝对不能被播报。');
    await startPromise;
    await new Promise((r) => setTimeout(r, 30));

    const leaked = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .filter((m) => m.payload.segment.spokenText.includes('这段迟到文本'));
    expect(leaked.length).toBe(0);

    // Follow-up turn succeeds cleanly
    await session.handleUserQuestion('请解释这里');
    await new Promise((r) => setTimeout(r, 30));

    const turn2Audio = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .filter((m) => m.payload.segment.spokenText.includes('这是打断后的全新回答'));
    expect(turn2Audio.length).toBe(1);
  });

  it('auto-syncs whiteboard focus when code_goto omits wb_focus and on manual editor switches', async () => {
    const sentMessages: HostToWebviewMessage[] = [];
    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's-sync' },
            configOptions: [],
          }),
          sendPrompt: vi.fn(async (_text: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
            cb.onTextDelta(
              '<wb_render id="ov" title="总览" mode="replace" map=\'{"AuthMod":"src/auth.ts:1-40","ApiMod":"src/api.ts:1-20"}\'>' +
                'flowchart LR\n  AuthMod["Auth"] --> ApiMod["API"]\n</wb_render>' +
                '先看整体架构。' +
                '<code_goto file="src/api.ts" lines="1-20" view="diff" label="API 路由"/>' +
                '这里切换到了接口文件。'
            );
            return { stopReason: 'end_turn' };
          }),
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: {
          build: vi.fn().mockResolvedValue(SAMPLE_PACK),
        },
        speech: {
          synthesizeWithFallback: vi.fn(async (text: string) => ({
            audioBase64: Buffer.from(text).toString('base64'),
            mimeType: 'audio/mpeg',
          })),
          transcribe: vi.fn().mockResolvedValue(''),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn(async (cmd) => ({
            file: cmd.file,
            lines: cmd.lines,
            view: cmd.view ?? 'diff',
            label: cmd.label,
          })),
          toggleViewMode: vi.fn().mockResolvedValue('diff'),
          getCurrentViewMode: () => 'diff',
          getCurrentLocation: () => undefined,
        },
        comments: {
          addDraft: vi.fn(),
          listDrafts: () => [],
          clear: vi.fn(),
        },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    await session.start(SAMPLE_TARGET);
    await new Promise((r) => setTimeout(r, 40));

    const enqueued = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment);

    expect(enqueued.length).toBe(2);
    // Start segment 2 (has code_goto src/api.ts WITHOUT explicit wb_focus)
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: enqueued[1] });

    const autoFocusMsg = sentMessages.find(
      (m) => m.type === 'directive:apply' && m.directive.type === 'wb_focus' && m.directive.id === 'ApiMod'
    );
    expect(autoFocusMsg).toBeDefined();

    // Now simulate user manually clicking another tab (src/auth.ts) in VS Code
    session.handleManualEditorSwitch('src/auth.ts', 15);

    const manualFocusMsg = sentMessages.find(
      (m) => m.type === 'directive:apply' && m.directive.type === 'wb_focus' && m.directive.id === 'AuthMod'
    );
    expect(manualFocusMsg).toBeDefined();

    const latestState = [...sentMessages]
      .reverse()
      .find((m): m is Extract<HostToWebviewMessage, { type: 'session:state' }> => m.type === 'session:state');
    expect(latestState?.meta?.activeEditorFile).toBe('src/auth.ts');
    expect(latestState?.meta?.activeEditorLabel).toBe('L15');
  });

  it('emits live activity updates across analyzing, connecting, thinking, reading_file, synthesizing, speaking, and audio_blocked', async () => {
    const sentMessages: HostToWebviewMessage[] = [];
    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's-act' },
            configOptions: [],
            modelResolution: {
              requestedThoughtLevel: 'low',
              resolvedModel: 'Gemini 4 Hydrogen',
              resolvedThoughtLevel: 'low',
              matchedRequestedModel: true,
              availableModels: [],
            },
          }),
          sendPrompt: vi.fn(async (_text: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
            cb.onThoughtDelta?.('先看 auth.ts 的并发锁逻辑');
            cb.onToolActivity?.({
              toolCallId: 'read-1',
              kind: 'read',
              status: 'in_progress',
              filePath: 'src/auth.ts',
              line: 10,
              limit: 20,
              title: 'Read src/auth.ts',
            });
            cb.onToolActivity?.({
              toolCallId: 'read-1',
              kind: 'read',
              status: 'completed',
              filePath: 'src/auth.ts',
              line: 10,
              limit: 20,
              title: 'Read src/auth.ts',
            });
            cb.onTextDelta('这段鉴权逻辑加入了锁保护。');
            return { stopReason: 'end_turn' };
          }),
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: {
          build: vi.fn().mockResolvedValue(SAMPLE_PACK),
        },
        speech: {
          synthesizeWithFallback: vi.fn(async (text: string) => ({
            audioBase64: Buffer.from(text).toString('base64'),
            mimeType: 'audio/mpeg',
          })),
          transcribe: vi.fn().mockResolvedValue(''),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn(async (cmd) => ({
            file: cmd.file,
            lines: cmd.lines,
            view: cmd.view ?? 'diff',
          })),
          toggleViewMode: vi.fn().mockResolvedValue('diff'),
          getCurrentViewMode: () => 'diff',
          getCurrentLocation: () => undefined,
        },
        comments: {
          addDraft: vi.fn(),
          listDrafts: () => [],
          clear: vi.fn(),
        },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    await session.start(SAMPLE_TARGET);
    await new Promise((r) => setTimeout(r, 150));

    const activityMsgs = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'activity:update' }> => m.type === 'activity:update')
      .map((m) => m.activity);

    const stages = activityMsgs.map((a) => a.stage);
    expect(stages).toContain('analyzing');
    expect(stages).toContain('connecting');
    expect(stages).toContain('thinking');
    expect(stages).toContain('reading_file');
    expect(stages).toContain('synthesizing');

    const readingEvent = activityMsgs.find((a) => a.stage === 'reading_file');
    expect(readingEvent?.currentFile).toBe('src/auth.ts');
    expect(readingEvent?.counters.thoughtChars).toBeGreaterThan(0);
    expect(readingEvent?.thoughtPreview).toContain('auth.ts');
    expect(readingEvent?.recentFiles[0]).toMatchObject({
      path: 'src/auth.ts',
      lineRange: 'L10-29',
      status: 'reading',
    });
    expect(readingEvent?.counters.filesRead).toBe(1);

    const enqueued = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment);
    expect(enqueued.length).toBe(1);

    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: enqueued[0] });
    const afterStart = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'activity:update' }> => m.type === 'activity:update')
      .map((m) => m.activity)
      .pop();
    expect(afterStart?.stage).toBe('speaking');
    expect(afterStart?.counters.segmentsPlayed).toBe(1);

    await session.handleWebviewMessage({
      type: 'telemetry:playbackEvent',
      kind: 'audio_blocked',
      detail: 'NotAllowedError',
    });
    const afterBlocked = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'activity:update' }> => m.type === 'activity:update')
      .map((m) => m.activity)
      .pop();
    expect(afterBlocked?.stage).toBe('audio_blocked');

    session.dispose();
  });

  it('handles host mic start/stop, barge-in interruption, and transcribed follow-up turns', async () => {
    const sentMessages: HostToWebviewMessage[] = [];
    const promptsReceived: string[] = [];
    let micStarted = false;
    let micCallbacks: Parameters<
      NonNullable<ConstructorParameters<typeof ReviewSession>[0]['mic']>['start']
    >[0] | null = null;
    let promptIdx = 0;

    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's-mic' },
            configOptions: [],
          }),
          sendPrompt: vi.fn(async (text: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
            promptsReceived.push(text);
            promptIdx += 1;
            if (promptIdx === 1) {
              cb.onTextDelta(
                '<wb_render id="ov" title="总览" mode="replace">flowchart LR\n  A["API"] --> B["Svc"]\n</wb_render>' +
                  '正在讲解接口层的改动细节，请随时打断提问。'
              );
            } else {
              cb.onTextDelta('好的，这里确实需要先校验权限再写库。');
            }
            return { stopReason: 'end_turn' };
          }),
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: {
          build: vi.fn().mockResolvedValue(SAMPLE_PACK),
        },
        speech: {
          synthesizeWithFallback: vi.fn(async (text: string) => ({
            audioBase64: Buffer.from(text).toString('base64'),
            mimeType: 'audio/mpeg',
          })),
          transcribe: vi.fn().mockResolvedValue('这里有没有先检查权限？'),
          checkSttReadiness: vi.fn().mockResolvedValue({ ready: true }),
        },
        mic: {
          start: vi.fn(async (cbs) => {
            micStarted = true;
            micCallbacks = cbs;
            return { backend: 'sox-rec' };
          }),
          stop: vi.fn(() => {
            micStarted = false;
          }),
          isActive: () => micStarted,
          setVoiceMode: vi.fn(),
          setAssistantSpeaking: vi.fn(),
          setVadConfig: vi.fn(),
          startPtt: vi.fn(),
          endPtt: vi.fn(),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn(async (cmd) => ({
            file: cmd.file,
            lines: cmd.lines,
            view: cmd.view ?? 'diff',
          })),
          toggleViewMode: vi.fn().mockResolvedValue('diff'),
          getCurrentViewMode: () => 'diff',
          getCurrentLocation: () => undefined,
        },
        comments: {
          addDraft: vi.fn(),
          listDrafts: () => [],
          clear: vi.fn(),
        },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    await session.start(SAMPLE_TARGET);
    await new Promise((r) => setTimeout(r, 40));

    const firstSeg = (
      sentMessages.find((m) => m.type === 'audio:enqueue') as Extract<
        HostToWebviewMessage,
        { type: 'audio:enqueue' }
      >
    ).payload.segment;
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: firstSeg });

    await session.handleWebviewMessage({ type: 'mic:start' });
    expect(micStarted).toBe(true);
    expect(
      sentMessages.some((m) => m.type === 'mic:state' && m.active && m.backend === 'sox-rec')
    ).toBe(true);

    // Host VAD triggers barge-in while speaking, then delivers recorded WAV buffer
    micCallbacks!.onBargeIn();
    expect(sentMessages.some((m) => m.type === 'audio:clear')).toBe(true);

    micCallbacks!.onUtteranceReady(Buffer.from('RIFFfake'));
    await new Promise((r) => setTimeout(r, 40));

    expect(promptsReceived.length).toBe(2);
    expect(promptsReceived[1]).toContain('<interruption_context>');
    expect(promptsReceived[1]).toContain('这里有没有先检查权限？');

    await session.handleWebviewMessage({ type: 'mic:stop' });
    expect(micStarted).toBe(false);
    const lastMicState = [...sentMessages]
      .reverse()
      .find((m): m is Extract<HostToWebviewMessage, { type: 'mic:state' }> => m.type === 'mic:state');
    expect(lastMicState?.active).toBe(false);

    session.dispose();
  });

  it('resolves unmodified files and out-of-hunk lines to source view while keeping diff view for modified hunks', async () => {
    expect(
      resolveCodeGotoView(
        { type: 'code_goto', file: 'src/unchanged_caller.ts', lines: { start: 10, end: 25 }, view: 'diff' },
        SAMPLE_PACK,
        'diff'
      )
    ).toEqual({ view: 'source', isModifiedFile: false });

    expect(
      resolveCodeGotoView(
        { type: 'code_goto', file: 'src/auth.ts', lines: { start: 10, end: 18 }, view: 'source' },
        SAMPLE_PACK,
        'diff'
      )
    ).toEqual({ view: 'source', isModifiedFile: true });

    expect(
      resolveCodeGotoView(
        { type: 'code_goto', file: 'src/auth.ts', lines: { start: 120, end: 150 }, view: 'diff' },
        SAMPLE_PACK,
        'diff'
      )
    ).toEqual({ view: 'source', isModifiedFile: true });

    expect(
      resolveCodeGotoView(
        { type: 'code_goto', file: 'src/auth.ts', lines: { start: 12, end: 18 }, view: 'diff' },
        SAMPLE_PACK,
        'diff'
      )
    ).toEqual({ view: 'diff', isModifiedFile: true });

    // Sticky source preference overrides even explicit view="diff" from the model
    expect(
      resolveCodeGotoView(
        { type: 'code_goto', file: 'src/auth.ts', lines: { start: 12, end: 18 }, view: 'diff' },
        SAMPLE_PACK,
        'source'
      )
    ).toEqual({ view: 'source', isModifiedFile: true });

    const navCalls: Array<{ cmd: CodeGotoDirective; opts?: { preferWorkspaceFile?: boolean } }> = [];
    const sentMessages: HostToWebviewMessage[] = [];
    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's-view' },
            configOptions: [],
          }),
          sendPrompt: vi.fn(async (_t: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
            cb.onTextDelta(
              '<code_goto file="src/auth.ts" lines="12-18" view="diff" label="修改处"/>先看改动的鉴权代码。' +
                '<code_goto file="src/unchanged_caller.ts" lines="30-50" view="diff" label="调用方"/>再看未修改的调用方。' +
                '<code_goto file="src/auth.ts" lines="120-150" label="未修改区域"/>最后看同文件下方未修改逻辑。'
            );
            return { stopReason: 'end_turn' };
          }),
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: { build: vi.fn().mockResolvedValue(SAMPLE_PACK) },
        speech: {
          synthesizeWithFallback: vi.fn(async (text: string) => ({
            audioBase64: Buffer.from(text).toString('base64'),
            mimeType: 'audio/mpeg',
          })),
          transcribe: vi.fn().mockResolvedValue(''),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn(async (cmd, _target, opts) => {
            navCalls.push({ cmd, opts });
            return { file: cmd.file, lines: cmd.lines, view: cmd.view ?? 'diff', label: cmd.label };
          }),
          toggleViewMode: vi.fn().mockResolvedValue('diff'),
          getCurrentViewMode: () => 'diff',
          getCurrentLocation: () => undefined,
        },
        comments: { addDraft: vi.fn(), listDrafts: () => [], clear: vi.fn() },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    await session.start(SAMPLE_TARGET);
    await new Promise((r) => setTimeout(r, 40));

    const enqueued = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment);
    expect(enqueued.length).toBe(3);

    for (const seg of enqueued) {
      await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: seg });
    }

    expect(navCalls[0].cmd.view).toBe('diff');
    expect(navCalls[0].opts).toEqual({ preferWorkspaceFile: false });

    expect(navCalls[1].cmd.file).toBe('src/unchanged_caller.ts');
    expect(navCalls[1].cmd.view).toBe('source');
    expect(navCalls[1].opts).toEqual({ preferWorkspaceFile: true });

    expect(navCalls[2].cmd.file).toBe('src/auth.ts');
    expect(navCalls[2].cmd.view).toBe('source');
    expect(navCalls[2].opts).toEqual({ preferWorkspaceFile: false });

    session.dispose();
  });

  it('supports pausing and resuming walkthrough playback for calm source inspection', async () => {
    const sentMessages: HostToWebviewMessage[] = [];
    const setAssistantSpeakingCalls: boolean[] = [];

    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's-pause' },
            configOptions: [],
          }),
          sendPrompt: vi.fn(async (_t: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
            cb.onTextDelta('先讲第一段架构逻辑。接下来讲第二段详细实现。');
            return { stopReason: 'end_turn' };
          }),
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: { build: vi.fn().mockResolvedValue(SAMPLE_PACK) },
        speech: {
          synthesizeWithFallback: vi.fn(async (text: string) => ({
            audioBase64: Buffer.from(text).toString('base64'),
            mimeType: 'audio/mpeg',
          })),
          transcribe: vi.fn().mockResolvedValue(''),
        },
        mic: {
          start: vi.fn().mockResolvedValue({ backend: 'sox-rec' }),
          stop: vi.fn(),
          isActive: () => true,
          setVoiceMode: vi.fn(),
          setAssistantSpeaking: (speaking) => setAssistantSpeakingCalls.push(speaking),
          setVadConfig: vi.fn(),
          startPtt: vi.fn(),
          endPtt: vi.fn(),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn(async (cmd) => ({
            file: cmd.file,
            lines: cmd.lines,
            view: cmd.view ?? 'source',
          })),
          toggleViewMode: vi.fn().mockResolvedValue('source'),
          getCurrentViewMode: () => 'source',
          getCurrentLocation: () => undefined,
        },
        comments: { addDraft: vi.fn(), listDrafts: () => [], clear: vi.fn() },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    await session.start(SAMPLE_TARGET);
    await new Promise((r) => setTimeout(r, 40));

    const seg1 = (
      sentMessages.find((m) => m.type === 'audio:enqueue') as Extract<
        HostToWebviewMessage,
        { type: 'audio:enqueue' }
      >
    ).payload.segment;
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: seg1 });
    expect(setAssistantSpeakingCalls.at(-1)).toBe(true);

    // User pauses from Webview
    await session.handleWebviewMessage({ type: 'playback:paused' });
    expect(setAssistantSpeakingCalls.at(-1)).toBe(false);
    const pausedActivity = [...sentMessages]
      .reverse()
      .find((m): m is Extract<HostToWebviewMessage, { type: 'activity:update' }> => m.type === 'activity:update');
    expect(pausedActivity?.activity.stage).toBe('paused');
    const pausedState = [...sentMessages]
      .reverse()
      .find((m): m is Extract<HostToWebviewMessage, { type: 'session:state' }> => m.type === 'session:state');
    expect(pausedState?.phase).toBe('paused');

    // User resumes from Webview
    await session.handleWebviewMessage({ type: 'playback:resumed' });
    expect(setAssistantSpeakingCalls.at(-1)).toBe(true);
    const resumedState = [...sentMessages]
      .reverse()
      .find((m): m is Extract<HostToWebviewMessage, { type: 'session:state' }> => m.type === 'session:state');
    expect(resumedState?.phase).toBe('speaking');

    // Host command togglePause forwards audio:setPaused
    session.togglePause();
    expect(
      sentMessages.some((m) => m.type === 'audio:setPaused' && m.paused === true)
    ).toBe(true);
    session.togglePause();
    expect(
      sentMessages.some((m) => m.type === 'audio:setPaused' && m.paused === false)
    ).toBe(true);

    session.dispose();
  });

  it('detects action/note intent including ASR homophones, auto-fills file/line, deduplicates, and supports goto/delete', async () => {
    expect(detectActionNoteIntent('这里记忆reaction应该没必要去做转换')).toBe(true);
    expect(detectActionNoteIntent('你可以直接揭露它嘛')).toBe(true);
    expect(detectActionNoteIntent('帮我记一个 action 后续改掉')).toBe(true);
    expect(detectActionNoteIntent('Please add a follow-up action item here')).toBe(true);
    expect(detectActionNoteIntent('这个函数的参数是什么意思')).toBe(false);

    const sentMessages: HostToWebviewMessage[] = [];
    const savedNotes: ReviewNoteDraft[] = [];
    const navigatedCalls: CodeGotoDirective[] = [];
    const promptsReceived: string[] = [];
    let callNum = 0;

    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's-notes' },
            configOptions: [],
          }),
          sendPrompt: vi.fn(async (text: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
            promptsReceived.push(text);
            callNum += 1;
            if (callNum === 1) {
              cb.onTextDelta(
                '<code_goto file="src/auth.ts" lines="22-35" label="refreshToken"/>我们先看第 22 行鉴权逻辑。'
              );
            } else {
              cb.onTextDelta(
                '<review_note severity="action">无需转换币种：不同线程不共享 AMV 值</review_note>' +
                  '<review_note severity="action">无需转换币种：不同线程不共享 AMV 值</review_note>' +
                  '好的，已帮你把这个 Action 加入批注列表。'
              );
            }
            return { stopReason: 'end_turn' };
          }),
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: { build: vi.fn().mockResolvedValue(SAMPLE_PACK) },
        speech: {
          synthesizeWithFallback: vi.fn(async (text: string) => ({
            audioBase64: Buffer.from(text).toString('base64'),
            mimeType: 'audio/mpeg',
          })),
          transcribe: vi.fn().mockResolvedValue(''),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn(async (cmd) => {
            navigatedCalls.push(cmd);
            return { file: cmd.file, lines: cmd.lines, view: cmd.view ?? 'source', label: cmd.label };
          }),
          toggleViewMode: vi.fn().mockResolvedValue('source'),
          getCurrentViewMode: () => 'source',
          getCurrentLocation: () =>
            navigatedCalls.length > 0
              ? {
                  file: navigatedCalls[navigatedCalls.length - 1].file,
                  lines: navigatedCalls[navigatedCalls.length - 1].lines,
                  view: 'source',
                }
              : undefined,
        },
        comments: {
          addDraft: vi.fn((note) => {
            const d: ReviewNoteDraft = {
              id: `draft-${savedNotes.length + 1}`,
              file: note.file,
              line: note.line,
              severity: note.severity,
              body: note.body,
              createdAt: '2026-11-20T00:00:00Z',
            };
            savedNotes.push(d);
            return d;
          }),
          removeDraft: vi.fn((id: string) => {
            const idx = savedNotes.findIndex((n) => n.id === id);
            if (idx === -1) return false;
            savedNotes.splice(idx, 1);
            return true;
          }),
          listDrafts: () => [...savedNotes],
          clear: () => {
            savedNotes.length = 0;
          },
        },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    await session.start(SAMPLE_TARGET);
    await new Promise((r) => setTimeout(r, 40));

    const seg1 = (
      sentMessages.find((m) => m.type === 'audio:enqueue') as Extract<
        HostToWebviewMessage,
        { type: 'audio:enqueue' }
      >
    ).payload.segment;
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: seg1 });
    await session.handleWebviewMessage({ type: 'playback:segmentEnded', segment: seg1 });

    // Follow-up containing ASR homophone triggers [Action/批注识别提示] and preserves editor line context
    await session.handleUserQuestion('这里记忆reaction应该没必要去做转换', undefined, 'voice');
    await new Promise((r) => setTimeout(r, 40));

    expect(promptsReceived[1]).toContain('[Action/批注识别提示]');
    expect(promptsReceived[1]).toContain('src/auth.ts (行 22-35)');

    const turn2Seg = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment)
      .find((s) => s.turnId > seg1.turnId)!;

    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: turn2Seg });

    // Duplicate was skipped; omitted file & line were filled from active location (src/auth.ts:22)
    expect(savedNotes.length).toBe(1);
    expect(savedNotes[0]).toMatchObject({
      file: 'src/auth.ts',
      line: 22,
      severity: 'action',
      body: '无需转换币种：不同线程不共享 AMV 值',
    });

    // Click note location -> navigates cleanly
    await session.handleWebviewMessage({ type: 'ui:gotoNote', file: 'src/auth.ts', line: 22 });
    expect(navigatedCalls.at(-1)).toMatchObject({
      file: 'src/auth.ts',
      lines: { start: 22, end: 22 },
      view: 'source',
    });

    // Delete note -> removed and synced
    await session.handleWebviewMessage({ type: 'ui:deleteNote', id: savedNotes[0].id });
    expect(savedNotes.length).toBe(0);

    session.dispose();
  });

  it('supports branch-explore mode (instruction, standby, forced source view) and auto-start on question', async () => {
    const branchTarget: BranchExploreTarget = {
      kind: 'branch-explore',
      repoRoot: '/tmp/repo',
      branchName: 'main',
      baseRef: 'HEAD',
      effectiveBaseRef: 'HEAD',
      headRef: 'HEAD',
      title: 'repo (main)',
      subtitle: '当前分支指令导读',
      initialInstruction: '帮我 Review 鉴权模块并发锁边界',
      startMode: 'instruction',
    };

    const branchPack: ReviewContextPack = {
      target: branchTarget,
      generatedAt: '2026-11-23T00:00:00.000Z',
      commits: ['def456 feat: auth module'],
      totalFilesChanged: 0,
      includedFilesCount: 5,
      ignoredFilesCount: 1,
      totalAdditions: 0,
      totalDeletions: 0,
      files: [],
      chapters: [
        {
          index: 1,
          title: '项目全局架构与核心模块总览',
          moduleGroup: 'overview',
          files: ['src/auth.ts'],
          summary: '全局架构',
        },
      ],
      moduleClusters: [
        {
          moduleGroup: 'src',
          fileCount: 5,
          additions: 0,
          deletions: 0,
          files: ['src/auth.ts'],
        },
      ],
      repoOverview: {
        branchName: 'main',
        totalTrackedFiles: 6,
        includedFiles: 5,
        ignoredFiles: 1,
        directorySummaries: ['src (5 files): auth.ts'],
        keyDocs: [{ path: 'README.md', snippet: '# Repo Overview' }],
        workingTreeChanges: [],
      },
    };

    // resolveCodeGotoView must force workspace source view for branch-explore even if diff was requested
    expect(
      resolveCodeGotoView(
        { type: 'code_goto', file: 'src/auth.ts', lines: { start: 10, end: 25 }, view: 'diff' },
        branchPack,
        'diff'
      )
    ).toEqual({ view: 'source', isModifiedFile: false });

    const systemPrompts: string[] = [];
    const sentPrompts: string[] = [];
    const sentMessages: HostToWebviewMessage[] = [];
    const navCalls: Array<{ cmd: CodeGotoDirective; opts?: { preferWorkspaceFile?: boolean } }> = [];

    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn(async (opts) => {
            systemPrompts.push(opts.systemPromptAppend ?? '');
            return {
              initResult: { protocolVersion: 1 },
              sessionResult: { sessionId: 's-branch' },
              configOptions: [],
              modelResolution: {
                requestedThoughtLevel: 'low',
                resolvedModel: 'gemini-4-hydrogen',
                resolvedThoughtLevel: 'low',
                matchedRequestedModel: true,
                availableModels: ['gemini-4-hydrogen'],
              },
            };
          }),
          sendPrompt: vi.fn(async (text: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
            sentPrompts.push(text);
            cb.onTextDelta(
              '<code_goto file="src/auth.ts" lines="10-30" view="diff" label="Auth.lock"/>先看当前分支的鉴权模块入口。'
            );
            return { stopReason: 'end_turn' };
          }),
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: { build: vi.fn().mockResolvedValue(branchPack) },
        speech: {
          synthesizeWithFallback: vi.fn(async (text: string) => ({
            audioBase64: Buffer.from(text).toString('base64'),
            mimeType: 'audio/mpeg',
          })),
          transcribe: vi.fn().mockResolvedValue(''),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn(async (cmd, _target, opts) => {
            navCalls.push({ cmd, opts });
            return { file: cmd.file, lines: cmd.lines, view: cmd.view ?? 'source', label: cmd.label };
          }),
          toggleViewMode: vi.fn().mockResolvedValue('source'),
          getCurrentViewMode: () => 'source',
          getCurrentLocation: () => undefined,
        },
        comments: { addDraft: vi.fn(), listDrafts: () => [], clear: vi.fn() },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    await session.start(branchTarget);
    await new Promise((r) => setTimeout(r, 40));

    expect(systemPrompts[0]).toContain('当前分支 / 项目全局导读与按指令 Code Review');
    expect(sentPrompts[0]).toContain('帮我 Review 鉴权模块并发锁边界');
    expect(sentPrompts[0]).toContain('## Module & Directory Map');

    const firstMetaState = sentMessages.find(
      (m): m is Extract<HostToWebviewMessage, { type: 'session:state' }> =>
        m.type === 'session:state' && m.meta?.sourceKind === 'branch-explore'
    );
    expect(firstMetaState?.meta?.viewMode).toBe('source');

    const enqueuedSeg = sentMessages.find(
      (m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue'
    )!.payload.segment;
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: enqueuedSeg });
    expect(navCalls[0].cmd.view).toBe('source');
    expect(navCalls[0].opts).toEqual({ preferWorkspaceFile: true });

    // Standby mode skips initial turn and uses first user question to build branch-explore prompt once
    const standbyTarget: BranchExploreTarget = {
      ...branchTarget,
      initialInstruction: undefined,
      startMode: 'standby',
    };
    const standbyPack: ReviewContextPack = { ...branchPack, target: standbyTarget };
    const standbyPrompts: string[] = [];
    const standbySession = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's-standby' },
            configOptions: [],
          }),
          sendPrompt: vi.fn(async (text: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
            standbyPrompts.push(text);
            cb.onTextDelta('好的，我来为你讲解项目整体结构。');
            return { stopReason: 'end_turn' };
          }),
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: { build: vi.fn().mockResolvedValue(standbyPack) },
        speech: {
          synthesizeWithFallback: vi.fn(async (text: string) => ({
            audioBase64: Buffer.from(text).toString('base64'),
            mimeType: 'audio/mpeg',
          })),
          transcribe: vi.fn().mockResolvedValue(''),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: vi.fn(),
        },
        codeNavigator: {
          navigateTo: vi.fn(async (cmd) => ({
            file: cmd.file,
            lines: cmd.lines,
            view: 'source' as const,
          })),
          toggleViewMode: vi.fn().mockResolvedValue('source'),
          getCurrentViewMode: () => 'source',
          getCurrentLocation: () => undefined,
        },
        comments: { addDraft: vi.fn(), listDrafts: () => [], clear: vi.fn() },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    await standbySession.start(standbyTarget);
    expect(standbyPrompts.length).toBe(0);

    await standbySession.handleUserQuestion('先给我讲讲项目入口模块', undefined, 'text');
    expect(standbyPrompts.length).toBe(1);
    expect(standbyPrompts[0]).toContain('先给我讲讲项目入口模块');
    expect(standbyPrompts[0]).toContain('## Module & Directory Map');

    // Second question should use normal follow-up prompt rather than repeating full repo context
    await standbySession.handleUserQuestion('再展开 auth 部分', undefined, 'text');
    expect(standbyPrompts.length).toBe(2);
    expect(standbyPrompts[1]).not.toContain('## Module & Directory Map');

    // Auto-start when user sends question before selecting any target
    const autoStartSpy = vi.fn().mockResolvedValue(undefined);
    const idleSession = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn(),
          sendPrompt: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: { build: vi.fn() },
        speech: {
          synthesizeWithFallback: vi.fn(),
          transcribe: vi.fn(),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn(),
          postMessage: vi.fn(),
        },
        codeNavigator: {
          navigateTo: vi.fn(),
          toggleViewMode: vi.fn(),
          getCurrentViewMode: () => 'source',
          getCurrentLocation: () => undefined,
        },
        comments: { addDraft: vi.fn(), listDrafts: () => [], clear: vi.fn() },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onAutoStartBranchExplore: autoStartSpy,
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    await idleSession.handleUserQuestion('讲一下整个项目的核心流程', undefined, 'text');
    expect(autoStartSpy).toHaveBeenCalledWith('讲一下整个项目的核心流程');

    session.dispose();
    standbySession.dispose();
    idleSession.dispose();
  });

  it('clamps highlight ranges to <=10 lines, preserves L1<->L2 navigation, and auto-opens mapped code on wb_focus', async () => {
    expect(clampHighlightRange({ start: 10, end: 15 })).toEqual({ start: 10, end: 15 });
    expect(clampHighlightRange({ start: 10, end: 45 })).toEqual({ start: 10, end: 19 });
    expect(clampHighlightRange({ start: 0, end: -3 })).toEqual({ start: 1, end: 1 });

    const sentMessages: HostToWebviewMessage[] = [];
    const navCalls: CodeGotoDirective[] = [];
    let turnCount = 0;

    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's-l1l2' },
            configOptions: [],
            modelResolution: {
              requestedThoughtLevel: 'low',
              resolvedModel: 'gemini-4-hydrogen',
              resolvedThoughtLevel: 'low',
              matchedRequestedModel: true,
              availableModels: ['gemini-4-hydrogen'],
            },
          }),
          sendPrompt: vi.fn(async (_text: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
            turnCount += 1;
            if (turnCount === 1) {
              cb.onTextDelta(
                '<wb_render id="l1" title="全局总览" mode="replace" map=\'{"Auth":"src/auth.ts:10-45"}\'>erDiagram\n  CLIENT ||--|| AUTH : uses\n</wb_render>' +
                  '<wb_focus id="Auth"/>' +
                  '先看全局实体关系。' +
                  '<wb_render id="l2" title="Auth 模块结构" mode="push" map=\'{"Lock":"src/auth.ts:50-80"}\'>classDiagram\n  class Lock\n</wb_render>' +
                  '再展开到 L2 模块结构。'
              );
            } else {
              cb.onTextDelta(
                '<wb_render id="l2-alt" title="新分支 L2" mode="push">flowchart LR\n  A["A"] --> B["B"]\n</wb_render>' +
                  '切换到新的 L2 分支。'
              );
            }
            return { stopReason: 'end_turn' };
          }),
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: { build: vi.fn().mockResolvedValue(SAMPLE_PACK) },
        speech: {
          synthesizeWithFallback: vi.fn(async (text: string) => ({
            audioBase64: Buffer.from(text).toString('base64'),
            mimeType: 'audio/mpeg',
          })),
          transcribe: vi.fn().mockResolvedValue(''),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn(async (cmd) => {
            navCalls.push(cmd);
            return { file: cmd.file, lines: cmd.lines, view: cmd.view ?? 'source', label: cmd.label };
          }),
          toggleViewMode: vi.fn().mockResolvedValue('source'),
          getCurrentViewMode: () => 'source',
          getCurrentLocation: () => undefined,
        },
        comments: { addDraft: vi.fn(), listDrafts: () => [], clear: vi.fn() },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    await session.start(SAMPLE_TARGET);
    await new Promise((r) => setTimeout(r, 40));

    const segs = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment);
    expect(segs.length).toBe(2);

    // Segment 1 has <wb_focus id="Auth"/> with NO explicit <code_goto> -> auto-navigates to src/auth.ts:10-19 (<=10 lines)
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: segs[0] });
    expect(navCalls.length).toBe(1);
    expect(navCalls[0]).toMatchObject({
      file: 'src/auth.ts',
      lines: { start: 10, end: 19 },
    });
    await session.handleWebviewMessage({ type: 'playback:segmentEnded', segment: segs[0] });

    // Segment 2 pushed L2
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: segs[1] });
    await session.handleWebviewMessage({ type: 'playback:segmentEnded', segment: segs[1] });

    // Click L1 (index 0) -> stack MUST keep [l1, l2] with activeIndex: 0
    await session.handleWebviewMessage({ type: 'whiteboard:popTo', index: 0 });
    const afterL1Click = [...sentMessages]
      .reverse()
      .find(
        (m): m is Extract<HostToWebviewMessage, { type: 'whiteboard:syncStack' }> =>
          m.type === 'whiteboard:syncStack'
      );
    expect(afterL1Click?.stack.map((d) => d.id)).toEqual(['l1', 'l2']);
    expect(afterL1Click?.activeIndex).toBe(0);

    // Click L2 (index 1) -> switches cleanly back to L2 without losing it!
    await session.handleWebviewMessage({ type: 'whiteboard:popTo', index: 1 });
    const afterL2Click = [...sentMessages]
      .reverse()
      .find(
        (m): m is Extract<HostToWebviewMessage, { type: 'whiteboard:syncStack' }> =>
          m.type === 'whiteboard:syncStack'
      );
    expect(afterL2Click?.stack.map((d) => d.id)).toEqual(['l1', 'l2']);
    expect(afterL2Click?.activeIndex).toBe(1);

    // Switch back to L1, then push a new L2 -> replaces forward branch cleanly ([l1, l2-alt])
    await session.handleWebviewMessage({ type: 'whiteboard:popTo', index: 0 });
    await session.handleUserQuestion('再换个角度展开 L2', undefined, 'text');
    await session.handleWebviewMessage({ type: 'webview:ready' });

    const afterPushFromL1 = [...sentMessages]
      .reverse()
      .find(
        (m): m is Extract<HostToWebviewMessage, { type: 'whiteboard:syncStack' }> =>
          m.type === 'whiteboard:syncStack'
      );
    expect(afterPushFromL1?.stack.map((d) => d.id)).toEqual(['l1', 'l2-alt']);
    expect(afterPushFromL1?.activeIndex).toBe(1);

    session.dispose();
  });

  it('syncs curated call_chain sidebar, calibrates line numbers, filters noise callers, and supports non-interrupting jumps & LSP expansion', async () => {
    const sampleTs = [
      '// header',
      'export class AuthService {',
      '  async validate() { return true; }',
      '  async refreshToken(id: string) {',
      '    return id;',
      '  }',
      '}',
    ].join('\n');
    expect(calibrateNodeLineFromContent(sampleTs, 'AuthService.refreshToken', 10)).toEqual({
      line: 4,
      verified: true,
    });
    expect(isNoiseCallerPath('src/auth/__tests__/token.test.ts')).toBe(true);
    expect(isNoiseCallerPath('src/api/controller.ts')).toBe(false);

    const sampleNodes = [
      { id: 'cc-0', symbol: 'Routes.post', file: 'src/api/routes.ts', line: 12 },
      { id: 'cc-1', symbol: 'AuthController.handle', file: 'src/api/controller.ts', line: 40 },
      { id: 'cc-2', symbol: 'AuthService.refreshToken', file: 'src/auth/token.ts', line: 24 },
    ];
    expect(matchActiveCallChainNode(sampleNodes, 'src/api/controller.ts', 42)).toBe(1);

    const sentMessages: HostToWebviewMessage[] = [];
    const navCalls: CodeGotoDirective[] = [];
    const calibrateSpy = vi.fn(async (nodes: typeof sampleNodes) =>
      nodes.map((n, i) => ({ ...n, line: n.line + i + 1, verified: true }))
    );
    const findCallersSpy = vi.fn().mockResolvedValue({
      callers: [
        {
          id: 'caller-0',
          symbol: 'SessionRouter.dispatch',
          file: 'src/api/router.ts',
          line: 88,
          source: 'lsp' as const,
        },
      ],
      source: 'lsp' as const,
      note: '已自动过滤 2 处测试/噪音调用',
    });

    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's-cc' },
            configOptions: [],
            modelResolution: {
              requestedThoughtLevel: 'low',
              resolvedModel: 'gemini-4-hydrogen',
              resolvedThoughtLevel: 'low',
              matchedRequestedModel: true,
              availableModels: ['gemini-4-hydrogen'],
            },
          }),
          sendPrompt: vi.fn(async (_t: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
            cb.onTextDelta(
              '<call_chain title="鉴权刷新主链路">\n' +
                'Routes.post | src/api/routes.ts:12 | 路由入口\n' +
                'AuthController.handle | src/api/controller.ts:40 | 控制器分发\n' +
                '* AuthService.refreshToken | src/auth/token.ts:24 | 核心刷新逻辑\n' +
                '</call_chain>' +
                '先从主链路全局入口往下看。' +
                '<code_goto file="src/api/controller.ts" lines="40-46" label="控制器"/>' +
                '这里控制层负责校验参数。'
            );
            return { stopReason: 'end_turn' };
          }),
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: { build: vi.fn().mockResolvedValue(SAMPLE_PACK) },
        speech: {
          synthesizeWithFallback: vi.fn(async (text: string) => ({
            audioBase64: Buffer.from(text).toString('base64'),
            mimeType: 'audio/mpeg',
          })),
          transcribe: vi.fn().mockResolvedValue(''),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn(async (cmd) => {
            navCalls.push(cmd);
            return { file: cmd.file, lines: cmd.lines, view: cmd.view ?? 'source', label: cmd.label };
          }),
          toggleViewMode: vi.fn().mockResolvedValue('source'),
          getCurrentViewMode: () => 'source',
          getCurrentLocation: () => undefined,
        },
        comments: { addDraft: vi.fn(), listDrafts: () => [], clear: vi.fn() },
        callChainResolver: {
          calibrateCallChain: calibrateSpy,
          findIncomingCallers: findCallersSpy,
          buildLspFallbackChain: vi.fn().mockResolvedValue(null),
        },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    await session.start(SAMPLE_TARGET);
    await new Promise((r) => setTimeout(r, 40));

    const segs = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment);
    expect(segs.length).toBe(2);

    // Segment 1 applies <call_chain> and triggers async calibration
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: segs[0] });
    await new Promise((r) => setTimeout(r, 20));
    expect(calibrateSpy).toHaveBeenCalledTimes(1);

    const calibratedSync = [...sentMessages]
      .reverse()
      .find(
        (m): m is Extract<HostToWebviewMessage, { type: 'callChain:sync' }> =>
          m.type === 'callChain:sync' && m.chain !== null
      );
    expect(calibratedSync?.chain?.activeIndex).toBe(2);
    expect(calibratedSync?.chain?.nodes[2].verified).toBe(true);

    // Segment 2 <code_goto> moves activeIndex automatically to controller (index 1)
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: segs[1] });
    const afterGotoSync = [...sentMessages]
      .reverse()
      .find(
        (m): m is Extract<HostToWebviewMessage, { type: 'callChain:sync' }> =>
          m.type === 'callChain:sync' && m.chain !== null
      );
    expect(afterGotoSync?.chain?.activeIndex).toBe(1);

    // Clicking a node in the sidebar jumps cleanly WITHOUT clearing/cancelling audio
    const clearCountBefore = sentMessages.filter((m) => m.type === 'audio:clear').length;
    await session.handleWebviewMessage({
      type: 'callChain:gotoNode',
      file: 'src/api/routes.ts',
      line: 13,
      label: 'Routes.post',
    });
    expect(navCalls.at(-1)).toMatchObject({
      file: 'src/api/routes.ts',
      lines: { start: 13, end: 19 },
    });
    expect(sentMessages.filter((m) => m.type === 'audio:clear').length).toBe(clearCountBefore);

    // Expanding incoming callers via LSP posts callersResult
    await session.handleWebviewMessage({
      type: 'callChain:expandCallers',
      nodeId: 'cc-2',
      file: 'src/auth/token.ts',
      line: 27,
      symbol: 'AuthService.refreshToken',
    });
    const callersRes = sentMessages.find(
      (m): m is Extract<HostToWebviewMessage, { type: 'callChain:callersResult' }> =>
        m.type === 'callChain:callersResult'
    );
    expect(callersRes?.callers[0].symbol).toBe('SessionRouter.dispatch');
    expect(callersRes?.note).toContain('过滤');

    session.dispose();
  });

  it('supports agent in-place wb_render mode="update", tree outline in follow-up prompts, and whiteboard:selectLayer', async () => {
    const sentMessages: HostToWebviewMessage[] = [];
    const seenPrompts: string[] = [];
    let turnCount = 0;

    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            profile: { id: 'agy', name: 'agy', command: 'agy', args: ['acp'] },
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's-tree' },
            configOptions: [],
            modelResolution: {
              requestedThoughtLevel: 'low',
              resolvedModel: 'gemini-4-hydrogen',
              resolvedThoughtLevel: 'low',
              matchedRequestedModel: true,
              availableModels: ['gemini-4-hydrogen'],
            },
          }),
          sendPrompt: vi.fn(async (promptText: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
            seenPrompts.push(promptText);
            turnCount += 1;
            if (turnCount === 1) {
              cb.onTextDelta(
                '<wb_render id="l1" title="全局总览" mode="replace">flowchart LR\n  A --> B\n</wb_render>' +
                  '先看全局架构与整体流程。' +
                  '<wb_render id="l2-a" title="分支 A" mode="push">flowchart LR\n  B --> C\n</wb_render>' +
                  '再展开看分支 A 的核心实现。'
              );
            } else {
              cb.onTextDelta(
                '<wb_render mode="update" target="l1" title="全局总览（补充完整）">flowchart LR\n  A --> B & D\n</wb_render>' +
                  '已原地更新 L1 全局架构图。'
              );
            }
            return { stopReason: 'end_turn' };
          }),
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: { build: vi.fn().mockResolvedValue(SAMPLE_PACK) },
        speech: {
          synthesizeWithFallback: vi.fn(async (text: string) => ({
            audioBase64: Buffer.from(text).toString('base64'),
            mimeType: 'audio/mpeg',
          })),
          transcribe: vi.fn().mockResolvedValue(''),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn().mockResolvedValue({ file: 'src/auth.ts', view: 'source' }),
          toggleViewMode: vi.fn().mockResolvedValue('source'),
          getCurrentViewMode: () => 'source',
          getCurrentLocation: () => undefined,
        },
        comments: { addDraft: vi.fn(), listDrafts: () => [], clear: vi.fn() },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    await session.start(SAMPLE_TARGET);
    await new Promise((r) => setTimeout(r, 40));

    const segs = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment);
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: segs[0] });
    await session.handleWebviewMessage({ type: 'playback:segmentEnded', segment: segs[0] });
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: segs[1] });
    await session.handleWebviewMessage({ type: 'playback:segmentEnded', segment: segs[1] });
    await session.handleWebviewMessage({ type: 'playback:queueEmpty', turnId: segs[1].turnId });

    // Ask follow-up while on l2-a -> prompt carries treeOutline and mode="update" instructions
    await session.handleUserQuestion('把 L1 全局图再补充完整一点', undefined, 'text');
    await new Promise((r) => setTimeout(r, 40));
    expect(seenPrompts[1]).toContain('当前白板树状结构 (L1~L4)');
    expect(seenPrompts[1]).toContain('id="l1"');
    expect(seenPrompts[1]).toContain('id="l2-a"');

    // Run segment of turn 2 and trigger webview:ready sync to inspect updated tree
    const turn2Seg = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment)
      .at(-1)!;
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: turn2Seg });
    await session.handleWebviewMessage({ type: 'webview:ready' });

    const synced = [...sentMessages]
      .reverse()
      .find(
        (m): m is Extract<HostToWebviewMessage, { type: 'whiteboard:syncStack' }> =>
          m.type === 'whiteboard:syncStack'
      );
    expect(synced?.activeId).toBe('l1');
    expect(synced?.nodes?.find((n) => n.id === 'l1')).toMatchObject({
      title: '全局总览（补充完整）',
      revision: 2,
    });
    expect(synced?.stack.map((n) => n.id)).toEqual(['l1', 'l2-a']);
    expect(synced?.activeIndex).toBe(0);

    // Selecting l2-a via whiteboard:selectLayer moves activeId to l2-a
    await session.handleWebviewMessage({ type: 'whiteboard:selectLayer', id: 'l2-a' });
    const afterSelect = [...sentMessages]
      .reverse()
      .find(
        (m): m is Extract<HostToWebviewMessage, { type: 'whiteboard:syncStack' }> =>
          m.type === 'whiteboard:syncStack'
      );
    expect(afterSelect?.activeId).toBe('l2-a');
    expect(afterSelect?.activeIndex).toBe(1);

    session.dispose();
  });

  it('supports input-driven core-path line-by-line review mode with auto sub-method jump, on-demand whiteboard deepening, and continuation', async () => {
    expect(buildCorePathLineReviewSystemPrompt()).toContain('基于输入的核心链路逐行 Review');
    const previewPrompt = buildCorePathLineReviewInitialPrompt('repo-pack', '追踪 POST /orders 扣库存链路', {
      file: 'src/api/orders.ts',
      line: 18,
      endLine: 22,
      selectedSnippet: 'const ok = await reserveStock(req.items);',
    });
    expect(previewPrompt).toContain('追踪 POST /orders 扣库存链路');
    expect(previewPrompt).toContain('src/api/orders.ts (第 18-22 行)');
    expect(previewPrompt).toContain('reserveStock');

    const sentMessages: HostToWebviewMessage[] = [];
    const seenPrompts: string[] = [];
    const navCalls: CodeGotoDirective[] = [];
    let connectSysPrompt = '';
    const onStartCorePathSpy = vi.fn().mockResolvedValue(undefined);

    const corePathTarget: BranchExploreTarget = {
      kind: 'branch-explore',
      repoRoot: '/tmp/repo',
      branchName: 'main',
      baseRef: 'HEAD',
      effectiveBaseRef: 'HEAD',
      headRef: 'HEAD',
      title: 'repo (main)',
      subtitle: '核心链路逐行 Review · 追踪 POST /orders 扣库存链路',
      initialInstruction: '追踪 POST /orders 扣库存链路',
      startMode: 'core-path-line-review',
      entryHint: {
        file: 'src/api/orders.ts',
        line: 18,
        endLine: 22,
        selectedSnippet: 'const ok = await reserveStock(req.items);',
      },
    };

    let turnCount = 0;
    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn(async (opts) => {
            connectSysPrompt = opts.systemPromptAppend;
            return {
              profile: { id: 'agy', name: 'agy', command: 'agy', args: ['acp'] },
              initResult: { protocolVersion: 1 },
              sessionResult: { sessionId: 's-core-path' },
              configOptions: [],
              modelResolution: {
                requestedThoughtLevel: 'low',
                resolvedModel: 'gemini-4-hydrogen',
                resolvedThoughtLevel: 'low',
                matchedRequestedModel: true,
                availableModels: ['gemini-4-hydrogen'],
              },
            };
          }),
          sendPrompt: vi.fn(async (promptText: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
            seenPrompts.push(promptText);
            turnCount += 1;
            if (turnCount === 1) {
              cb.onTextDelta(
                '<wb_render id="core_path" title="核心链路：下单扣库存" mode="replace">sequenceDiagram\n  API->>Inv: reserveStock()\n</wb_render>' +
                  '<call_chain title="下单扣库存链路">\n* OrderApi.create | src/api/orders.ts:18 | 参数校验并调用扣库存\nInventorySvc.reserve | src/services/inventory.ts:40 | 原子扣减库存\n</call_chain>' +
                  '<code_goto file="src/api/orders.ts" lines="18-23" view="source" label="OrderApi.create — 参数校验"/>' +
                  '先看入口第 18 到 23 行的鉴权与下单参数分支判断。' +
                  '<wb_render id="sub-inv" parent="core_path" title="子方法：InventorySvc.reserve" mode="push">flowchart TD\n  Check --> Deduct\n</wb_render>' +
                  '<code_goto file="src/services/inventory.ts" lines="40-46" view="source" label="InventorySvc.reserve — 核心分支"/>' +
                  '自动跳入库存服务第 40 到 46 行，我们把白板深化到 L2 看里面的并发分支。' +
                  '<wb_pop/>' +
                  '<code_goto file="src/api/orders.ts" lines="25-30" view="source" label="OrderApi.create — 返回结果"/>' +
                  '回到入口第 25 到 30 行继续往下检查返回值，这里先停下等你确认。'
              );
            } else {
              cb.onTextDelta(
                '<code_goto file="src/api/orders.ts" lines="31-37" view="source" label="OrderApi.create — 异常兜底"/>' +
                  '继续往第 31 到 37 行看异常分支处理。'
              );
            }
            return { stopReason: 'end_turn' };
          }),
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: { build: vi.fn().mockResolvedValue(SAMPLE_PACK) },
        speech: {
          synthesizeWithFallback: vi.fn(async (text: string) => ({
            audioBase64: Buffer.from(text).toString('base64'),
            mimeType: 'audio/mpeg',
          })),
          transcribe: vi.fn().mockResolvedValue(''),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn(async (cmd) => {
            navCalls.push(cmd);
            return { file: cmd.file, lines: cmd.lines, view: cmd.view ?? 'source', label: cmd.label };
          }),
          toggleViewMode: vi.fn().mockResolvedValue('source'),
          getCurrentViewMode: () => 'source',
          getCurrentLocation: () =>
            navCalls.length > 0
              ? {
                  file: navCalls.at(-1)!.file,
                  lines: navCalls.at(-1)!.lines,
                  view: 'source' as const,
                  label: navCalls.at(-1)!.label,
                }
              : undefined,
        },
        comments: { addDraft: vi.fn(), listDrafts: () => [], clear: vi.fn() },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onStartCorePathReview: onStartCorePathSpy,
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    await session.start(corePathTarget);
    await new Promise((r) => setTimeout(r, 40));

    expect(connectSysPrompt).toContain('基于输入的核心链路逐行 Review');
    expect(seenPrompts[0]).toContain('追踪 POST /orders 扣库存链路');
    expect(seenPrompts[0]).toContain('src/api/orders.ts (第 18-22 行)');

    const modeMetaMsg = sentMessages.find(
      (m): m is Extract<HostToWebviewMessage, { type: 'session:state' }> =>
        m.type === 'session:state' && m.meta?.reviewMode === 'core-path-line-review'
    );
    expect(modeMetaMsg).toBeDefined();

    const segs = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment);
    expect(segs.length).toBe(3);

    for (const seg of segs) {
      await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: seg });
      await session.handleWebviewMessage({ type: 'playback:segmentEnded', segment: seg });
    }
    await session.handleWebviewMessage({ type: 'playback:queueEmpty', turnId: segs[2].turnId });

    // Verified line-by-line jump sequence: caller -> sub-method -> caller next chunk
    expect(navCalls.map((c) => `${c.file}:${c.lines?.start}-${c.lines?.end}`)).toEqual([
      'src/api/orders.ts:18-23',
      'src/services/inventory.ts:40-46',
      'src/api/orders.ts:25-30',
    ]);

    // Continuing after checkpoint injects core-path-line-review continuation guidance + current lines
    await session.handleUserQuestion('继续', undefined, 'text');
    expect(seenPrompts[1]).toContain('核心链路逐行 Review 延续规则');
    expect(seenPrompts[1]).toContain('src/api/orders.ts (行 25-30)');
    expect(seenPrompts[1]).toContain('id="sub-inv"');

    // Also test standalone follow-up prompt helper directly
    const standalone = buildUserFollowUpPrompt('继续往下', {
      diagramId: 'core_path',
      editorFile: 'src/api/orders.ts',
      editorLines: { start: 25, end: 30 },
      mode: 'core-path-line-review',
    });
    expect(standalone).toContain('核心链路逐行 Review 延续规则');

    await session.handleWebviewMessage({ type: 'ui:startCorePathReview' });
    expect(onStartCorePathSpy).toHaveBeenCalledTimes(1);

    session.dispose();
  });

  it('auto-continues seamlessly using lookahead prefetch buffer without asking to continue and stops on <walkthrough_done/>', async () => {
    const sentMessages: HostToWebviewMessage[] = [];
    const seenPrompts: string[] = [];
    let callIdx = 0;

    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            profile: { id: 'agy', name: 'agy', command: 'agy', args: ['acp'] },
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's-auto' },
            configOptions: [],
          }),
          sendPrompt: vi.fn(async (promptText: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
            seenPrompts.push(promptText);
            callIdx += 1;
            if (callIdx === 1) {
              cb.onTextDelta(
                '<chapter index="1" total="2" title="L1 全局总览"/>' +
                  '<wb_render id="l1" title="全局架构" mode="replace">flowchart LR\n  A --> B\n</wb_render>' +
                  '<code_goto file="src/auth.ts" lines="1-5" view="source"/>' +
                  '第一段先看全局入口设计。' +
                  '第二段看入口参数基础校验逻辑。' +
                  '第三段看如何构造初始上下文对象。'
              );
            } else {
              cb.onTextDelta(
                '<chapter index="2" total="2" title="L2 核心模块"/>' +
                  '<wb_render id="l2" parent="l1" title="Auth 子模块" mode="push">flowchart TD\n  B --> C\n</wb_render>' +
                  '<code_goto file="src/auth.ts" lines="20-26" view="source"/>' +
                  '紧接着进入第二章核心模块分析。' +
                  '整条链路已经完整收尾。<walkthrough_done/>'
              );
            }
            return { stopReason: 'end_turn' };
          }),
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: { build: vi.fn().mockResolvedValue(SAMPLE_PACK) },
        speech: {
          synthesizeWithFallback: vi.fn(async (text: string) => ({
            audioBase64: Buffer.from(text).toString('base64'),
            mimeType: 'audio/mpeg',
          })),
          transcribe: vi.fn().mockResolvedValue(''),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn(async (cmd) => ({
            file: cmd.file,
            lines: cmd.lines,
            view: cmd.view ?? 'source',
            label: cmd.label,
          })),
          toggleViewMode: vi.fn().mockResolvedValue('source'),
          getCurrentViewMode: () => 'source',
          getCurrentLocation: () => undefined,
        },
        comments: { addDraft: vi.fn(), listDrafts: () => [], clear: vi.fn() },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      { ...BASE_CONFIG, autoContinue: true }
    );

    await session.start(SAMPLE_TARGET);
    await new Promise((r) => setTimeout(r, 40));

    const chunk1Segs = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment);
    expect(chunk1Segs.length).toBe(3);
    const turnId = chunk1Segs[0].turnId;
    const clearCountBefore = sentMessages.filter((m) => m.type === 'audio:clear').length;

    // Playing segment 1 starts background prefetch of chunk 2 without flushing yet (3-0=3 > watermark 2)
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: chunk1Segs[0] });
    await new Promise((r) => setTimeout(r, 40));

    expect(seenPrompts.length).toBe(2);
    expect(seenPrompts[1]).toContain('系统自动连续推演');
    // Still buffered cleanly: chunk 2 NOT enqueued yet while 3 segments remain
    expect(sentMessages.filter((m) => m.type === 'audio:enqueue').length).toBe(3);

    // Finishing segment 1 brings remaining to 3 - 1 = 2 <= watermark 2 -> flushes chunk 2 seamlessly!
    await session.handleWebviewMessage({ type: 'playback:segmentEnded', segment: chunk1Segs[0] });
    const allAfterFlush = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment);
    expect(allAfterFlush.length).toBe(5);
    expect(allAfterFlush[3].turnId).toBe(turnId);
    expect(sentMessages.filter((m) => m.type === 'audio:clear').length).toBe(clearCountBefore);

    // Complete all segments -> walkthrough_done stops further prefetch and goes idle cleanly
    for (const seg of allAfterFlush.slice(1)) {
      await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: seg });
      await session.handleWebviewMessage({ type: 'playback:segmentEnded', segment: seg });
    }
    await session.handleWebviewMessage({ type: 'playback:queueEmpty', turnId });
    await new Promise((r) => setTimeout(r, 30));

    expect(seenPrompts.length).toBe(2);
    const lastState = [...sentMessages]
      .reverse()
      .find((m): m is Extract<HostToWebviewMessage, { type: 'session:state' }> => m.type === 'session:state');
    expect(lastState?.phase).toBe('idle');

    session.dispose();
  });

  it('holds buffer when paused and discards prefetched buffer cleanly on barge-in', async () => {
    const sentMessages: HostToWebviewMessage[] = [];
    const seenPrompts: string[] = [];
    let callIdx = 0;
    const cancelSpy = vi.fn();

    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            profile: { id: 'agy', name: 'agy', command: 'agy', args: ['acp'] },
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's-pause-cancel' },
            configOptions: [],
          }),
          sendPrompt: vi.fn(async (promptText: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
            seenPrompts.push(promptText);
            callIdx += 1;
            if (callIdx === 1) {
              cb.onTextDelta(
                '<wb_render id="l1" title="全局图" mode="replace">flowchart LR\n  A --> B\n</wb_render>' +
                  '这是第一轮的第一段讲解内容。' +
                  '这是第一轮的第二段讲解内容。' +
                  '这是第一轮的第三段讲解内容。'
              );
            } else if (callIdx === 2) {
              // Speculative prefetch chunk 2 that will get buffered then discarded on interrupt
              cb.onTextDelta(
                '<wb_render id="l2-stale" title="被废弃预缓冲" mode="push">flowchart LR\n  X --> Y\n</wb_render>' +
                  '这段是提前缓冲但尚未播报的章节。'
              );
            } else {
              cb.onTextDelta(
                '<wb_render id="l2-fresh" title="按打断新生成" mode="push">flowchart LR\n  B --> Z\n</wb_render>' +
                  '根据你的打断提问重新生成这段解答。<walkthrough_done/>'
              );
            }
            return { stopReason: 'end_turn' };
          }),
          cancel: cancelSpy,
          dispose: vi.fn(),
        },
        contextPackBuilder: { build: vi.fn().mockResolvedValue(SAMPLE_PACK) },
        speech: {
          synthesizeWithFallback: vi.fn(async (text: string) => ({
            audioBase64: Buffer.from(text).toString('base64'),
            mimeType: 'audio/mpeg',
          })),
          transcribe: vi.fn().mockResolvedValue(''),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn().mockResolvedValue({ file: 'src/auth.ts', view: 'source' }),
          toggleViewMode: vi.fn().mockResolvedValue('source'),
          getCurrentViewMode: () => 'source',
          getCurrentLocation: () => undefined,
        },
        comments: { addDraft: vi.fn(), listDrafts: () => [], clear: vi.fn() },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      { ...BASE_CONFIG, autoContinue: true }
    );

    await session.start(SAMPLE_TARGET);
    await new Promise((r) => setTimeout(r, 40));
    const segs = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment);

    // Start seg 1 -> prefetch chunk 2 fills buffer
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: segs[0] });
    await new Promise((r) => setTimeout(r, 40));
    expect(seenPrompts.length).toBe(2);

    // User pauses before finishing seg 1 -> ending seg 1 MUST NOT flush buffered chunk 2 while paused
    await session.handleWebviewMessage({ type: 'playback:paused' });
    await session.handleWebviewMessage({ type: 'playback:segmentEnded', segment: segs[0] });
    expect(sentMessages.filter((m) => m.type === 'audio:enqueue').length).toBe(3);

    // User asks a new question -> discards stale buffer (l2-stale) and regenerates fresh (l2-fresh)
    await session.handleUserQuestion('别讲后面了，直接讲 Z 模块怎么校验', undefined, 'text');
    await new Promise((r) => setTimeout(r, 40));

    expect(seenPrompts.length).toBe(3);
    expect(seenPrompts[2]).not.toContain('l2-stale');
    await session.handleWebviewMessage({ type: 'webview:ready' });
    const latestSync = [...sentMessages]
      .reverse()
      .find((m): m is Extract<HostToWebviewMessage, { type: 'whiteboard:syncStack' }> => m.type === 'whiteboard:syncStack');
    expect(latestSync?.nodes?.some((n) => n.id === 'l2-stale')).toBe(false);

    session.dispose();
  });

  it('replays recorded session timeline cleanly from start or checkpoint without extra LLM/TTS calls or duplicate notes', async () => {
    const sentMessages: HostToWebviewMessage[] = [];
    const navCalls: CodeGotoDirective[] = [];
    const addDraftSpy = vi.fn(() => ({
      id: 'n1',
      file: 'src/auth.ts',
      line: 12,
      severity: 'action' as const,
      body: '补充空值检查',
      createdAt: '2026-11-23T00:00:00Z',
    }));
    const sendPromptSpy = vi.fn(async (_text: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
      cb.onTextDelta(
        '<chapter index="1" total="2" title="第一章 总览"/>' +
          '<wb_render id="l1" title="L1 总览" mode="replace">flowchart LR\n  A --> B\n</wb_render>' +
          '<code_goto file="src/auth.ts" lines="1-5" view="source"/>' +
          '<review_note file="src/auth.ts" line="12" severity="action">补充空值检查</review_note>' +
          '先看第一章整体流程。<chapter index="2" total="2" title="第二章 细节"/>' +
          '<wb_render id="l2" title="L2 细节" mode="push">flowchart TD\n  B --> C\n</wb_render>' +
          '<code_goto file="src/auth.ts" lines="20-25" view="source"/>' +
          '再看第二章局部实现。<walkthrough_done/>'
      );
      return { stopReason: 'end_turn' };
    });
    const synthSpy = vi.fn(async (text: string) => ({
      audioBase64: Buffer.from(text).toString('base64'),
      mimeType: 'audio/mpeg',
    }));

    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            profile: { id: 'agy', name: 'agy', command: 'agy', args: ['acp'] },
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's-replay' },
            configOptions: [],
          }),
          sendPrompt: sendPromptSpy,
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: { build: vi.fn().mockResolvedValue(SAMPLE_PACK) },
        speech: {
          synthesizeWithFallback: synthSpy,
          transcribe: vi.fn().mockResolvedValue(''),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn(async (cmd) => {
            navCalls.push(cmd);
            return { file: cmd.file, lines: cmd.lines, view: cmd.view ?? 'source', label: cmd.label };
          }),
          toggleViewMode: vi.fn().mockResolvedValue('source'),
          getCurrentViewMode: () => 'source',
          getCurrentLocation: () => undefined,
        },
        comments: { addDraft: addDraftSpy, listDrafts: () => [], clear: vi.fn() },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      { ...BASE_CONFIG, autoContinue: false }
    );

    await session.start(SAMPLE_TARGET);
    await new Promise((r) => setTimeout(r, 40));

    const origSegs = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment);
    expect(origSegs.length).toBe(2);

    for (const s of origSegs) {
      await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: s });
      await session.handleWebviewMessage({ type: 'playback:segmentEnded', segment: s });
    }
    await session.handleWebviewMessage({ type: 'playback:queueEmpty', turnId: origSegs[1].turnId });

    expect(sendPromptSpy).toHaveBeenCalledTimes(1);
    expect(synthSpy).toHaveBeenCalledTimes(2);
    expect(addDraftSpy).toHaveBeenCalledTimes(1);

    const replayStatus = [...sentMessages]
      .reverse()
      .find((m): m is Extract<HostToWebviewMessage, { type: 'replay:status' }> => m.type === 'replay:status');
    expect(replayStatus?.status.totalSegments).toBe(2);
    expect(replayStatus?.status.checkpoints.map((c) => c.title)).toEqual([
      '第一章 总览',
      '第二章 细节',
    ]);

    // Trigger replay from checkpoint #2 (index 1) -> restores L1 pre-state first without calling LLM/TTS
    const msgCountBeforeReplay = sentMessages.length;
    await session.handleWebviewMessage({
      type: 'replay:start',
      mode: 'from-index',
      startIndex: 1,
    });

    expect(sendPromptSpy).toHaveBeenCalledTimes(1);
    expect(synthSpy).toHaveBeenCalledTimes(2);

    const replaySlice = sentMessages.slice(msgCountBeforeReplay);
    const syncedPreState = replaySlice.find(
      (m): m is Extract<HostToWebviewMessage, { type: 'whiteboard:syncStack' }> =>
        m.type === 'whiteboard:syncStack'
    );
    expect(syncedPreState?.activeId).toBe('l1');

    const replayedEnqueues = replaySlice
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment);
    expect(replayedEnqueues.length).toBe(1);

    // Playing replayed segment navigates code & pushes L2, without duplicating review notes
    const navCountBefore = navCalls.length;
    await session.handleWebviewMessage({
      type: 'playback:segmentStarted',
      segment: replayedEnqueues[0],
    });
    expect(navCalls.length).toBe(navCountBefore + 1);
    expect(navCalls.at(-1)?.lines).toEqual({ start: 20, end: 25 });
    expect(addDraftSpy).toHaveBeenCalledTimes(1);

    // Stop replay explicitly
    await session.handleWebviewMessage({ type: 'replay:stop' });
    const stoppedStatus = [...sentMessages]
      .reverse()
      .find((m): m is Extract<HostToWebviewMessage, { type: 'replay:status' }> => m.type === 'replay:status');
    expect(stoppedStatus?.status.isReplaying).toBe(false);

    // Replay from start cleanly queues all 2 segments
    await session.handleWebviewMessage({ type: 'replay:start', mode: 'from-start' });
    const allFromStart = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .slice(-2);
    expect(allFromStart.length).toBe(2);
    expect(addDraftSpy).toHaveBeenCalledTimes(1);

    session.dispose();
  });

  it('auto-retries with agent silently on telemetry:mermaidError, updates diagram in place without interrupting audio, and enforces max 2 attempts', async () => {
    const sentMessages: HostToWebviewMessage[] = [];
    const seenPrompts: string[] = [];
    const synthSpy = vi.fn(async (text: string) => ({
      audioBase64: Buffer.from(text).toString('base64'),
      mimeType: 'audio/mpeg',
    }));

    let callIdx = 0;
    const sendPromptSpy = vi.fn(async (promptText: string, cb: AcpPromptCallbacks): Promise<AcpPromptResult> => {
      seenPrompts.push(promptText);
      callIdx += 1;
      if (callIdx === 1) {
        cb.onTextDelta(
          '<wb_render id="l1" title="下单主链路" mode="replace" map=\'{"N2":"src/order.ts:10-18"}\'>' +
            'flowchart TD\n  N1["Start"] --> N2["下单 & 接收回执"]\n</wb_render>' +
            '先看下单主链路。'
        );
      } else {
        // Silent repair response: only outputs <wb_render mode="update" target="l1"> with no spoken prose
        cb.onTextDelta(
          `<wb_render id="l1" target="l1" title="下单主链路" mode="update">flowchart TD\n  N1["Start"] --> N2["下单 & 接收回执"]\n  Note1["📝 每 lane 独立串行 (已修复 v${callIdx})"] -.-> N2\n</wb_render>`
        );
      }
      return { stopReason: 'end_turn' };
    });

    const session = new ReviewSession(
      {
        acpClient: {
          connect: vi.fn().mockResolvedValue({
            profile: { id: 'agy', name: 'agy', command: 'agy', args: ['acp'] },
            initResult: { protocolVersion: 1 },
            sessionResult: { sessionId: 's-mermaid-repair' },
            configOptions: [],
          }),
          sendPrompt: sendPromptSpy,
          cancel: vi.fn(),
          dispose: vi.fn(),
        },
        contextPackBuilder: { build: vi.fn().mockResolvedValue(SAMPLE_PACK) },
        speech: {
          synthesizeWithFallback: synthSpy,
          transcribe: vi.fn().mockResolvedValue(''),
        },
        whiteboard: {
          openOrReveal: vi.fn(),
          popOutToWindow: vi.fn().mockResolvedValue(undefined),
          postMessage: (msg) => sentMessages.push(msg),
        },
        codeNavigator: {
          navigateTo: vi.fn().mockResolvedValue({ file: 'src/order.ts', view: 'source' }),
          toggleViewMode: vi.fn().mockResolvedValue('source'),
          getCurrentViewMode: () => 'source',
          getCurrentLocation: () => undefined,
        },
        comments: { addDraft: vi.fn(), listDrafts: () => [], clear: vi.fn() },
        actions: {
          onSwitchTarget: vi.fn().mockResolvedValue(undefined),
          onPublishOrExportNotes: vi.fn().mockResolvedValue(undefined),
        },
      },
      BASE_CONFIG
    );

    await session.start(SAMPLE_TARGET);
    await new Promise((r) => setTimeout(r, 40));

    const seg1 = sentMessages
      .filter((m): m is Extract<HostToWebviewMessage, { type: 'audio:enqueue' }> => m.type === 'audio:enqueue')
      .map((m) => m.payload.segment)[0];
    await session.handleWebviewMessage({ type: 'playback:segmentStarted', segment: seg1 });

    const clearsBefore = sentMessages.filter((m) => m.type === 'audio:clear').length;
    const synthBefore = synthSpy.mock.calls.length;

    // Webview hits Mermaid parse error -> triggers silent Agent repair
    await session.handleWebviewMessage({
      type: 'telemetry:mermaidError',
      diagramId: 'l1',
      error: 'Parse error on line 3: unexpected Note',
      mermaidCode: 'flowchart TD\n  N1 --> N2\n  Note right of N2: 每 lane',
    });
    await new Promise((r) => setTimeout(r, 40));

    expect(sendPromptSpy).toHaveBeenCalledTimes(2);
    expect(seenPrompts[1]).toContain('系统自动语法修复请求');
    expect(seenPrompts[1]).toContain('id="l1"');
    expect(seenPrompts[1]).toContain('Parse error on line 3');

    // No audio interruption & no extra TTS calls
    expect(sentMessages.filter((m) => m.type === 'audio:clear').length).toBe(clearsBefore);
    expect(synthSpy).toHaveBeenCalledTimes(synthBefore);

    const syncedAfterRepair1 = [...sentMessages]
      .reverse()
      .find(
        (m): m is Extract<HostToWebviewMessage, { type: 'whiteboard:syncStack' }> =>
          m.type === 'whiteboard:syncStack'
      );
    expect(syncedAfterRepair1?.nodes?.length).toBe(1);
    expect(syncedAfterRepair1?.nodes?.[0]).toMatchObject({
      id: 'l1',
      revision: 2,
      nodeCodeMap: { N2: 'src/order.ts:10-18' },
    });
    expect(syncedAfterRepair1?.nodes?.[0].mermaidCode).toContain('已修复 v2');

    // 2nd error still retries once; 3rd error is capped at MAX_MERMAID_REPAIR_ATTEMPTS = 2
    await session.handleWebviewMessage({
      type: 'telemetry:mermaidError',
      diagramId: 'l1',
      error: 'Another error',
      mermaidCode: 'flowchart TD\n  bad',
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(sendPromptSpy).toHaveBeenCalledTimes(3);

    await session.handleWebviewMessage({
      type: 'telemetry:mermaidError',
      diagramId: 'l1',
      error: 'Third error should stop',
      mermaidCode: 'flowchart TD\n  bad',
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(sendPromptSpy).toHaveBeenCalledTimes(3);

    session.dispose();
  });

  it('frames PR diff and branch review prompts around end-to-end Story line-by-line walkthroughs', () => {
    const diffSystem = buildWalkthroughSystemPrompt();
    expect(diffSystem).toContain('Story / Feature');
    expect(diffSystem).toContain('未修改代码');
    expect(diffSystem).toContain('重点逐行串讲');
    expect(diffSystem).toContain('自动跳入关键子方法');
    expect(diffSystem).toContain('<walkthrough_done/>');

    const diffInit = buildInitialWalkthroughPrompt('## Summary');
    expect(diffInit).toContain('Story / Feature 主线');
    expect(diffInit).toContain('未改部分简略串联');
    expect(diffInit).toContain('2~8 行');

    const branchSystem = buildBranchExploreSystemPrompt();
    expect(branchSystem).toContain('Story / Feature');
    expect(branchSystem).toContain('外围桥接/辅助样板代码');
    expect(branchSystem).toContain('重点逐行串讲');
    expect(branchSystem).toContain('自动跳入关键子方法');

    const branchInitTargeted = buildBranchExploreInitialPrompt('## Repo', '审查下单幂等流程');
    expect(branchInitTargeted).toContain('Story / Feature 执行链路');
    expect(branchInitTargeted).toContain('外围简略串联 -> 核心代码逐行深讲');

    const branchInitOverview = buildBranchExploreInitialPrompt('## Repo');
    expect(branchInitOverview).toContain('Story 主链路');
    expect(branchInitOverview).toContain('2~8 行');

    const diffAutoContinue = buildAutoContinuePrompt({
      mode: 'diff',
      lastEditorFile: 'src/order.ts',
      lastEditorLines: { start: 20, end: 26 },
      chunkNumber: 2,
    });
    expect(diffAutoContinue).toContain('PR Story / Feature 主链路');
    expect(diffAutoContinue).toContain('未改简略、已改逐行深讲');
    expect(diffAutoContinue).toContain('自动跳入关键子方法');

    const branchAutoContinue = buildAutoContinuePrompt({
      mode: 'branch-explore',
      lastEditorFile: 'src/order.ts',
      lastEditorLines: { start: 20, end: 26 },
      chunkNumber: 3,
    });
    expect(branchAutoContinue).toContain('Story / Feature 执行链路');
    expect(branchAutoContinue).toContain('外围桥接/样板逻辑');
    expect(branchAutoContinue).toContain('2~8 行');

    const interruptionDiff = buildInterruptionPrompt(
      {
        turnId: 1,
        spokenAlready: '刚刚看到这里',
        unspokenCutOff: '',
        diagramId: 'overview',
        stackPath: 'overview',
      },
      '继续',
      undefined,
      'diff'
    );
    expect(interruptionDiff).toContain('PR Story 执行链路');
    expect(interruptionDiff).toContain('2~8 行');

    const interruptionBranch = buildInterruptionPrompt(
      {
        turnId: 2,
        spokenAlready: '刚刚看到这里',
        unspokenCutOff: '',
        diagramId: 'overview',
        stackPath: 'overview',
      },
      '继续',
      undefined,
      'branch-explore'
    );
    expect(interruptionBranch).toContain('Story / Feature 执行链路');

    const followUpDiff = buildUserFollowUpPrompt('继续往下', {
      diagramId: 'overview',
      mode: 'diff',
    });
    expect(followUpDiff).toContain('PR Story 逐行串讲');

    const followUpBranch = buildUserFollowUpPrompt('继续往下', {
      diagramId: 'overview',
      mode: 'branch-explore',
    });
    expect(followUpBranch).toContain('Story 逐行串讲');

    const formattedDiffPack = formatContextPackForPrompt({
      target: {
        kind: 'local-diff',
        repoRoot: '/tmp/repo',
        baseRef: 'main',
        effectiveBaseRef: 'main',
        headRef: 'HEAD',
        title: 'Local Diff',
        subtitle: 'main..HEAD',
      },
      generatedAt: '2026-11-23T00:00:00Z',
      commits: [],
      totalFilesChanged: 1,
      includedFilesCount: 1,
      ignoredFilesCount: 0,
      totalAdditions: 5,
      totalDeletions: 2,
      files: [],
      moduleClusters: [
        {
          moduleGroup: 'core',
          fileCount: 1,
          additions: 5,
          deletions: 2,
          files: ['src/order.ts'],
        },
      ],
      chapters: [
        {
          index: 1,
          title: 'Core Flow',
          moduleGroup: 'core',
          summary: '1 file',
          files: ['src/order.ts'],
        },
      ],
    });
    expect(formattedDiffPack).toContain(
      'Recommended Walkthrough Chapters (Organize as an End-to-End Story / Feature)'
    );

    const formattedBranchPack = formatContextPackForPrompt({
      target: {
        kind: 'branch-explore',
        repoRoot: '/tmp/repo',
        branchName: 'main',
        baseRef: 'HEAD',
        effectiveBaseRef: 'HEAD',
        headRef: 'HEAD',
        title: 'Current Branch',
        subtitle: 'main',
        startMode: 'auto-overview',
      },
      generatedAt: '2026-11-23T00:00:00Z',
      commits: [],
      totalFilesChanged: 1,
      includedFilesCount: 1,
      ignoredFilesCount: 0,
      totalAdditions: 0,
      totalDeletions: 0,
      files: [],
      moduleClusters: [],
      chapters: [
        {
          index: 1,
          title: 'Entry',
          moduleGroup: 'src',
          summary: '1 file',
          files: ['src/index.ts'],
        },
      ],
      repoOverview: {
        branchName: 'main',
        totalTrackedFiles: 1,
        includedFiles: 1,
        ignoredFiles: 0,
        directorySummaries: ['src (1 file)'],
        keyDocs: [],
        workingTreeChanges: [],
      },
    });
    expect(formattedBranchPack).toContain('end-to-end Story / Feature flow');
  });
});
