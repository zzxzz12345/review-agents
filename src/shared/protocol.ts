export interface LineRange {
  start: number;
  end: number;
}

export type CodeViewMode = 'diff' | 'source';

export type VoiceMode = 'vad' | 'ptt';

export type SessionPhase =
  | 'idle'
  | 'analyzing'
  | 'connecting'
  | 'thinking'
  | 'speaking'
  | 'listening'
  | 'paused'
  | 'error';

export type AgentActivityStage =
  | 'idle'
  | 'analyzing'
  | 'connecting'
  | 'thinking'
  | 'reading_file'
  | 'tool_call'
  | 'streaming'
  | 'synthesizing'
  | 'speaking'
  | 'paused'
  | 'listening'
  | 'audio_blocked'
  | 'error';

export interface AgentActivityFileEntry {
  path: string;
  lineRange?: string;
  status: 'reading' | 'done' | 'error';
  updatedAtMs: number;
}

export interface AgentActivityLogEntry {
  id: string;
  ts: number;
  stage: AgentActivityStage;
  text: string;
}

export interface AgentActivityState {
  stage: AgentActivityStage;
  headline: string;
  detail?: string;
  currentFile?: string;
  thoughtPreview?: string;
  startedAtMs: number;
  lastHeartbeatMs: number;
  counters: {
    thoughtChars: number;
    outputChars: number;
    filesRead: number;
    segmentsParsed: number;
    ttsReady: number;
    segmentsPlayed: number;
  };
  recentFiles: AgentActivityFileEntry[];
  recentLogs: AgentActivityLogEntry[];
}

export type WbRenderMode = 'replace' | 'push' | 'update';

export interface WbRenderDirective {
  type: 'wb_render';
  id: string;
  title: string;
  mode: WbRenderMode;
  targetId?: string;
  parentId?: string;
  mermaidCode: string;
  nodeCodeMap?: Record<string, string>;
}

export interface WbFocusDirective {
  type: 'wb_focus';
  id: string;
  edge?: string;
}

export interface WbPopDirective {
  type: 'wb_pop';
}

export interface WbClearDirective {
  type: 'wb_clear';
}

export interface CodeGotoDirective {
  type: 'code_goto';
  file: string;
  lines?: LineRange;
  view?: CodeViewMode;
  label?: string;
}

export interface ChapterDirective {
  type: 'chapter';
  index: number;
  total: number;
  title: string;
}

export interface ReviewNoteDirective {
  type: 'review_note';
  file: string;
  line: number;
  severity: 'info' | 'warning' | 'issue' | 'action';
  body: string;
}

export interface IncomingCallerItem {
  id: string;
  symbol: string;
  file: string;
  line: number;
  detail?: string;
  source: 'lsp' | 'scan';
}

export interface CallChainNode {
  id: string;
  symbol: string;
  file: string;
  line: number;
  endLine?: number;
  role?: string;
  verified?: boolean;
}

export interface CallChainState {
  title: string;
  nodes: CallChainNode[];
  activeIndex: number;
  source: 'agent' | 'lsp';
}

export interface CallChainDirective {
  type: 'call_chain';
  title: string;
  nodes: CallChainNode[];
  activeIndex: number;
}

export interface WalkthroughDoneDirective {
  type: 'walkthrough_done';
}

export type Directive =
  | WbRenderDirective
  | WbFocusDirective
  | WbPopDirective
  | WbClearDirective
  | CodeGotoDirective
  | ChapterDirective
  | ReviewNoteDirective
  | CallChainDirective
  | WalkthroughDoneDirective;

export interface UtteranceSegment {
  segmentId: string;
  turnId: number;
  spokenText: string;
  directivesBefore: Directive[];
  directivesAfter: Directive[];
}

export interface AudioSegmentPayload {
  segment: UtteranceSegment;
  audioBase64: string;
  mimeType: string;
  ttsRate: number;
  fallbackTextOnly?: boolean;
  muted?: boolean;
}

export interface DiagramStackItem {
  id: string;
  title: string;
  mermaidCode: string;
  nodeCodeMap?: Record<string, string>;
  focusedNodeId?: string;
  focusedEdge?: string;
  parentId?: string;
  level?: number;
  revision?: number;
}

export interface ChapterProgress {
  index: number;
  total: number;
  title: string;
}

export interface ReviewNoteDraft {
  id: string;
  file: string;
  line: number;
  severity: 'info' | 'warning' | 'issue' | 'action';
  body: string;
  createdAt: string;
  published?: boolean;
}

export interface EditorLocationState {
  file: string;
  lines?: LineRange;
  view: CodeViewMode;
  label?: string;
}

export interface InterruptionSnapshot {
  turnId: number;
  spokenAlready: string;
  unspokenCutOff: string;
  diagramId?: string;
  focusedNodeId?: string;
  stackPath: string;
  treeOutline?: string;
  editorState?: EditorLocationState;
}

export interface WebviewPlaybackCutoff {
  turnId: number;
  segmentId?: string;
  spokenCharOffset: number;
}

export type ReviewModeStyle =
  | 'walkthrough'
  | 'branch-explore'
  | 'core-path-line-review';

export interface SessionMetaState {
  targetTitle: string;
  targetSubtitle: string;
  sourceKind: 'local-diff' | 'bitbucket-pr' | 'branch-explore';
  reviewMode?: ReviewModeStyle;
  acpProfileLabel: string;
  viewMode: CodeViewMode;
  voiceMode: VoiceMode;
  vadBargeInMs: number;
  vadSilenceMs: number;
  isPoppedOut: boolean;
  ttsMuted: boolean;
  autoContinue?: boolean;
  activeEditorFile?: string;
  activeEditorLabel?: string;
}

export interface ReplayCheckpoint {
  startIndex: number;
  segmentCount: number;
  title: string;
}

export interface ReplayStatusState {
  totalSegments: number;
  isReplaying: boolean;
  currentIndex?: number;
  checkpoints: ReplayCheckpoint[];
}

export type HostToWebviewMessage =
  | {
      type: 'session:state';
      phase: SessionPhase;
      statusMessage?: string;
      meta?: Partial<SessionMetaState>;
    }
  | {
      type: 'audio:enqueue';
      payload: AudioSegmentPayload;
    }
  | {
      type: 'audio:clear';
      turnId: number;
    }
  | {
      type: 'audio:setPaused';
      paused: boolean;
    }
  | {
      type: 'directive:apply';
      directive: Directive;
    }
  | {
      type: 'whiteboard:syncStack';
      stack: DiagramStackItem[];
      activeIndex?: number;
      nodes?: DiagramStackItem[];
      activeId?: string;
    }
  | {
      type: 'chapter:update';
      chapter: ChapterProgress;
    }
  | {
      type: 'subtitle:update';
      text: string;
      isSpeaking: boolean;
    }
  | {
      type: 'notes:sync';
      notes: ReviewNoteDraft[];
    }
  | {
      type: 'notice:toast';
      level: 'info' | 'warn' | 'error';
      message: string;
    }
  | {
      type: 'activity:update';
      activity: AgentActivityState;
    }
  | {
      type: 'mic:state';
      active: boolean;
      isUserSpeaking: boolean;
      level: number;
      backend?: string;
    }
  | {
      type: 'callChain:sync';
      chain: CallChainState | null;
    }
  | {
      type: 'callChain:callersResult';
      nodeId: string;
      callers: IncomingCallerItem[];
      source: 'lsp' | 'scan' | 'none';
      note?: string;
    }
  | {
      type: 'replay:status';
      status: ReplayStatusState;
    }
  | {
      type: 'export:renderDiagrams';
      requestId: string;
      diagrams: Array<{ key: string; mermaidCode: string }>;
    };

export type WebviewToHostMessage =
  | { type: 'webview:ready' }
  | { type: 'playback:segmentStarted'; segment: UtteranceSegment }
  | { type: 'playback:segmentEnded'; segment: UtteranceSegment }
  | { type: 'playback:queueEmpty'; turnId: number }
  | { type: 'playback:paused' }
  | { type: 'playback:resumed' }
  | {
      type: 'voice:bargeIn';
      cutoff: WebviewPlaybackCutoff;
      diagramState: {
        diagramId?: string;
        focusedNodeId?: string;
        stackPath: string;
      };
    }
  | {
      type: 'voice:utteranceAudio';
      audioWavBase64: string;
      selectedNodeId?: string;
    }
  | {
      type: 'text:userPrompt';
      text: string;
      selectedNodeId?: string;
    }
  | { type: 'node:select'; nodeId?: string }
  | { type: 'node:doubleClick'; nodeId: string; codeTarget?: string }
  | { type: 'whiteboard:popTo'; index: number }
  | { type: 'whiteboard:selectLayer'; id: string }
  | { type: 'ui:toggleViewMode' }
  | { type: 'ui:popOutWindow' }
  | { type: 'ui:toggleVoiceMode'; mode: VoiceMode }
  | { type: 'ui:toggleMute'; muted: boolean }
  | { type: 'ui:toggleAutoContinue'; enabled: boolean }
  | { type: 'ui:switchTarget' }
  | { type: 'ui:startBranchExplore' }
  | { type: 'ui:startCorePathReview' }
  | { type: 'ui:publishOrExportNotes' }
  | { type: 'ui:exportHtmlWalkthrough' }
  | {
      type: 'export:diagramsRendered';
      requestId: string;
      svgs: Record<string, string>;
    }
  | {
      type: 'replay:start';
      mode: 'from-start' | 'current-section' | 'from-index';
      startIndex?: number;
    }
  | { type: 'replay:stop' }
  | { type: 'ui:addManualNote'; body: string }
  | { type: 'ui:deleteNote'; id: string }
  | { type: 'ui:gotoNote'; file: string; line: number }
  | {
      type: 'telemetry:mermaidError';
      diagramId?: string;
      error: string;
      mermaidCode: string;
    }
  | {
      type: 'telemetry:playbackEvent';
      kind:
        | 'audio_blocked'
        | 'audio_unlocked'
        | 'html_audio_fallback'
        | 'decode_error'
        | 'speech_synth_timeout';
      detail?: string;
    }
  | { type: 'mic:start' }
  | { type: 'mic:stop' }
  | { type: 'mic:pttStart' }
  | { type: 'mic:pttEnd' }
  | {
      type: 'callChain:gotoNode';
      file: string;
      line: number;
      endLine?: number;
      label?: string;
    }
  | {
      type: 'callChain:expandCallers';
      nodeId: string;
      file: string;
      line: number;
      symbol: string;
    }
  | { type: 'callChain:inspectCurrent' };
