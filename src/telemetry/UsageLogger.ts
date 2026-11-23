import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface UsageLogRecord {
  ts: string;
  sessionId: string;
  turnId?: number;
  event: string;
  data?: Record<string, unknown>;
}

export interface UsageSessionCounters {
  turns: number;
  bargeIns: number;
  mermaidErrors: number;
  ttsFallbacks: number;
  notesAdded: number;
}

export interface UsageLoggerOptions {
  logDir: string;
  enabled: boolean;
  onLine?: (line: string) => void;
}

export class UsageLogger {
  private logDir: string;
  private enabled: boolean;
  private readonly onLine?: (line: string) => void;

  private sessionId = '';
  private currentLogPath: string | undefined;
  private dirReady = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private counters: UsageSessionCounters = createEmptyCounters();

  constructor(options: UsageLoggerOptions) {
    this.logDir = options.logDir;
    this.enabled = options.enabled;
    this.onLine = options.onLine;
  }

  public configure(next: { logDir?: string; enabled?: boolean }): void {
    if (next.logDir !== undefined && next.logDir !== this.logDir) {
      this.logDir = next.logDir;
      this.dirReady = false;
    }
    if (next.enabled !== undefined) {
      this.enabled = next.enabled;
    }
  }

  public getLogDirectory(): string {
    return this.logDir;
  }

  public getCurrentLogPath(): string | undefined {
    return this.currentLogPath;
  }

  public getCounters(): UsageSessionCounters {
    return { ...this.counters };
  }

  public startSession(meta?: Record<string, unknown>): string {
    // Finalize previous session summary cleanly if active
    if (this.sessionId && this.currentLogPath) {
      this.writeSessionEndRecord();
    }

    const shortId = crypto.randomUUID().slice(0, 8);
    this.sessionId = `${formatTimestampSlug(new Date())}-${shortId}`;
    this.counters = createEmptyCounters();

    if (this.enabled) {
      this.currentLogPath = path.join(this.logDir, `session-${this.sessionId}.jsonl`);
      this.dirReady = false;
    } else {
      this.currentLogPath = undefined;
    }

    this.log('session.start', meta);
    return this.sessionId;
  }

  public log(
    event: string,
    data?: Record<string, unknown>,
    turnId?: number
  ): void {
    this.updateCounters(event, data);

    const record: UsageLogRecord = {
      ts: new Date().toISOString(),
      sessionId: this.sessionId || 'no-session',
      ...(turnId !== undefined ? { turnId } : {}),
      event,
      ...(data !== undefined ? { data } : {}),
    };

    if (this.onLine) {
      const compactData = data ? ` ${safeCompactJson(data, 260)}` : '';
      const turnPart = turnId !== undefined ? ` [turn=${turnId}]` : '';
      this.onLine(`[${record.ts}] ${event}${turnPart}${compactData}`);
    }

    if (!this.enabled) {
      return;
    }

    if (!this.currentLogPath) {
      if (!this.sessionId) {
        this.sessionId = `${formatTimestampSlug(new Date())}-${crypto
          .randomUUID()
          .slice(0, 8)}`;
        record.sessionId = this.sessionId;
      }
      this.currentLogPath = path.join(this.logDir, `session-${this.sessionId}.jsonl`);
    }

    const targetPath = this.currentLogPath;
    const serialized = `${JSON.stringify(record)}\n`;

    this.writeQueue = this.writeQueue
      .then(async () => {
        if (!this.dirReady) {
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          this.dirReady = true;
        }
        await fs.appendFile(targetPath, serialized, 'utf8');
      })
      .catch(() => {
        // Never allow telemetry disk failures to crash review execution
      });
  }

  public async flush(): Promise<void> {
    await this.writeQueue;
  }

  public async dispose(): Promise<void> {
    if (this.sessionId) {
      this.writeSessionEndRecord();
      this.sessionId = '';
    }
    await this.flush();
  }

  private writeSessionEndRecord(): void {
    this.log('session.end', {
      counters: { ...this.counters },
      logPath: this.currentLogPath,
    });
  }

  private updateCounters(event: string, data?: Record<string, unknown>): void {
    if (event === 'turn.start') {
      this.counters.turns += 1;
    } else if (event === 'voice.barge_in') {
      this.counters.bargeIns += 1;
    } else if (event === 'whiteboard.mermaid_error') {
      this.counters.mermaidErrors += 1;
    } else if (event === 'tts.synthesize' && data?.fallbackUsed === true) {
      this.counters.ttsFallbacks += 1;
    } else if (
      event === 'ui.interaction' &&
      (data?.action === 'review_note_draft' || data?.action === 'manual_note_added')
    ) {
      this.counters.notesAdded += 1;
    }
  }
}

function createEmptyCounters(): UsageSessionCounters {
  return {
    turns: 0,
    bargeIns: 0,
    mermaidErrors: 0,
    ttsFallbacks: 0,
    notesAdded: 0,
  };
}

function formatTimestampSlug(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function safeCompactJson(obj: Record<string, unknown>, maxLen: number): string {
  try {
    const str = JSON.stringify(obj);
    return str.length > maxLen ? `${str.slice(0, maxLen)}...` : str;
  } catch {
    return '[unserializable]';
  }
}
