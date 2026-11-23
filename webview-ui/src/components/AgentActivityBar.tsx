import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileSearch,
  Loader2,
  Mic,
  Pause,
  Volume2,
  Wrench,
} from 'lucide-react';
import type {
  AgentActivityStage,
  AgentActivityState,
} from '../../../src/shared/protocol';

interface AgentActivityBarProps {
  activity: AgentActivityState;
  audioBlocked: boolean;
  isPaused: boolean;
  onUnlockAudio: () => void;
  onTogglePause: () => void;
  onInterrupt: () => void;
}

const STAGE_LABELS: Record<AgentActivityStage, string> = {
  idle: '空闲',
  analyzing: '分析Diff',
  connecting: '连接ACP',
  thinking: '思考中',
  reading_file: '读文件',
  tool_call: '工具调用',
  streaming: '流式输出',
  synthesizing: '合成语音',
  speaking: '讲解中',
  paused: '已暂停',
  listening: '聆听中',
  audio_blocked: '等待解锁语音',
  error: '出错',
};

export const AgentActivityBar: React.FC<AgentActivityBarProps> = ({
  activity,
  audioBlocked,
  isPaused,
  onUnlockAudio,
  onTogglePause,
  onInterrupt,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const isActive =
    activity.stage !== 'idle' &&
    activity.stage !== 'error' &&
    activity.stage !== 'paused';

  useEffect(() => {
    setNowMs(Date.now());
    if (!isActive) {
      return;
    }
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [isActive, activity.lastHeartbeatMs]);

  const elapsedSec = Math.max(0, Math.floor((nowMs - activity.startedAtMs) / 1000));
  const idleGapSec = Math.max(0, Math.floor((nowMs - activity.lastHeartbeatMs) / 1000));
  const isStalled = isActive && idleGapSec >= 15;

  const inlineDetail =
    activity.detail ||
    (activity.thoughtPreview ? `💭 ${activity.thoughtPreview}` : undefined);

  const stageIcon = renderStageIcon(activity.stage);

  return (
    <section className={`ra-activity-bar ${isStalled ? 'stalled' : ''}`}>
      <div className="ra-activity-main">
        <div className="ra-activity-left">
          <span className={`ra-activity-icon ${activity.stage}`}>{stageIcon}</span>
          <span className="ra-activity-headline" title={activity.headline}>
            {activity.headline}
          </span>
          {inlineDetail && (
            <span className="ra-activity-detail" title={inlineDetail}>
              {inlineDetail}
            </span>
          )}
        </div>

        <div className="ra-activity-right">
          {(activity.counters.thoughtChars > 0 ||
            activity.counters.filesRead > 0 ||
            activity.counters.segmentsParsed > 0) && (
            <div className="ra-activity-counters">
              {activity.counters.thoughtChars > 0 && (
                <span>思考 {activity.counters.thoughtChars}字</span>
              )}
              {activity.counters.filesRead > 0 && (
                <span>读 {activity.counters.filesRead}文件</span>
              )}
              {activity.counters.segmentsParsed > 0 && (
                <span>
                  语音 {activity.counters.ttsReady}/{activity.counters.segmentsParsed}
                </span>
              )}
            </div>
          )}

          {isActive ? (
            <span
              className={`ra-heartbeat ${isStalled ? 'stalled' : 'alive'}`}
              title={`会话耗时 ${elapsedSec}s，距上次心跳 ${idleGapSec}s`}
            >
              <span className="ra-heartbeat-dot" />
              {isStalled
                ? `已等待 ${idleGapSec}s`
                : idleGapSec >= 3
                  ? `活跃 · ${elapsedSec}s (${idleGapSec}s前更新)`
                  : `活跃 · ${elapsedSec}s`}
            </span>
          ) : (
            <span className="ra-heartbeat idle">
              <span className="ra-heartbeat-dot" />
              {STAGE_LABELS[activity.stage]}
            </span>
          )}

          {isStalled && (
            <button
              type="button"
              className="ra-mini-btn warn"
              onClick={onInterrupt}
              title="等待超时时可中断当前回合"
            >
              中断
            </button>
          )}

          {(isPaused || activity.stage === 'paused') && (
            <button
              type="button"
              className="ra-mini-btn accent"
              onClick={onTogglePause}
              title="恢复语音讲解与自动跳转（快捷键 Space）"
            >
              继续讲解 (Space)
            </button>
          )}

          {audioBlocked && (
            <button
              type="button"
              className="ra-mini-btn accent"
              onClick={onUnlockAudio}
              title="解除浏览器自动播放限制并恢复语音播报"
            >
              解锁语音
            </button>
          )}

          <button
            type="button"
            className="ra-mini-btn"
            onClick={() => setExpanded((prev) => !prev)}
            title={expanded ? '收起读取文件与过程日志' : '展开查看读取文件与过程日志'}
          >
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            <span>详情</span>
          </button>
        </div>
      </div>

      {expanded && (
        <div className="ra-activity-drawer">
          <div className="ra-activity-section">
            <div className="ra-activity-section-title">
              Agent 读取的文件 ({activity.recentFiles.length})
            </div>
            {activity.recentFiles.length === 0 ? (
              <div className="ra-activity-empty">本轮暂未额外读取工作区文件（直接使用 Diff 上下文）</div>
            ) : (
              <div className="ra-activity-files">
                {activity.recentFiles.map((file) => (
                  <span
                    key={file.path}
                    className={`ra-activity-file-chip ${file.status}`}
                    title={`${file.path}${file.lineRange ? ` (${file.lineRange})` : ''}`}
                  >
                    <span className={`ra-file-dot ${file.status}`} />
                    <span className="ra-file-path">{file.path}</span>
                    {file.lineRange && (
                      <span className="ra-file-lines">{file.lineRange}</span>
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="ra-activity-section">
            <div className="ra-activity-section-title">过程流水</div>
            {activity.recentLogs.length === 0 ? (
              <div className="ra-activity-empty">暂无过程记录</div>
            ) : (
              <div className="ra-activity-logs">
                {[...activity.recentLogs].reverse().map((entry) => (
                  <div key={entry.id} className="ra-activity-log-row">
                    <span className="ra-log-time">{formatClockTime(entry.ts)}</span>
                    <span className="ra-log-stage">{STAGE_LABELS[entry.stage]}</span>
                    <span className="ra-log-text">{entry.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};

function renderStageIcon(stage: AgentActivityStage): React.ReactNode {
  switch (stage) {
    case 'analyzing':
    case 'connecting':
    case 'thinking':
    case 'streaming':
    case 'synthesizing':
      return <Loader2 size={13} className="ra-spin" />;
    case 'reading_file':
      return <FileSearch size={13} className="ra-pulse-icon" />;
    case 'tool_call':
      return <Wrench size={13} className="ra-pulse-icon" />;
    case 'speaking':
      return <Volume2 size={13} />;
    case 'paused':
      return <Pause size={13} />;
    case 'listening':
      return <Mic size={13} />;
    case 'audio_blocked':
    case 'error':
      return <AlertTriangle size={13} />;
    case 'idle':
    default:
      return <CheckCircle2 size={13} />;
  }
}

function formatClockTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
