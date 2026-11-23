import type { DiagramStackItem, Directive, WbRenderDirective } from './protocol';

export const MAX_WHITEBOARD_DEPTH = 4;

export interface WhiteboardTreeState {
  nodes: DiagramStackItem[];
  activeId?: string;
  lastChildByParent: Record<string, string>;
}

export function createEmptyWhiteboardTree(): WhiteboardTreeState {
  return {
    nodes: [],
    activeId: undefined,
    lastChildByParent: {},
  };
}

export function computeNodeLevel(nodes: DiagramStackItem[], id: string): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();
  let depth = 0;
  let curId: string | undefined = id;
  while (curId && !visited.has(curId)) {
    const node = byId.get(curId);
    if (!node) {
      break;
    }
    visited.add(curId);
    depth += 1;
    curId = node.parentId;
  }
  return Math.max(1, depth);
}

export function deriveActivePath(state: WhiteboardTreeState): {
  stack: DiagramStackItem[];
  activeIndex: number;
} {
  if (state.nodes.length === 0) {
    return { stack: [], activeIndex: -1 };
  }

  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const active =
    (state.activeId ? byId.get(state.activeId) : undefined) ??
    state.nodes[state.nodes.length - 1];

  // Walk up from active -> root
  const ancestors: DiagramStackItem[] = [];
  const upVisited = new Set<string>();
  let cur: DiagramStackItem | undefined = active;
  while (cur && !upVisited.has(cur.id)) {
    upVisited.add(cur.id);
    ancestors.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  // Walk down from active along remembered active child branch
  const descendants: DiagramStackItem[] = [];
  const downVisited = new Set<string>(upVisited);
  let childId = state.lastChildByParent[active.id];
  while (childId && !downVisited.has(childId)) {
    const child = byId.get(childId);
    if (!child || child.parentId !== (descendants[descendants.length - 1]?.id ?? active.id)) {
      break;
    }
    downVisited.add(childId);
    descendants.push(child);
    childId = state.lastChildByParent[child.id];
  }

  const stack = [...ancestors, ...descendants];
  const activeIndex = Math.max(0, ancestors.length - 1);
  return { stack, activeIndex };
}

export function getActiveDiagram(state: WhiteboardTreeState): DiagramStackItem | undefined {
  if (state.nodes.length === 0) {
    return undefined;
  }
  if (state.activeId) {
    const found = state.nodes.find((n) => n.id === state.activeId);
    if (found) {
      return found;
    }
  }
  return state.nodes[state.nodes.length - 1];
}

export function getSiblingsForLayer(
  nodes: DiagramStackItem[],
  layerId: string
): DiagramStackItem[] {
  const target = nodes.find((n) => n.id === layerId);
  if (!target) {
    return [];
  }
  return nodes.filter((n) => n.parentId === target.parentId);
}

export function selectWhiteboardLayer(
  state: WhiteboardTreeState,
  layerId: string
): WhiteboardTreeState {
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const target = byId.get(layerId);
  if (!target) {
    return state;
  }

  const nextLastChildByParent = { ...state.lastChildByParent };
  const visited = new Set<string>([target.id]);
  let child = target;
  while (child.parentId && !visited.has(child.parentId)) {
    const parent = byId.get(child.parentId);
    if (!parent) {
      break;
    }
    visited.add(parent.id);
    nextLastChildByParent[parent.id] = child.id;
    child = parent;
  }

  return {
    nodes: state.nodes,
    activeId: target.id,
    lastChildByParent: nextLastChildByParent,
  };
}

export function selectWhiteboardIndex(
  state: WhiteboardTreeState,
  index: number
): WhiteboardTreeState {
  const { stack } = deriveActivePath(state);
  if (index < 0 || index >= stack.length) {
    return state;
  }
  return selectWhiteboardLayer(state, stack[index].id);
}

export function applyWhiteboardDirective(
  state: WhiteboardTreeState,
  dir: Directive
): WhiteboardTreeState {
  if (dir.type === 'wb_render') {
    return applyWbRender(state, dir);
  }

  if (dir.type === 'wb_pop') {
    const active = getActiveDiagram(state);
    if (!active?.parentId) {
      return state;
    }
    const parentExists = state.nodes.some((n) => n.id === active.parentId);
    if (!parentExists) {
      return state;
    }
    return {
      ...state,
      activeId: active.parentId,
    };
  }

  if (dir.type === 'wb_focus') {
    const active = getActiveDiagram(state);
    if (!active) {
      return state;
    }
    const nodes = state.nodes.map((n) =>
      n.id === active.id
        ? { ...n, focusedNodeId: dir.id, focusedEdge: dir.edge }
        : n
    );
    return { ...state, nodes };
  }

  if (dir.type === 'wb_clear') {
    const active = getActiveDiagram(state);
    if (!active) {
      return state;
    }
    const nodes = state.nodes.map((n) =>
      n.id === active.id
        ? { ...n, focusedNodeId: undefined, focusedEdge: undefined }
        : n
    );
    return { ...state, nodes };
  }

  return state;
}

function applyWbRender(
  state: WhiteboardTreeState,
  dir: WbRenderDirective
): WhiteboardTreeState {
  const findById = (id?: string): DiagramStackItem | undefined =>
    id ? state.nodes.find((n) => n.id === id) : undefined;

  const rewriteInPlace = (target: DiagramStackItem): WhiteboardTreeState => {
    const level = target.level ?? computeNodeLevel(state.nodes, target.id);
    const updated: DiagramStackItem = {
      ...target,
      title: dir.title || target.title,
      mermaidCode: dir.mermaidCode,
      nodeCodeMap: dir.nodeCodeMap,
      focusedNodeId: undefined,
      focusedEdge: undefined,
      level,
      revision: (target.revision ?? 1) + 1,
    };
    const nextNodes = state.nodes.map((n) => (n.id === target.id ? updated : n));
    return selectWhiteboardLayer(
      {
        nodes: nextNodes,
        activeId: target.id,
        lastChildByParent: state.lastChildByParent,
      },
      target.id
    );
  };

  if (dir.mode === 'update') {
    const target =
      findById(dir.targetId) ??
      findById(dir.id) ??
      getActiveDiagram(state);
    if (target) {
      return rewriteInPlace(target);
    }
    const root: DiagramStackItem = {
      id: dir.id,
      title: dir.title,
      mermaidCode: dir.mermaidCode,
      nodeCodeMap: dir.nodeCodeMap,
      level: 1,
      revision: 1,
    };
    return {
      nodes: [root],
      activeId: root.id,
      lastChildByParent: {},
    };
  }

  if (dir.mode === 'replace') {
    const existing = findById(dir.targetId) ?? findById(dir.id);
    if (existing) {
      return rewriteInPlace(existing);
    }
    const root: DiagramStackItem = {
      id: dir.id,
      title: dir.title,
      mermaidCode: dir.mermaidCode,
      nodeCodeMap: dir.nodeCodeMap,
      level: 1,
      revision: 1,
    };
    return {
      nodes: [root],
      activeId: root.id,
      lastChildByParent: {},
    };
  }

  // mode === 'push'
  if (state.nodes.length === 0) {
    const root: DiagramStackItem = {
      id: dir.id,
      title: dir.title,
      mermaidCode: dir.mermaidCode,
      nodeCodeMap: dir.nodeCodeMap,
      level: 1,
      revision: 1,
    };
    return {
      nodes: [root],
      activeId: root.id,
      lastChildByParent: {},
    };
  }

  let resolvedParent =
    findById(dir.parentId) ??
    getActiveDiagram(state) ??
    state.nodes[state.nodes.length - 1];

  const existingSameId = findById(dir.id);
  if (
    existingSameId &&
    (existingSameId.parentId === resolvedParent.id ||
      existingSameId.id === resolvedParent.id ||
      (dir.parentId !== undefined && dir.parentId === existingSameId.parentId))
  ) {
    return rewriteInPlace(existingSameId);
  }

  let parentLevel = computeNodeLevel(state.nodes, resolvedParent.id);
  if (parentLevel >= MAX_WHITEBOARD_DEPTH) {
    // Enforce L1..L4 depth cap: attach as an L4 sibling under L3, or rewrite L4 if no L3
    const grandParent = resolvedParent.parentId
      ? findById(resolvedParent.parentId)
      : undefined;
    if (!grandParent) {
      return rewriteInPlace(resolvedParent);
    }
    resolvedParent = grandParent;
    parentLevel = computeNodeLevel(state.nodes, resolvedParent.id);
  }

  const uniqueId = makeUniqueLayerId(state.nodes, dir.id);
  const newNode: DiagramStackItem = {
    id: uniqueId,
    title: dir.title,
    mermaidCode: dir.mermaidCode,
    nodeCodeMap: dir.nodeCodeMap,
    parentId: resolvedParent.id,
    level: Math.min(MAX_WHITEBOARD_DEPTH, parentLevel + 1),
    revision: 1,
  };

  return selectWhiteboardLayer(
    {
      nodes: [...state.nodes, newNode],
      activeId: newNode.id,
      lastChildByParent: state.lastChildByParent,
    },
    newNode.id
  );
}

export function syncWhiteboardTreeFromPayload(payload: {
  stack: DiagramStackItem[];
  activeIndex?: number;
  nodes?: DiagramStackItem[];
  activeId?: string;
}): WhiteboardTreeState {
  if (payload.nodes && payload.nodes.length > 0) {
    const normalizedNodes = payload.nodes.map((n) => ({
      ...n,
      level: n.level ?? computeNodeLevel(payload.nodes!, n.id),
      revision: n.revision ?? 1,
    }));
    const lastChildByParent: Record<string, string> = {};
    for (const node of normalizedNodes) {
      if (node.parentId) {
        lastChildByParent[node.parentId] = node.id;
      }
    }
    const fallbackActive =
      payload.activeId && normalizedNodes.some((n) => n.id === payload.activeId)
        ? payload.activeId
        : normalizedNodes[normalizedNodes.length - 1].id;

    return selectWhiteboardLayer(
      {
        nodes: normalizedNodes,
        activeId: fallbackActive,
        lastChildByParent,
      },
      fallbackActive
    );
  }

  if (!payload.stack || payload.stack.length === 0) {
    return createEmptyWhiteboardTree();
  }

  // Fallback reconstruction from linear stack
  const normalizedNodes: DiagramStackItem[] = payload.stack.map((item, idx) => ({
    ...item,
    parentId: idx > 0 ? payload.stack[idx - 1].id : undefined,
    level: Math.min(MAX_WHITEBOARD_DEPTH, idx + 1),
    revision: item.revision ?? 1,
  }));
  const activeIdx =
    payload.activeIndex !== undefined &&
    payload.activeIndex >= 0 &&
    payload.activeIndex < normalizedNodes.length
      ? payload.activeIndex
      : normalizedNodes.length - 1;
  const lastChildByParent: Record<string, string> = {};
  for (let i = 1; i < normalizedNodes.length; i += 1) {
    lastChildByParent[normalizedNodes[i - 1].id] = normalizedNodes[i].id;
  }
  return selectWhiteboardLayer(
    {
      nodes: normalizedNodes,
      activeId: normalizedNodes[activeIdx].id,
      lastChildByParent,
    },
    normalizedNodes[activeIdx].id
  );
}

export function formatWhiteboardTreeOutline(state: WhiteboardTreeState): string {
  if (state.nodes.length === 0) {
    return '';
  }

  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const childrenByParent = new Map<string | undefined, DiagramStackItem[]>();
  for (const node of state.nodes) {
    const parentKey =
      node.parentId && byId.has(node.parentId) ? node.parentId : undefined;
    const bucket = childrenByParent.get(parentKey);
    if (bucket) {
      bucket.push(node);
    } else {
      childrenByParent.set(parentKey, [node]);
    }
  }

  const lines: string[] = [];
  const visited = new Set<string>();

  const walk = (parentId: string | undefined, depth: number): void => {
    const children = childrenByParent.get(parentId) ?? [];
    for (const node of children) {
      if (visited.has(node.id)) {
        continue;
      }
      visited.add(node.id);
      const level = node.level ?? Math.min(MAX_WHITEBOARD_DEPTH, depth + 1);
      const revSuffix = (node.revision ?? 1) > 1 ? ` v${node.revision}` : '';
      const activeSuffix = node.id === state.activeId ? ' (当前)' : '';
      const indent = '  '.repeat(Math.max(0, level - 1));
      lines.push(
        `${indent}- [L${level}] id="${node.id}" ${node.title || node.id}${revSuffix}${activeSuffix}`
      );
      walk(node.id, depth + 1);
    }
  };

  walk(undefined, 0);
  return lines.join('\n');
}

function makeUniqueLayerId(nodes: DiagramStackItem[], baseId: string): string {
  const cleanBase = baseId.trim() || 'diagram';
  const existingIds = new Set(nodes.map((n) => n.id));
  if (!existingIds.has(cleanBase)) {
    return cleanBase;
  }
  let suffix = 2;
  while (existingIds.has(`${cleanBase}-${suffix}`)) {
    suffix += 1;
  }
  return `${cleanBase}-${suffix}`;
}
