import React from 'react';
import { ChevronRight, FileCode2, Layers } from 'lucide-react';
import type { DiagramStackItem } from '../../../src/shared/protocol';

interface BreadcrumbStackProps {
  stack: DiagramStackItem[];
  activeIndex?: number;
  activeEditorFile?: string;
  activeEditorLabel?: string;
  onPopTo: (index: number) => void;
}

export const BreadcrumbStack: React.FC<BreadcrumbStackProps> = ({
  stack,
  activeIndex,
  activeEditorFile,
  activeEditorLabel,
  onPopTo,
}) => {
  if (stack.length === 0 && !activeEditorFile) {
    return null;
  }

  const effectiveActive =
    activeIndex !== undefined && activeIndex >= 0
      ? Math.min(activeIndex, stack.length - 1)
      : stack.length - 1;

  const fileDisplay = activeEditorFile
    ? activeEditorFile.split('/').pop() || activeEditorFile
    : '';

  return (
    <div className="ra-breadcrumbs" aria-label="白板层级导航">
      <div className="ra-breadcrumbs-left">
        <Layers size={13} style={{ opacity: 0.7, flexShrink: 0 }} />
        {stack.map((item, idx) => {
          const isCurrent = idx === effectiveActive;
          const isDeeper = idx > effectiveActive;
          return (
            <React.Fragment key={`${item.id}-${idx}`}>
              {idx > 0 && <ChevronRight size={13} style={{ opacity: 0.5, flexShrink: 0 }} />}
              <button
                type="button"
                className={`ra-crumb ${isCurrent ? 'current' : isDeeper ? 'deeper' : ''}`}
                disabled={isCurrent}
                onClick={() => onPopTo(idx)}
                title={
                  isCurrent
                    ? '当前层级'
                    : isDeeper
                      ? `切回下层：L${idx + 1} ${item.title}`
                      : `返回上层：L${idx + 1} ${item.title}`
                }
              >
                <span className="ra-level-tag">L{idx + 1}</span>
                <span>{item.title || item.id}</span>
              </button>
            </React.Fragment>
          );
        })}
      </div>

      {activeEditorFile && (
        <span
          className="ra-active-file-badge"
          title={activeEditorFile}
        >
          <FileCode2 size={12} />
          <span>
            {fileDisplay}
            {activeEditorLabel ? ` · ${activeEditorLabel}` : ''}
          </span>
        </span>
      )}
    </div>
  );
};
