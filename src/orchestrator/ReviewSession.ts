import type { AcpClientManager, AcpConnectOptions } from '../acp/AcpClientManager';
import type { AcpModelResolution, AcpProfile, AcpToolActivityInfo } from '../acp/types';
import { ContextPackBuilder, formatContextPackForPrompt } from '../context/ContextPackBuilder';
import type { ReviewContextPack, ReviewTarget } from '../context/types';
import type { UsageLogger } from '../telemetry/UsageLogger';
import type {
  AgentActivityFileEntry,
  AgentActivityStage,
  AgentActivityState,
  AudioSegmentPayload,
  CallChainState,
  ChapterProgress,
  CodeGotoDirective,
  CodeViewMode,
  DiagramStackItem,
  Directive,
  EditorLocationState,
  HostToWebviewMessage,
  InterruptionSnapshot,
  LineRange,
  ReplayCheckpoint,
  ReplayStatusState,
  ReviewNoteDraft,
  SessionMetaState,
  SessionPhase,
  UtteranceSegment,
  VoiceMode,
  WbRenderDirective,
  WebviewPlaybackCutoff,
  WebviewToHostMessage,
} from '../shared/protocol';
import { normalizeTextForTts } from '../speech/textNormalizer';
import { WhisperModelMissingError } from '../speech/stt/SystemNativeStt';
import type { TtsAudioResult, TtsOptions } from '../speech/types';
import type { CallChainResolver } from '../vscode-ui/CallChainResolver';
import { clampHighlightRange } from '../vscode-ui/highlightRange';
import { DirectiveParser, sanitizeMermaidCode } from './DirectiveParser';
import { matchActiveCallChainNode } from './callChainUtils';
import {
  buildAutoContinuePrompt,
  buildBranchExploreInitialPrompt,
  buildBranchExploreSystemPrompt,
  buildCorePathLineReviewInitialPrompt,
  buildCorePathLineReviewSystemPrompt,
  buildInitialWalkthroughPrompt,
  buildInterruptionPrompt,
  buildMermaidRepairPrompt,
  buildUserFollowUpPrompt,
  buildWalkthroughSystemPrompt,
} from './PromptTemplates';
import {
  applyWhiteboardDirective,
  createEmptyWhiteboardTree,
  deriveActivePath,
  formatWhiteboardTreeOutline,
  getActiveDiagram as getActiveTreeDiagram,
  selectWhiteboardIndex,
  selectWhiteboardLayer,
  type WhiteboardTreeState,
} from '../shared/whiteboardTree';

export interface ReviewSessionRuntimeConfig {
  acpProfile: AcpProfile;
  thoughtLevel: 'low' | 'medium' | 'high';
  preferredModel?: string;
  ttsVoice: string;
  ttsRate: number;
  sttLocale: string;
  voiceMode: VoiceMode;
  vadBargeInMs: number;
  vadSilenceMs: number;
  maxContextChars: number;
  ignorePatterns: string[];
  autoContinue?: boolean;
}

export interface ReviewSessionDependencies {
  acpClient: Pick<AcpClientManager, 'connect' | 'sendPrompt' | 'cancel' | 'dispose'>;
  contextPackBuilder: Pick<ContextPackBuilder, 'build'>;
  speech: {
    synthesizeWithFallback: (
      text: string,
      options: TtsOptions,
      onFallbackWarning?: (msg: string) => void
    ) => Promise<TtsAudioResult>;
    transcribe: (audioWav: Buffer, locale: string, signal?: AbortSignal) => Promise<string>;
    checkSttReadiness?: () => Promise<{ ready: boolean; reason?: string }>;
  };
  mic?: {
    start: (
      callbacks: {
        onLevel: (level: number) => void;
        onUserSpeakingChange: (speaking: boolean) => void;
        onBargeIn: () => void;
        onUtteranceReady: (wavBuf: Buffer) => void;
        onSilentInputWarning: () => void;
        onError: (message: string) => void;
      },
      options: {
        voiceMode: VoiceMode;
        vadBargeInMs: number;
        vadSilenceMs: number;
      }
    ) => Promise<{ backend: string }>;
    stop: () => void;
    isActive: () => boolean;
    setVoiceMode: (mode: VoiceMode) => void;
    setAssistantSpeaking: (speaking: boolean) => void;
    setVadConfig: (bargeInMs: number, silenceMs: number) => void;
    startPtt: () => void;
    endPtt: () => void;
  };
  whiteboard: {
    openOrReveal: () => void;
    popOutToWindow: () => Promise<void>;
    postMessage: (msg: HostToWebviewMessage) => void;
    getPoppedOut?: () => boolean;
  };
  codeNavigator: {
    navigateTo: (
      cmd: CodeGotoDirective,
      target: ReviewTarget,
      options?: { preferWorkspaceFile?: boolean; preferredLines?: LineRange }
    ) => Promise<EditorLocationState>;
    toggleViewMode: (target: ReviewTarget | undefined) => Promise<CodeViewMode>;
    getCurrentViewMode: () => CodeViewMode;
    getCurrentLocation: () => EditorLocationState | undefined;
  };
  comments: {
    addDraft: (
      note: {
        file: string;
        line: number;
        severity: 'info' | 'warning' | 'issue' | 'action';
        body: string;
      },
      target: ReviewTarget
    ) => ReviewNoteDraft;
    removeDraft?: (id: string) => boolean;
    listDrafts: () => ReviewNoteDraft[];
    clear: () => void;
  };
  callChainResolver?: Pick<
    CallChainResolver,
    'calibrateCallChain' | 'findIncomingCallers' | 'buildLspFallbackChain'
  >;
  actions: {
    onSwitchTarget: () => Promise<void>;
    onStartBranchExplore?: () => Promise<void>;
    onStartCorePathReview?: () => Promise<void>;
    onAutoStartBranchExplore?: (initialInstruction: string) => Promise<void>;
    getActiveEditorRelPath?: (repoRoot: string) => string | undefined;
    onPublishOrExportNotes: () => Promise<void>;
    onPhaseChanged?: (
      phase: SessionPhase,
      targetTitle?: string,
      activitySummary?: string
    ) => void;
    onSttModelMissing?: () => void;
    onEnsureVoiceDependencies?: (
      reason: 'mic_cli_missing' | 'whisper_model_missing' | 'stt_engine_missing'
    ) => Promise<boolean>;
  };
  logger?: Pick<UsageLogger, 'startSession' | 'log' | 'flush'>;
}

interface TurnSynthesisEntry {
  segment: UtteranceSegment;
  promise: Promise<TtsAudioResult>;
}

interface ReplayPreStateSnapshot {
  diagramTree: WhiteboardTreeState;
  callChain: CallChainState | null;
  chapter?: ChapterProgress;
}

interface PrefetchedChunk {
  payloads: AudioSegmentPayload[];
  walkthroughDone: boolean;
}

interface ReplayTimelineEntry {
  index: number;
  groupId: number;
  groupTitle: string;
  payload: AudioSegmentPayload;
  preState: ReplayPreStateSnapshot;
}

const MAX_TTS_CONCURRENCY = 2;
const PREFETCH_MAX_BUFFERED_CHUNKS = 1;
const PREFETCH_FLUSH_LOW_WATERMARK = 2;
const MAX_AUTO_CONTINUE_CHUNKS = 8;
const MAX_MERMAID_REPAIR_ATTEMPTS = 2;

export class ReviewSession {
  private target: ReviewTarget | undefined;
  private contextPack: ReviewContextPack | undefined;
  private config: ReviewSessionRuntimeConfig;

  private phase: SessionPhase = 'idle';
  private activeTurnId = 0;
  private activeTurnAbort: AbortController | null = null;
  private promptRunning = false;
  private paused = false;
  private ttsMuted = false;
  private voiceMode: VoiceMode;
  private autoContinueEnabled: boolean;

  private parser = new DirectiveParser(0);
  private diagramTree: WhiteboardTreeState = createEmptyWhiteboardTree();
  private diagramArchive: DiagramStackItem[] = [];
  private currentCallChain: CallChainState | null = null;
  private callChainSeq = 0;
  private currentChapter: ChapterProgress | undefined;
  private selectedNodeId: string | undefined;
  private activeModelResolution: AcpModelResolution | undefined;
  private manualEditorLocation: EditorLocationState | undefined;

  // Turn tracking for exact barge-in snapshots
  private turnSegments: UtteranceSegment[] = [];
  private playedSegmentIds = new Set<string>();
  private currentPlayingSegment: UtteranceSegment | undefined;
  private currentSegmentStartedAtMs = 0;
  private pendingInterruption: InterruptionSnapshot | undefined;
  private enqueuedSegmentCount = 0;

  // Lookahead prefetch buffer for continuous auto-advance
  private walkthroughDone = false;
  private autoContinueCount = 0;
  private autoContinueChunkSeq = 0;
  private prefetchRunning = false;
  private prefetchAbort: AbortController | null = null;
  private prefetchGeneration = 0;
  private prefetchChunks: PrefetchedChunk[] = [];

  // Synchronized timeline & replay state
  private replayShadowTree: WhiteboardTreeState = createEmptyWhiteboardTree();
  private replayShadowCallChain: CallChainState | null = null;
  private replayShadowChapter: ChapterProgress | undefined;
  private replayTimeline: ReplayTimelineEntry[] = [];
  private replayGroupSeq = 0;
  private isReplaying = false;
  private replayCurrentIndex = -1;

  // Silent Mermaid syntax auto-repair state
  private mermaidRepairRunning = false;
  private mermaidRepairAbort: AbortController | null = null;
  private mermaidRepairGeneration = 0;
  private mermaidRepairAttempts = new Map<string, number>();
  private pendingMermaidRepair: {
    diagramId: string;
    error: string;
    mermaidCode: string;
  } | null = null;

  // Extension Host native microphone tracking
  private micActive = false;
  private micUserSpeaking = false;
  private micBackend: string | undefined;
  private promptedSttSetup = false;
  private announcedMicReady = false;

  // Live agent activity telemetry for Webview & VS Code status bar
  private activity: AgentActivityState = createIdleActivityState();
  private thoughtTail = '';
  private lastActivityEmitMs = 0;
  private activityEmitTimer: NodeJS.Timeout | null = null;
  private activityLogSeq = 0;
  private turnReadFilePaths = new Set<string>();
  private lastStatusBarSummary = '';
  private pendingBranchContextIntro = false;
  private autoStartingBranch = false;

  constructor(
    private readonly deps: ReviewSessionDependencies,
    initialConfig: ReviewSessionRuntimeConfig
  ) {
    this.config = initialConfig;
    this.voiceMode = initialConfig.voiceMode;
    this.autoContinueEnabled = initialConfig.autoContinue ?? true;
  }

  public get currentTarget(): ReviewTarget | undefined {
    return this.target;
  }

  private isCorePathLineReviewTarget(target = this.target): boolean {
    return (
      target?.kind === 'branch-explore' &&
      target.startMode === 'core-path-line-review'
    );
  }

  public get currentContextPack(): ReviewContextPack | undefined {
    return this.contextPack;
  }

  public get collectedDiagrams(): DiagramStackItem[] {
    return [...this.diagramArchive];
  }

  public updateConfig(next: ReviewSessionRuntimeConfig): void {
    this.config = next;
    this.voiceMode = next.voiceMode;
    if (next.autoContinue !== undefined) {
      this.autoContinueEnabled = next.autoContinue;
    }
    this.deps.mic?.setVoiceMode(this.voiceMode);
    this.deps.mic?.setVadConfig(next.vadBargeInMs, next.vadSilenceMs);
    this.emitSessionState(this.phase);
  }

  public togglePause(): void {
    if (
      this.phase !== 'speaking' &&
      this.phase !== 'paused' &&
      !this.currentPlayingSegment
    ) {
      return;
    }
    this.paused = !this.paused;
    this.deps.whiteboard.postMessage({
      type: 'audio:setPaused',
      paused: this.paused,
    });
  }

  public async start(target: ReviewTarget): Promise<void> {
    this.stopCurrentPlaybackAndPrompt();
    this.deps.comments.clear();

    this.target = target;
    this.diagramTree = createEmptyWhiteboardTree();
    this.diagramArchive = [];
    this.currentCallChain = null;
    this.callChainSeq += 1;
    this.currentChapter = undefined;
    this.selectedNodeId = undefined;
    this.pendingInterruption = undefined;
    this.activeModelResolution = undefined;
    this.manualEditorLocation = undefined;
    this.pendingBranchContextIntro = false;
    this.walkthroughDone = false;
    this.autoContinueCount = 0;
    this.autoContinueChunkSeq = 0;
    this.enqueuedSegmentCount = 0;
    this.prefetchChunks = [];
    this.replayShadowTree = createEmptyWhiteboardTree();
    this.replayShadowCallChain = null;
    this.replayShadowChapter = undefined;
    this.replayTimeline = [];
    this.replayGroupSeq = 0;
    this.isReplaying = false;
    this.replayCurrentIndex = -1;
    this.mermaidRepairAttempts.clear();
    this.pendingMermaidRepair = null;

    const isBranchExplore = target.kind === 'branch-explore';
    const isCorePathReview = this.isCorePathLineReviewTarget(target);

    // Start UsageLogger BEFORE opening Webview so early webview:ready belongs to this session
    this.deps.logger?.startSession({
      targetKind: target.kind,
      startMode: isBranchExplore ? target.startMode : undefined,
      targetTitle: target.title,
      acpProfile: this.config.acpProfile.id,
      preferredModel: this.config.preferredModel,
      thoughtLevel: this.config.thoughtLevel,
      voiceMode: this.voiceMode,
    });

    this.deps.whiteboard.openOrReveal();
    this.resetActivity(
      'analyzing',
      isCorePathReview
        ? '正在定位输入入口与核心链路源码...'
        : isBranchExplore
          ? '正在扫描当前分支项目结构与核心文档...'
          : '正在解析 Git Diff 与类/方法索引...',
      target.title,
      isCorePathReview
        ? `开始核心链路逐行 Review：${target.title}`
        : isBranchExplore
          ? `开始扫描当前分支项目：${target.title}`
          : `开始解析变更上下文：${target.title}`
    );
    this.setPhase(
      'analyzing',
      isCorePathReview && target.kind === 'branch-explore'
        ? `正在定位核心链路源码：${target.branchName}...`
        : target.kind === 'branch-explore'
          ? `正在扫描当前分支：${target.branchName}...`
          : `正在分析变更上下文：${target.title}...`
    );

    const packStartMs = Date.now();
    this.contextPack = await this.deps.contextPackBuilder.build(target, {
      maxContextChars: this.config.maxContextChars,
      ignorePatterns: this.config.ignorePatterns,
      activeEditorFile: this.deps.actions.getActiveEditorRelPath?.(target.repoRoot),
    });
    const contextPackBuildMs = Date.now() - packStartMs;

    this.deps.logger?.log('context.pack_built', {
      targetKind: target.kind,
      totalFilesChanged: this.contextPack.totalFilesChanged,
      includedFilesCount: this.contextPack.includedFilesCount,
      ignoredFilesCount: this.contextPack.ignoredFilesCount,
      totalAdditions: this.contextPack.totalAdditions,
      totalDeletions: this.contextPack.totalDeletions,
      trackedFiles: this.contextPack.repoOverview?.totalTrackedFiles,
      contextPackBuildMs,
    });

    const connectingDetail =
      target.kind === 'branch-explore'
        ? `分支 ${target.branchName} · ${this.contextPack.includedFilesCount} 个源码文件`
        : `${this.contextPack.includedFilesCount} 个文件 (+${this.contextPack.totalAdditions}/-${this.contextPack.totalDeletions})`;
    const contextReadyLog =
      target.kind === 'branch-explore'
        ? `项目上下文就绪：分支 ${target.branchName}，${this.contextPack.includedFilesCount} 个索引文件 (${contextPackBuildMs}ms)`
        : `上下文包就绪：${this.contextPack.includedFilesCount} 个文件，+${this.contextPack.totalAdditions}/-${this.contextPack.totalDeletions} (${contextPackBuildMs}ms)`;

    this.updateActivity(
      {
        stage: 'connecting',
        headline: `正在连接 ACP (${this.config.acpProfile.displayName})...`,
        detail: connectingDetail,
      },
      {
        logText: contextReadyLog,
        force: true,
        statusBarSummary: '连接 ACP...',
      }
    );
    this.setPhase('connecting', `正在连接 ACP Harness (${this.config.acpProfile.displayName})...`);

    const connectOpts: AcpConnectOptions = {
      cwd: target.repoRoot,
      profile: this.config.acpProfile,
      systemPromptAppend: isCorePathReview
        ? buildCorePathLineReviewSystemPrompt()
        : isBranchExplore
          ? buildBranchExploreSystemPrompt()
          : buildWalkthroughSystemPrompt(),
      thoughtLevel: this.config.thoughtLevel,
      preferredModel: this.config.preferredModel,
      allowMutations: false,
    };

    const connectStartMs = Date.now();
    const connectResult = (await this.deps.acpClient.connect(connectOpts)) as {
      modelResolution?: AcpModelResolution;
    };
    const connectMs = Date.now() - connectStartMs;
    this.activeModelResolution = connectResult?.modelResolution;

    this.deps.logger?.log('acp.connect', {
      connectMs,
      profile: this.config.acpProfile.id,
      modelResolution: this.activeModelResolution,
    });

    const resolvedModelLabel = this.activeModelResolution
      ? `${this.activeModelResolution.resolvedModel} (${this.activeModelResolution.resolvedThoughtLevel})`
      : this.config.acpProfile.displayName;
    this.updateActivity(
      {
        stage: 'thinking',
        headline: `ACP 已连接 (${resolvedModelLabel})，准备生成导读...`,
        detail: `连接耗时 ${connectMs}ms`,
      },
      {
        logText: `已连接 ${resolvedModelLabel} (${connectMs}ms)`,
        force: true,
      }
    );

    if (
      this.activeModelResolution?.requestedModel &&
      !this.activeModelResolution.matchedRequestedModel
    ) {
      this.deps.whiteboard.postMessage({
        type: 'notice:toast',
        level: 'warn',
        message: `未在当前 ACP Harness 找到模型 "${this.activeModelResolution.requestedModel}"，已自动使用 "${this.activeModelResolution.resolvedModel}" (effort=${this.activeModelResolution.resolvedThoughtLevel})。`,
      });
    }

    this.emitSessionState(this.phase);
    this.postSyncWhiteboardTree();
    this.emitReplayStatus();
    this.deps.whiteboard.postMessage({ type: 'callChain:sync', chain: null });
    this.deps.whiteboard.postMessage({ type: 'notes:sync', notes: [] });

    if (target.kind === 'branch-explore' && target.startMode === 'standby') {
      this.pendingBranchContextIntro = true;
      this.updateActivity(
        {
          stage: 'idle',
          headline: '已连接当前分支，请直接语音或打字下达指令',
          detail: target.branchName,
        },
        {
          logText: `当前分支待命就绪 (${resolvedModelLabel})`,
          force: true,
          statusBarSummary: '',
        }
      );
      this.setPhase('idle', '已连接当前分支，请直接开口或输入你想 Review / 了解的内容');
      this.deps.whiteboard.postMessage({
        type: 'subtitle:update',
        text: `已连接到当前分支 ${target.branchName}，请直接开口或打字告诉我你想 Review 或了解哪块代码。`,
        isSpeaking: false,
      });
      return;
    }

    const packMd = formatContextPackForPrompt(
      this.contextPack,
      this.config.maxContextChars + 4000
    );
    const initialPrompt = isCorePathReview
      ? buildCorePathLineReviewInitialPrompt(
          packMd,
          target.kind === 'branch-explore' ? (target.initialInstruction ?? '') : '',
          target.kind === 'branch-explore' ? target.entryHint : undefined
        )
      : target.kind === 'branch-explore'
        ? buildBranchExploreInitialPrompt(packMd, target.initialInstruction)
        : buildInitialWalkthroughPrompt(packMd);
    await this.runAcpTurn(initialPrompt, 'initial');
  }

  public async handleWebviewMessage(msg: WebviewToHostMessage): Promise<void> {
    switch (msg.type) {
      case 'webview:ready': {
        this.deps.logger?.log('webview.ready', {
          phase: this.phase,
          stackDepth: this.diagramTree.nodes.length,
        });
        this.emitSessionState(this.phase);
        this.postSyncWhiteboardTree();
        this.emitReplayStatus();
        this.deps.whiteboard.postMessage({
          type: 'callChain:sync',
          chain: this.currentCallChain,
        });
        if (this.currentChapter) {
          this.deps.whiteboard.postMessage({
            type: 'chapter:update',
            chapter: this.currentChapter,
          });
        }
        this.deps.whiteboard.postMessage({
          type: 'notes:sync',
          notes: this.deps.comments.listDrafts(),
        });
        this.deps.whiteboard.postMessage({
          type: 'activity:update',
          activity: this.cloneActivity(),
        });
        this.emitMicState(0);
        return;
      }

      case 'playback:segmentStarted': {
        if (msg.segment.turnId !== this.activeTurnId) {
          return;
        }
        this.currentPlayingSegment = msg.segment;
        this.currentSegmentStartedAtMs = Date.now();
        const playedCount = this.activity.counters.segmentsPlayed + 1;
        this.activity.counters.segmentsPlayed = playedCount;
        if (this.isReplaying) {
          const idxMatch = msg.segment.segmentId.match(/^replay-\d+-(\d+)$/);
          if (idxMatch) {
            this.replayCurrentIndex = Number.parseInt(idxMatch[1], 10);
            this.emitReplayStatus();
          }
          this.recordWhiteboardDirectives(msg.segment.directivesBefore);
        }
        if (msg.segment.spokenText) {
          this.setPhase('speaking');
          this.deps.whiteboard.postMessage({
            type: 'subtitle:update',
            text: msg.segment.spokenText,
            isSpeaking: true,
          });
        }
        this.deps.logger?.log(
          'playback.segment_started',
          {
            segmentId: msg.segment.segmentId,
            textLen: msg.segment.spokenText.length,
            isReplay: this.isReplaying,
            directivesBefore: msg.segment.directivesBefore.map((d) =>
              d.type === 'code_goto'
                ? { type: d.type, file: d.file, lines: d.lines, view: d.view }
                : d.type === 'wb_focus'
                  ? { type: d.type, id: d.id, edge: d.edge }
                  : { type: d.type }
            ),
          },
          msg.segment.turnId
        );
        await this.applyHostDirectives(msg.segment.directivesBefore, {
          isReplay: this.isReplaying,
        });
        const totalPlanned = Math.max(this.activity.counters.segmentsParsed, playedCount);
        const speakDetail =
          this.currentChapter?.title ||
          this.getActiveEditorLocation()?.file ||
          msg.segment.spokenText.slice(0, 48);
        this.updateActivity(
          {
            stage: this.activity.stage === 'audio_blocked' ? 'audio_blocked' : 'speaking',
            headline: this.isReplaying
              ? `重放同步中 (${playedCount}/${totalPlanned} 段)`
              : this.activity.stage === 'audio_blocked'
                ? `字幕同步推进中 (${playedCount}/${totalPlanned} 段 · 点击白板解锁语音)`
                : `正在同步讲解 (${playedCount}/${totalPlanned} 段)`,
            detail: speakDetail,
            currentFile: this.getActiveEditorLocation()?.file,
          },
          {
            force: true,
            statusBarSummary: `${this.isReplaying ? '重放' : '讲解'} ${playedCount}/${totalPlanned} 段`,
          }
        );
        if (!this.isReplaying && !this.paused && !this.promptRunning) {
          if (this.remainingUnplayedInWebview() <= PREFETCH_FLUSH_LOW_WATERMARK) {
            this.flushNextPrefetchedChunk();
          }
          this.maybeStartPrefetch();
        }
        return;
      }

      case 'playback:segmentEnded': {
        if (msg.segment.turnId !== this.activeTurnId) {
          return;
        }
        this.playedSegmentIds.add(msg.segment.segmentId);
        if (this.currentPlayingSegment?.segmentId === msg.segment.segmentId) {
          this.currentPlayingSegment = undefined;
        }
        if (this.isReplaying) {
          this.recordWhiteboardDirectives(msg.segment.directivesAfter);
        }
        await this.applyHostDirectives(msg.segment.directivesAfter, {
          isReplay: this.isReplaying,
        });
        if (!this.isReplaying && !this.paused && !this.promptRunning) {
          if (this.remainingUnplayedInWebview() <= PREFETCH_FLUSH_LOW_WATERMARK) {
            this.flushNextPrefetchedChunk();
          }
          this.maybeStartPrefetch();
        }
        return;
      }

      case 'playback:queueEmpty': {
        if (msg.turnId !== this.activeTurnId) {
          return;
        }
        this.paused = false;
        this.deps.whiteboard.postMessage({
          type: 'subtitle:update',
          text: '',
          isSpeaking: false,
        });
        if (this.isReplaying) {
          this.isReplaying = false;
          this.replayCurrentIndex = -1;
          this.emitReplayStatus();
          this.setPhase('idle', '重放完成，可随时提问或再次重放');
          this.updateActivity(
            {
              stage: 'idle',
              headline: '重放完成，可随时提问或再次重放',
              detail: undefined,
              currentFile: undefined,
            },
            {
              logText: '同步重放完成',
              force: true,
              statusBarSummary: '',
            }
          );
          return;
        }
        if (!this.promptRunning) {
          if (!this.paused && this.flushNextPrefetchedChunk()) {
            return;
          }
          if (!this.paused && this.prefetchRunning) {
            this.setPhase('thinking', '正在衔接下一章节...');
            this.updateActivity(
              {
                stage: 'thinking',
                headline: '正在衔接下一章节...',
                detail: undefined,
                currentFile: undefined,
              },
              {
                statusBarSummary: '衔接下一章...',
              }
            );
            return;
          }
          if (!this.paused && this.canAutoContinue()) {
            this.setPhase('thinking', '正在生成下一章节...');
            this.updateActivity(
              {
                stage: 'thinking',
                headline: '正在生成下一章节...',
                detail: undefined,
                currentFile: undefined,
              },
              {
                statusBarSummary: '准备下一章...',
              }
            );
            this.maybeStartPrefetch(true);
            return;
          }
          if (this.phase === 'speaking' || this.phase === 'paused' || this.phase === 'thinking') {
            this.setPhase('idle', '等待你的提问，可随时直接开口或点击白板节点');
            this.updateActivity(
              {
                stage: 'idle',
                headline: '本轮导读完成，可随时提问或点击白板节点',
                detail: undefined,
                currentFile: undefined,
              },
              {
                logText: '本轮导读播报完成',
                force: true,
                statusBarSummary: '',
              }
            );
          }
        }
        return;
      }

      case 'playback:paused': {
        this.paused = true;
        this.setPhase('paused', '讲解已暂停，可安心阅读源码');
        this.updateActivity(
          {
            stage: 'paused',
            headline: '讲解已暂停，可安心阅读源码（点击「继续讲解」恢复）',
          },
          {
            logText: '讲解已暂停',
            force: true,
            statusBarSummary: '已暂停 · 看源码',
          }
        );
        this.deps.logger?.log('ui.interaction', { action: 'playback_paused' });
        return;
      }

      case 'playback:resumed': {
        this.paused = false;
        const hasRemaining =
          Boolean(this.currentPlayingSegment) ||
          this.turnSegments.some(
            (s) => s.turnId === this.activeTurnId && !this.playedSegmentIds.has(s.segmentId)
          );
        if (hasRemaining) {
          this.setPhase('speaking');
          this.updateActivity(
            {
              stage: this.activity.stage === 'audio_blocked' ? 'audio_blocked' : 'speaking',
              headline: '已恢复同步讲解',
            },
            {
              logText: '恢复同步讲解',
              force: true,
              statusBarSummary: '继续讲解',
            }
          );
          if (!this.isReplaying && !this.promptRunning) {
            if (this.remainingUnplayedInWebview() <= PREFETCH_FLUSH_LOW_WATERMARK) {
              this.flushNextPrefetchedChunk();
            }
            this.maybeStartPrefetch();
          }
        } else if (!this.isReplaying && !this.promptRunning && this.flushNextPrefetchedChunk()) {
          this.setPhase('speaking');
        } else {
          this.setPhase('idle', '等待你的提问，可随时直接开口或点击白板节点');
          this.updateActivity(
            {
              stage: 'idle',
              headline: '本轮导读完成，可随时提问或点击白板节点',
            },
            { force: true, statusBarSummary: '' }
          );
        }
        this.deps.logger?.log('ui.interaction', { action: 'playback_resumed' });
        return;
      }

      case 'voice:bargeIn': {
        this.handleBargeIn(msg.cutoff, msg.diagramState);
        return;
      }

      case 'voice:utteranceAudio': {
        await this.handleVoiceUtterance(msg.audioWavBase64, msg.selectedNodeId);
        return;
      }

      case 'text:userPrompt': {
        await this.handleUserQuestion(msg.text, msg.selectedNodeId, 'text');
        return;
      }

      case 'node:select': {
        this.selectedNodeId = msg.nodeId;
        this.deps.logger?.log('ui.interaction', {
          action: 'node_select',
          nodeId: msg.nodeId,
        });
        return;
      }

      case 'node:doubleClick': {
        this.deps.logger?.log('ui.interaction', {
          action: 'node_double_click',
          nodeId: msg.nodeId,
          codeTarget: msg.codeTarget,
        });
        await this.handleNodeDoubleClick(msg.nodeId, msg.codeTarget);
        return;
      }

      case 'whiteboard:popTo': {
        const nextTree = selectWhiteboardIndex(this.diagramTree, msg.index);
        if (nextTree !== this.diagramTree) {
          this.diagramTree = nextTree;
          this.postSyncWhiteboardTree();
          const { stack } = deriveActivePath(this.diagramTree);
          this.deps.logger?.log('ui.interaction', {
            action: 'whiteboard_select_level',
            index: msg.index,
            stackLength: stack.length,
            totalNodes: this.diagramTree.nodes.length,
            diagramId: this.diagramTree.activeId,
          });
        }
        return;
      }

      case 'whiteboard:selectLayer': {
        const nextTree = selectWhiteboardLayer(this.diagramTree, msg.id);
        if (nextTree !== this.diagramTree) {
          this.diagramTree = nextTree;
          this.postSyncWhiteboardTree();
          this.deps.logger?.log('ui.interaction', {
            action: 'whiteboard_select_layer',
            diagramId: this.diagramTree.activeId,
            totalNodes: this.diagramTree.nodes.length,
          });
        }
        return;
      }

      case 'ui:toggleViewMode': {
        if (this.target?.kind === 'branch-explore') {
          this.deps.whiteboard.postMessage({
            type: 'notice:toast',
            level: 'info',
            message: '当前分支导读模式无 PR Diff，已保持源码视图。',
          });
          this.emitSessionState(this.phase);
          return;
        }
        const nextMode = await this.deps.codeNavigator.toggleViewMode(this.target);
        this.deps.logger?.log('ui.interaction', {
          action: 'toggle_view_mode',
          viewMode: nextMode,
        });
        this.emitSessionState(this.phase);
        return;
      }

      case 'ui:popOutWindow': {
        await this.deps.whiteboard.popOutToWindow();
        this.deps.logger?.log('ui.interaction', { action: 'pop_out_window' });
        this.emitSessionState(this.phase);
        return;
      }

      case 'ui:toggleVoiceMode': {
        this.voiceMode = msg.mode;
        this.deps.mic?.setVoiceMode(msg.mode);
        this.deps.logger?.log('ui.interaction', {
          action: 'toggle_voice_mode',
          voiceMode: msg.mode,
        });
        this.emitSessionState(this.phase);
        return;
      }

      case 'ui:toggleMute': {
        this.ttsMuted = msg.muted;
        this.deps.logger?.log('ui.interaction', {
          action: 'toggle_mute',
          muted: msg.muted,
        });
        this.emitSessionState(this.phase);
        return;
      }

      case 'ui:toggleAutoContinue': {
        this.autoContinueEnabled = msg.enabled;
        this.deps.logger?.log('ui.interaction', {
          action: 'toggle_auto_continue',
          enabled: msg.enabled,
        });
        if (!msg.enabled) {
          this.cancelPrefetch();
        } else if (
          !this.paused &&
          !this.promptRunning &&
          !this.isReplaying &&
          (this.activity.counters.segmentsPlayed > 0 || this.currentPlayingSegment !== undefined)
        ) {
          this.maybeStartPrefetch();
        }
        this.emitSessionState(this.phase);
        return;
      }

      case 'replay:start': {
        this.startReplay(msg.mode, msg.startIndex);
        return;
      }

      case 'replay:stop': {
        this.stopReplay();
        return;
      }

      case 'ui:switchTarget': {
        await this.deps.actions.onSwitchTarget();
        return;
      }

      case 'ui:startBranchExplore': {
        await this.deps.actions.onStartBranchExplore?.();
        return;
      }

      case 'ui:startCorePathReview': {
        await this.deps.actions.onStartCorePathReview?.();
        return;
      }

      case 'ui:publishOrExportNotes': {
        await this.deps.actions.onPublishOrExportNotes();
        this.deps.whiteboard.postMessage({
          type: 'notes:sync',
          notes: this.deps.comments.listDrafts(),
        });
        return;
      }

      case 'ui:deleteNote': {
        if (this.deps.comments.removeDraft?.(msg.id)) {
          this.deps.logger?.log('ui.interaction', {
            action: 'note_deleted',
            id: msg.id,
          });
          this.deps.whiteboard.postMessage({
            type: 'notes:sync',
            notes: this.deps.comments.listDrafts(),
          });
        }
        return;
      }

      case 'ui:gotoNote': {
        if (!this.target || !msg.file) {
          return;
        }
        this.manualEditorLocation = undefined;
        const gotoCmd: CodeGotoDirective = {
          type: 'code_goto',
          file: msg.file,
          lines: msg.line > 0 ? { start: msg.line, end: msg.line } : undefined,
          label: 'Review 批注',
        };
        const { view, isModifiedFile } = resolveCodeGotoView(
          gotoCmd,
          this.contextPack,
          this.deps.codeNavigator.getCurrentViewMode()
        );
        await this.deps.codeNavigator.navigateTo(
          { ...gotoCmd, view },
          this.target,
          { preferWorkspaceFile: !isModifiedFile }
        );
        this.syncWhiteboardFocusForFile(msg.file);
        this.emitSessionState(this.phase);
        this.deps.logger?.log('ui.interaction', {
          action: 'note_goto',
          file: msg.file,
          line: msg.line,
        });
        return;
      }

      case 'ui:addManualNote': {
        if (!this.target || !msg.body.trim()) {
          return;
        }
        const loc = this.deps.codeNavigator.getCurrentLocation();
        const file =
          loc?.file ??
          this.contextPack?.files[0]?.path ??
          this.contextPack?.repoOverview?.activeEditorFile ??
          this.contextPack?.moduleClusters[0]?.files[0] ??
          '';
        const line = loc?.lines?.start ?? 1;
        this.deps.comments.addDraft(
          {
            file,
            line,
            severity: 'info',
            body: msg.body.trim(),
          },
          this.target
        );
        this.deps.logger?.log('ui.interaction', {
          action: 'manual_note_added',
          file,
          line,
        });
        this.deps.whiteboard.postMessage({
          type: 'notes:sync',
          notes: this.deps.comments.listDrafts(),
        });
        return;
      }

      case 'telemetry:mermaidError': {
        this.deps.logger?.log('whiteboard.mermaid_error', {
          diagramId: msg.diagramId,
          error: msg.error,
          mermaidCode: msg.mermaidCode.slice(0, 1200),
        });
        this.scheduleMermaidAutoRepair(msg.diagramId, msg.error, msg.mermaidCode);
        return;
      }

      case 'telemetry:playbackEvent': {
        this.deps.logger?.log('playback.event', {
          kind: msg.kind,
          detail: msg.detail,
        });
        if (msg.kind === 'audio_blocked') {
          this.updateActivity(
            {
              stage: 'audio_blocked',
              headline: '浏览器限制自动播报，已切字幕同步推进（点击白板任意处解锁语音）',
              detail: msg.detail,
            },
            {
              logText: '浏览器限制自动播报，已切字幕同步推进',
              force: true,
              statusBarSummary: '点击白板解锁语音',
            }
          );
        } else if (msg.kind === 'audio_unlocked') {
          this.updateActivity(
            {
              stage: this.currentPlayingSegment
                ? 'speaking'
                : this.activity.stage === 'audio_blocked'
                  ? 'speaking'
                  : this.activity.stage,
              headline:
                this.activity.stage === 'audio_blocked'
                  ? `正在同步讲解 (${this.activity.counters.segmentsPlayed}/${Math.max(
                      this.activity.counters.segmentsParsed,
                      this.activity.counters.segmentsPlayed
                    )} 段)`
                  : this.activity.headline,
            },
            {
              logText: '语音播报已解锁',
              force: true,
            }
          );
        }
        return;
      }

      case 'mic:start': {
        await this.startHostMic();
        return;
      }

      case 'mic:stop': {
        this.stopHostMic();
        return;
      }

      case 'mic:pttStart': {
        const started = await this.startHostMic();
        if (started) {
          this.deps.mic?.startPtt();
        }
        return;
      }

      case 'mic:pttEnd': {
        this.deps.mic?.endPtt();
        return;
      }

      case 'callChain:gotoNode': {
        if (!this.target || !msg.file) {
          return;
        }
        this.manualEditorLocation = undefined;
        const cmd: CodeGotoDirective = {
          type: 'code_goto',
          file: msg.file,
          lines: clampHighlightRange({
            start: msg.line > 0 ? msg.line : 1,
            end: msg.endLine && msg.endLine >= msg.line ? msg.endLine : msg.line + 6,
          }),
          label: msg.label || '调用链节点',
        };
        const { view, isModifiedFile } = resolveCodeGotoView(
          cmd,
          this.contextPack,
          this.deps.codeNavigator.getCurrentViewMode()
        );
        await this.deps.codeNavigator.navigateTo(
          { ...cmd, view },
          this.target,
          { preferWorkspaceFile: !isModifiedFile }
        );
        this.syncWhiteboardFocusForFile(msg.file);
        this.syncCallChainActiveForLocation(msg.file, msg.line);
        this.emitSessionState(this.phase);
        this.deps.logger?.log('ui.interaction', {
          action: 'call_chain_goto',
          file: msg.file,
          line: msg.line,
        });
        return;
      }

      case 'callChain:expandCallers': {
        if (!this.target || !this.deps.callChainResolver) {
          this.deps.whiteboard.postMessage({
            type: 'callChain:callersResult',
            nodeId: msg.nodeId,
            callers: [],
            source: 'none',
            note: '当前会话尚未就绪或未启用 LSP 解析器。',
          });
          return;
        }
        const res = await this.deps.callChainResolver.findIncomingCallers(
          msg.file,
          msg.line,
          msg.symbol,
          this.target.repoRoot
        );
        this.deps.whiteboard.postMessage({
          type: 'callChain:callersResult',
          nodeId: msg.nodeId,
          callers: res.callers,
          source: res.source,
          note: res.note,
        });
        this.deps.logger?.log('ui.interaction', {
          action: 'call_chain_expand_callers',
          nodeId: msg.nodeId,
          file: msg.file,
          line: msg.line,
          source: res.source,
          count: res.callers.length,
        });
        return;
      }

      case 'callChain:inspectCurrent': {
        if (!this.target || !this.deps.callChainResolver) {
          return;
        }
        const loc = this.getActiveEditorLocation();
        const fallbackFile =
          loc?.file ||
          this.currentCallChain?.nodes[this.currentCallChain.activeIndex]?.file ||
          this.contextPack?.repoOverview?.activeEditorFile ||
          this.contextPack?.files[0]?.path;
        const fallbackLine =
          loc?.lines?.start ??
          this.currentCallChain?.nodes[this.currentCallChain.activeIndex]?.line ??
          1;
        if (!fallbackFile) {
          this.deps.whiteboard.postMessage({
            type: 'notice:toast',
            level: 'info',
            message: '请先定位到一个具体源码文件，再使用 LSP 反查上游调用链。',
          });
          return;
        }
        const lspChain = await this.deps.callChainResolver.buildLspFallbackChain(
          fallbackFile,
          fallbackLine,
          this.target.repoRoot
        );
        if (!lspChain) {
          this.deps.whiteboard.postMessage({
            type: 'notice:toast',
            level: 'warn',
            message: '未能通过 LSP 解析当前符号的上游调用关系（请确认对应语言服务已激活）。',
          });
          return;
        }
        this.callChainSeq += 1;
        this.currentCallChain = lspChain;
        this.deps.whiteboard.postMessage({
          type: 'callChain:sync',
          chain: this.currentCallChain,
        });
        return;
      }
    }
  }

  public handleBargeIn(
    cutoff: WebviewPlaybackCutoff,
    diagramState: {
      diagramId?: string;
      focusedNodeId?: string;
      stackPath: string;
    }
  ): InterruptionSnapshot {
    const cancelledMidStream = this.promptRunning;
    const snapshot = this.buildInterruptionSnapshot(cutoff, diagramState);
    this.pendingInterruption = snapshot;

    const cutoffSeg = this.turnSegments.find((s) => s.segmentId === cutoff.segmentId);
    const spokenRatio =
      cutoffSeg && cutoffSeg.spokenText.length > 0
        ? Number((cutoff.spokenCharOffset / cutoffSeg.spokenText.length).toFixed(2))
        : undefined;

    this.deps.logger?.log(
      'voice.barge_in',
      {
        interruptedTurnId: cutoff.turnId,
        segmentId: cutoff.segmentId,
        spokenCharOffset: cutoff.spokenCharOffset,
        spokenRatio,
        cancelledMidStream,
        diagramId: diagramState.diagramId,
        focusedNodeId: diagramState.focusedNodeId,
        editorFile: snapshot.editorState?.file,
        voiceMode: this.voiceMode,
      },
      cutoff.turnId
    );

    const wasReplaying = this.isReplaying;
    if (this.isReplaying) {
      this.isReplaying = false;
      this.replayCurrentIndex = -1;
      this.emitReplayStatus();
    }
    this.stopCurrentPlaybackAndPrompt();
    if (wasReplaying) {
      this.deps.logger?.log('replay.interrupted', { diagramId: diagramState.diagramId });
    }
    this.setPhase('listening', '已打断，请继续提问...');
    this.updateActivity(
      {
        stage: 'listening',
        headline: '已打断，等待你的提问...',
        detail: undefined,
        currentFile: undefined,
      },
      {
        logText: '用户语音/手动打断',
        force: true,
        statusBarSummary: '等待提问...',
      }
    );
    return snapshot;
  }

  public dispose(): void {
    if (this.activityEmitTimer) {
      clearTimeout(this.activityEmitTimer);
      this.activityEmitTimer = null;
    }
    this.deps.mic?.stop();
    this.micActive = false;
    this.micUserSpeaking = false;
    this.micBackend = undefined;
    this.isReplaying = false;
    this.replayCurrentIndex = -1;
    this.replayTimeline = [];
    this.stopCurrentPlaybackAndPrompt();
    this.deps.acpClient.dispose();
  }

  private async handleVoiceUtterance(
    audioWavBase64: string,
    selectedNodeId?: string
  ): Promise<void> {
    if (!audioWavBase64) {
      return;
    }
    await this.handleVoiceUtteranceBuffer(
      Buffer.from(audioWavBase64, 'base64'),
      selectedNodeId
    );
  }

  private async handleVoiceUtteranceBuffer(
    wavBuf: Buffer,
    selectedNodeId?: string
  ): Promise<void> {
    if (!wavBuf || wavBuf.length === 0) {
      return;
    }
    this.setPhase('thinking', '正在识别语音...');
    this.updateActivity(
      {
        stage: 'thinking',
        headline: '正在识别语音...',
        detail: undefined,
      },
      {
        logText: '正在识别语音...',
        force: true,
        statusBarSummary: '识别语音中...',
      }
    );
    const sttStartMs = Date.now();
    try {
      const transcript = (
        await this.deps.speech.transcribe(wavBuf, this.config.sttLocale)
      ).trim();
      const transcribeMs = Date.now() - sttStartMs;

      this.deps.logger?.log('stt.transcribe', {
        audioBytes: wavBuf.length,
        transcribeMs,
        transcriptLen: transcript.length,
        transcript: transcript.slice(0, 200),
      });

      if (!transcript) {
        this.deps.whiteboard.postMessage({
          type: 'notice:toast',
          level: 'info',
          message: '未识别到有效语音内容，请重试或直接输入文字。',
        });
        this.setPhase('idle');
        this.updateActivity(
          {
            stage: 'idle',
            headline: '未识别到有效语音，等待继续输入',
            detail: undefined,
          },
          { force: true, statusBarSummary: '' }
        );
        return;
      }

      await this.handleUserQuestion(transcript, selectedNodeId, 'voice');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger?.log('stt.transcribe', {
        audioBytes: wavBuf.length,
        transcribeMs: Date.now() - sttStartMs,
        error: message,
      });
      if (
        err instanceof WhisperModelMissingError ||
        (err as { code?: string } | null)?.code === 'WHISPER_MODEL_MISSING'
      ) {
        if (this.deps.actions.onEnsureVoiceDependencies) {
          void this.deps.actions.onEnsureVoiceDependencies('whisper_model_missing');
        } else {
          this.deps.actions.onSttModelMissing?.();
        }
      }
      this.deps.whiteboard.postMessage({
        type: 'notice:toast',
        level: 'error',
        message: `语音识别失败: ${message}`,
      });
      this.setPhase('idle', '语音识别失败，可改用底部输入框提问');
      this.updateActivity(
        {
          stage: 'error',
          headline: '语音识别失败',
          detail: message,
        },
        {
          logText: `语音识别失败: ${message}`,
          force: true,
          statusBarSummary: '语音识别失败',
        }
      );
    }
  }

  private async startHostMic(): Promise<boolean> {
    if (this.micActive && this.deps.mic?.isActive()) {
      return true;
    }
    if (!this.deps.mic) {
      this.deps.whiteboard.postMessage({
        type: 'notice:toast',
        level: 'warn',
        message: '当前环境未挂载本地麦克风服务，请使用底部输入框提问。',
      });
      return false;
    }

    const doStart = () =>
      this.deps.mic!.start(
        {
          onLevel: (level) => {
            if (this.micActive) {
              this.emitMicState(level);
            }
          },
          onUserSpeakingChange: (speaking) => {
            this.micUserSpeaking = speaking;
            this.emitMicState(speaking ? 0.25 : 0);
          },
          onBargeIn: () => {
            if (!this.currentPlayingSegment && !this.promptRunning) {
              return;
            }
            const seg = this.currentPlayingSegment;
            const elapsedMs =
              seg && this.currentSegmentStartedAtMs > 0
                ? Math.max(0, Date.now() - this.currentSegmentStartedAtMs)
                : 0;
            const spokenLen = seg?.spokenText.length ?? 0;
            const estimatedOffset = Math.min(
              spokenLen,
              Math.max(0, Math.round(elapsedMs / 160))
            );
            this.handleBargeIn(
              {
                turnId: seg?.turnId ?? this.activeTurnId,
                segmentId: seg?.segmentId,
                spokenCharOffset: estimatedOffset,
              },
              this.getDiagramStateSnapshot()
            );
          },
          onUtteranceReady: (wavBuf) => {
            void this.handleVoiceUtteranceBuffer(wavBuf, this.selectedNodeId);
          },
          onSilentInputWarning: () => {
            this.deps.logger?.log('mic.silent_warning', {
              backend: this.micBackend,
            });
            this.deps.whiteboard.postMessage({
              type: 'notice:toast',
              level: 'warn',
              message:
                '检测到麦克风持续静音（全零音频）。若 macOS 未自动弹出授权，请在「系统设置 → 隐私与安全性 → 麦克风」中允许 Visual Studio Code。',
            });
          },
          onError: (message) => {
            this.micActive = false;
            this.micUserSpeaking = false;
            this.micBackend = undefined;
            this.emitMicState(0);
            this.deps.logger?.log('mic.error', { message });
            this.deps.whiteboard.postMessage({
              type: 'notice:toast',
              level: 'error',
              message,
            });
          },
        },
        {
          voiceMode: this.voiceMode,
          vadBargeInMs: this.config.vadBargeInMs,
          vadSilenceMs: this.config.vadSilenceMs,
        }
      );

    try {
      let result: { backend: string };
      try {
        result = await doStart();
      } catch (firstErr) {
        const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        const looksMissingTool =
          firstMsg.includes('未找到可用的本地录音工具') ||
          firstMsg.includes('ENOENT') ||
          firstMsg.toLowerCase().includes('sox') ||
          firstMsg.toLowerCase().includes('rec');
        if (!looksMissingTool || !this.deps.actions.onEnsureVoiceDependencies) {
          throw firstErr;
        }
        this.deps.whiteboard.postMessage({
          type: 'notice:toast',
          level: 'info',
          message: '检测到缺少本地录音依赖，正在自动安装 (sox)...',
        });
        const installedOk = await this.deps.actions.onEnsureVoiceDependencies(
          'mic_cli_missing'
        );
        if (!installedOk) {
          throw firstErr;
        }
        result = await doStart();
      }

      const { backend } = result;
      this.micActive = true;
      this.micUserSpeaking = false;
      this.micBackend = backend;
      this.deps.mic.setAssistantSpeaking(this.phase === 'speaking');
      this.emitMicState(0);
      this.deps.logger?.log('mic.started', {
        backend,
        voiceMode: this.voiceMode,
      });

      if (!this.announcedMicReady) {
        this.announcedMicReady = true;
        this.deps.whiteboard.postMessage({
          type: 'notice:toast',
          level: 'info',
          message: `已开启本地原生麦克风 (${backend})`,
        });
      }

      if (this.deps.speech.checkSttReadiness && !this.promptedSttSetup) {
        void this.deps.speech
          .checkSttReadiness()
          .then((res) => {
            if (
              !res.ready &&
              (res.reason === 'whisper_model_missing' || res.reason === 'no_engine') &&
              !this.promptedSttSetup
            ) {
              this.promptedSttSetup = true;
              if (this.deps.actions.onEnsureVoiceDependencies) {
                this.deps.whiteboard.postMessage({
                  type: 'notice:toast',
                  level: 'info',
                  message: '检测到缺少本地语音识别依赖，正在自动检查并安装...',
                });
                void this.deps.actions.onEnsureVoiceDependencies(
                  res.reason === 'whisper_model_missing'
                    ? 'whisper_model_missing'
                    : 'stt_engine_missing'
                );
              } else if (res.reason === 'whisper_model_missing') {
                this.deps.actions.onSttModelMissing?.();
              }
            }
          })
          .catch(() => undefined);
      }

      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.micActive = false;
      this.micUserSpeaking = false;
      this.micBackend = undefined;
      this.emitMicState(0);
      this.deps.logger?.log('mic.error', { message });
      this.deps.whiteboard.postMessage({
        type: 'notice:toast',
        level: 'error',
        message: `${message}，你仍可在下方直接打字提问。`,
      });
      return false;
    }
  }

  private stopHostMic(): void {
    this.deps.mic?.stop();
    this.micActive = false;
    this.micUserSpeaking = false;
    this.micBackend = undefined;
    this.emitMicState(0);
    this.deps.logger?.log('mic.stopped', {});
  }

  private emitMicState(level: number): void {
    this.deps.whiteboard.postMessage({
      type: 'mic:state',
      active: this.micActive,
      isUserSpeaking: this.micUserSpeaking,
      level,
      backend: this.micBackend,
    });
  }

  public async handleUserQuestion(
    rawText: string,
    selectedNodeId?: string,
    source: 'voice' | 'text' = 'text'
  ): Promise<void> {
    const text = rawText.trim();
    if (!text) {
      return;
    }
    if (!this.target) {
      if (this.deps.actions.onAutoStartBranchExplore) {
        if (this.autoStartingBranch) {
          return;
        }
        this.autoStartingBranch = true;
        try {
          await this.deps.actions.onAutoStartBranchExplore(text);
        } finally {
          this.autoStartingBranch = false;
        }
        return;
      }
      this.deps.whiteboard.postMessage({
        type: 'notice:toast',
        level: 'warn',
        message: '请先选择当前分支导读或 PR / Branch Diff 开启会话。',
      });
      return;
    }

    if (
      this.pendingBranchContextIntro &&
      this.target.kind === 'branch-explore' &&
      this.contextPack
    ) {
      this.pendingBranchContextIntro = false;
      this.deps.logger?.log('user.question', {
        source,
        selectedNodeId,
        textLength: text.length,
        textPreview: text.slice(0, 120),
        hadInterruption: false,
      });
      const packMd = formatContextPackForPrompt(
        this.contextPack,
        this.config.maxContextChars + 4000
      );
      const prompt = buildBranchExploreInitialPrompt(packMd, text);
      await this.runAcpTurn(prompt, source, false, selectedNodeId);
      return;
    }

    // If user submitted text/voice while previous turn / replay is still active without prior barge-in
    if (
      !this.pendingInterruption &&
      (this.promptRunning || this.currentPlayingSegment || this.isReplaying)
    ) {
      this.pendingInterruption = this.buildInterruptionSnapshot(
        {
          turnId: this.activeTurnId,
          segmentId: this.currentPlayingSegment?.segmentId,
          spokenCharOffset: this.currentPlayingSegment?.spokenText.length ?? 0,
        },
        this.getDiagramStateSnapshot()
      );
      if (this.isReplaying) {
        this.isReplaying = false;
        this.replayCurrentIndex = -1;
        this.emitReplayStatus();
      }
      this.stopCurrentPlaybackAndPrompt();
    } else {
      this.cancelPrefetch();
    }

    this.walkthroughDone = false;
    this.autoContinueCount = 0;

    const effectiveNode = selectedNodeId ?? this.selectedNodeId;
    const hadInterruption = Boolean(this.pendingInterruption);
    const promptMode = this.isCorePathLineReviewTarget()
      ? 'core-path-line-review'
      : this.target.kind === 'branch-explore'
        ? 'branch-explore'
        : 'diff';
    let promptText: string;

    if (this.pendingInterruption) {
      promptText = buildInterruptionPrompt(
        this.pendingInterruption,
        text,
        effectiveNode,
        promptMode
      );
      this.pendingInterruption = undefined;
    } else {
      const diagState = this.getDiagramStateSnapshot();
      const editorLoc = this.getActiveEditorLocation();
      promptText = buildUserFollowUpPrompt(text, {
        selectedNodeId: effectiveNode,
        diagramId: diagState.diagramId,
        stackPath: diagState.stackPath,
        treeOutline: diagState.treeOutline,
        editorFile: editorLoc?.file,
        editorLines: editorLoc?.lines,
        notesCount: this.deps.comments.listDrafts().length,
        mode: promptMode,
      });
    }

    await this.runAcpTurn(promptText, source, hadInterruption, effectiveNode);
  }

  private async runAcpTurn(
    promptText: string,
    source: 'initial' | 'voice' | 'text' = 'initial',
    hasInterruptionContext = false,
    selectedNodeId?: string
  ): Promise<void> {
    this.activeTurnId += 1;
    const turnId = this.activeTurnId;
    const turnGroupId = ++this.replayGroupSeq;
    let activeGroupId = turnGroupId;
    const abortCtrl = new AbortController();
    this.activeTurnAbort = abortCtrl;
    this.promptRunning = true;
    this.paused = false;

    this.parser.reset(turnId);
    this.turnSegments = [];
    this.playedSegmentIds.clear();
    this.currentPlayingSegment = undefined;
    this.enqueuedSegmentCount = 0;

    const turnStartMs = Date.now();
    let firstTokenRecorded = false;
    let firstAudioRecorded = false;
    const toolCalls: string[] = [];
    const directiveCounts: Record<string, number> = {};

    this.deps.logger?.log(
      'turn.start',
      {
        source,
        hasInterruptionContext,
        selectedNodeId,
        promptLen: promptText.length,
      },
      turnId
    );

    this.thoughtTail = '';
    this.turnReadFilePaths.clear();
    this.activity.counters = {
      thoughtChars: 0,
      outputChars: 0,
      filesRead: 0,
      segmentsParsed: 0,
      ttsReady: 0,
      segmentsPlayed: 0,
    };
    this.activity.recentFiles = [];
    this.updateActivity(
      {
        stage: 'thinking',
        headline: 'Agent 正在思考并规划导读...',
        detail: '等待模型首包响应...',
        currentFile: undefined,
        thoughtPreview: undefined,
      },
      {
        logText:
          source === 'initial'
            ? '开始生成首轮自顶向下导读...'
            : `处理用户提问 (${source === 'voice' ? '语音' : '文本'})...`,
        force: true,
        statusBarSummary: 'Agent 思考中...',
      }
    );
    this.setPhase('thinking', 'Agent 正在快速组织导读...');

    const entries: TurnSynthesisEntry[] = [];
    let activeSynth = 0;
    const pendingSynthQueue: Array<() => void> = [];
    let drainedIndex = 0;
    let draining = false;

    const runWithConcurrency = <T>(fn: () => Promise<T>): Promise<T> => {
      return new Promise<T>((resolve, reject) => {
        const exec = () => {
          if (abortCtrl.signal.aborted || turnId !== this.activeTurnId) {
            reject(new Error('Turn aborted'));
            return;
          }
          activeSynth += 1;
          fn()
            .then(resolve, reject)
            .finally(() => {
              activeSynth -= 1;
              const next = pendingSynthQueue.shift();
              if (next) {
                next();
              }
            });
        };

        if (activeSynth < MAX_TTS_CONCURRENCY) {
          exec();
        } else {
          pendingSynthQueue.push(exec);
        }
      });
    };

    const drainOrdered = async (): Promise<void> => {
      if (draining) {
        return;
      }
      draining = true;
      try {
        while (drainedIndex < entries.length) {
          if (abortCtrl.signal.aborted || turnId !== this.activeTurnId) {
            return;
          }
          const entry = entries[drainedIndex];
          let audioResult: TtsAudioResult;
          try {
            audioResult = await entry.promise;
          } catch {
            if (abortCtrl.signal.aborted || turnId !== this.activeTurnId) {
              return;
            }
            audioResult = { audioBase64: '', mimeType: '', fallbackTextOnly: true };
          }
          if (abortCtrl.signal.aborted || turnId !== this.activeTurnId) {
            return;
          }
          if (!firstAudioRecorded) {
            firstAudioRecorded = true;
            this.deps.logger?.log(
              'turn.first_audio_ready',
              {
                firstAudioMs: Date.now() - turnStartMs,
                segmentId: entry.segment.segmentId,
              },
              turnId
            );
          }
          drainedIndex += 1;
          this.activity.counters.ttsReady += 1;
          if (this.activity.counters.segmentsPlayed === 0) {
            this.updateActivity(
              {
                stage: 'synthesizing',
                headline: `语音已就绪 (${this.activity.counters.ttsReady}/${this.activity.counters.segmentsParsed} 段)，准备播报...`,
                detail: entry.segment.spokenText.slice(0, 48) || undefined,
              },
              {
                force: true,
                statusBarSummary: `语音就绪 ${this.activity.counters.ttsReady}/${this.activity.counters.segmentsParsed}`,
              }
            );
          }
          const payload: AudioSegmentPayload = {
            segment: entry.segment,
            audioBase64: audioResult.audioBase64,
            mimeType: audioResult.mimeType,
            ttsRate: this.config.ttsRate,
            fallbackTextOnly: audioResult.fallbackTextOnly,
            muted: this.ttsMuted,
          };
          const hasChapterDir = entry.segment.directivesBefore.some(
            (d) => d.type === 'chapter'
          );
          if (hasChapterDir) {
            activeGroupId = ++this.replayGroupSeq;
          }
          this.recordTimelineEntry(payload, activeGroupId);
          this.enqueuedSegmentCount += 1;
          this.deps.whiteboard.postMessage({
            type: 'audio:enqueue',
            payload,
          });
          this.emitReplayStatus();
        }
      } finally {
        draining = false;
      }
    };

    const enqueueSegment = (segment: UtteranceSegment): void => {
      if (turnId !== this.activeTurnId || abortCtrl.signal.aborted) {
        return;
      }
      for (const dir of [...segment.directivesBefore, ...segment.directivesAfter]) {
        directiveCounts[dir.type] = (directiveCounts[dir.type] ?? 0) + 1;
        if (dir.type === 'walkthrough_done') {
          this.walkthroughDone = true;
        }
      }

      if (
        !segment.spokenText.trim() &&
        segment.directivesBefore.every((d) => d.type === 'walkthrough_done') &&
        segment.directivesAfter.every((d) => d.type === 'walkthrough_done')
      ) {
        return;
      }

      this.turnSegments.push(segment);
      this.activity.counters.segmentsParsed += 1;
      this.recordWhiteboardDirectives(segment.directivesBefore);
      this.recordWhiteboardDirectives(segment.directivesAfter);

      const ttsText = normalizeTextForTts(segment.spokenText);
      if (
        !this.ttsMuted &&
        ttsText &&
        this.activity.counters.segmentsPlayed === 0 &&
        !this.currentPlayingSegment &&
        this.activity.counters.ttsReady === 0
      ) {
        this.updateActivity(
          {
            stage: 'synthesizing',
            headline: `正在合成第 1 段语音 (已解析 ${this.activity.counters.segmentsParsed} 段)...`,
            detail: segment.spokenText.slice(0, 48) || undefined,
          },
          {
            logText: `已解析第 1 段讲解，开始合成语音`,
            force: true,
            statusBarSummary: '合成语音中...',
          }
        );
      }

      const promise =
        this.ttsMuted || !ttsText
          ? Promise.resolve<TtsAudioResult>({
              audioBase64: '',
              mimeType: '',
              fallbackTextOnly: true,
            })
          : runWithConcurrency(async () => {
              const ttsStartMs = Date.now();
              let callbackWarned = false;
              try {
                const res = await this.deps.speech.synthesizeWithFallback(
                  ttsText,
                  {
                    voice: this.config.ttsVoice,
                    rate: this.config.ttsRate,
                    signal: abortCtrl.signal,
                  },
                  (warnMsg) => {
                    callbackWarned = true;
                    this.deps.whiteboard.postMessage({
                      type: 'notice:toast',
                      level: 'warn',
                      message: warnMsg,
                    });
                  }
                );
                const fallbackUsed = Boolean(res.fallbackUsed || callbackWarned);
                this.deps.logger?.log(
                  'tts.synthesize',
                  {
                    segmentId: segment.segmentId,
                    textLen: segment.spokenText.length,
                    synthMs: Date.now() - ttsStartMs,
                    fallbackUsed,
                    ...(res.fallbackReason ? { fallbackReason: res.fallbackReason } : {}),
                  },
                  turnId
                );
                return res;
              } catch (err) {
                if (!abortCtrl.signal.aborted) {
                  this.deps.logger?.log(
                    'tts.synthesize',
                    {
                      segmentId: segment.segmentId,
                      textLen: segment.spokenText.length,
                      synthMs: Date.now() - ttsStartMs,
                      fallbackUsed: callbackWarned,
                      error: err instanceof Error ? err.message : String(err),
                    },
                    turnId
                  );
                }
                throw err;
              }
            });

      entries.push({ segment, promise });
      void drainOrdered();
    };

    try {
      const promptRes = await this.deps.acpClient.sendPrompt(promptText, {
        onTextDelta: (delta) => {
          if (turnId !== this.activeTurnId || abortCtrl.signal.aborted) {
            return;
          }
          if (!firstTokenRecorded) {
            firstTokenRecorded = true;
            this.deps.logger?.log(
              'turn.first_token',
              { ttftMs: Date.now() - turnStartMs },
              turnId
            );
          }
          this.activity.counters.outputChars += delta.length;
          const segments = this.parser.feed(delta);
          for (const seg of segments) {
            enqueueSegment(seg);
          }
          if (
            this.activity.counters.segmentsPlayed === 0 &&
            this.activity.counters.ttsReady === 0
          ) {
            this.updateActivity(
              {
                stage: 'streaming',
                headline: `正在生成导读与白板 (${this.activity.counters.outputChars} 字 · ${this.activity.counters.segmentsParsed} 段)`,
                detail: this.activity.thoughtPreview,
                currentFile: undefined,
              },
              {
                statusBarSummary: `生成导读 ${this.activity.counters.outputChars}字`,
              }
            );
          }
        },
        onThoughtDelta: (delta) => {
          if (turnId !== this.activeTurnId || abortCtrl.signal.aborted) {
            return;
          }
          this.activity.counters.thoughtChars += delta.length;
          this.thoughtTail = (this.thoughtTail + delta).slice(-400);
          const preview = extractThoughtPreview(this.thoughtTail);
          const nextPreview = preview || this.activity.thoughtPreview;
          if (this.activity.stage === 'reading_file') {
            this.updateActivity({ thoughtPreview: nextPreview });
          } else {
            this.updateActivity(
              {
                stage: 'thinking',
                headline: `Agent 思考中 (${this.activity.counters.thoughtChars} 字)`,
                detail: nextPreview || '正在组织架构与代码脉络...',
                thoughtPreview: nextPreview,
              },
              {
                statusBarSummary: `思考中 ${this.activity.counters.thoughtChars}字`,
              }
            );
          }
        },
        onToolActivity: (info: AcpToolActivityInfo) => {
          if (turnId !== this.activeTurnId || abortCtrl.signal.aborted) {
            return;
          }
          this.deps.logger?.log(
            'agent.tool_activity',
            {
              toolCallId: info.toolCallId,
              kind: info.kind,
              status: info.status,
              title: info.title,
              filePath: info.filePath,
              line: info.line,
              limit: info.limit,
            },
            turnId
          );

          const lineRange = formatLineRange(info.line, info.limit);
          const isFileRead = Boolean(info.filePath) || info.kind === 'read';

          if (isFileRead && info.filePath) {
            const base = info.filePath.split('/').pop() || info.filePath;
            const fileStatus: AgentActivityFileEntry['status'] =
              info.status === 'failed'
                ? 'error'
                : info.status === 'completed'
                  ? 'done'
                  : 'reading';
            this.upsertActivityFile(info.filePath, fileStatus, lineRange);

            if (fileStatus === 'reading') {
              const rangeLabel = lineRange ? ` (${lineRange})` : '';
              this.setPhase('thinking', `正在读取文件：${info.filePath}${rangeLabel}`);
              this.updateActivity(
                {
                  stage: 'reading_file',
                  headline: `正在读取 ${base}${rangeLabel}`,
                  detail: info.filePath,
                  currentFile: info.filePath,
                },
                {
                  logText: `读取 ${info.filePath}${lineRange ? `:${lineRange}` : ''}`,
                  force: true,
                  statusBarSummary: `读 ${base}`,
                }
              );
            } else if (fileStatus === 'done') {
              this.updateActivity(
                {
                  stage: 'thinking',
                  headline: `已读完 ${base}，继续分析...`,
                  detail: this.activity.thoughtPreview || info.filePath,
                  currentFile: undefined,
                },
                {
                  force: true,
                  statusBarSummary: 'Agent 分析中...',
                }
              );
            } else {
              this.updateActivity(
                {
                  stage: 'thinking',
                  headline: `读取 ${base} 失败，继续分析...`,
                  detail: info.filePath,
                  currentFile: undefined,
                },
                {
                  logText: `读取失败：${info.filePath}`,
                  force: true,
                  statusBarSummary: 'Agent 分析中...',
                }
              );
            }
            return;
          }

          if (info.title) {
            toolCalls.push(info.title);
          }
          if (info.status === 'completed' || info.status === 'failed') {
            this.updateActivity(
              {
                stage: 'thinking',
                headline:
                  info.status === 'failed'
                    ? `工具失败，继续分析...`
                    : `工具完成，继续分析...`,
                detail: info.detail || info.title,
                currentFile: undefined,
              },
              {
                force: true,
                statusBarSummary: 'Agent 分析中...',
              }
            );
          } else {
            const label = info.title || info.kind || '工具调用';
            this.setPhase('thinking', `正在查看代码：${label}`);
            this.updateActivity(
              {
                stage: 'tool_call',
                headline: `执行工具: ${label}`,
                detail: info.detail,
                currentFile: info.filePath,
              },
              {
                logText: `工具: ${label}`,
                force: true,
                statusBarSummary: label.slice(0, 24),
              }
            );
          }
        },
      });

      if (turnId === this.activeTurnId && !abortCtrl.signal.aborted) {
        const trailing = this.parser.flush();
        for (const seg of trailing) {
          enqueueSegment(seg);
        }
        await drainOrdered();
        this.deps.logger?.log(
          'turn.complete',
          {
            turnTotalMs: Date.now() - turnStartMs,
            stopReason: promptRes?.stopReason,
            usage: promptRes?.usage,
            segmentCount: entries.length,
            directiveCounts,
            toolCalls: Array.from(new Set(toolCalls)),
          },
          turnId
        );
        if (entries.length === 0 && this.phase === 'thinking') {
          this.setPhase('idle');
          this.updateActivity(
            {
              stage: 'idle',
              headline: '本轮已完成',
              detail: undefined,
              currentFile: undefined,
            },
            {
              logText: '本轮响应完成（无新增播报段）',
              force: true,
              statusBarSummary: '',
            }
          );
        }
      }
    } catch (err) {
      if (turnId === this.activeTurnId && !abortCtrl.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger?.log(
          'session.error',
          { scope: 'acp.prompt', message, turnTotalMs: Date.now() - turnStartMs },
          turnId
        );
        this.setPhase('error', `ACP 请求出错: ${message}`);
        this.updateActivity(
          {
            stage: 'error',
            headline: 'ACP 导读出错',
            detail: message,
            currentFile: undefined,
          },
          {
            logText: `ACP 出错: ${message}`,
            force: true,
            statusBarSummary: 'ACP 出错',
          }
        );
        this.deps.whiteboard.postMessage({
          type: 'notice:toast',
          level: 'error',
          message: `ACP 导读出错: ${message}`,
        });
      }
    } finally {
      if (turnId === this.activeTurnId) {
        this.promptRunning = false;
        if (!abortCtrl.signal.aborted) {
          if (!this.drainPendingMermaidRepair()) {
            this.maybeStartPrefetch();
          }
        }
      }
    }
  }

  private stopCurrentPlaybackAndPrompt(): void {
    const hadActiveTurn = this.activeTurnId > 0 || this.promptRunning || this.isReplaying;
    const wasPromptRunning = this.promptRunning;
    this.activeTurnId += 1;
    this.cancelPrefetch();
    this.cancelMermaidRepair();
    if (this.activeTurnAbort) {
      this.activeTurnAbort.abort();
      this.activeTurnAbort = null;
    }
    this.promptRunning = false;
    this.paused = false;
    this.enqueuedSegmentCount = 0;
    if (wasPromptRunning) {
      this.deps.acpClient.cancel();
    }
    if (hadActiveTurn) {
      this.deps.whiteboard.postMessage({
        type: 'audio:clear',
        turnId: this.activeTurnId,
      });
      this.deps.whiteboard.postMessage({
        type: 'subtitle:update',
        text: '',
        isSpeaking: false,
      });
    }
  }

  public handleManualEditorSwitch(relFile: string, line?: number): void {
    if (!this.target) {
      return;
    }
    const cleanRel = relFile.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanRel) {
      return;
    }
    this.manualEditorLocation = {
      file: cleanRel,
      lines: line && line > 0 ? { start: line, end: line } : undefined,
      view: this.deps.codeNavigator.getCurrentViewMode(),
    };

    const syncedNodeId = this.syncWhiteboardFocusForFile(cleanRel);
    this.syncCallChainActiveForLocation(cleanRel, line);
    this.deps.logger?.log('ui.interaction', {
      action: 'editor_tab_switched',
      file: cleanRel,
      line,
      syncedNodeId,
    });
    this.emitSessionState(this.phase);
  }

  private async applyHostDirectives(
    directives: Directive[],
    opts?: { isReplay?: boolean }
  ): Promise<void> {
    if (!this.target) {
      return;
    }
    const hasExplicitWbUpdate = directives.some(
      (d) => d.type === 'wb_focus' || d.type === 'wb_render'
    );
    const hasExplicitCodeGoto = directives.some((d) => d.type === 'code_goto');

    for (const dir of directives) {
      if (dir.type === 'call_chain') {
        const seq = ++this.callChainSeq;
        this.currentCallChain = {
          title: dir.title,
          nodes: dir.nodes,
          activeIndex: dir.activeIndex,
          source: 'agent',
        };
        this.deps.whiteboard.postMessage({
          type: 'callChain:sync',
          chain: this.currentCallChain,
        });
        if (this.deps.callChainResolver && this.target) {
          const repoRoot = this.target.repoRoot;
          void this.deps.callChainResolver
            .calibrateCallChain(dir.nodes, repoRoot)
            .then((calibrated) => {
              if (seq !== this.callChainSeq || !this.currentCallChain) {
                return;
              }
              this.currentCallChain = {
                ...this.currentCallChain,
                nodes: calibrated,
              };
              this.deps.whiteboard.postMessage({
                type: 'callChain:sync',
                chain: this.currentCallChain,
              });
            })
            .catch(() => undefined);
        }
      } else if (dir.type === 'code_goto') {
        this.manualEditorLocation = undefined;
        const { view, isModifiedFile } = resolveCodeGotoView(
          dir,
          this.contextPack,
          this.deps.codeNavigator.getCurrentViewMode()
        );
        const preferredLines =
          !dir.lines || dir.lines.start <= 5
            ? resolveBestDefaultLinesForFile(dir.file, this.contextPack)
            : undefined;
        const navigated = await this.deps.codeNavigator.navigateTo(
          { ...dir, view },
          this.target,
          preferredLines
            ? { preferWorkspaceFile: !isModifiedFile, preferredLines }
            : { preferWorkspaceFile: !isModifiedFile }
        );
        if (!hasExplicitWbUpdate) {
          this.syncWhiteboardFocusForFile(dir.file);
        }
        this.syncCallChainActiveForLocation(
          dir.file,
          navigated?.lines?.start ?? dir.lines?.start
        );
        this.emitSessionState(this.phase);
      } else if (dir.type === 'walkthrough_done') {
        this.walkthroughDone = true;
      } else if (dir.type === 'review_note') {
        if (opts?.isReplay) {
          continue;
        }
        const activeLoc = this.getActiveEditorLocation();
        const effectiveFile =
          dir.file.trim() ||
          activeLoc?.file ||
          this.contextPack?.files[0]?.path ||
          (this.target.kind === 'branch-explore'
            ? this.contextPack?.repoOverview?.activeEditorFile ||
              this.contextPack?.moduleClusters[0]?.files[0] ||
              'Project-General'
            : 'PR-General');
        const effectiveLine =
          dir.line > 0 ? dir.line : (activeLoc?.lines?.start ?? 1);
        const trimmedBody = dir.body.trim();
        const isDuplicate = this.deps.comments
          .listDrafts()
          .some(
            (existing) =>
              existing.file === effectiveFile &&
              existing.line === effectiveLine &&
              existing.body.trim() === trimmedBody
          );
        if (isDuplicate) {
          continue;
        }
        this.deps.comments.addDraft(
          {
            file: effectiveFile,
            line: effectiveLine,
            severity: dir.severity,
            body: trimmedBody,
          },
          this.target
        );
        this.deps.logger?.log('ui.interaction', {
          action: 'review_note_draft',
          file: effectiveFile,
          line: effectiveLine,
          severity: dir.severity,
        });
        this.deps.whiteboard.postMessage({
          type: 'notes:sync',
          notes: this.deps.comments.listDrafts(),
        });
        const baseName = effectiveFile.split('/').pop() || effectiveFile;
        const preview =
          trimmedBody.length > 36 ? `${trimmedBody.slice(0, 36)}...` : trimmedBody;
        this.deps.whiteboard.postMessage({
          type: 'notice:toast',
          level: 'info',
          message: `已自动加入 ${dir.severity === 'action' ? 'Action ' : ''}批注：${baseName}:${effectiveLine} — ${preview}`,
        });
      }
    }

    // Fallback: when a spoken step focuses a mapped whiteboard node without emitting <code_goto>,
    // open its local source snippet (capped to <=10 lines) so code stays synced step-by-step.
    if (!hasExplicitCodeGoto) {
      const focusDirectives = directives.filter(
        (d): d is Extract<Directive, { type: 'wb_focus' }> => d.type === 'wb_focus'
      );
      const lastFocus = focusDirectives[focusDirectives.length - 1];
      if (lastFocus) {
        const mappedTarget = this.findMappedCodeForNode(lastFocus.id, directives);
        const parsed = mappedTarget ? parseCodeMapTarget(mappedTarget) : null;
        if (parsed) {
          const preferredLines =
            !parsed.lines || parsed.lines.start <= 5
              ? resolveBestDefaultLinesForFile(parsed.file, this.contextPack)
              : undefined;
          const clampedLines = clampHighlightRange(
            parsed.lines ?? preferredLines ?? { start: 1, end: 8 }
          );
          const cmd: CodeGotoDirective = {
            type: 'code_goto',
            file: parsed.file,
            lines: clampedLines,
            label: lastFocus.id,
          };
          const { view, isModifiedFile } = resolveCodeGotoView(
            cmd,
            this.contextPack,
            this.deps.codeNavigator.getCurrentViewMode()
          );
          try {
            this.manualEditorLocation = undefined;
            const navigated = await this.deps.codeNavigator.navigateTo(
              { ...cmd, view },
              this.target,
              preferredLines
                ? { preferWorkspaceFile: !isModifiedFile, preferredLines }
                : { preferWorkspaceFile: !isModifiedFile }
            );
            this.syncCallChainActiveForLocation(
              parsed.file,
              navigated?.lines?.start ?? clampedLines.start
            );
            this.emitSessionState(this.phase);
          } catch (err) {
            this.deps.logger?.log('code.focus_auto_nav_failed', {
              nodeId: lastFocus.id,
              file: parsed.file,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }
  }

  private syncCallChainActiveForLocation(file: string, line?: number): void {
    if (!this.currentCallChain || this.currentCallChain.nodes.length === 0) {
      return;
    }
    const matchedIdx = matchActiveCallChainNode(
      this.currentCallChain.nodes,
      file,
      line
    );
    if (matchedIdx >= 0 && matchedIdx !== this.currentCallChain.activeIndex) {
      this.currentCallChain = {
        ...this.currentCallChain,
        activeIndex: matchedIdx,
      };
      this.deps.whiteboard.postMessage({
        type: 'callChain:sync',
        chain: this.currentCallChain,
      });
    }
  }

  private postSyncWhiteboardTree(): void {
    const { stack, activeIndex } = deriveActivePath(this.diagramTree);
    this.deps.whiteboard.postMessage({
      type: 'whiteboard:syncStack',
      stack,
      activeIndex,
      nodes: this.diagramTree.nodes,
      activeId: this.diagramTree.activeId,
    });
  }

  private getActiveDiagram(): DiagramStackItem | undefined {
    return getActiveTreeDiagram(this.diagramTree);
  }

  private findMappedCodeForNode(
    nodeId: string,
    inlineDirectives: Directive[] = []
  ): string | undefined {
    const cleanId = nodeId.trim();
    if (!cleanId) {
      return undefined;
    }
    const lowerId = cleanId.toLowerCase();

    const lookupInMap = (map?: Record<string, string>): string | undefined => {
      if (!map) {
        return undefined;
      }
      if (map[cleanId]) {
        return map[cleanId];
      }
      for (const [k, v] of Object.entries(map)) {
        if (k.toLowerCase() === lowerId) {
          return v;
        }
      }
      return undefined;
    };

    for (let i = inlineDirectives.length - 1; i >= 0; i--) {
      const dir = inlineDirectives[i];
      if (dir.type === 'wb_render') {
        const hit = lookupInMap(dir.nodeCodeMap);
        if (hit) {
          return hit;
        }
      }
    }

    const active = this.getActiveDiagram();
    const activeHit = lookupInMap(active?.nodeCodeMap);
    if (activeHit) {
      return activeHit;
    }

    for (let i = this.diagramTree.nodes.length - 1; i >= 0; i--) {
      const hit = lookupInMap(this.diagramTree.nodes[i].nodeCodeMap);
      if (hit) {
        return hit;
      }
    }

    return undefined;
  }

  private recordWhiteboardDirectives(directives: Directive[]): void {
    for (const dir of directives) {
      if (
        dir.type === 'wb_render' ||
        dir.type === 'wb_focus' ||
        dir.type === 'wb_pop' ||
        dir.type === 'wb_clear'
      ) {
        this.diagramTree = applyWhiteboardDirective(this.diagramTree, dir);
        if (dir.type === 'wb_render') {
          const active = getActiveTreeDiagram(this.diagramTree);
          if (active) {
            const idx = this.diagramArchive.findIndex((d) => d.id === active.id);
            if (idx >= 0) {
              this.diagramArchive[idx] = active;
            } else {
              this.diagramArchive.push(active);
            }
          }
        }
      } else if (dir.type === 'chapter') {
        this.currentChapter = {
          index: dir.index,
          total: dir.total,
          title: dir.title,
        };
      }
    }
  }

  private async handleNodeDoubleClick(
    nodeId: string,
    explicitCodeTarget?: string
  ): Promise<void> {
    if (!this.target) {
      return;
    }
    const active = this.getActiveDiagram();
    const mappedTarget = explicitCodeTarget ?? active?.nodeCodeMap?.[nodeId];
    if (mappedTarget) {
      const parsed = parseCodeMapTarget(mappedTarget);
      if (parsed) {
        this.manualEditorLocation = undefined;
        const preferredLines =
          !parsed.lines || parsed.lines.start <= 5
            ? resolveBestDefaultLinesForFile(parsed.file, this.contextPack)
            : undefined;
        const cmd: CodeGotoDirective = {
          type: 'code_goto',
          file: parsed.file,
          lines: parsed.lines ? clampHighlightRange(parsed.lines) : preferredLines,
          label: `白板节点 ${nodeId}`,
        };
        const { view, isModifiedFile } = resolveCodeGotoView(
          cmd,
          this.contextPack,
          this.deps.codeNavigator.getCurrentViewMode()
        );
        await this.deps.codeNavigator.navigateTo(
          { ...cmd, view },
          this.target,
          preferredLines
            ? { preferWorkspaceFile: !isModifiedFile, preferredLines }
            : { preferWorkspaceFile: !isModifiedFile }
        );
        this.emitSessionState(this.phase);
        return;
      }
    }

    // Fallback: match node ID heuristically against changed files
    const lower = nodeId.toLowerCase();
    const matched = this.contextPack?.files.find((f) =>
      f.path.toLowerCase().includes(lower)
    );
    if (matched) {
      this.manualEditorLocation = undefined;
      const preferredLines = resolveBestDefaultLinesForFile(matched.path, this.contextPack);
      await this.deps.codeNavigator.navigateTo(
        {
          type: 'code_goto',
          file: matched.path,
          lines: preferredLines ?? { start: 1, end: 8 },
          label: `白板节点 ${nodeId}`,
        },
        this.target,
        preferredLines ? { preferredLines } : undefined
      );
      this.emitSessionState(this.phase);
    }
  }

  private buildInterruptionSnapshot(
    cutoff: WebviewPlaybackCutoff,
    diagramState: {
      diagramId?: string;
      focusedNodeId?: string;
      stackPath: string;
      treeOutline?: string;
    }
  ): InterruptionSnapshot {
    const spokenParts: string[] = [];
    const unspokenParts: string[] = [];

    let reachedCutoffSeg = false;

    for (const seg of this.turnSegments) {
      if (!seg.spokenText) {
        continue;
      }
      if (this.playedSegmentIds.has(seg.segmentId)) {
        spokenParts.push(seg.spokenText);
        continue;
      }
      if (!reachedCutoffSeg && cutoff.segmentId && seg.segmentId === cutoff.segmentId) {
        reachedCutoffSeg = true;
        const offset = Math.max(0, Math.min(seg.spokenText.length, cutoff.spokenCharOffset));
        if (offset > 0) {
          spokenParts.push(seg.spokenText.slice(0, offset));
        }
        if (offset < seg.spokenText.length) {
          unspokenParts.push(seg.spokenText.slice(offset));
        }
        continue;
      }
      unspokenParts.push(seg.spokenText);
    }

    return {
      turnId: cutoff.turnId,
      spokenAlready: spokenParts.join(' '),
      unspokenCutOff: unspokenParts.join(' '),
      diagramId: diagramState.diagramId,
      focusedNodeId: diagramState.focusedNodeId,
      stackPath: diagramState.stackPath,
      treeOutline: diagramState.treeOutline ?? (formatWhiteboardTreeOutline(this.diagramTree) || undefined),
      editorState: this.getActiveEditorLocation(),
    };
  }

  private getActiveEditorLocation(): EditorLocationState | undefined {
    return this.manualEditorLocation ?? this.deps.codeNavigator.getCurrentLocation();
  }

  private syncWhiteboardFocusForFile(relFile: string): string | undefined {
    const active = this.getActiveDiagram();
    if (!active) {
      return undefined;
    }
    const matchedNodeId = findNodeIdForFile(active, relFile);
    if (!matchedNodeId || active.focusedNodeId === matchedNodeId) {
      return matchedNodeId;
    }
    this.diagramTree = applyWhiteboardDirective(this.diagramTree, {
      type: 'wb_focus',
      id: matchedNodeId,
    });
    this.deps.whiteboard.postMessage({
      type: 'directive:apply',
      directive: { type: 'wb_focus', id: matchedNodeId },
    });
    return matchedNodeId;
  }

  private getDiagramStateSnapshot(): {
    diagramId?: string;
    focusedNodeId?: string;
    stackPath: string;
    treeOutline?: string;
  } {
    const { stack, activeIndex } = deriveActivePath(this.diagramTree);
    const active =
      activeIndex >= 0 && activeIndex < stack.length
        ? stack[activeIndex]
        : getActiveTreeDiagram(this.diagramTree);
    const visiblePath = activeIndex >= 0 ? stack.slice(0, activeIndex + 1) : stack;
    const treeOutline = formatWhiteboardTreeOutline(this.diagramTree);
    return {
      diagramId: active?.id,
      focusedNodeId: active?.focusedNodeId,
      stackPath: visiblePath.map((d) => d.title || d.id).join(' > '),
      treeOutline: treeOutline || undefined,
    };
  }

  private setPhase(phase: SessionPhase, statusMessage?: string): void {
    this.phase = phase;
    this.deps.mic?.setAssistantSpeaking(phase === 'speaking');
    this.deps.actions.onPhaseChanged?.(
      phase,
      this.target?.title,
      this.lastStatusBarSummary || undefined
    );
    this.emitSessionState(phase, statusMessage);
  }

  private resetActivity(
    stage: AgentActivityStage,
    headline: string,
    detail?: string,
    logText?: string
  ): void {
    const now = Date.now();
    this.thoughtTail = '';
    this.turnReadFilePaths.clear();
    this.activity = {
      stage,
      headline,
      detail,
      startedAtMs: now,
      lastHeartbeatMs: now,
      counters: {
        thoughtChars: 0,
        outputChars: 0,
        filesRead: 0,
        segmentsParsed: 0,
        ttsReady: 0,
        segmentsPlayed: 0,
      },
      recentFiles: [],
      recentLogs: logText
        ? [
            {
              id: `log-${++this.activityLogSeq}`,
              ts: now,
              stage,
              text: logText,
            },
          ]
        : [],
    };
    this.lastStatusBarSummary = headline;
    this.deps.actions.onPhaseChanged?.(
      this.phase,
      this.target?.title,
      this.lastStatusBarSummary || undefined
    );
    this.emitActivityNow();
  }

  private updateActivity(
    patch: Partial<Omit<AgentActivityState, 'counters' | 'recentFiles' | 'recentLogs'>>,
    opts?: {
      logText?: string;
      force?: boolean;
      statusBarSummary?: string;
    }
  ): void {
    const now = Date.now();
    const prevStage = this.activity.stage;
    const prevFile = this.activity.currentFile;
    Object.assign(this.activity, patch, { lastHeartbeatMs: now });

    if (opts?.logText) {
      const last = this.activity.recentLogs[this.activity.recentLogs.length - 1];
      if (!last || last.text !== opts.logText || last.stage !== this.activity.stage) {
        this.activity.recentLogs = [
          ...this.activity.recentLogs.slice(-9),
          {
            id: `log-${++this.activityLogSeq}`,
            ts: now,
            stage: this.activity.stage,
            text: opts.logText,
          },
        ];
      }
    }

    if (opts?.statusBarSummary !== undefined) {
      const changed = opts.statusBarSummary !== this.lastStatusBarSummary;
      this.lastStatusBarSummary = opts.statusBarSummary;
      if (changed || prevStage !== this.activity.stage || prevFile !== this.activity.currentFile) {
        this.deps.actions.onPhaseChanged?.(
          this.phase,
          this.target?.title,
          this.lastStatusBarSummary || undefined
        );
      }
    }

    if (opts?.force) {
      this.emitActivityNow();
    } else {
      this.scheduleActivityEmit();
    }
  }

  private upsertActivityFile(
    filePath: string,
    status: AgentActivityFileEntry['status'],
    lineRange?: string
  ): void {
    const now = Date.now();
    if (!this.turnReadFilePaths.has(filePath)) {
      this.turnReadFilePaths.add(filePath);
      this.activity.counters.filesRead = this.turnReadFilePaths.size;
    }
    const filtered = this.activity.recentFiles.filter((f) => f.path !== filePath);
    const entry: AgentActivityFileEntry = {
      path: filePath,
      lineRange,
      status,
      updatedAtMs: now,
    };
    this.activity.recentFiles = [entry, ...filtered].slice(0, 8);
  }

  private scheduleActivityEmit(): void {
    const now = Date.now();
    const elapsed = now - this.lastActivityEmitMs;
    if (elapsed >= 120) {
      this.emitActivityNow();
      return;
    }
    if (!this.activityEmitTimer) {
      this.activityEmitTimer = setTimeout(() => {
        this.activityEmitTimer = null;
        this.emitActivityNow();
      }, 120 - elapsed);
    }
  }

  private emitActivityNow(): void {
    if (this.activityEmitTimer) {
      clearTimeout(this.activityEmitTimer);
      this.activityEmitTimer = null;
    }
    this.lastActivityEmitMs = Date.now();
    this.deps.whiteboard.postMessage({
      type: 'activity:update',
      activity: this.cloneActivity(),
    });
  }

  private cloneActivity(): AgentActivityState {
    return {
      ...this.activity,
      counters: { ...this.activity.counters },
      recentFiles: this.activity.recentFiles.map((f) => ({ ...f })),
      recentLogs: this.activity.recentLogs.map((l) => ({ ...l })),
    };
  }

  private emitSessionState(phase: SessionPhase, statusMessage?: string): void {
    const modelSuffix = this.activeModelResolution
      ? ` · ${this.activeModelResolution.resolvedModel} (${this.activeModelResolution.resolvedThoughtLevel})`
      : '';
    const activeLoc = this.getActiveEditorLocation();
    const activeLineSuffix = activeLoc?.lines
      ? activeLoc.lines.start === activeLoc.lines.end
        ? `:${activeLoc.lines.start}`
        : `:${activeLoc.lines.start}-${activeLoc.lines.end}`
      : '';
    const activeEditorLabel = activeLoc
      ? activeLoc.label
        ? `${activeLoc.label} (${activeLineSuffix || activeLoc.view})`
        : activeLineSuffix.replace(/^:/, 'L')
      : undefined;

    const meta: SessionMetaState = {
      targetTitle: this.target?.title ?? '未选择目标',
      targetSubtitle:
        this.target?.subtitle ?? '可直接基于当前分支开始导读，或点击「切换目标」选择 PR / Diff',
      sourceKind: this.target?.kind ?? 'local-diff',
      reviewMode: this.isCorePathLineReviewTarget()
        ? 'core-path-line-review'
        : this.target?.kind === 'branch-explore'
          ? 'branch-explore'
          : 'walkthrough',
      acpProfileLabel: `${this.config.acpProfile.displayName}${modelSuffix}`,
      viewMode:
        this.target?.kind === 'branch-explore'
          ? 'source'
          : this.deps.codeNavigator.getCurrentViewMode(),
      voiceMode: this.voiceMode,
      vadBargeInMs: this.config.vadBargeInMs,
      vadSilenceMs: this.config.vadSilenceMs,
      isPoppedOut: this.deps.whiteboard.getPoppedOut?.() ?? false,
      ttsMuted: this.ttsMuted,
      autoContinue: this.autoContinueEnabled,
      activeEditorFile: activeLoc?.file,
      activeEditorLabel,
    };

    this.deps.whiteboard.postMessage({
      type: 'session:state',
      phase,
      statusMessage,
      meta,
    });
  }

  public startReplay(
    mode: 'from-start' | 'current-section' | 'from-index',
    explicitIndex?: number
  ): void {
    if (this.replayTimeline.length === 0) {
      this.deps.whiteboard.postMessage({
        type: 'notice:toast',
        level: 'info',
        message: '当前会话尚无可供重放的历史讲解片段。',
      });
      return;
    }

    const status = this.buildReplayStatus();
    let resolvedStart = 0;
    if (mode === 'from-index' && explicitIndex !== undefined) {
      resolvedStart = Math.max(0, Math.min(explicitIndex, this.replayTimeline.length - 1));
    } else if (mode === 'current-section') {
      const refIdx =
        this.replayCurrentIndex >= 0
          ? this.replayCurrentIndex
          : this.replayTimeline.length - 1;
      const matchingCheckpoint = [...status.checkpoints]
        .reverse()
        .find((cp) => refIdx >= cp.startIndex);
      resolvedStart = matchingCheckpoint?.startIndex ?? 0;
    }

    this.stopCurrentPlaybackAndPrompt();
    this.isReplaying = true;
    this.replayCurrentIndex = resolvedStart;
    this.turnSegments = [];
    this.playedSegmentIds.clear();
    this.currentPlayingSegment = undefined;
    this.enqueuedSegmentCount = 0;

    if (resolvedStart === 0) {
      this.diagramTree = createEmptyWhiteboardTree();
      this.currentCallChain = null;
      this.currentChapter = undefined;
    } else {
      const preState = this.replayTimeline[resolvedStart].preState;
      this.diagramTree = cloneWhiteboardTreeState(preState.diagramTree);
      this.currentCallChain = preState.callChain
        ? cloneCallChainState(preState.callChain)
        : null;
      this.currentChapter = preState.chapter ? { ...preState.chapter } : undefined;
    }

    this.postSyncWhiteboardTree();
    this.deps.whiteboard.postMessage({
      type: 'callChain:sync',
      chain: this.currentCallChain,
    });
    if (this.currentChapter) {
      this.deps.whiteboard.postMessage({
        type: 'chapter:update',
        chapter: this.currentChapter,
      });
    }

    const slice = this.replayTimeline.slice(resolvedStart);
    this.activity.counters = {
      ...this.activity.counters,
      segmentsParsed: slice.length,
      ttsReady: slice.length,
      segmentsPlayed: 0,
    };
    this.setPhase('speaking', `开始同步重放 (${resolvedStart + 1}/${this.replayTimeline.length})`);
    this.updateActivity(
      {
        stage: 'speaking',
        headline: `同步重放中 (0/${slice.length} 段)`,
        detail: this.replayTimeline[resolvedStart]?.groupTitle,
      },
      {
        logText: `开始同步重放 (${mode}, 第 ${resolvedStart + 1} 段起，共 ${slice.length} 段)`,
        force: true,
        statusBarSummary: `重放 0/${slice.length}`,
      }
    );
    this.emitReplayStatus();

    const replayTurnId = this.activeTurnId;
    for (const item of slice) {
      const clonedSegment: UtteranceSegment = {
        ...item.payload.segment,
        turnId: replayTurnId,
        segmentId: `replay-${replayTurnId}-${item.index}`,
        directivesBefore: [...item.payload.segment.directivesBefore],
        directivesAfter: [...item.payload.segment.directivesAfter],
      };
      this.turnSegments.push(clonedSegment);
      this.enqueuedSegmentCount += 1;
      this.deps.whiteboard.postMessage({
        type: 'audio:enqueue',
        payload: {
          ...item.payload,
          segment: clonedSegment,
          ttsRate: this.config.ttsRate,
          muted: this.ttsMuted,
        },
      });
    }
  }

  public stopReplay(): void {
    if (!this.isReplaying) {
      return;
    }
    this.isReplaying = false;
    this.replayCurrentIndex = -1;
    this.stopCurrentPlaybackAndPrompt();
    this.setPhase('idle', '已停止重放，可随时提问或点击白板节点');
    this.updateActivity(
      {
        stage: 'idle',
        headline: '已停止重放',
        detail: undefined,
        currentFile: undefined,
      },
      {
        logText: '已手动停止重放',
        force: true,
        statusBarSummary: '',
      }
    );
    this.emitReplayStatus();
  }

  private remainingUnplayedInWebview(): number {
    return Math.max(0, this.enqueuedSegmentCount - this.playedSegmentIds.size);
  }

  private canAutoContinue(): boolean {
    return Boolean(
      this.target &&
        this.autoContinueEnabled &&
        !this.paused &&
        !this.isReplaying &&
        !this.walkthroughDone &&
        !this.pendingBranchContextIntro &&
        this.autoContinueCount < MAX_AUTO_CONTINUE_CHUNKS
    );
  }

  private maybeStartPrefetch(forceWhenEmpty = false): void {
    if (
      !this.canAutoContinue() ||
      this.promptRunning ||
      this.prefetchRunning ||
      this.mermaidRepairRunning ||
      this.pendingMermaidRepair !== null ||
      this.prefetchChunks.length >= PREFETCH_MAX_BUFFERED_CHUNKS
    ) {
      return;
    }
    const playbackStarted =
      this.activity.counters.segmentsPlayed > 0 ||
      this.currentPlayingSegment !== undefined;
    if (!forceWhenEmpty && !playbackStarted) {
      return;
    }
    void this.runPrefetchChunk();
  }

  private cancelPrefetch(): void {
    const wasRunning = this.prefetchRunning;
    this.prefetchGeneration += 1;
    if (this.prefetchAbort) {
      this.prefetchAbort.abort();
      this.prefetchAbort = null;
    }
    this.prefetchRunning = false;
    this.prefetchChunks = [];
    if (wasRunning) {
      this.deps.acpClient.cancel();
    }
  }

  private async runPrefetchChunk(): Promise<void> {
    if (!this.target) {
      return;
    }
    const gen = ++this.prefetchGeneration;
    const targetTurnId = this.activeTurnId;
    const chunkNumber = ++this.autoContinueChunkSeq;
    const abortCtrl = new AbortController();
    this.prefetchAbort = abortCtrl;
    this.prefetchRunning = true;

    const promptMode = this.isCorePathLineReviewTarget()
      ? 'core-path-line-review'
      : this.target.kind === 'branch-explore'
        ? 'branch-explore'
        : 'diff';
    const editorLoc = this.getActiveEditorLocation();
    const promptText = buildAutoContinuePrompt({
      mode: promptMode,
      treeOutline: this.projectDiagramTreeWithBuffer(),
      lastEditorFile: editorLoc?.file,
      lastEditorLines: editorLoc?.lines,
      lastChapterTitle: this.currentChapter?.title,
      chunkNumber,
    });

    const localParser = new DirectiveParser(targetTurnId);
    const localEntries: TurnSynthesisEntry[] = [];
    let localSeq = 0;
    let activeSynth = 0;
    const synthQueue: Array<() => void> = [];
    let chunkDone = false;

    const runWithConcurrency = <T>(fn: () => Promise<T>): Promise<T> => {
      return new Promise<T>((resolve, reject) => {
        const exec = () => {
          if (
            abortCtrl.signal.aborted ||
            gen !== this.prefetchGeneration ||
            targetTurnId !== this.activeTurnId
          ) {
            reject(new Error('Prefetch aborted'));
            return;
          }
          activeSynth += 1;
          fn()
            .then(resolve, reject)
            .finally(() => {
              activeSynth -= 1;
              const next = synthQueue.shift();
              if (next) {
                next();
              }
            });
        };
        if (activeSynth < MAX_TTS_CONCURRENCY) {
          exec();
        } else {
          synthQueue.push(exec);
        }
      });
    };

    const enqueueLocal = (seg: UtteranceSegment): void => {
      if (
        abortCtrl.signal.aborted ||
        gen !== this.prefetchGeneration ||
        targetTurnId !== this.activeTurnId
      ) {
        return;
      }
      for (const dir of [...seg.directivesBefore, ...seg.directivesAfter]) {
        if (dir.type === 'walkthrough_done') {
          chunkDone = true;
        }
      }
      if (
        !seg.spokenText.trim() &&
        seg.directivesBefore.every((d) => d.type === 'walkthrough_done') &&
        seg.directivesAfter.every((d) => d.type === 'walkthrough_done')
      ) {
        return;
      }
      localSeq += 1;
      const stamped: UtteranceSegment = {
        ...seg,
        turnId: targetTurnId,
        segmentId: `t${targetTurnId}-c${chunkNumber}-s${localSeq}`,
      };
      const ttsText = normalizeTextForTts(stamped.spokenText);
      const promise =
        this.ttsMuted || !ttsText
          ? Promise.resolve<TtsAudioResult>({
              audioBase64: '',
              mimeType: '',
              fallbackTextOnly: true,
            })
          : runWithConcurrency(() =>
              this.deps.speech.synthesizeWithFallback(ttsText, {
                voice: this.config.ttsVoice,
                rate: this.config.ttsRate,
                signal: abortCtrl.signal,
              })
            );
      localEntries.push({ segment: stamped, promise });
    };

    this.deps.logger?.log(
      'prefetch.start',
      { chunkNumber, mode: promptMode },
      targetTurnId
    );

    try {
      await this.deps.acpClient.sendPrompt(promptText, {
        onTextDelta: (delta) => {
          if (
            abortCtrl.signal.aborted ||
            gen !== this.prefetchGeneration ||
            targetTurnId !== this.activeTurnId
          ) {
            return;
          }
          for (const seg of localParser.feed(delta)) {
            enqueueLocal(seg);
          }
        },
        onThoughtDelta: () => undefined,
        onToolActivity: () => undefined,
      });

      if (
        abortCtrl.signal.aborted ||
        gen !== this.prefetchGeneration ||
        targetTurnId !== this.activeTurnId
      ) {
        return;
      }

      for (const seg of localParser.flush()) {
        enqueueLocal(seg);
      }

      const payloads: AudioSegmentPayload[] = [];
      for (const entry of localEntries) {
        if (
          abortCtrl.signal.aborted ||
          gen !== this.prefetchGeneration ||
          targetTurnId !== this.activeTurnId
        ) {
          return;
        }
        let audioResult: TtsAudioResult;
        try {
          audioResult = await entry.promise;
        } catch {
          if (
            abortCtrl.signal.aborted ||
            gen !== this.prefetchGeneration ||
            targetTurnId !== this.activeTurnId
          ) {
            return;
          }
          audioResult = { audioBase64: '', mimeType: '', fallbackTextOnly: true };
        }
        payloads.push({
          segment: entry.segment,
          audioBase64: audioResult.audioBase64,
          mimeType: audioResult.mimeType,
          ttsRate: this.config.ttsRate,
          fallbackTextOnly: audioResult.fallbackTextOnly,
          muted: this.ttsMuted,
        });
      }

      if (
        abortCtrl.signal.aborted ||
        gen !== this.prefetchGeneration ||
        targetTurnId !== this.activeTurnId
      ) {
        return;
      }

      this.prefetchRunning = false;
      this.prefetchAbort = null;

      if (payloads.length === 0) {
        this.walkthroughDone = true;
        this.deps.logger?.log('prefetch.empty', { chunkNumber }, targetTurnId);
        if (!this.currentPlayingSegment && this.phase === 'thinking') {
          this.setPhase('idle', '全部导读已完成，可随时提问或点击重放');
          this.updateActivity(
            { stage: 'idle', headline: '导读已全部完成，可随时提问或重放' },
            { force: true, statusBarSummary: '' }
          );
        }
        return;
      }

      this.prefetchChunks.push({ payloads, walkthroughDone: chunkDone });
      this.autoContinueCount += 1;
      this.deps.logger?.log(
        'prefetch.ready',
        { chunkNumber, segmentCount: payloads.length, walkthroughDone: chunkDone },
        targetTurnId
      );

      if (
        !this.paused &&
        !this.isReplaying &&
        (this.remainingUnplayedInWebview() <= PREFETCH_FLUSH_LOW_WATERMARK ||
          (!this.currentPlayingSegment && this.phase === 'thinking'))
      ) {
        this.flushNextPrefetchedChunk();
      }
      this.drainPendingMermaidRepair();
    } catch (err) {
      if (gen !== this.prefetchGeneration || targetTurnId !== this.activeTurnId) {
        return;
      }
      this.prefetchRunning = false;
      this.prefetchAbort = null;
      this.deps.logger?.log(
        'prefetch.error',
        { chunkNumber, message: err instanceof Error ? err.message : String(err) },
        targetTurnId
      );
      if (!this.drainPendingMermaidRepair()) {
        if (!this.currentPlayingSegment && this.phase === 'thinking') {
          this.setPhase('idle', '等待你的提问，可随时直接开口或点击白板节点');
          this.updateActivity(
            { stage: 'idle', headline: '本轮导读完成，可随时提问或点击白板节点' },
            { force: true, statusBarSummary: '' }
          );
        }
      }
    }
  }

  private flushNextPrefetchedChunk(): boolean {
    if (this.paused || this.isReplaying || this.prefetchChunks.length === 0) {
      return false;
    }
    const chunk = this.prefetchChunks.shift()!;
    if (chunk.walkthroughDone) {
      this.walkthroughDone = true;
    }

    let groupId = ++this.replayGroupSeq;
    for (const rawPayload of chunk.payloads) {
      const seg: UtteranceSegment = {
        ...rawPayload.segment,
        turnId: this.activeTurnId,
      };
      if (seg.directivesBefore.some((d) => d.type === 'chapter')) {
        groupId = ++this.replayGroupSeq;
      }
      const payload: AudioSegmentPayload = {
        ...rawPayload,
        segment: seg,
        ttsRate: this.config.ttsRate,
        muted: this.ttsMuted,
      };
      this.turnSegments.push(seg);
      this.activity.counters.segmentsParsed += 1;
      this.activity.counters.ttsReady += 1;
      this.recordWhiteboardDirectives(seg.directivesBefore);
      this.recordWhiteboardDirectives(seg.directivesAfter);
      this.recordTimelineEntry(payload, groupId);
      this.enqueuedSegmentCount += 1;
      this.deps.whiteboard.postMessage({
        type: 'audio:enqueue',
        payload,
      });
    }

    this.emitReplayStatus();
    if (this.canAutoContinue()) {
      this.maybeStartPrefetch();
    }
    return true;
  }

  private recordTimelineEntry(payload: AudioSegmentPayload, groupId: number): void {
    const preState: ReplayPreStateSnapshot = {
      diagramTree: cloneWhiteboardTreeState(this.replayShadowTree),
      callChain: this.replayShadowCallChain
        ? cloneCallChainState(this.replayShadowCallChain)
        : null,
      chapter: this.replayShadowChapter ? { ...this.replayShadowChapter } : undefined,
    };

    const allDirs = [...payload.segment.directivesBefore, ...payload.segment.directivesAfter];
    for (const dir of allDirs) {
      if (
        dir.type === 'wb_render' ||
        dir.type === 'wb_focus' ||
        dir.type === 'wb_pop' ||
        dir.type === 'wb_clear'
      ) {
        this.replayShadowTree = applyWhiteboardDirective(this.replayShadowTree, dir);
      } else if (dir.type === 'chapter') {
        this.replayShadowChapter = {
          index: dir.index,
          total: dir.total,
          title: dir.title,
        };
      } else if (dir.type === 'call_chain') {
        this.replayShadowCallChain = {
          title: dir.title,
          nodes: dir.nodes.map((n) => ({ ...n })),
          activeIndex: dir.activeIndex,
          source: 'agent',
        };
      }
    }

    const activeDiag = getActiveTreeDiagram(this.replayShadowTree);
    const groupTitle =
      this.replayShadowChapter?.title ||
      activeDiag?.title ||
      `片段 #${this.replayTimeline.length + 1}`;

    this.replayTimeline.push({
      index: this.replayTimeline.length,
      groupId,
      groupTitle,
      payload: {
        ...payload,
        segment: {
          ...payload.segment,
          directivesBefore: [...payload.segment.directivesBefore],
          directivesAfter: [...payload.segment.directivesAfter],
        },
      },
      preState,
    });
  }

  private buildReplayStatus(): ReplayStatusState {
    const checkpoints: ReplayCheckpoint[] = [];
    for (const entry of this.replayTimeline) {
      const prev = checkpoints[checkpoints.length - 1];
      if (!prev || this.replayTimeline[prev.startIndex].groupId !== entry.groupId) {
        checkpoints.push({
          startIndex: entry.index,
          segmentCount: 1,
          title: entry.groupTitle,
        });
      } else {
        prev.segmentCount += 1;
        prev.title = entry.groupTitle || prev.title;
      }
    }
    return {
      totalSegments: this.replayTimeline.length,
      isReplaying: this.isReplaying,
      currentIndex: this.isReplaying ? this.replayCurrentIndex : undefined,
      checkpoints,
    };
  }

  private emitReplayStatus(): void {
    this.deps.whiteboard.postMessage({
      type: 'replay:status',
      status: this.buildReplayStatus(),
    });
  }

  private projectDiagramTreeWithBuffer(): string | undefined {
    let projected = cloneWhiteboardTreeState(this.diagramTree);
    for (const chunk of this.prefetchChunks) {
      for (const p of chunk.payloads) {
        for (const dir of [...p.segment.directivesBefore, ...p.segment.directivesAfter]) {
          if (
            dir.type === 'wb_render' ||
            dir.type === 'wb_focus' ||
            dir.type === 'wb_pop' ||
            dir.type === 'wb_clear'
          ) {
            projected = applyWhiteboardDirective(projected, dir);
          }
        }
      }
    }
    return formatWhiteboardTreeOutline(projected) || undefined;
  }

  private scheduleMermaidAutoRepair(
    diagramId: string | undefined,
    error: string,
    mermaidCode: string
  ): void {
    if (!this.target || this.isReplaying) {
      return;
    }
    const targetId = diagramId?.trim() || this.getActiveDiagram()?.id;
    if (!targetId) {
      return;
    }
    const usedAttempts = this.mermaidRepairAttempts.get(targetId) ?? 0;
    if (usedAttempts >= MAX_MERMAID_REPAIR_ATTEMPTS) {
      this.deps.logger?.log('whiteboard.mermaid_repair_exhausted', {
        diagramId: targetId,
        attempts: usedAttempts,
      });
      return;
    }
    if (this.promptRunning || this.prefetchRunning || this.mermaidRepairRunning) {
      this.pendingMermaidRepair = { diagramId: targetId, error, mermaidCode };
      this.deps.logger?.log('whiteboard.mermaid_repair_queued', {
        diagramId: targetId,
        usedAttempts,
      });
      return;
    }
    void this.runMermaidRepair({ diagramId: targetId, error, mermaidCode });
  }

  private drainPendingMermaidRepair(): boolean {
    if (
      !this.pendingMermaidRepair ||
      this.promptRunning ||
      this.prefetchRunning ||
      this.mermaidRepairRunning ||
      this.isReplaying
    ) {
      return false;
    }
    const next = this.pendingMermaidRepair;
    this.pendingMermaidRepair = null;
    this.scheduleMermaidAutoRepair(next.diagramId, next.error, next.mermaidCode);
    return true;
  }

  private cancelMermaidRepair(): void {
    const wasRunning = this.mermaidRepairRunning;
    this.mermaidRepairGeneration += 1;
    if (this.mermaidRepairAbort) {
      this.mermaidRepairAbort.abort();
      this.mermaidRepairAbort = null;
    }
    this.mermaidRepairRunning = false;
    this.pendingMermaidRepair = null;
    if (wasRunning) {
      this.deps.acpClient.cancel();
    }
  }

  private async runMermaidRepair(req: {
    diagramId: string;
    error: string;
    mermaidCode: string;
  }): Promise<void> {
    if (!this.target) {
      return;
    }
    const attempt = (this.mermaidRepairAttempts.get(req.diagramId) ?? 0) + 1;
    this.mermaidRepairAttempts.set(req.diagramId, attempt);

    const gen = ++this.mermaidRepairGeneration;
    const turnId = this.activeTurnId;
    const abortCtrl = new AbortController();
    this.mermaidRepairAbort = abortCtrl;
    this.mermaidRepairRunning = true;

    const existingNode = this.diagramTree.nodes.find((n) => n.id === req.diagramId);
    const existingTitle = existingNode?.title || req.diagramId;

    const repairPrompt = buildMermaidRepairPrompt({
      diagramId: req.diagramId,
      title: existingTitle,
      error: req.error,
      brokenMermaidCode: req.mermaidCode,
    });

    this.deps.logger?.log(
      'whiteboard.mermaid_repair_start',
      { diagramId: req.diagramId, attempt },
      turnId
    );

    const localParser = new DirectiveParser(turnId);
    let rawResponseText = '';
    const parsedSegments: UtteranceSegment[] = [];

    try {
      await this.deps.acpClient.sendPrompt(repairPrompt, {
        onTextDelta: (delta) => {
          if (
            abortCtrl.signal.aborted ||
            gen !== this.mermaidRepairGeneration ||
            turnId !== this.activeTurnId
          ) {
            return;
          }
          rawResponseText += delta;
          parsedSegments.push(...localParser.feed(delta));
        },
        onThoughtDelta: () => undefined,
        onToolActivity: () => undefined,
      });

      if (
        abortCtrl.signal.aborted ||
        gen !== this.mermaidRepairGeneration ||
        turnId !== this.activeTurnId
      ) {
        return;
      }

      parsedSegments.push(...localParser.flush());
      const wbDirectives = parsedSegments
        .flatMap((s) => [...s.directivesBefore, ...s.directivesAfter])
        .filter((d): d is WbRenderDirective => d.type === 'wb_render');

      let fixedDir: WbRenderDirective | undefined = wbDirectives[wbDirectives.length - 1];
      if (!fixedDir) {
        const sanitizedFallback = sanitizeMermaidCode(rawResponseText);
        if (sanitizedFallback) {
          fixedDir = {
            type: 'wb_render',
            id: req.diagramId,
            targetId: req.diagramId,
            title: existingTitle,
            mode: 'update',
            mermaidCode: sanitizedFallback,
            nodeCodeMap: existingNode?.nodeCodeMap,
          };
        }
      }

      if (fixedDir) {
        const normalizedFixed: WbRenderDirective = {
          ...fixedDir,
          type: 'wb_render',
          id: req.diagramId,
          targetId: req.diagramId,
          title: fixedDir.title || existingTitle,
          mode: 'update',
          nodeCodeMap: fixedDir.nodeCodeMap ?? existingNode?.nodeCodeMap,
        };
        this.recordWhiteboardDirectives([normalizedFixed]);
        this.patchReplayTimelineDiagram(normalizedFixed);
        this.postSyncWhiteboardTree();
        this.deps.logger?.log(
          'whiteboard.mermaid_repaired',
          { diagramId: req.diagramId, attempt },
          turnId
        );
      } else {
        this.deps.logger?.log(
          'whiteboard.mermaid_repair_empty',
          { diagramId: req.diagramId, attempt },
          turnId
        );
      }
    } catch (err) {
      if (gen === this.mermaidRepairGeneration && turnId === this.activeTurnId) {
        this.deps.logger?.log(
          'whiteboard.mermaid_repair_error',
          {
            diagramId: req.diagramId,
            attempt,
            message: err instanceof Error ? err.message : String(err),
          },
          turnId
        );
      }
    } finally {
      if (gen === this.mermaidRepairGeneration) {
        this.mermaidRepairRunning = false;
        this.mermaidRepairAbort = null;
        if (!this.drainPendingMermaidRepair()) {
          this.maybeStartPrefetch();
        }
      }
    }
  }

  private patchReplayTimelineDiagram(fixed: WbRenderDirective): void {
    this.replayShadowTree = applyWhiteboardDirective(this.replayShadowTree, fixed);
    for (const entry of this.replayTimeline) {
      entry.payload.segment.directivesBefore = entry.payload.segment.directivesBefore.map(
        (d) => (d.type === 'wb_render' && d.id === fixed.id ? { ...fixed } : d)
      );
      entry.payload.segment.directivesAfter = entry.payload.segment.directivesAfter.map(
        (d) => (d.type === 'wb_render' && d.id === fixed.id ? { ...fixed } : d)
      );
      entry.preState.diagramTree = {
        ...entry.preState.diagramTree,
        nodes: entry.preState.diagramTree.nodes.map((n) =>
          n.id === fixed.id
            ? {
                ...n,
                title: fixed.title || n.title,
                mermaidCode: fixed.mermaidCode,
                nodeCodeMap: fixed.nodeCodeMap ?? n.nodeCodeMap,
              }
            : n
        ),
      };
    }
  }
}

function cloneWhiteboardTreeState(tree: WhiteboardTreeState): WhiteboardTreeState {
  return {
    nodes: tree.nodes.map((n) => ({
      ...n,
      nodeCodeMap: n.nodeCodeMap ? { ...n.nodeCodeMap } : undefined,
    })),
    activeId: tree.activeId,
    lastChildByParent: { ...tree.lastChildByParent },
  };
}

function cloneCallChainState(chain: CallChainState): CallChainState {
  return {
    ...chain,
    nodes: chain.nodes.map((n) => ({ ...n })),
  };
}

export function findNodeIdForFile(
  diagram: DiagramStackItem | undefined,
  relFile: string
): string | undefined {
  if (!diagram) {
    return undefined;
  }
  const cleanTarget = relFile.replace(/\\/g, '/').replace(/^\/+/, '');
  const cleanLower = cleanTarget.toLowerCase();
  const basename = (cleanLower.split('/').pop() ?? cleanLower).replace(/\.[^.]+$/, '');

  // 1. Check explicit nodeCodeMap entries
  if (diagram.nodeCodeMap) {
    for (const [nodeId, rawTarget] of Object.entries(diagram.nodeCodeMap)) {
      const parsed = parseCodeMapTarget(rawTarget);
      if (!parsed) {
        continue;
      }
      const mapped = parsed.file.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
      if (
        mapped === cleanLower ||
        cleanLower.endsWith(`/${mapped}`) ||
        mapped.endsWith(`/${cleanLower}`)
      ) {
        return nodeId;
      }
    }
    for (const [nodeId, rawTarget] of Object.entries(diagram.nodeCodeMap)) {
      const parsed = parseCodeMapTarget(rawTarget);
      if (!parsed) {
        continue;
      }
      const mappedBase = (parsed.file.toLowerCase().split('/').pop() ?? '').replace(
        /\.[^.]+$/,
        ''
      );
      if (mappedBase && mappedBase === basename) {
        return nodeId;
      }
    }
  }

  // 2. Fallback: match node definitions in Mermaid source against filename stem tokens
  if (!basename || basename.length < 3) {
    return undefined;
  }
  const tokens = [
    basename,
    ...basename
      .split(/[_\-.]+/)
      .filter((t) => t.length >= 4 && !['test', 'spec', 'index', 'utils'].includes(t)),
  ];

  const nodeDefRegex = /\b([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\[\s*"?([^"\]\n]+)"?\s*\]|\(\s*"?([^")\n]+)"?\s*\)|\{\s*"?([^"}\n]+)"?\s*\})/g;
  let match: RegExpExecArray | null;
  while ((match = nodeDefRegex.exec(diagram.mermaidCode)) !== null) {
    const nodeId = match[1];
    const label = (match[2] ?? match[3] ?? match[4] ?? '').toLowerCase();
    const idLower = nodeId.toLowerCase();
    for (const tok of tokens) {
      if (idLower.includes(tok) || label.includes(tok)) {
        return nodeId;
      }
    }
  }

  return undefined;
}

export function parseCodeMapTarget(
  raw: string
): { file: string; lines?: LineRange } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(.+?):(\d+)(?:-(\d+))?$/);
  if (match) {
    const start = Number.parseInt(match[2], 10);
    const end = match[3] ? Number.parseInt(match[3], 10) : start;
    return {
      file: match[1].trim(),
      lines: { start, end: Math.max(start, end) },
    };
  }
  return { file: trimmed };
}

function createIdleActivityState(): AgentActivityState {
  const now = Date.now();
  return {
    stage: 'idle',
    headline: '待命中，可随时启动导读或提问',
    startedAtMs: now,
    lastHeartbeatMs: now,
    counters: {
      thoughtChars: 0,
      outputChars: 0,
      filesRead: 0,
      segmentsParsed: 0,
      ttsReady: 0,
      segmentsPlayed: 0,
    },
    recentFiles: [],
    recentLogs: [],
  };
}

function formatLineRange(line?: number, limit?: number): string | undefined {
  if (line === undefined || line <= 0) {
    return undefined;
  }
  if (limit !== undefined && limit > 1) {
    return `L${line}-${line + limit - 1}`;
  }
  return `L${line}`;
}

export function parseHunkHeadRanges(hunkHeaders: string[]): LineRange[] {
  const ranges: LineRange[] = [];
  for (const header of hunkHeaders) {
    const m = header.match(/\+(\d+)(?:,(\d+))?/);
    if (!m) {
      continue;
    }
    const start = Number.parseInt(m[1], 10);
    if (!Number.isFinite(start) || start <= 0) {
      continue;
    }
    const count = m[2] !== undefined ? Number.parseInt(m[2], 10) : 1;
    const end = count <= 1 ? start : start + count - 1;
    ranges.push({ start, end });
  }
  return ranges;
}

export function resolveBestDefaultLinesForFile(
  relFile: string,
  contextPack: ReviewContextPack | undefined
): LineRange | undefined {
  if (!contextPack) {
    return undefined;
  }
  const normalizeRel = (p: string) =>
    p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  const cleanRel = normalizeRel(relFile);
  const cleanLower = cleanRel.toLowerCase();
  const changedFile =
    contextPack.files.find((f) => normalizeRel(f.path) === cleanRel) ??
    contextPack.files.find((f) => normalizeRel(f.path).toLowerCase() === cleanLower);
  if (!changedFile) {
    return undefined;
  }

  const hunkRanges = parseHunkHeadRanges(changedFile.hunkHeaders);
  const nonImportHunk = hunkRanges.find((h) => h.start > 15);
  if (nonImportHunk) {
    return {
      start: nonImportHunk.start,
      end: Math.min(nonImportHunk.end, nonImportHunk.start + 7),
    };
  }

  const symLines: number[] = [];
  if (changedFile.touchedSymbols) {
    for (const sym of changedFile.touchedSymbols) {
      const m = sym.match(/\(L(\d+)\)/);
      if (m) {
        const line = Number.parseInt(m[1], 10);
        if (Number.isFinite(line) && line > 0) {
          symLines.push(line);
        }
      }
    }
  }
  const deepSym = symLines.find((l) => l > 15);
  if (deepSym !== undefined) {
    return { start: deepSym, end: deepSym + 7 };
  }
  const anyRealSym = symLines.find((l) => l > 1);
  if (anyRealSym !== undefined) {
    return { start: anyRealSym, end: anyRealSym + 7 };
  }

  const firstHunk = hunkRanges[0];
  if (firstHunk) {
    return {
      start: firstHunk.start,
      end: Math.min(firstHunk.end, firstHunk.start + 7),
    };
  }
  return undefined;
}

export function resolveCodeGotoView(
  cmd: CodeGotoDirective,
  contextPack: ReviewContextPack | undefined,
  preferredViewMode: CodeViewMode
): { view: CodeViewMode; isModifiedFile: boolean } {
  if (contextPack?.target.kind === 'branch-explore') {
    return {
      view: 'source',
      isModifiedFile: false,
    };
  }

  const normalizeRel = (p: string) =>
    p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  const cleanRel = normalizeRel(cmd.file);
  const cleanLower = cleanRel.toLowerCase();

  const changedFile = contextPack
    ? contextPack.files.find((f) => normalizeRel(f.path) === cleanRel) ??
      contextPack.files.find((f) => normalizeRel(f.path).toLowerCase() === cleanLower)
    : undefined;
  const isModifiedFile = contextPack ? Boolean(changedFile) : true;

  // Sticky user preference: when the user wants Source View (the default),
  // jumping to another file must NEVER flip them back to Diff View.
  if (preferredViewMode === 'source') {
    return {
      view: 'source',
      isModifiedFile,
    };
  }

  if (!contextPack) {
    return {
      view: cmd.view ?? preferredViewMode,
      isModifiedFile: true,
    };
  }

  if (!changedFile) {
    return {
      view: 'source',
      isModifiedFile: false,
    };
  }

  if (cmd.view === 'source') {
    return {
      view: 'source',
      isModifiedFile: true,
    };
  }

  if (cmd.lines && changedFile.hunkHeaders.length > 0) {
    const hunkRanges = parseHunkHeadRanges(changedFile.hunkHeaders);
    const HUNK_MARGIN = 15;
    const overlapsAny = hunkRanges.some(
      (h) =>
        cmd.lines!.end >= Math.max(1, h.start - HUNK_MARGIN) &&
        cmd.lines!.start <= h.end + HUNK_MARGIN
    );
    if (hunkRanges.length > 0 && !overlapsAny) {
      return {
        view: 'source',
        isModifiedFile: true,
      };
    }
  }

  return {
    view: cmd.view ?? preferredViewMode,
    isModifiedFile: true,
  };
}

function extractThoughtPreview(tail: string): string | undefined {
  const lines = tail
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^[\s>#*\-\d.]+/, '')
        .replace(/[*`]/g, '')
        .trim()
    )
    .filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }
  const latest = lines[lines.length - 1];
  return latest.length > 90 ? `...${latest.slice(-87)}` : latest;
}
