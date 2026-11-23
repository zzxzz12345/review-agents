import { describe, expect, it } from 'vitest';
import {
  applyWhiteboardDirective,
  createEmptyWhiteboardTree,
  deriveActivePath,
  formatWhiteboardTreeOutline,
  getSiblingsForLayer,
  MAX_WHITEBOARD_DEPTH,
  selectWhiteboardLayer,
} from '../../shared/whiteboardTree';

describe('whiteboardTree (L1~L4 dynamic tree & in-place rewrite)', () => {
  it('supports in-place update by targetId without losing child branches', () => {
    let tree = createEmptyWhiteboardTree();
    tree = applyWhiteboardDirective(tree, {
      type: 'wb_render',
      id: 'l1',
      title: '全局架构',
      mode: 'replace',
      mermaidCode: 'flowchart LR\n  A --> B',
    });
    tree = applyWhiteboardDirective(tree, {
      type: 'wb_render',
      id: 'l2',
      title: 'Fork 迁移链路',
      mode: 'push',
      mermaidCode: 'flowchart TD\n  B --> C',
    });
    tree = applyWhiteboardDirective(tree, {
      type: 'wb_render',
      id: 'l3',
      title: 'legacy 适配示例',
      mode: 'push',
      mermaidCode: 'flowchart TD\n  C --> D',
    });

    // Update L2 in place while viewing L3
    tree = applyWhiteboardDirective(tree, {
      type: 'wb_render',
      id: 'l2-ignored',
      targetId: 'l2',
      title: 'Fork 迁移链路（已补全）',
      mode: 'update',
      mermaidCode: 'flowchart TD\n  B --> C1 & C2',
    });

    expect(tree.activeId).toBe('l2');
    const l2Node = tree.nodes.find((n) => n.id === 'l2');
    expect(l2Node?.title).toBe('Fork 迁移链路（已补全）');
    expect(l2Node?.revision).toBe(2);
    expect(l2Node?.level).toBe(2);

    // Child L3 is still preserved in deriveActivePath & tree outline
    const { stack, activeIndex } = deriveActivePath(tree);
    expect(stack.map((n) => n.id)).toEqual(['l1', 'l2', 'l3']);
    expect(activeIndex).toBe(1);
    expect(tree.nodes.length).toBe(3);
  });

  it('caps hierarchy at L1~L4 so pushing from L4 creates a sibling L4 instead of L5/L6/L7', () => {
    let tree = createEmptyWhiteboardTree();
    tree = applyWhiteboardDirective(tree, {
      type: 'wb_render',
      id: 'root',
      title: 'L1',
      mode: 'replace',
      mermaidCode: 'flowchart LR\n  A-->B',
    });
    tree = applyWhiteboardDirective(tree, {
      type: 'wb_render',
      id: 'mod',
      title: 'L2',
      mode: 'push',
      mermaidCode: 'flowchart LR\n  B-->C',
    });
    tree = applyWhiteboardDirective(tree, {
      type: 'wb_render',
      id: 'cls',
      title: 'L3',
      mode: 'push',
      mermaidCode: 'flowchart LR\n  C-->D',
    });
    tree = applyWhiteboardDirective(tree, {
      type: 'wb_render',
      id: 'case1',
      title: 'L4 单个适配示例',
      mode: 'push',
      mermaidCode: 'flowchart LR\n  D-->E',
    });

    expect(tree.nodes.find((n) => n.id === 'case1')?.level).toBe(MAX_WHITEBOARD_DEPTH);

    // Attempting to push again while on L4 attaches as sibling L4 under L3 (`cls`)
    tree = applyWhiteboardDirective(tree, {
      type: 'wb_render',
      id: 'summary5',
      title: 'L4 全部 5 类适配汇总',
      mode: 'push',
      mermaidCode: 'flowchart LR\n  D-->S1 & S2',
    });

    const summary = tree.nodes.find((n) => n.id === 'summary5');
    expect(summary?.level).toBe(MAX_WHITEBOARD_DEPTH);
    expect(summary?.parentId).toBe('cls');
    expect(deriveActivePath(tree).stack.map((n) => n.id)).toEqual([
      'root',
      'mod',
      'cls',
      'summary5',
    ]);

    const l4Siblings = getSiblingsForLayer(tree.nodes, 'summary5');
    expect(l4Siblings.map((n) => n.id)).toEqual(['case1', 'summary5']);
  });

  it('supports branching via parentId and switching cleanly between sibling subtrees', () => {
    let tree = createEmptyWhiteboardTree();
    tree = applyWhiteboardDirective(tree, {
      type: 'wb_render',
      id: 'l1',
      title: '总览',
      mode: 'replace',
      mermaidCode: 'flowchart LR\n A-->B',
    });
    tree = applyWhiteboardDirective(tree, {
      type: 'wb_render',
      id: 'l2-a',
      title: '分支 A',
      mode: 'push',
      mermaidCode: 'flowchart LR\n B-->A1',
    });
    tree = applyWhiteboardDirective(tree, {
      type: 'wb_render',
      id: 'l3-a',
      title: '分支 A 细节',
      mode: 'push',
      mermaidCode: 'flowchart LR\n A1-->A2',
    });
    // Push sibling L2 directly under l1 via parentId
    tree = applyWhiteboardDirective(tree, {
      type: 'wb_render',
      id: 'l2-b',
      parentId: 'l1',
      title: '分支 B',
      mode: 'push',
      mermaidCode: 'flowchart LR\n B-->B1',
    });

    expect(deriveActivePath(tree).stack.map((n) => n.id)).toEqual(['l1', 'l2-b']);

    // Switch back to l2-a -> remembers l3-a child below it
    tree = selectWhiteboardLayer(tree, 'l2-a');
    expect(deriveActivePath(tree).stack.map((n) => n.id)).toEqual(['l1', 'l2-a', 'l3-a']);
    expect(deriveActivePath(tree).activeIndex).toBe(1);

    const outline = formatWhiteboardTreeOutline(tree);
    expect(outline).toContain('[L1] id="l1" 总览');
    expect(outline).toContain('  - [L2] id="l2-a" 分支 A (当前)');
    expect(outline).toContain('    - [L3] id="l3-a" 分支 A 细节');
    expect(outline).toContain('  - [L2] id="l2-b" 分支 B');
  });
});
