import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageLogger } from '../UsageLogger';

describe('UsageLogger', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((d) => fs.rm(d, { recursive: true, force: true }))
    );
    tempDirs.length = 0;
  });

  it('writes structured JSONL records, updates counters, and flushes session.end on dispose', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-logs-'));
    tempDirs.push(dir);
    const linesMirrored: string[] = [];

    const logger = new UsageLogger({
      logDir: dir,
      enabled: true,
      onLine: (line) => linesMirrored.push(line),
    });

    const sid = logger.startSession({ targetTitle: 'PR #42', thoughtLevel: 'low' });
    expect(sid).toBeTruthy();

    logger.log('turn.start', { source: 'initial' }, 1);
    logger.log('tts.synthesize', { synthMs: 42, fallbackUsed: true }, 1);
    logger.log('voice.barge_in', { spokenRatio: 0.4 }, 1);
    logger.log('whiteboard.mermaid_error', { diagramId: 'ov', error: 'Parse error' });
    logger.log('ui.interaction', { action: 'manual_note_added', line: 10 });

    await logger.dispose();

    const logPath = logger.getCurrentLogPath();
    expect(logPath).toBeTruthy();

    const raw = await fs.readFile(logPath!, 'utf8');
    const records = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { ts: string; sessionId: string; event: string; turnId?: number; data?: Record<string, unknown> });

    expect(records.map((r) => r.event)).toEqual([
      'session.start',
      'turn.start',
      'tts.synthesize',
      'voice.barge_in',
      'whiteboard.mermaid_error',
      'ui.interaction',
      'session.end',
    ]);

    const endRec = records[records.length - 1];
    expect(endRec.data?.counters).toEqual({
      turns: 1,
      bargeIns: 1,
      mermaidErrors: 1,
      ttsFallbacks: 1,
      notesAdded: 1,
    });
    expect(linesMirrored.length).toBe(7);
  });

  it('does not create log files when disabled', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-logs-off-'));
    tempDirs.push(dir);

    const logger = new UsageLogger({
      logDir: dir,
      enabled: false,
    });
    logger.startSession({ targetTitle: 'Local Diff' });
    logger.log('turn.start', { source: 'initial' }, 1);
    await logger.dispose();

    expect(logger.getCurrentLogPath()).toBeUndefined();
    const entries = await fs.readdir(dir);
    expect(entries.length).toBe(0);
  });
});
