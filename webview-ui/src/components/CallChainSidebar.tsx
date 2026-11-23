import React from 'react';
import {
  ArrowDown,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitFork,
  Loader2,
  MessageSquare,
  Search,
  X,
} from 'lucide-react';
import type {
  CallChainNode,
  CallChainState,
  IncomingCallerItem,
} from '../../../src/shared/protocol';

export interface CallersEntryState {
  loading: boolean;
  callers: IncomingCallerItem[];
  source?: 'lsp' | 'scan' | 'none';
  note?: string;
  expanded: boolean;
}

interface CallChainSidebarProps {
  chain: CallChainState | null;
  callersMap: Record<string, CallersEntryState | undefined>;
  width: number;
  onClose: () => void;
  onInspectCurrent: () => void;
  onGotoNode: (target: {
    file: string;
    line: number;
    endLine?: number;
    label?: string;
  }) => void;
  onExpandCallers: (node: CallChainNode) => void;
  onAskAboutNode: (node: CallChainNode) => void;
}

export const CallChainSidebar: React.FC<CallChainSidebarProps> = ({
  chain,
  callersMap,
  width,
  onClose,
  onInspectCurrent,
  onGotoNode,
  onExpandCallers,
  onAskAboutNode,
}) => {
  const nodes = chain?.nodes ?? [];

  return (
    <aside
      className="ra-callchain-sidebar"
      style={{ width }}
      aria-label="主调用链导读栏"
    >
      <div className="ra-callchain-header">
        <div className="ra-callchain-title-wrap">
          <GitFork size={13} className="ra-callchain-header-icon" />
          <div className="ra-callchain-title-col">
            <div className="ra-callchain-title" title={chain?.title || '主调用链导读'}>
              {chain?.title || '主调用链导读'}
            </div>
            <div className="ra-callchain-meta">
              {chain
                ? `${nodes.length} 步 · ${chain.source === 'lsp' ? 'LSP 逆向链路' : '主题精简主链'}`
                : '入口 → 父方法 → 当前'}
            </div>
          </div>
        </div>
        <div className="ra-callchain-header-actions">
          <button
            type="button"
            className="ra-mini-btn"
            onClick={onInspectCurrent}
            title="基于当前编辑器位置通过 LSP 反查上游调用链"
          >
            <Search size={11} />
            <span>反查</span>
          </button>
          <button
            type="button"
            className="ra-icon-btn"
            onClick={onClose}
            title="收起调用链导读栏"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="ra-callchain-body">
        {nodes.length === 0 ? (
          <div className="ra-callchain-empty">
            <div className="ra-callchain-empty-title">等待进入具体调用链</div>
            <div className="ra-callchain-empty-desc">
              Agent 讲到核心模块与方法时，会在此自顶向下展示「全局入口 → 主要父方法 → 当前方法」（自动过滤噪音方法）。
            </div>
            <button
              type="button"
              className="ra-btn"
              style={{ marginTop: 6 }}
              onClick={onInspectCurrent}
            >
              <Search size={13} />
              <span>用 LSP 反查当前文件链路</span>
            </button>
          </div>
        ) : (
          <div className="ra-callchain-timeline">
            {nodes.map((node, idx) => {
              const isActive = idx === chain?.activeIndex;
              const isEntry = idx === 0;
              const badgeLabel = isActive
                ? '▶ 当前'
                : isEntry
                  ? '入口'
                  : '父方法';
              const baseFile = node.file
                ? node.file.split('/').pop() || node.file
                : '';
              const callerState = callersMap[node.id];

              return (
                <React.Fragment key={node.id}>
                  {idx > 0 && (
                    <div className="ra-callchain-connector" aria-hidden="true">
                      <ArrowDown size={12} />
                    </div>
                  )}

                  <div
                    className={`ra-callchain-card ${isActive ? 'active' : ''} ${isEntry ? 'entry' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (!node.file) {
                        return;
                      }
                      onGotoNode({
                        file: node.file,
                        line: node.line,
                        endLine: node.endLine,
                        label: node.symbol,
                      });
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && node.file) {
                        e.preventDefault();
                        onGotoNode({
                          file: node.file,
                          line: node.line,
                          endLine: node.endLine,
                          label: node.symbol,
                        });
                      }
                    }}
                    title={
                      node.file
                        ? `点击跳转源码：${node.file}:${node.line}（不打断语音）`
                        : node.symbol
                    }
                  >
                    <div className="ra-callchain-card-top">
                      <span
                        className={`ra-cc-badge ${isActive ? 'active' : isEntry ? 'entry' : ''}`}
                      >
                        {badgeLabel}
                      </span>
                      <span className="ra-cc-symbol" title={node.symbol}>
                        {node.symbol}
                      </span>
                      {node.verified && (
                        <span
                          className="ra-cc-verified"
                          title="已由本地源码校准精准行号"
                        >
                          <CheckCircle2 size={11} />
                        </span>
                      )}
                    </div>

                    {node.file && (
                      <div className="ra-cc-loc" title={`${node.file}:${node.line}`}>
                        {baseFile}:{node.line}
                      </div>
                    )}

                    {node.role && <div className="ra-cc-role">{node.role}</div>}

                    <div
                      className="ra-cc-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {node.file && (
                        <button
                          type="button"
                          className={`ra-mini-btn ${callerState?.expanded ? 'accent' : ''}`}
                          onClick={() => onExpandCallers(node)}
                          title="通过 VS Code LSP 展开真实上游调用方"
                        >
                          {callerState?.loading ? (
                            <Loader2 size={10} className="ra-spin" />
                          ) : callerState?.expanded ? (
                            <ChevronDown size={10} />
                          ) : (
                            <ChevronRight size={10} />
                          )}
                          <span>调用方</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="ra-mini-btn"
                        onClick={() => onAskAboutNode(node)}
                        title="让 Agent 针对这一步展开讲解"
                      >
                        <MessageSquare size={10} />
                        <span>问 Agent</span>
                      </button>
                    </div>

                    {callerState?.expanded && (
                      <div
                        className="ra-caller-drawer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {callerState.loading ? (
                          <div className="ra-caller-note">
                            正在通过 LSP 检索上游调用方...
                          </div>
                        ) : (
                          <>
                            {callerState.note && (
                              <div className="ra-caller-note">{callerState.note}</div>
                            )}
                            {callerState.callers.length > 0 && (
                              <div className="ra-caller-list">
                                {callerState.callers.map((caller) => {
                                  const callerBase =
                                    caller.file.split('/').pop() || caller.file;
                                  return (
                                    <button
                                      key={caller.id}
                                      type="button"
                                      className="ra-caller-item"
                                      onClick={() =>
                                        onGotoNode({
                                          file: caller.file,
                                          line: caller.line,
                                          label: `调用方 ${caller.symbol}`,
                                        })
                                      }
                                      title={`跳转到调用点 ${caller.file}:${caller.line}`}
                                    >
                                      <span className="ra-caller-sym">
                                        {caller.symbol}
                                      </span>
                                      <span className="ra-caller-loc">
                                        {callerBase}:{caller.line}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
};
