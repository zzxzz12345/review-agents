import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Columns2,
  Download,
  ExternalLink,
  FileCode2,
  GitBranch,
  GitFork,
  MessageSquarePlus,
  Play,
  RotateCcw,
  Square,
} from 'lucide-react';
import type {
  ReplayStatusState,
  SessionMetaState,
  SessionPhase,
} from '../../../src/shared/protocol';

interface TopToolbarProps {
  phase: SessionPhase;
  statusMessage?: string;
  meta: SessionMetaState;
  notesCount: number;
  notesOpen?: boolean;
  callChainCount?: number;
  callChainOpen?: boolean;
  replayStatus?: ReplayStatusState;
  onStartReplay?: (
    mode: 'from-start' | 'current-section' | 'from-index',
    startIndex?: number
  ) => void;
  onStopReplay?: () => void;
  onExportHtml?: () => void;
  onToggleViewMode: () => void;
  onToggleCallChain?: () => void;
  onPopOutWindow: () => void;
  onSwitchTarget: () => void;
  onPublishOrExportNotes: () => void;
}

const PHASE_LABELS: Record<SessionPhase, string> = {
  idle: '待命中',
  analyzing: '分析 Diff',
  connecting: '连接 ACP',
  thinking: '组织导读',
  speaking: '语音讲解中',
  listening: '正在聆听',
  paused: '已暂停',
  error: '出错',
};

export const TopToolbar: React.FC<TopToolbarProps> = ({
  phase,
  statusMessage,
  meta,
  notesCount,
  notesOpen,
  callChainCount = 0,
  callChainOpen = false,
  replayStatus,
  onStartReplay,
  onStopReplay,
  onExportHtml,
  onToggleViewMode,
  onToggleCallChain,
  onPopOutWindow,
  onSwitchTarget,
  onPublishOrExportNotes,
}) => {
  const [replayMenuOpen, setReplayMenuOpen] = useState(false);
  const replayWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!replayMenuOpen) {
      return;
    }
    const onMouseDown = (e: MouseEvent) => {
      if (replayWrapRef.current && !replayWrapRef.current.contains(e.target as Node)) {
        setReplayMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setReplayMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [replayMenuOpen]);

  const isBranchExplore = meta.sourceKind === 'branch-explore';
  const isCorePathReview = meta.reviewMode === 'core-path-line-review';
  const phaseLabel =
    phase === 'analyzing' && isCorePathReview
      ? '定位链路'
      : phase === 'analyzing' && isBranchExplore
        ? '扫描项目'
        : PHASE_LABELS[phase];

  const hasReplay = Boolean(replayStatus && replayStatus.totalSegments > 0 && onStartReplay);

  return (
    <header className="ra-toolbar">
      <div className="ra-toolbar-left">
        <div className="ra-title-block">
          <div className="ra-title">{meta.targetTitle}</div>
          <div className="ra-subtitle">
            {statusMessage || meta.targetSubtitle} · {meta.acpProfileLabel}
          </div>
        </div>
        {isCorePathReview && (
          <span
            className="ra-mode-badge"
            title="基于输入的核心链路逐行 Review 模式：逐段看核心分支与调用，自动跳子方法并按需深化白板"
          >
            逐行链路 Review
          </span>
        )}
        <span className="ra-phase-pill">
          <span className={`ra-phase-dot ${phase}`} />
          {phaseLabel}
        </span>
      </div>

      <div className="ra-toolbar-actions">
        {hasReplay && replayStatus && (
          <div ref={replayWrapRef} className="ra-replay-wrap">
            <button
              type="button"
              className={`ra-btn ${replayStatus.isReplaying || replayMenuOpen ? 'active' : ''}`}
              onClick={() => setReplayMenuOpen((prev) => !prev)}
              title="重放本轮历史讲解（音画 + 白板 + 代码跳转全同步，不消耗额外模型调用）"
            >
              <RotateCcw size={14} />
              <span>
                {replayStatus.isReplaying && replayStatus.currentIndex !== undefined
                  ? `重放中 ${replayStatus.currentIndex + 1}/${replayStatus.totalSegments}`
                  : '重放'}
              </span>
              <ChevronDown size={11} />
            </button>

            {replayMenuOpen && (
              <div className="ra-replay-popover" role="menu" aria-label="同步重放选项">
                <div className="ra-tree-popover-header">
                  <span>同步重放（音频 · 白板 · 代码）</span>
                  <span className="ra-tree-popover-sub">
                    共 {replayStatus.totalSegments} 段
                  </span>
                </div>
                <div className="ra-tree-popover-list">
                  <button
                    type="button"
                    className="ra-tree-node-btn"
                    onClick={() => {
                      setReplayMenuOpen(false);
                      onStartReplay?.('from-start');
                    }}
                  >
                    <Play size={12} />
                    <span>从头播放全部（第 1 段起）</span>
                  </button>
                  <button
                    type="button"
                    className="ra-tree-node-btn"
                    onClick={() => {
                      setReplayMenuOpen(false);
                      onStartReplay?.('current-section');
                    }}
                  >
                    <RotateCcw size={12} />
                    <span>重放当前章节</span>
                  </button>
                  {replayStatus.isReplaying && onStopReplay && (
                    <button
                      type="button"
                      className="ra-tree-node-btn danger"
                      onClick={() => {
                        setReplayMenuOpen(false);
                        onStopReplay();
                      }}
                    >
                      <Square size={12} />
                      <span>停止重放</span>
                    </button>
                  )}
                  {onExportHtml && (
                    <button
                      type="button"
                      className="ra-tree-node-btn"
                      onClick={() => {
                        setReplayMenuOpen(false);
                        onExportHtml();
                      }}
                    >
                      <Download size={12} />
                      <span>导出独立可播放 HTML</span>
                    </button>
                  )}
                  {replayStatus.checkpoints.length > 0 && (
                    <>
                      <div className="ra-replay-divider">按章节 / 检查点重放</div>
                      {replayStatus.checkpoints.map((cp) => (
                        <button
                          key={`${cp.startIndex}-${cp.title}`}
                          type="button"
                          className="ra-tree-node-btn"
                          onClick={() => {
                            setReplayMenuOpen(false);
                            onStartReplay?.('from-index', cp.startIndex);
                          }}
                          title={`从第 ${cp.startIndex + 1} 段起重放`}
                        >
                          <span className="ra-level-tag">#{cp.startIndex + 1}</span>
                          <span className="ra-tree-node-title">{cp.title}</span>
                          <span className="ra-tree-popover-sub">{cp.segmentCount} 段</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {hasReplay && onExportHtml && (
          <button
            type="button"
            className="ra-btn"
            onClick={onExportHtml}
            title="将本次导读导出为可离线播放的独立 HTML（分屏代码 + 语音播报 + 白板）"
          >
            <Download size={14} />
            <span>导出 HTML</span>
          </button>
        )}

        {!isBranchExplore && (
          <button
            type="button"
            className="ra-btn"
            onClick={onToggleViewMode}
            title="在原生 Diff 对比视图与单文件源码视图间切换"
          >
            {meta.viewMode === 'diff' ? <Columns2 size={14} /> : <FileCode2 size={14} />}
            <span>{meta.viewMode === 'diff' ? 'Diff 视图' : '源码视图'}</span>
          </button>
        )}

        {!meta.isPoppedOut && (
          <button
            type="button"
            className="ra-btn"
            onClick={onPopOutWindow}
            title="将白板弹出到独立悬浮窗口（适合双屏常驻）"
          >
            <ExternalLink size={14} />
            <span>独立窗口</span>
          </button>
        )}

        {onToggleCallChain && (
          <button
            type="button"
            className={`ra-btn ${callChainOpen ? 'active' : ''}`}
            onClick={onToggleCallChain}
            title="展开/收起右侧主调用链导读栏（全局入口 → 父方法 → 当前）"
          >
            <GitFork size={14} />
            <span>{callChainCount > 0 ? `调用链 (${callChainCount})` : '调用链'}</span>
          </button>
        )}

        <button
          type="button"
          className={`ra-btn ${notesOpen || notesCount > 0 ? 'active' : ''}`}
          onClick={onPublishOrExportNotes}
          title="查看 / 跳转 / 发布 Review 批注与 Action 列表"
        >
          <MessageSquarePlus size={14} />
          <span>批注 ({notesCount})</span>
        </button>

        <button
          type="button"
          className="ra-btn"
          onClick={onSwitchTarget}
          title="切换当前分支导读 / Local Diff / Bitbucket PR"
        >
          <GitBranch size={14} />
          <span>切换目标</span>
        </button>
      </div>
    </header>
  );
};
