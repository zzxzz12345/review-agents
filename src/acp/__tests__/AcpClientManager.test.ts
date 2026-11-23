import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpClientManager } from '../AcpClientManager';

const MOCK_ACP_SERVER_JS = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n');
}

let activePromptId = null;
let promptTimer = null;
let setConfigs = [];

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          _meta: { antigravity: { systemPrompt: { append: true } } },
        },
        agentInfo: { name: 'Mock ACP', version: '1.0.0' },
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    const appended = msg.params?._meta?.antigravity?.systemPrompt?.append || '';
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'mock-sess-1',
        configOptions: [
          {
            id: 'thought_level',
            name: 'Thinking Level',
            category: 'thought_level',
            type: 'select',
            currentValue: 'medium',
            options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
          },
        ],
        _echoAppendLen: appended.length,
      },
    });
    return;
  }

  if (msg.method === 'session/set_config_option') {
    setConfigs.push({ configId: msg.params.configId, value: msg.params.value });
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        configOptions: [
          {
            id: 'thought_level',
            category: 'thought_level',
            type: 'select',
            currentValue: msg.params.value,
          },
        ],
      },
    });
    return;
  }

  if (msg.method === 'session/prompt') {
    const text = msg.params?.prompt?.[0]?.text || '';
    if (text.includes('TRIGGER_CANCEL')) {
      activePromptId = msg.id;
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'mock-sess-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Part 1...' },
          },
        },
      });
      promptTimer = setTimeout(() => {
        if (activePromptId === msg.id) {
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          activePromptId = null;
        }
      }, 2500);
      return;
    }

    if (text.includes('TRIGGER_READ')) {
      send({
        jsonrpc: '2.0',
        id: 9001,
        method: 'fs/read_text_file',
        params: { sessionId: 'mock-sess-1', path: 'sample.txt', line: 2, limit: 1 },
      });
      // wait for client response 9001 before finishing
      rl.once('line', (respLine) => {
        const resp = JSON.parse(respLine);
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'mock-sess-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'LINE=' + (resp.result?.content || '') + '|CFG=' + JSON.stringify(setConfigs) },
            },
          },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      });
      return;
    }

    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'mock-sess-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'OK' },
        },
      },
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }

  if (msg.method === 'session/cancel') {
    if (promptTimer) {
      clearTimeout(promptTimer);
      promptTimer = null;
    }
    if (activePromptId !== null) {
      const id = activePromptId;
      activePromptId = null;
      send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
    }
  }
});
`;

describe('AcpClientManager', () => {
  const tempDirs: string[] = [];
  const clients: AcpClientManager[] = [];

  afterEach(async () => {
    for (const c of clients) {
      c.dispose();
    }
    clients.length = 0;
    await Promise.all(
      tempDirs.map((d) => fs.rm(d, { recursive: true, force: true }))
    );
    tempDirs.length = 0;
  });

  it('connects, sets thought_level=low, handles fs/read_text_file, streams chunks, and cancels cleanly', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-acp-test-'));
    tempDirs.push(dir);
    const serverPath = path.join(dir, 'mock-acp.cjs');
    await fs.writeFile(serverPath, MOCK_ACP_SERVER_JS, 'utf8');
    await fs.writeFile(path.join(dir, 'sample.txt'), 'line1\nline2\nline3\n', 'utf8');

    const client = new AcpClientManager();
    clients.push(client);

    const conn = await client.connect({
      cwd: dir,
      profile: {
        id: 'custom',
        displayName: 'Mock ACP',
        command: process.execPath,
        args: [serverPath],
      },
      systemPromptAppend: 'Test append prompt',
      thoughtLevel: 'low',
    });

    expect(conn.sessionResult.sessionId).toBe('mock-sess-1');
    expect(conn.configOptions[0]?.currentValue).toBe('low');

    let readOut = '';
    const readActivities: Array<{
      kind?: string;
      status?: string;
      filePath?: string;
      line?: number;
      limit?: number;
    }> = [];
    await client.sendPrompt('TRIGGER_READ', {
      onTextDelta: (d) => {
        readOut += d;
      },
      onToolActivity: (info) => {
        readActivities.push(info);
      },
    });
    expect(readOut).toContain('LINE=line2');
    expect(readOut).toContain('"value":"low"');
    expect(readActivities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'read',
          status: 'in_progress',
          filePath: 'sample.txt',
          line: 2,
          limit: 1,
        }),
        expect.objectContaining({
          kind: 'read',
          status: 'completed',
          filePath: 'sample.txt',
          line: 2,
          limit: 1,
        }),
      ])
    );

    let cancelOut = '';
    const promptPromise = client.sendPrompt('TRIGGER_CANCEL', {
      onTextDelta: (d) => {
        cancelOut += d;
      },
    });

    await new Promise((r) => setTimeout(r, 80));
    client.cancel();
    const cancelRes = await promptPromise;
    expect(cancelRes.stopReason).toBe('cancelled');
    expect(cancelOut).toBe('Part 1...');
  });

  it('resolves preferred model "Gemini 4 Hydrogen" with low effort and reports graceful fallback when absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-acp-model-'));
    tempDirs.push(dir);

    const modelServerJs = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

let modelOpts = [
  { value: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5' },
  { value: 'gemini-4-hydrogen-group', name: 'Gemini 4 Hydrogen · routing group' },
];
let currentModel = 'claude-sonnet-5.5';
let currentThought = 'medium';
const callOrder = [];

function currentConfigOptions() {
  return [
    { id: 'model', category: 'model', type: 'select', currentValue: currentModel, options: modelOpts },
    { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: currentThought, options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }] },
  ];
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'm1', configOptions: currentConfigOptions() } });
    return;
  }
  if (msg.method === 'session/set_config_option') {
    callOrder.push(msg.params.configId + '=' + msg.params.value);
    if (msg.params.configId === 'model') {
      currentModel = msg.params.value;
      // Simulate server resetting thought_level when model switches
      currentThought = 'medium';
    } else if (msg.params.configId === 'thought_level') {
      currentThought = msg.params.value;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: currentConfigOptions() } });
    return;
  }
  if (msg.method === 'session/prompt') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'm1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: callOrder.join(',') } } },
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;

    const serverPath = path.join(dir, 'model-acp.cjs');
    await fs.writeFile(serverPath, modelServerJs, 'utf8');

    const client = new AcpClientManager();
    clients.push(client);

    // 1. Exact/fuzzy match against Gemini 4 Hydrogen and low effort applied AFTER model switch
    const matchedConn = await client.connect({
      cwd: dir,
      profile: { id: 'custom', displayName: 'Model ACP', command: process.execPath, args: [serverPath] },
      preferredModel: 'Gemini 4 Hydrogen',
      thoughtLevel: 'low',
    });

    expect(matchedConn.modelResolution.matchedRequestedModel).toBe(true);
    expect(matchedConn.modelResolution.resolvedModel).toContain('Gemini 4 Hydrogen');
    expect(matchedConn.modelResolution.resolvedThoughtLevel).toBe('low');

    let orderText = '';
    await client.sendPrompt('hi', { onTextDelta: (d) => (orderText += d) });
    expect(orderText).toBe('model=gemini-4-hydrogen-group,thought_level=low');

    // 2. Comma-separated preference list matches first available candidate cleanly
    const listConn = await client.connect({
      cwd: dir,
      profile: { id: 'custom', displayName: 'Model ACP', command: process.execPath, args: [serverPath] },
      preferredModel: 'NonExistent Model 99, claude-sonnet-5.5',
      thoughtLevel: 'low',
    });
    expect(listConn.modelResolution.matchedRequestedModel).toBe(true);
    expect(listConn.modelResolution.matchedCandidate).toBe('claude-sonnet-5.5');
    expect(listConn.modelResolution.resolvedModel).toBe('Claude Sonnet 5.5');
    expect(listConn.modelResolution.resolvedThoughtLevel).toBe('low');

    // 3. Non-existent model triggers graceful fallback reporting instead of crashing
    const fallbackConn = await client.connect({
      cwd: dir,
      profile: { id: 'custom', displayName: 'Model ACP', command: process.execPath, args: [serverPath] },
      preferredModel: 'NonExistent Model 99',
      thoughtLevel: 'low',
    });
    expect(fallbackConn.modelResolution.matchedRequestedModel).toBe(false);
    expect(fallbackConn.modelResolution.resolvedModel).toBe('claude-sonnet-5.5');
    expect(fallbackConn.modelResolution.resolvedThoughtLevel).toBe('low');
  });

  it('extracts agent_thought_chunk deltas and structured file paths from tool_call locations and rawInput', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-acp-activity-'));
    tempDirs.push(dir);
    const absTarget = path.join(dir, 'src', 'auth.ts');

    const activityServerJs = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'act-1', configOptions: [] } });
    return;
  }
  if (msg.method === 'session/prompt') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'act-1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: '**Checking** \`src/auth.ts\` flow' },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'act-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'Read File',
          kind: 'read',
          status: 'in_progress',
          locations: [{ path: ${JSON.stringify(absTarget)}, line: 12 }],
          rawInput: { StartLine: 12, EndLine: 45 },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'act-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-2',
          title: 'Grep',
          kind: 'search',
          status: 'completed',
          rawInput: { file_path: 'src/api.ts', line: 8, query: 'refreshToken' },
        },
      },
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;

    const serverPath = path.join(dir, 'activity-acp.cjs');
    await fs.writeFile(serverPath, activityServerJs, 'utf8');

    const client = new AcpClientManager();
    clients.push(client);
    await client.connect({
      cwd: dir,
      profile: {
        id: 'custom',
        displayName: 'Activity ACP',
        command: process.execPath,
        args: [serverPath],
      },
      thoughtLevel: 'low',
    });

    const thoughts: string[] = [];
    const activities: Array<{
      toolCallId?: string;
      filePath?: string;
      line?: number;
      limit?: number;
      detail?: string;
      status?: string;
    }> = [];

    await client.sendPrompt('trace', {
      onTextDelta: () => undefined,
      onThoughtDelta: (d) => thoughts.push(d),
      onToolActivity: (info) => activities.push(info),
    });

    expect(thoughts.join('')).toContain('Checking');
    expect(activities[0]).toMatchObject({
      toolCallId: 'tc-1',
      filePath: 'src/auth.ts',
      line: 12,
      limit: 34,
      status: 'in_progress',
    });
    expect(activities[1]).toMatchObject({
      toolCallId: 'tc-2',
      filePath: 'src/api.ts',
      line: 8,
      detail: 'refreshToken',
      status: 'completed',
    });
  });
});
