import React from 'react';
import type { ChapterProgress } from '../../../src/shared/protocol';

interface SubtitleHudProps {
  chapter?: ChapterProgress;
  subtitleText: string;
  isSpeaking: boolean;
  fallbackStatus?: string;
}

export const SubtitleHud: React.FC<SubtitleHudProps> = ({
  chapter,
  subtitleText,
  isSpeaking,
  fallbackStatus,
}) => {
  const pct =
    chapter && chapter.total > 0
      ? Math.min(100, Math.round((chapter.index / chapter.total) * 100))
      : 0;

  return (
    <div className="ra-subtitle-box">
      <div className="ra-chapter-row">
        <span>
          {chapter
            ? `第 ${chapter.index}/${chapter.total} 章 · ${chapter.title}`
            : fallbackStatus || '导读准备中'}
        </span>
        {chapter && (
          <div className="ra-progress-track" aria-label="导读进度">
            <div className="ra-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className="ra-subtitle-text">
        {subtitleText ||
          (isSpeaking
            ? '...'
            : '实时字幕区 — 讲解开始后将逐句同步展示口播文字、白板高亮与代码跳转')}
      </div>
    </div>
  );
};
