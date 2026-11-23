import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentActivityState,
  CallChainNode,
  CallChainState,
  ChapterProgress,
  DiagramStackItem,
  Directive,
  ReviewNoteDraft,
  SessionMetaState,
  SessionPhase,
  UtteranceSegment,
  VoiceMode,
} from '../../src/shared/protocol';
import { AgentActivityBar } from './components/AgentActivityBar';
import { BreadcrumbStack } from './components/BreadcrumbStack';
import { CallChainSidebar, type CallersEntryState } from './components/CallChainSidebar';
import { MermaidStage } from './components/MermaidStage';
import { NotesDrawer } from './components/NotesDrawer';
import { SubtitleHud } from './components/SubtitleHud';
import { TopToolbar } from './components/TopToolbar';
import { VoiceControlBar } from './components/VoiceControlBar';
import { useAudioSyncQueue, type PlaybackEventKind } from './hooks/useAudioSyncQueue';
import { useVoiceVad } from './hooks/useVoiceVad';
import { onHostMessage, postToHost } from './vscodeApi';

interface ToastItem {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

const DEFAULT_META: SessionMetaState = {
  targetTitle: 'Review Agents',
  targetSubtitle: '可直接基于当前分支开始导读，或点击「切换目标」选择 PR / Diff',
  sourceKind: 'local-diff',
  acpProfileLabel: 'Antigravity (agy acp)',
  viewMode: 'source',
  voiceMode: 'vad',
  vadBargeInMs: 300,
  vadSilenceMs: 900,
  isPoppedOut: false,
  ttsMuted: false,
};

const DEFAULT_ACTIVITY: AgentActivityState = {
  stage: 'idle',
  headline: '待命中，可基于当前分支直接提问，或点击「切换目标」选择 PR',
  startedAtMs: Date.now(),
  lastHeartbeatMs: Date.now(),
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

export const App: React.FC = () => {
  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [statusMessage, setStatusMessage] = useState<string | undefined>();
  const [meta, setMeta] = useState<SessionMetaState>(DEFAULT_META);
  const [activity, setActivity] = useState<AgentActivityState>(DEFAULT_ACTIVITY);
  const [diagramNav, setDiagramNav] = useState<{
    items: DiagramStackItem[];
    activeIndex: number;
  }>({ items: [], activeIndex: -1 });
  const diagramNavRef = useRef(diagramNav);
  diagramNavRef.current = diagramNav;

  const [chapter, setChapter] = useState<ChapterProgress | undefined>();
  const [subtitleText, setSubtitleText] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [notes, setNotes] = useState<ReviewNoteDraft[]>([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [callChain, setCallChain] = useState<CallChainState | null>(null);
  const [callersMap, setCallersMap] = useState<Record<string, CallersEntryState | undefined>>({});
  const [callChainOpen, setCallChainOpen] = useState(false);
  const [callChainWidth, setCallChainWidth] = useState(270);
  const userSidebarOverrideRef = useRef(false);
  const workspaceBodyRef = useRef<HTMLDivElement | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [micState, setMicState] = useState({
    active: false,
    isUserSpeaking: false,
    level: 0,
  });

  const pushToast = useCallback(
    (level: 'info' | 'warn' | 'error', message: string) => {
      const id = Date.now() + Math.random();
      setToasts((prev) => [...prev.slice(-3), { id, level, message }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4500);
    },
    []
  );

  const applyLocalDirectives = useCallback((directives: Directive[]) => {
    for (const dir of directives) {
      if (dir.type === 'chapter') {
        setChapter({
          index: dir.index,
          total: dir.total,
          title: dir.title,
        });
      } else if (dir.type === 'wb_render') {
        const nextItem: DiagramStackItem = {
          id: dir.id,
          title: dir.title,
          mermaidCode: dir.mermaidCode,
          nodeCodeMap: dir.nodeCodeMap,
        };
        setDiagramNav((prev) => {
          if (dir.mode === 'push' && prev.items.length > 0) {
            const anchor =
              prev.activeIndex >= 0
                ? Math.min(prev.activeIndex, prev.items.length - 1)
                : prev.items.length - 1;
            const items = [...prev.items.slice(0, anchor + 1), nextItem];
            return { items, activeIndex: items.length - 1 };
          }
          return { items: [nextItem], activeIndex: 0 };
        });
      } else if (dir.type === 'wb_focus') {
        setDiagramNav((prev) => {
          if (prev.items.length === 0) {
            return prev;
          }
          const idx =
            prev.activeIndex >= 0
              ? Math.min(prev.activeIndex, prev.items.length - 1)
              : prev.items.length - 1;
          const items = [...prev.items];
          items[idx] = { ...items[idx], focusedNodeId: dir.id, focusedEdge: dir.edge };
          return { ...prev, items };
        });
      } else if (dir.type === 'wb_pop') {
        setDiagramNav((prev) => {
          if (prev.items.length <= 1) {
            return prev;
          }
          const idx =
            prev.activeIndex >= 0
              ? Math.min(prev.activeIndex, prev.items.length - 1)
              : prev.items.length - 1;
          if (idx <= 0) {
            return prev;
          }
          return { ...prev, activeIndex: idx - 1 };
        });
      } else if (dir.type === 'wb_clear') {
        setDiagramNav((prev) => {
          if (prev.items.length === 0) {
            return prev;
          }
          const idx =
            prev.activeIndex >= 0
              ? Math.min(prev.activeIndex, prev.items.length - 1)
              : prev.items.length - 1;
          const items = [...prev.items];
          items[idx] = {
            ...items[idx],
            focusedNodeId: undefined,
            focusedEdge: undefined,
          };
          return { ...prev, items };
        });
      }
    }
  }, []);

  const handleSegmentStarted = useCallback(
    (segment: UtteranceSegment) => {
      applyLocalDirectives(segment.directivesBefore);
      if (segment.spokenText) {
        setSubtitleText(segment.spokenText);
      }
      postToHost({ type: 'playback:segmentStarted', segment });
    },
    [applyLocalDirectives]
  );

  const handleSegmentEnded = useCallback(
    (segment: UtteranceSegment) => {
      applyLocalDirectives(segment.directivesAfter);
      postToHost({ type: 'playback:segmentEnded', segment });
    },
    [applyLocalDirectives]
  );

  const handleQueueEmpty = useCallback((turnId: number) => {
    postToHost({ type: 'playback:queueEmpty', turnId });
  }, []);

  const handlePlaybackEvent = useCallback(
    (kind: PlaybackEventKind, detail?: string) => {
      postToHost({ type: 'telemetry:playbackEvent', kind, detail });
    },
    []
  );

  const handlePauseStateChange = useCallback((paused: boolean) => {
    postToHost({ type: paused ? 'playback:paused' : 'playback:resumed' });
  }, []);

  const audioQueue = useAudioSyncQueue({
    onSegmentStarted: handleSegmentStarted,
    onSegmentEnded: handleSegmentEnded,
    onQueueEmpty: handleQueueEmpty,
    onPlaybackEvent: handlePlaybackEvent,
    onPauseStateChange: handlePauseStateChange,
  });

  const handleBargeIn = useCallback(() => {
    const cutoff = audioQueue.interruptAndFlush();
    const { items, activeIndex } = diagramNavRef.current;
    const idx = activeIndex >= 0 ? Math.min(activeIndex, items.length - 1) : items.length - 1;
    const active = idx >= 0 ? items[idx] : undefined;
    const visiblePath = idx >= 0 ? items.slice(0, idx + 1) : items;
    postToHost({
      type: 'voice:bargeIn',
      cutoff,
      diagramState: {
        diagramId: active?.id,
        focusedNodeId: active?.focusedNodeId,
        stackPath: visiblePath.map((d) => d.title || d.id).join(' > '),
      },
    });
  }, [audioQueue]);

  const voiceVad = useVoiceVad({
    voiceMode: meta.voiceMode,
    isAssistantSpeaking:
      (audioQueue.isSpeaking && !audioQueue.isPaused) || phase === 'speaking',
    micActive: micState.active,
    isUserSpeaking: micState.isUserSpeaking,
    micLevel: micState.level,
    onStartMic: () => postToHost({ type: 'mic:start' }),
    onStopMic: () => postToHost({ type: 'mic:stop' }),
    onPttStart: () => postToHost({ type: 'mic:pttStart' }),
    onPttEnd: () => postToHost({ type: 'mic:pttEnd' }),
    onBargeIn: handleBargeIn,
  });

  const audioQueueRef = useRef(audioQueue);
  audioQueueRef.current = audioQueue;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const applyLocalDirectivesRef = useRef(applyLocalDirectives);
  applyLocalDirectivesRef.current = applyLocalDirectives;
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;

  // Spacebar shortcut for Pause / Resume walkthrough
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) {
        return false;
      }
      const tag = el.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el.isContentEditable
      );
    };

    const canTogglePauseNow = () => {
      const q = audioQueueRef.current;
      const p = phaseRef.current;
      return q.isSpeaking || q.isPaused || p === 'speaking' || p === 'paused';
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.code !== 'Space' ||
        e.repeat ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.shiftKey
      ) {
        return;
      }
      if (isEditableTarget(e.target)) {
        return;
      }
      if (canTogglePauseNow()) {
        e.preventDefault();
        e.stopPropagation();
        audioQueueRef.current.togglePause();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isEditableTarget(e.target)) {
        return;
      }
      if (canTogglePauseNow()) {
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, []);

  useEffect(() => {
    const unsub = onHostMessage((msg) => {
      switch (msg.type) {
        case 'session:state':
          setPhase(msg.phase);
          setStatusMessage(msg.statusMessage);
          if (msg.meta) {
            setMeta((prev) => (shallowEqualSubset(prev, msg.meta!) ? prev : { ...prev, ...msg.meta }));
          }
          return;
        case 'audio:enqueue':
          audioQueueRef.current.enqueue(msg.payload);
          return;
        case 'audio:clear':
          audioQueueRef.current.interruptAndFlush(msg.turnId);
          return;
        case 'audio:setPaused':
          audioQueueRef.current.setPaused(msg.paused);
          return;
        case 'directive:apply':
          applyLocalDirectivesRef.current([msg.directive]);
          return;
        case 'whiteboard:syncStack':
          setDiagramNav({
            items: msg.stack,
            activeIndex:
              msg.activeIndex !== undefined ? msg.activeIndex : msg.stack.length - 1,
          });
          return;
        case 'chapter:update':
          setChapter(msg.chapter);
          return;
        case 'subtitle:update':
          setSubtitleText(msg.text);
          return;
        case 'notes:sync':
          setNotes(msg.notes);
          return;
        case 'notice:toast':
          pushToastRef.current(msg.level, msg.message);
          return;
        case 'activity:update':
          setActivity(msg.activity);
          return;
        case 'mic:state':
          setMicState({
            active: msg.active,
            isUserSpeaking: msg.isUserSpeaking,
            level: msg.level,
          });
          return;
        case 'callChain:sync':
          setCallChain(msg.chain);
          setCallersMap({});
          if (msg.chain && msg.chain.nodes.length > 0 && !userSidebarOverrideRef.current) {
            const bodyWidth = workspaceBodyRef.current?.clientWidth ?? 800;
            if (bodyWidth >= 680) {
              setCallChainOpen(true);
            }
          }
          return;
        case 'callChain:callersResult':
          setCallersMap((prev) => ({
            ...prev,
            [msg.nodeId]: {
              loading: false,
              callers: msg.callers,
              source: msg.source,
              note: msg.note,
              expanded: true,
            },
          }));
          return;
      }
    });

    postToHost({ type: 'webview:ready' });
    return unsub;
  }, []);

  useEffect(() => {
    const el = workspaceBodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      if (!userSidebarOverrideRef.current) {
        if (width < 680) {
          setCallChainOpen(false);
        } else if (callChain && callChain.nodes.length > 0) {
          setCallChainOpen(true);
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [callChain]);

  const startResizeSidebar = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = callChainWidth;
      const onMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX;
        const clamped = Math.max(200, Math.min(440, startW + delta));
        setCallChainWidth(clamped);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [callChainWidth]
  );

  const handleExpandCallers = useCallback(
    (node: CallChainNode) => {
      const existing = callersMap[node.id];
      if (existing && !existing.loading) {
        setCallersMap((prev) => ({
          ...prev,
          [node.id]: { ...existing, expanded: !existing.expanded },
        }));
        return;
      }
      setCallersMap((prev) => ({
        ...prev,
        [node.id]: {
          loading: true,
          callers: [],
          expanded: true,
        },
      }));
      postToHost({
        type: 'callChain:expandCallers',
        nodeId: node.id,
        file: node.file,
        line: node.line,
        symbol: node.symbol,
      });
    },
    [callersMap]
  );

  const activeIdx =
    diagramNav.activeIndex >= 0
      ? Math.min(diagramNav.activeIndex, diagramNav.items.length - 1)
      : diagramNav.items.length - 1;
  const currentDiagram = activeIdx >= 0 ? diagramNav.items[activeIdx] : undefined;

  return (
    <div className="ra-app">
      <TopToolbar
        phase={phase}
        statusMessage={statusMessage}
        meta={meta}
        notesCount={notes.length}
        notesOpen={notesOpen}
        callChainCount={callChain?.nodes.length ?? 0}
        callChainOpen={callChainOpen}
        onToggleViewMode={() => postToHost({ type: 'ui:toggleViewMode' })}
        onToggleCallChain={() => {
          userSidebarOverrideRef.current = true;
          setCallChainOpen((prev) => !prev);
        }}
        onPopOutWindow={() => postToHost({ type: 'ui:popOutWindow' })}
        onSwitchTarget={() => postToHost({ type: 'ui:switchTarget' })}
        onPublishOrExportNotes={() => setNotesOpen((prev) => !prev)}
      />

      <BreadcrumbStack
        stack={diagramNav.items}
        activeIndex={activeIdx}
        activeEditorFile={meta.activeEditorFile}
        activeEditorLabel={meta.activeEditorLabel}
        onPopTo={(index) => {
          setDiagramNav((prev) => ({ ...prev, activeIndex: index }));
          setSelectedNodeId(undefined);
          postToHost({ type: 'node:select', nodeId: undefined });
          postToHost({ type: 'whiteboard:popTo', index });
        }}
      />

      <AgentActivityBar
        activity={activity}
        audioBlocked={audioQueue.audioBlocked}
        isPaused={audioQueue.isPaused}
        onUnlockAudio={() => void audioQueue.unlockAudio()}
        onTogglePause={audioQueue.togglePause}
        onInterrupt={handleBargeIn}
      />

      {notesOpen && (
        <NotesDrawer
          notes={notes}
          onClose={() => setNotesOpen(false)}
          onGotoNote={(file, line) => postToHost({ type: 'ui:gotoNote', file, line })}
          onDeleteNote={(id) => postToHost({ type: 'ui:deleteNote', id })}
          onPublishOrExport={() => postToHost({ type: 'ui:publishOrExportNotes' })}
        />
      )}

      <div ref={workspaceBodyRef} className="ra-workspace-body">
        <MermaidStage
          diagram={currentDiagram}
          selectedNodeId={selectedNodeId}
          onSelectNode={(nodeId) => {
            setSelectedNodeId(nodeId);
            postToHost({ type: 'node:select', nodeId });
          }}
          onDoubleClickNode={(nodeId, codeTarget) => {
            postToHost({ type: 'node:doubleClick', nodeId, codeTarget });
          }}
          onStartBranchExplore={() => postToHost({ type: 'ui:startBranchExplore' })}
          onSwitchTarget={() => postToHost({ type: 'ui:switchTarget' })}
          onParseError={(info) => {
            postToHost({
              type: 'telemetry:mermaidError',
              diagramId: info.diagramId,
              error: info.error,
              mermaidCode: info.mermaidCode,
            });
          }}
        />

        {callChainOpen && (
          <>
            <div
              className="ra-sidebar-resizer"
              onMouseDown={startResizeSidebar}
              title="拖拽调整调用链栏宽度"
            />
            <CallChainSidebar
              chain={callChain}
              callersMap={callersMap}
              width={callChainWidth}
              onClose={() => {
                userSidebarOverrideRef.current = true;
                setCallChainOpen(false);
              }}
              onInspectCurrent={() => postToHost({ type: 'callChain:inspectCurrent' })}
              onGotoNode={(target) => postToHost({ type: 'callChain:gotoNode', ...target })}
              onExpandCallers={handleExpandCallers}
              onAskAboutNode={(node) => {
                if (audioQueue.isSpeaking) {
                  handleBargeIn();
                }
                const loc = node.file ? `（${node.file}:${node.line}）` : '';
                postToHost({
                  type: 'text:userPrompt',
                  text: `请重点讲一下主调用链中的 ${node.symbol}${loc}：它在这条链路里承担什么职责、是被哪个父方法触发的，以及内部核心逻辑与边界是什么？`,
                  selectedNodeId,
                });
              }}
            />
          </>
        )}
      </div>

      {toasts.length > 0 && (
        <div className="ra-toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className={`ra-toast ${t.level}`}>
              {t.message}
            </div>
          ))}
        </div>
      )}

      <footer className="ra-hud-footer">
        {audioQueue.audioBlocked && (
          <button
            type="button"
            className="ra-btn active"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => void audioQueue.unlockAudio()}
          >
            浏览器限制自动播放，点击此处解锁语音播报
          </button>
        )}
        <SubtitleHud
          chapter={chapter}
          subtitleText={subtitleText}
          isSpeaking={audioQueue.isSpeaking}
          fallbackStatus={activity.stage !== 'idle' ? activity.headline : undefined}
        />
        <VoiceControlBar
          voiceMode={meta.voiceMode}
          micActive={voiceVad.micActive}
          isUserSpeaking={voiceVad.isUserSpeaking}
          isAssistantSpeaking={
            (audioQueue.isSpeaking && !audioQueue.isPaused) || phase === 'speaking'
          }
          isPaused={audioQueue.isPaused}
          canPause={audioQueue.isSpeaking || phase === 'speaking'}
          micLevel={voiceVad.micLevel}
          ttsMuted={meta.ttsMuted}
          selectedNodeId={selectedNodeId}
          onToggleMic={voiceVad.toggleMic}
          onTogglePause={audioQueue.togglePause}
          onStartPtt={voiceVad.startPttHold}
          onEndPtt={voiceVad.endPttHold}
          onToggleVoiceMode={(mode: VoiceMode) => {
            setMeta((prev) => ({ ...prev, voiceMode: mode }));
            postToHost({ type: 'ui:toggleVoiceMode', mode });
          }}
          onToggleMute={(muted: boolean) => {
            setMeta((prev) => ({ ...prev, ttsMuted: muted }));
            postToHost({ type: 'ui:toggleMute', muted });
          }}
          onManualInterrupt={handleBargeIn}
          onSubmitText={(text) => {
            if (audioQueue.isSpeaking) {
              handleBargeIn();
            }
            postToHost({
              type: 'text:userPrompt',
              text,
              selectedNodeId,
            });
          }}
          onClearSelectedNode={() => {
            setSelectedNodeId(undefined);
            postToHost({ type: 'node:select', nodeId: undefined });
          }}
          onQuickNote={(body) => {
            postToHost({ type: 'ui:addManualNote', body });
          }}
        />
      </footer>
    </div>
  );
};

function shallowEqualSubset<T extends object>(prev: T, patch: Partial<T>): boolean {
  for (const key of Object.keys(patch) as Array<keyof T>) {
    if (prev[key] !== patch[key]) {
      return false;
    }
  }
  return true;
}
