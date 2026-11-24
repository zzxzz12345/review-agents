import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import svgPanZoom from 'svg-pan-zoom';
import { Compass, GitBranch, ListTree, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import type { DiagramStackItem } from '../../../src/shared/protocol';

interface MermaidStageProps {
  diagram: DiagramStackItem | undefined;
  selectedNodeId?: string;
  onSelectNode: (nodeId?: string) => void;
  onDoubleClickNode: (nodeId: string, codeTarget?: string) => void;
  onStartCorePathReview?: () => void;
  onStartBranchExplore?: () => void;
  onSwitchTarget?: () => void;
  onParseError?: (info: {
    diagramId?: string;
    error: string;
    mermaidCode: string;
  }) => void;
}

let renderCounter = 0;

const INTERACTIVE_NODE_SELECTOR =
  '.node, g[id^="entity-"], g.statediagram-state';

export const MermaidStage: React.FC<MermaidStageProps> = ({
  diagram,
  selectedNodeId,
  onSelectNode,
  onDoubleClickNode,
  onStartCorePathReview,
  onStartBranchExplore,
  onSwitchTarget,
  onParseError,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panZoomRef = useRef<ReturnType<typeof svgPanZoom> | null>(null);
  const [parseWarning, setParseWarning] = useState<string | null>(null);
  const [renderVersion, setRenderVersion] = useState(0);

  const diagramId = diagram?.id;
  const diagramCode = diagram?.mermaidCode ?? '';
  const hasDiagram = Boolean(diagramCode.trim());
  const focusedNodeId = diagram?.focusedNodeId;
  const focusedEdge = diagram?.focusedEdge;
  const nodeCodeMapRef = useRef(diagram?.nodeCodeMap);
  nodeCodeMapRef.current = diagram?.nodeCodeMap;
  const onParseErrorRef = useRef(onParseError);
  onParseErrorRef.current = onParseError;
  const onSelectNodeRef = useRef(onSelectNode);
  onSelectNodeRef.current = onSelectNode;
  const onDoubleClickNodeRef = useRef(onDoubleClickNode);
  onDoubleClickNodeRef.current = onDoubleClickNode;
  const diagramIdRef = useRef(diagramId);
  diagramIdRef.current = diagramId;

  // Render Mermaid diagram whenever code changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (!diagramCode.trim()) {
      panZoomRef.current?.destroy();
      panZoomRef.current = null;
      container.innerHTML = '';
      setParseWarning(null);
      return;
    }

    let cancelled = false;

    const renderDiagram = async () => {
      const isLight = document.body.classList.contains('vscode-light');
      mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: isLight
          ? {
              background: '#ffffff',
              primaryColor: '#eef2ff',
              primaryBorderColor: '#4f46e5',
              primaryTextColor: '#0f172a',
              secondaryColor: '#f1f5f9',
              tertiaryColor: '#f8fafc',
              lineColor: '#334155',
              edgeLabelBackground: '#ffffff',
              textColor: '#0f172a',
              noteBkgColor: '#fef9c3',
              noteTextColor: '#1e293b',
              noteBorderColor: '#eab308',
              fontSize: '14px',
            }
          : {
              background: '#18181b',
              primaryColor: '#27272a',
              primaryBorderColor: '#818cf8',
              primaryTextColor: '#f4f4f5',
              secondaryColor: '#1f2937',
              tertiaryColor: '#27272a',
              lineColor: '#94a3b8',
              edgeLabelBackground: '#18181b',
              textColor: '#f4f4f5',
              noteBkgColor: '#292524',
              noteTextColor: '#fef3c7',
              noteBorderColor: '#f59e0b',
              fontSize: '14px',
            },
        securityLevel: 'loose',
        flowchart: {
          useMaxWidth: false,
          htmlLabels: true,
          curve: 'basis',
        },
      });

      const cleaned = sanitizeMermaidClient(diagramCode);
      try {
        await mermaid.parse(cleaned);
        const svgId = `ra-mermaid-${++renderCounter}`;
        const { svg } = await mermaid.render(svgId, cleaned);
        if (cancelled) {
          return;
        }

        panZoomRef.current?.destroy();
        panZoomRef.current = null;
        container.innerHTML = svg;
        setParseWarning(null);

        const svgEl = container.querySelector('svg');
        if (svgEl) {
          svgEl.removeAttribute('style');
          svgEl.style.width = '100%';
          svgEl.style.height = '100%';
          panZoomRef.current = svgPanZoom(svgEl, {
            zoomEnabled: true,
            panEnabled: true,
            mouseWheelZoomEnabled: false,
            dblClickZoomEnabled: false,
            controlIconsEnabled: false,
            fit: true,
            center: true,
            minZoom: 0.25,
            maxZoom: 5,
            zoomScaleSensitivity: 0.25,
          });
        }
        setRenderVersion((v) => v + 1);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setParseWarning(
            `白板图形语法异常（保留上一帧，正在自动通知 Agent 修复重写...）：${msg.slice(0, 80)}`
          );
          onParseErrorRef.current?.({
            diagramId: diagramIdRef.current,
            error: msg,
            mermaidCode: cleaned,
          });
        }
      }
    };

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [diagramId, diagramCode]);

  // Apply SVG DOM focus, dimming, selection, and smooth camera panning
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const svgEl = container.querySelector('svg');
    if (!svgEl) {
      return;
    }

    const nodeEls = Array.from(svgEl.querySelectorAll<SVGGElement>(INTERACTIVE_NODE_SELECTOR));
    const edgeEls = Array.from(
      svgEl.querySelectorAll<SVGElement>(
        '.edgePath, .edgeLabel, path.flowchart-link, path.relation, path.transition'
      )
    );

    const matchedFocusEl = focusedNodeId
      ? findBestMatchingNode(nodeEls, focusedNodeId)
      : null;
    const matchedSelectEl = selectedNodeId
      ? findBestMatchingNode(nodeEls, selectedNodeId)
      : null;

    for (const el of nodeEls) {
      el.classList.remove('ra-node-focused', 'ra-dimmed', 'ra-node-selected');

      const isSelected = matchedSelectEl === el;
      const isFocused = matchedFocusEl === el;

      if (isSelected) {
        el.classList.add('ra-node-selected');
      }

      if (isFocused) {
        el.classList.add('ra-node-focused');
      } else if (matchedFocusEl !== null && !isSelected) {
        // Only dim sibling nodes when a valid focus target actually matched
        el.classList.add('ra-dimmed');
      }
    }

    for (const edgeEl of edgeEls) {
      edgeEl.classList.remove('ra-dimmed');
      if (matchedFocusEl !== null && focusedNodeId) {
        const edgeId = (edgeEl.id || edgeEl.getAttribute('data-id') || '').toLowerCase();
        const focusLogical = extractLogicalNodeId(matchedFocusEl).toLowerCase();
        const matchesEdge =
          focusedEdge &&
          edgeId.includes(focusedEdge.replace(/\s*->\s*/, '-').toLowerCase());
        const touchesFocusedNode =
          edgeId.includes(focusedNodeId.toLowerCase()) ||
          (focusLogical.length > 0 && edgeId.includes(focusLogical));
        if (!matchesEdge && !touchesFocusedNode) {
          edgeEl.classList.add('ra-dimmed');
        }
      }
    }

    if (matchedFocusEl && panZoomRef.current) {
      centerElementInPanZoom(container, matchedFocusEl, panZoomRef.current);
    }
  }, [renderVersion, focusedNodeId, focusedEdge, selectedNodeId]);

  // Attach permanent click, dblclick, and trackpad pinch-zoom / two-finger pan handlers
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let downX = 0;
    let downY = 0;
    let movedDuringDrag = false;

    const handlePointerDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
      movedDuringDrag = false;
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (
        !movedDuringDrag &&
        (Math.abs(e.clientX - downX) > 6 || Math.abs(e.clientY - downY) > 6)
      ) {
        movedDuringDrag = true;
      }
    };

    const handleClick = (e: MouseEvent) => {
      if (movedDuringDrag) {
        return;
      }
      const target = e.target as Element | null;
      const nodeEl = target?.closest(INTERACTIVE_NODE_SELECTOR) as SVGGElement | null;
      if (!nodeEl) {
        onSelectNodeRef.current(undefined);
        return;
      }
      const logicalId = extractLogicalNodeId(nodeEl);
      if (logicalId) {
        onSelectNodeRef.current(logicalId);
      }
    };

    const handleDblClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const nodeEl = target?.closest(INTERACTIVE_NODE_SELECTOR) as SVGGElement | null;
      if (!nodeEl) {
        return;
      }
      const logicalId = extractLogicalNodeId(nodeEl);
      if (logicalId) {
        onDoubleClickNodeRef.current(logicalId, nodeCodeMapRef.current?.[logicalId]);
      }
    };

    const handleWheel = (e: WheelEvent) => {
      const pz = panZoomRef.current;
      if (!pz) {
        return;
      }
      e.preventDefault();

      // macOS trackpad pinch sets ctrlKey=true; Cmd+scroll also zooms
      if (e.ctrlKey || e.metaKey) {
        const clampedDelta = Math.max(-60, Math.min(60, e.deltaY));
        const factor = Math.exp(-clampedDelta * 0.012);
        const rect = container.getBoundingClientRect();
        pz.zoomAtPointBy(factor, {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
      } else {
        // Two-finger trackpad scroll pans the diagram smoothly
        pz.panBy({ x: -e.deltaX, y: -e.deltaY });
      }
    };

    container.addEventListener('pointerdown', handlePointerDown);
    container.addEventListener('pointermove', handlePointerMove);
    container.addEventListener('click', handleClick);
    container.addEventListener('dblclick', handleDblClick);
    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      container.removeEventListener('pointerdown', handlePointerDown);
      container.removeEventListener('pointermove', handlePointerMove);
      container.removeEventListener('click', handleClick);
      container.removeEventListener('dblclick', handleDblClick);
      container.removeEventListener('wheel', handleWheel);
    };
  }, []);

  useEffect(() => {
    return () => {
      panZoomRef.current?.destroy();
      panZoomRef.current = null;
    };
  }, []);

  return (
    <div className="ra-stage-wrapper">
      {parseWarning && <div className="ra-stage-warning">{parseWarning}</div>}

      {hasDiagram && (
        <div className="ra-zoom-controls">
          <button
            type="button"
            className="ra-icon-btn"
            title="放大"
            onClick={() => panZoomRef.current?.zoomIn()}
          >
            <ZoomIn size={15} />
          </button>
          <button
            type="button"
            className="ra-icon-btn"
            title="缩小"
            onClick={() => panZoomRef.current?.zoomOut()}
          >
            <ZoomOut size={15} />
          </button>
          <button
            type="button"
            className="ra-icon-btn"
            title="自适应画布"
            onClick={() => {
              panZoomRef.current?.fit();
              panZoomRef.current?.center();
            }}
          >
            <Maximize2 size={15} />
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        className="ra-stage-canvas"
        style={{ display: hasDiagram ? 'block' : 'none' }}
      />

      {!hasDiagram && (
        <div className="ra-stage-empty">
          <div style={{ fontSize: '15px', fontWeight: 600 }}>
            交互式架构白板已就绪
          </div>
          <div style={{ maxWidth: 520, lineHeight: 1.55 }}>
            可直接基于当前分支按指令 Review 代码或全局架构导读（无需选 PR），也可以选择本地 Branch Diff 或 Bitbucket PR 进行对比复盘。
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 4 }}>
            {onStartCorePathReview && (
              <button
                type="button"
                className="ra-btn active"
                onClick={onStartCorePathReview}
                title="指定输入或当前光标入口，沿核心链路逐行审核心分支并自动跳入子方法深化白板"
              >
                <ListTree size={14} />
                <span>核心链路逐行 Review</span>
              </button>
            )}
            {onStartBranchExplore && (
              <button
                type="button"
                className={`ra-btn ${onStartCorePathReview ? '' : 'active'}`}
                onClick={onStartBranchExplore}
              >
                <Compass size={14} />
                <span>基于当前分支开始导读 / Review</span>
              </button>
            )}
            {onSwitchTarget && (
              <button
                type="button"
                className="ra-btn"
                onClick={onSwitchTarget}
              >
                <GitBranch size={14} />
                <span>选择 PR / Branch Diff</span>
              </button>
            )}
          </div>
          <div style={{ fontSize: '11px', maxWidth: 540 }}>
            提示：也可以直接在下方输入或语音说出你想了解/Review 的模块，将自动开启当前分支导读；双指平移缩放白板，单击节点提问、双击直达源码。
          </div>
        </div>
      )}
    </div>
  );
};

function extractLogicalNodeId(el: Element): string {
  const dataId = el.getAttribute('data-id');
  if (dataId) {
    return dataId;
  }
  const rawId = el.id || '';
  const match = rawId.match(
    /^(?:flowchart|state|statediagram|class|classId|er|entity)-(.+?)-\d+$/
  );
  if (match) {
    return match[1];
  }
  return rawId;
}

function findBestMatchingNode(
  nodeEls: SVGGElement[],
  targetId: string
): SVGGElement | null {
  const cleanTarget = targetId.trim();
  if (!cleanTarget) {
    return null;
  }

  // Tier 1: exact logical ID match
  for (const el of nodeEls) {
    if (extractLogicalNodeId(el) === cleanTarget) {
      return el;
    }
  }

  // Tier 2: case-insensitive exact logical ID match
  const lowerTarget = cleanTarget.toLowerCase();
  for (const el of nodeEls) {
    if (extractLogicalNodeId(el).toLowerCase() === lowerTarget) {
      return el;
    }
  }

  // Tier 3: case-insensitive substring match against logical ID or raw element ID
  for (const el of nodeEls) {
    const logical = extractLogicalNodeId(el).toLowerCase();
    const raw = (el.id || '').toLowerCase();
    if (
      (logical && (logical.includes(lowerTarget) || lowerTarget.includes(logical))) ||
      (raw && raw.includes(lowerTarget))
    ) {
      return el;
    }
  }

  return null;
}

function centerElementInPanZoom(
  container: HTMLElement,
  nodeEl: SVGGElement,
  pz: ReturnType<typeof svgPanZoom>
): void {
  const containerRect = container.getBoundingClientRect();
  const nodeRect = nodeEl.getBoundingClientRect();
  if (nodeRect.width === 0 || nodeRect.height === 0) {
    return;
  }
  const containerCx = containerRect.left + containerRect.width / 2;
  const containerCy = containerRect.top + containerRect.height / 2;
  const nodeCx = nodeRect.left + nodeRect.width / 2;
  const nodeCy = nodeRect.top + nodeRect.height / 2;
  const dx = (containerCx - nodeCx) * 0.65;
  const dy = (containerCy - nodeCy) * 0.65;
  if (Math.abs(dx) > 12 || Math.abs(dy) > 12) {
    pz.panBy({ x: dx, y: dy });
  }
}

export function sanitizeMermaidClient(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:mermaid)?\s*\r?\n?/i, '')
    .replace(/\r?\n?```\s*$/i, '')
    .trim();
}
