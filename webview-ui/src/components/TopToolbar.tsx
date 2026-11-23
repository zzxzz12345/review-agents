import React from 'react';
import {
  Columns2,
  ExternalLink,
  FileCode2,
  GitBranch,
  GitFork,
  MessageSquarePlus,
} from 'lucide-react';
import type { SessionMetaState, SessionPhase } from '../../../src/shared/protocol';

interface TopToolbarProps {
  phase: SessionPhase;
  statusMessage?: string;
  meta: SessionMetaState;
  notesCount: number;
  notesOpen?: boolean;
  callChainCount?: number;
  callChainOpen?: boolean;
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
  onToggleViewMode,
  onToggleCallChain,
  onPopOutWindow,
  onSwitchTarget,
  onPublishOrExportNotes,
}) => {
  const isBranchExplore = meta.sourceKind === 'branch-explore';
  const phaseLabel =
    phase === 'analyzing' && isBranchExplore ? '扫描项目' : PHASE_LABELS[phase];

  return (
    <header className="ra-toolbar">
      <div className="ra-toolbar-left">
        <div className="ra-title-block">
          <div className="ra-title">{meta.targetTitle}</div>
          <div className="ra-subtitle">
            {statusMessage || meta.targetSubtitle} · {meta.acpProfileLabel}
          </div>
        </div>
        <span className="ra-phase-pill">
          <span className={`ra-phase-dot ${phase}`} />
          {phaseLabel}
        </span>
      </div>

      <div className="ra-toolbar-actions">
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
