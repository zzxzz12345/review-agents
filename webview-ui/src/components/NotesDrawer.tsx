import React from 'react';
import { Trash2, Upload, X } from 'lucide-react';
import type { ReviewNoteDraft } from '../../../src/shared/protocol';

interface NotesDrawerProps {
  notes: ReviewNoteDraft[];
  onClose: () => void;
  onGotoNote: (file: string, line: number) => void;
  onDeleteNote: (id: string) => void;
  onPublishOrExport: () => void;
}

const SEVERITY_LABELS: Record<ReviewNoteDraft['severity'], string> = {
  action: 'ACTION',
  issue: 'ISSUE',
  warning: 'WARN',
  info: 'INFO',
};

export const NotesDrawer: React.FC<NotesDrawerProps> = ({
  notes,
  onClose,
  onGotoNote,
  onDeleteNote,
  onPublishOrExport,
}) => {
  return (
    <aside className="ra-notes-drawer" aria-label="Review 批注与 Action 列表">
      <div className="ra-notes-header">
        <span className="ra-notes-title">
          Review 批注与 Action ({notes.length})
        </span>
        <div className="ra-notes-header-actions">
          <button
            type="button"
            className="ra-mini-btn accent"
            onClick={onPublishOrExport}
            title="发布到 Bitbucket PR 或导出为 Markdown 报告"
          >
            <Upload size={12} />
            <span>发布 / 导出</span>
          </button>
          <button
            type="button"
            className="ra-icon-btn"
            onClick={onClose}
            title="收起批注面板"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {notes.length === 0 ? (
        <div className="ra-notes-empty">
          暂无批注。评审时可直接说「这里记一个 action，...」或「帮我记录它」，Agent 会自动识别并存入此处。
        </div>
      ) : (
        <div className="ra-notes-list">
          {[...notes].reverse().map((note) => (
            <div key={note.id} className="ra-note-card">
              <div className="ra-note-card-top">
                <span className={`ra-note-sev ${note.severity}`}>
                  {SEVERITY_LABELS[note.severity]}
                </span>
                <button
                  type="button"
                  className="ra-note-loc"
                  onClick={() => onGotoNote(note.file, note.line)}
                  title={`跳转到 ${note.file}:${note.line}`}
                >
                  {note.file}:{note.line}
                </button>
                <span className="ra-note-status">
                  {note.published ? '已发布' : '草稿'}
                </span>
                <button
                  type="button"
                  className="ra-icon-btn ra-note-del"
                  onClick={() => onDeleteNote(note.id)}
                  title="删除此条批注"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="ra-note-body">{note.body}</div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
};
