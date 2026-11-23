import { describe, expect, it } from 'vitest';
import { DirectiveParser, sanitizeMermaidCode } from '../DirectiveParser';

describe('DirectiveParser', () => {
  it('parses interleaved directives and sentences across arbitrary chunk boundaries', () => {
    const parser = new DirectiveParser(1);
    const stream = [
      '<chap',
      'ter index="1" total="3" title="架构总览"/>',
      '<wb_render id="ov" title="Auth Flow" mode="replace" ',
      'map=\'{"Auth":"src/auth.ts:10-40"}\'>\n```mermaid\nflowchart LR\n',
      '  GW["Gateway"] --> Auth[Token Refresh (v2)]\n```\n</wb_render>',
      '你好，我们先看整体架构。',
      '<wb_focus id="Auth" edge="GW->Auth"/>',
      '<code_goto file="src/auth.ts" lines="10-40" view="diff" label="刷新锁"/>',
      '接下来看 src/auth.ts 文件里的并发锁逻辑，当 x < 10 时直接跳过。',
      '<review_note file="src/auth.ts" line="28" severity="warning">异常分支未释放锁</review_note>',
      '这里有一个潜在问题需要注意。<wb_clear/>',
    ];

    const emitted = [];
    for (const chunk of stream) {
      emitted.push(...parser.feed(chunk));
    }
    emitted.push(...parser.flush());

    expect(emitted.length).toBe(4);

    // Segment 1: chapter + wb_render bound to first spoken sentence
    expect(emitted[0].spokenText).toBe('你好，我们先看整体架构。');
    expect(emitted[0].directivesBefore.map((d) => d.type)).toEqual([
      'chapter',
      'wb_render',
    ]);
    const renderDir = emitted[0].directivesBefore[1];
    expect(renderDir.type).toBe('wb_render');
    if (renderDir.type === 'wb_render') {
      expect(renderDir.nodeCodeMap).toEqual({ Auth: 'src/auth.ts:10-40' });
      expect(renderDir.mermaidCode).toContain('Auth["Token Refresh (v2)"]');
      expect(renderDir.mermaidCode).not.toContain('```');
    }

    // Segment 2: wb_focus + code_goto bound to second sentence; preserves '<' and 'src/auth.ts'
    expect(emitted[1].directivesBefore.map((d) => d.type)).toEqual([
      'wb_focus',
      'code_goto',
    ]);
    expect(emitted[1].spokenText).toContain('src/auth.ts');
    expect(emitted[1].spokenText).toContain('x < 10');

    // Segment 3: review_note bound to third sentence
    expect(emitted[2].directivesBefore[0]).toEqual({
      type: 'review_note',
      file: 'src/auth.ts',
      line: 28,
      severity: 'warning',
      body: '异常分支未释放锁',
    });
    expect(emitted[2].spokenText).toBe('这里有一个潜在问题需要注意。');

    // Segment 4: trailing wb_clear preserved on flush
    expect(emitted[3].spokenText).toBe('');
    expect(emitted[3].directivesBefore).toEqual([{ type: 'wb_clear' }]);
  });

  it('does not split sentences on version numbers or code filenames', () => {
    const parser = new DirectiveParser(2);
    const out = [
      ...parser.feed('请看 Node.js v2.0 与 src/auth.ts 的交互，第 1. 步先校验签名。'),
      ...parser.flush(),
    ];
    expect(out.length).toBe(1);
    expect(out[0].spokenText).toBe(
      '请看 Node.js v2.0 与 src/auth.ts 的交互，第 1. 步先校验签名。'
    );
  });

  it('sanitizes unquoted Mermaid parentheses without breaking special shapes', () => {
    const raw = `\`\`\`mermaid
flowchart TD
  A[Load Config (env)] --> DB[(Postgres)]
  DB --> C["Already (Quoted)"]
\`\`\``;
    const cleaned = sanitizeMermaidCode(raw);
    expect(cleaned).toContain('A["Load Config (env)"]');
    expect(cleaned).toContain('DB[(Postgres)]');
    expect(cleaned).toContain('C["Already (Quoted)"]');
  });

  it('normalizes code_goto source view aliases (source, file, code, raw) and diff', () => {
    const parser = new DirectiveParser(3);
    const out = [
      ...parser.feed(
        '<code_goto file="src/util.ts" lines="10-20" view="file"/>先看工具函数。' +
          '<code_goto file="src/caller.ts" lines="5" view="SOURCE"/>再看调用方。' +
          '<code_goto file="src/other.ts" lines="1-8" view="code"/>还有基础定义。'
      ),
      ...parser.flush(),
    ];
    expect(out[0].directivesBefore[0]).toMatchObject({ file: 'src/util.ts', view: 'source' });
    expect(out[1].directivesBefore[0]).toMatchObject({ file: 'src/caller.ts', view: 'source' });
    expect(out[2].directivesBefore[0]).toMatchObject({ file: 'src/other.ts', view: 'source' });
  });

  it('parses action severity, action_item tags, and omitted line=0 on review notes', () => {
    const parser = new DirectiveParser(4);
    const out = [
      ...parser.feed(
        '<review_note severity="action">需要补充空值校验</review_note>' +
          '<action_item file="src/a.ts" lines="40-50">移除冗余重算逻辑</action_item>' +
          '已为你记入 Action 列表。'
      ),
      ...parser.flush(),
    ];

    expect(out.length).toBe(1);
    expect(out[0].directivesBefore).toEqual([
      {
        type: 'review_note',
        file: '',
        line: 0,
        severity: 'action',
        body: '需要补充空值校验',
      },
      {
        type: 'review_note',
        file: 'src/a.ts',
        line: 40,
        severity: 'action',
        body: '移除冗余重算逻辑',
      },
    ]);
  });

  it('preserves erDiagram, classDiagram, sequenceDiagram, and Notes untouched in sanitizeMermaidCode', () => {
    const erRaw = `\`\`\`mermaid
erDiagram
  ORDER ||--o{ ORDER_ITEM : "contains (v2)"
  ORDER {
    string id PK
    json items[1..N]
  }
\`\`\``;
    const erCleaned = sanitizeMermaidCode(erRaw);
    expect(erCleaned).toContain('erDiagram');
    expect(erCleaned).toContain('json items[1..N]');
    expect(erCleaned).not.toContain('["');

    const seqRaw = `sequenceDiagram
  Note right of Auth: TokenMutex[v2] (non-blocking)
  Client->>Auth: refresh()`;
    expect(sanitizeMermaidCode(seqRaw)).toBe(seqRaw);

    const clsRaw = `classDiagram
  note for AuthService "Refresh[Token] (mutex)"
  class AuthService`;
    expect(sanitizeMermaidCode(clsRaw)).toBe(clsRaw);
  });

  it('parses call_chain directive in both pipe-delimited and JSON formats', () => {
    const parser = new DirectiveParser(5);
    const out = [
      ...parser.feed(
        `<call_chain title="Token 刷新主链路">\n` +
          `POST /auth/refresh | src/api/routes.ts:12 | 入口路由接收请求\n` +
          `AuthController.handle | src/api/controller.ts:45-52 | 校验参数\n` +
          `* AuthService.refreshToken | src/auth/token.ts:24 | 加锁执行刷新\n` +
          `</call_chain>` +
          '先看这一条 Token 刷新链路。' +
          `<call_chain title="JSON 链路">[{"symbol":"Main.run","file":"src/main.ts","line":10,"active":true,"role":"主入口"}]</call_chain>` +
          '再切另一条链路。'
      ),
      ...parser.flush(),
    ];

    expect(out.length).toBe(2);
    const cc1 = out[0].directivesBefore[0];
    expect(cc1.type).toBe('call_chain');
    if (cc1.type === 'call_chain') {
      expect(cc1.title).toBe('Token 刷新主链路');
      expect(cc1.activeIndex).toBe(2);
      expect(cc1.nodes).toEqual([
        {
          id: 'cc-0',
          symbol: 'POST /auth/refresh',
          file: 'src/api/routes.ts',
          line: 12,
          endLine: undefined,
          role: '入口路由接收请求',
        },
        {
          id: 'cc-1',
          symbol: 'AuthController.handle',
          file: 'src/api/controller.ts',
          line: 45,
          endLine: 52,
          role: '校验参数',
        },
        {
          id: 'cc-2',
          symbol: 'AuthService.refreshToken',
          file: 'src/auth/token.ts',
          line: 24,
          endLine: undefined,
          role: '加锁执行刷新',
        },
      ]);
    }

    const cc2 = out[1].directivesBefore[0];
    expect(cc2).toMatchObject({
      type: 'call_chain',
      title: 'JSON 链路',
      activeIndex: 0,
      nodes: [
        {
          id: 'cc-0',
          symbol: 'Main.run',
          file: 'src/main.ts',
          line: 10,
          role: '主入口',
        },
      ],
    });
  });

  it('parses wb_render mode="update|rewrite", target, and parent attributes', () => {
    const parser = new DirectiveParser(6);
    const out = [
      ...parser.feed(
        '<wb_render mode="update" target="l2-auth" title="更新 L2">flowchart LR\n  A --> B\n</wb_render>' +
          '<wb_render mode="push" parent="overview" id="l2-db" title="DB 分支">erDiagram\n  USER ||--o{ KEY : has\n</wb_render>' +
          '白板已更新并新增分支。'
      ),
      ...parser.flush(),
    ];

    expect(out.length).toBe(1);
    expect(out[0].directivesBefore[0]).toMatchObject({
      type: 'wb_render',
      mode: 'update',
      targetId: 'l2-auth',
      title: '更新 L2',
    });
    expect(out[0].directivesBefore[1]).toMatchObject({
      type: 'wb_render',
      mode: 'push',
      parentId: 'overview',
      id: 'l2-db',
      title: 'DB 分支',
    });
  });

  it('parses self-closing <walkthrough_done/> directive', () => {
    const parser = new DirectiveParser(7);
    const out = [
      ...parser.feed('这一整条链路已全部讲解完毕。<walkthrough_done/>'),
      ...parser.flush(),
    ];
    const allDirs = out.flatMap((s) => [...s.directivesBefore, ...s.directivesAfter]);
    expect(allDirs).toContainEqual({ type: 'walkthrough_done' });
  });

  it('rewrites sequence-style Note right/left/over lines inside flowchart without breaking sequenceDiagram', () => {
    const brokenFlow = `flowchart TD
  N1["下单请求"] --> N2["下单 & 接收回执"]
  Note right of N2: 每 lane 独立串行
  Note left of N1: 入口校验`;
    const fixedFlow = sanitizeMermaidCode(brokenFlow);
    expect(fixedFlow).toContain('_Note_1["📝 每 lane 独立串行"] -.-> N2');
    expect(fixedFlow).toContain('_Note_2["📝 入口校验"] -.-> N1');
    expect(fixedFlow).not.toContain('Note right of');

    const seqDiagram = `sequenceDiagram
  Note right of N2: 每 lane 独立串行
  A->>N2: submit()`;
    expect(sanitizeMermaidCode(seqDiagram)).toBe(seqDiagram);
  });
});
