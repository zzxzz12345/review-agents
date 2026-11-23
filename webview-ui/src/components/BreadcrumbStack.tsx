import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, FileCode2, GitBranch, Layers } from 'lucide-react';
import type { DiagramStackItem } from '../../../src/shared/protocol';
import { computeNodeLevel, getSiblingsForLayer } from '../../../src/shared/whiteboardTree';

interface BreadcrumbStackProps {
  stack: DiagramStackItem[];
  activeIndex?: number;
  nodes?: DiagramStackItem[];
  activeId?: string;
  activeEditorFile?: string;
  activeEditorLabel?: string;
  onPopTo: (index: number) => void;
  onSelectLayer?: (id: string) => void;
}

interface TreeDisplayEntry {
  node: DiagramStackItem;
  level: number;
}

export const BreadcrumbStack: React.FC<BreadcrumbStackProps> = ({
  stack,
  activeIndex,
  nodes,
  activeId,
  activeEditorFile,
  activeEditorLabel,
  onPopTo,
  onSelectLayer,
}) => {
  const [treeOpen, setTreeOpen] = useState(false);
  const [siblingMenu, setSiblingMenu] = useState<{
    layerId: string;
    leftPx: number;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const allNodes = nodes && nodes.length > 0 ? nodes : stack;
  const effectiveActive =
    activeIndex !== undefined && activeIndex >= 0
      ? Math.min(activeIndex, stack.length - 1)
      : stack.length - 1;
  const resolvedActiveId =
    activeId ?? (effectiveActive >= 0 ? stack[effectiveActive]?.id : undefined);

  useEffect(() => {
    if (!treeOpen && !siblingMenu) {
      return;
    }
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setTreeOpen(false);
        setSiblingMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTreeOpen(false);
        setSiblingMenu(null);
      }
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [treeOpen, siblingMenu]);

  const orderedTreeEntries = useMemo<TreeDisplayEntry[]>(() => {
    if (allNodes.length === 0) {
      return [];
    }
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    const childrenByParent = new Map<string | undefined, DiagramStackItem[]>();
    for (const node of allNodes) {
      const parentKey =
        node.parentId && byId.has(node.parentId) ? node.parentId : undefined;
      const bucket = childrenByParent.get(parentKey);
      if (bucket) {
        bucket.push(node);
      } else {
        childrenByParent.set(parentKey, [node]);
      }
    }
    const entries: TreeDisplayEntry[] = [];
    const visited = new Set<string>();
    const walk = (parentId: string | undefined) => {
      const children = childrenByParent.get(parentId) ?? [];
      for (const node of children) {
        if (visited.has(node.id)) {
          continue;
        }
        visited.add(node.id);
        const level = node.level ?? computeNodeLevel(allNodes, node.id);
        entries.push({ node, level });
        walk(node.id);
      }
    };
    walk(undefined);
    return entries;
  }, [allNodes]);

  if (stack.length === 0 && !activeEditorFile) {
    return null;
  }

  const fileDisplay = activeEditorFile
    ? activeEditorFile.split('/').pop() || activeEditorFile
    : '';

  const selectById = (layerId: string) => {
    setTreeOpen(false);
    setSiblingMenu(null);
    if (onSelectLayer) {
      onSelectLayer(layerId);
      return;
    }
    const stackIdx = stack.findIndex((item) => item.id === layerId);
    if (stackIdx >= 0) {
      onPopTo(stackIdx);
    }
  };

  const activeSiblings = siblingMenu
    ? getSiblingsForLayer(allNodes, siblingMenu.layerId)
    : [];

  return (
    <div ref={containerRef} className="ra-breadcrumbs" aria-label="白板层级导航">
      <div className="ra-breadcrumbs-left">
        <button
          type="button"
          className={`ra-tree-btn ${treeOpen ? 'active' : ''}`}
          disabled={allNodes.length === 0}
          onClick={() => {
            setSiblingMenu(null);
            setTreeOpen((prev) => !prev);
          }}
          title={
            allNodes.length > 0
              ? `查看白板树状结构（共 ${allNodes.length} 张 · L1~L4）`
              : '白板树状结构'
          }
        >
          <Layers size={13} style={{ opacity: 0.85, flexShrink: 0 }} />
          {allNodes.length > 1 && <span className="ra-tree-count">{allNodes.length}</span>}
          {allNodes.length > 0 && <ChevronDown size={11} style={{ opacity: 0.7 }} />}
        </button>

        {stack.map((item, idx) => {
          const isCurrent = idx === effectiveActive;
          const isDeeper = idx > effectiveActive;
          const level = item.level ?? idx + 1;
          const rev = item.revision ?? 1;
          const siblings = getSiblingsForLayer(allNodes, item.id);
          const hasSiblings = siblings.length > 1;
          const siblingIndex = hasSiblings
            ? Math.max(0, siblings.findIndex((s) => s.id === item.id))
            : 0;

          return (
            <React.Fragment key={`${item.id}-${idx}`}>
              {idx > 0 && <ChevronRight size={13} style={{ opacity: 0.5, flexShrink: 0 }} />}
              <div className="ra-crumb-group">
                <button
                  type="button"
                  className={`ra-crumb ${isCurrent ? 'current' : isDeeper ? 'deeper' : ''}`}
                  disabled={isCurrent}
                  onClick={() => {
                    setTreeOpen(false);
                    setSiblingMenu(null);
                    onPopTo(idx);
                  }}
                  title={
                    isCurrent
                      ? `当前层级 · id=${item.id}`
                      : isDeeper
                        ? `切回下层：L${level} ${item.title}`
                        : `返回上层：L${level} ${item.title}`
                  }
                >
                  <span className="ra-level-tag">L{level}</span>
                  <span>{item.title || item.id}</span>
                  {rev > 1 && <span className="ra-rev-badge">v{rev}</span>}
                </button>
                {hasSiblings && (
                  <button
                    type="button"
                    className={`ra-sibling-btn ${
                      siblingMenu?.layerId === item.id ? 'active' : ''
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setTreeOpen(false);
                      if (siblingMenu?.layerId === item.id) {
                        setSiblingMenu(null);
                        return;
                      }
                      const hostRect = containerRef.current?.getBoundingClientRect();
                      const btnRect = e.currentTarget.getBoundingClientRect();
                      const rawLeft = hostRect ? btnRect.left - hostRect.left : 12;
                      const maxLeft = hostRect ? Math.max(12, hostRect.width - 260) : rawLeft;
                      setSiblingMenu({
                        layerId: item.id,
                        leftPx: Math.max(12, Math.min(rawLeft, maxLeft)),
                      });
                    }}
                    title={`切换同级分支 (${siblingIndex + 1}/${siblings.length})`}
                  >
                    <GitBranch size={10} />
                    <span>
                      {siblingIndex + 1}/{siblings.length}
                    </span>
                    <ChevronDown size={10} />
                  </button>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {activeEditorFile && (
        <span className="ra-active-file-badge" title={activeEditorFile}>
          <FileCode2 size={12} />
          <span>
            {fileDisplay}
            {activeEditorLabel ? ` · ${activeEditorLabel}` : ''}
          </span>
        </span>
      )}

      {treeOpen && orderedTreeEntries.length > 0 && (
        <div className="ra-tree-popover" role="menu" aria-label="白板树状结构">
          <div className="ra-tree-popover-header">
            <span>白板树状导览（L1~L4）</span>
            <span className="ra-tree-popover-sub">{orderedTreeEntries.length} 个视图</span>
          </div>
          <div className="ra-tree-popover-list">
            {orderedTreeEntries.map(({ node, level }) => {
              const isActive = node.id === resolvedActiveId;
              const rev = node.revision ?? 1;
              return (
                <button
                  key={node.id}
                  type="button"
                  className={`ra-tree-node-btn ${isActive ? 'active' : ''}`}
                  style={{ paddingLeft: `${8 + (level - 1) * 14}px` }}
                  onClick={() => selectById(node.id)}
                  title={`${node.title || node.id} (id=${node.id})`}
                >
                  <span className="ra-level-tag">L{level}</span>
                  <span className="ra-tree-node-title">{node.title || node.id}</span>
                  {rev > 1 && <span className="ra-rev-badge">v{rev}</span>}
                  {isActive && <Check size={12} className="ra-tree-node-check" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {siblingMenu && activeSiblings.length > 1 && (
        <div
          className="ra-sibling-popover"
          style={{ left: `${siblingMenu.leftPx}px` }}
          role="menu"
          aria-label="同级分支切换"
        >
          <div className="ra-tree-popover-header">
            <span>同级分支（{activeSiblings.length}）</span>
          </div>
          <div className="ra-tree-popover-list">
            {activeSiblings.map((sib) => {
              const isActive = sib.id === siblingMenu.layerId || sib.id === resolvedActiveId;
              const level = sib.level ?? computeNodeLevel(allNodes, sib.id);
              const rev = sib.revision ?? 1;
              return (
                <button
                  key={sib.id}
                  type="button"
                  className={`ra-tree-node-btn ${isActive ? 'active' : ''}`}
                  onClick={() => selectById(sib.id)}
                >
                  <span className="ra-level-tag">L{level}</span>
                  <span className="ra-tree-node-title">{sib.title || sib.id}</span>
                  {rev > 1 && <span className="ra-rev-badge">v{rev}</span>}
                  {isActive && <Check size={12} className="ra-tree-node-check" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
