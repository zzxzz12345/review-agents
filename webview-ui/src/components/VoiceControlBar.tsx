import React, { useState } from 'react';
import {
  BookmarkPlus,
  Hand,
  Mic,
  MicOff,
  Pause,
  Play,
  Send,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { VoiceMode } from '../../../src/shared/protocol';

interface VoiceControlBarProps {
  voiceMode: VoiceMode;
  micActive: boolean;
  isUserSpeaking: boolean;
  isAssistantSpeaking: boolean;
  isPaused: boolean;
  canPause: boolean;
  micLevel: number;
  ttsMuted: boolean;
  selectedNodeId?: string;
  onToggleMic: () => void;
  onTogglePause: () => void;
  onStartPtt: () => void;
  onEndPtt: () => void;
  onToggleVoiceMode: (mode: VoiceMode) => void;
  onToggleMute: (muted: boolean) => void;
  onManualInterrupt: () => void;
  onSubmitText: (text: string) => void;
  onClearSelectedNode: () => void;
  onQuickNote: (noteText: string) => void;
}

export const VoiceControlBar: React.FC<VoiceControlBarProps> = ({
  voiceMode,
  micActive,
  isUserSpeaking,
  isAssistantSpeaking,
  isPaused,
  canPause,
  micLevel,
  ttsMuted,
  selectedNodeId,
  onToggleMic,
  onTogglePause,
  onStartPtt,
  onEndPtt,
  onToggleVoiceMode,
  onToggleMute,
  onManualInterrupt,
  onSubmitText,
  onClearSelectedNode,
  onQuickNote,
}) => {
  const [textInput, setTextInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = textInput.trim();
    if (!trimmed) {
      return;
    }
    onSubmitText(trimmed);
    setTextInput('');
  };

  return (
    <div className="ra-voice-bar">
      <button
        type="button"
        className={`ra-btn ${micActive ? 'active' : ''}`}
        onClick={onToggleMic}
        title={micActive ? '关闭麦克风监听' : '开启麦克风进行全双工语音对话'}
      >
        {micActive ? <Mic size={14} /> : <MicOff size={14} />}
        <span>{micActive ? (isUserSpeaking ? '收音中...' : '麦克风已开') : '开启麦克风'}</span>
      </button>

      {micActive && (
        <div className="ra-meter" title="麦克风实时音量">
          <div
            className="ra-meter-fill"
            style={{ width: `${Math.round(micLevel * 100)}%` }}
          />
        </div>
      )}

      <button
        type="button"
        className="ra-btn"
        onClick={() => onToggleVoiceMode(voiceMode === 'vad' ? 'ptt' : 'vad')}
        title="切换全双工自动打断 (VAD) 与按住 Option 键说话 (PTT)"
      >
        <span>{voiceMode === 'vad' ? '模式: 全双工 VAD' : '模式: 按键 PTT'}</span>
      </button>

      {voiceMode === 'ptt' && (
        <button
          type="button"
          className={`ra-btn ${isUserSpeaking ? 'active' : ''}`}
          onMouseDown={onStartPtt}
          onMouseUp={onEndPtt}
          onMouseLeave={onEndPtt}
          title="按住说话，松开发送（也可直接按住 Option / Alt 键）"
        >
          <span>{isUserSpeaking ? '松开发送' : '按住说话 (Option)'}</span>
        </button>
      )}

      <button
        type="button"
        className="ra-btn"
        onClick={() => onToggleMute(!ttsMuted)}
        title={ttsMuted ? '恢复语音播报' : '静音模式（仅展示字幕、白板与代码联动）'}
      >
        {ttsMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </button>

      {(canPause || isPaused) && (
        <button
          type="button"
          className={`ra-btn ${isPaused ? 'active' : ''}`}
          onClick={onTogglePause}
          title={
            isPaused
              ? '恢复语音讲解与自动代码跳转（快捷键 Space）'
              : '暂停语音讲解与代码自动跳转，停下来阅读源码（快捷键 Space）'
          }
        >
          {isPaused ? <Play size={14} /> : <Pause size={14} />}
          <span>{isPaused ? '继续讲解 (Space)' : '暂停 (Space)'}</span>
        </button>
      )}

      {isAssistantSpeaking && (
        <button
          type="button"
          className="ra-btn danger"
          onClick={onManualInterrupt}
          title="立即打断当前语音讲解"
        >
          <Hand size={14} />
          <span>打断</span>
        </button>
      )}

      {selectedNodeId && (
        <span className="ra-node-pill">
          已选节点: {selectedNodeId}
          <button
            type="button"
            className="ra-icon-btn"
            style={{ width: 16, height: 16 }}
            onClick={onClearSelectedNode}
            title="取消选中节点"
          >
            <X size={11} />
          </button>
        </span>
      )}

      <form className="ra-prompt-form" onSubmit={handleSubmit}>
        <input
          type="text"
          className="ra-input"
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          placeholder={
            selectedNodeId
              ? `针对节点 ${selectedNodeId} 追问，或直接开口说话...`
              : '直接开口或输入指令（如：讲下项目架构 / Review 某模块 / 记批注）...'
          }
        />
        <button type="submit" className="ra-btn" title="发送提问">
          <Send size={13} />
        </button>
        <button
          type="button"
          className="ra-btn"
          title="将输入框文字快速记为当前代码行的 Review 草稿批注"
          disabled={!textInput.trim()}
          onClick={() => {
            if (textInput.trim()) {
              onQuickNote(textInput.trim());
              setTextInput('');
            }
          }}
        >
          <BookmarkPlus size={13} />
        </button>
      </form>
    </div>
  );
};
