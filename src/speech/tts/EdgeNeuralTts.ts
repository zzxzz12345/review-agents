import type { Readable } from 'node:stream';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { ITtsProvider, TtsAudioResult, TtsOptions } from '../types';

const CONNECTION_TIMEOUT_MS = 8000;
const SYNTHESIS_TIMEOUT_MS = 12000;
const HARD_DEADLINE_MS = 15000;
const IDLE_CLOSE_MS = 90_000;
const RETRY_BACKOFF_MS = 250;

export interface MsEdgeTTSLike {
  setMetadata(voiceName: string, outputFormat: OUTPUT_FORMAT): Promise<void>;
  toStream(input: string, options?: { rate?: string }): { audioStream: Readable };
  close(): void;
}

export type MsEdgeTTSFactory = (opts: {
  connectionTimeoutMs: number;
  synthesisTimeoutMs: number;
}) => MsEdgeTTSLike;

export class EdgeNeuralTts implements ITtsProvider {
  public readonly id = 'edge-neural';
  public readonly displayName = 'Edge Neural TTS (Free)';

  private readonly clientFactory: MsEdgeTTSFactory;
  private sharedClient?: MsEdgeTTSLike;
  private sharedVoice?: string;
  private clientReadyPromise?: Promise<void>;
  private inFlightCount = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(options?: { clientFactory?: MsEdgeTTSFactory }) {
    this.clientFactory =
      options?.clientFactory ?? ((opts) => new MsEdgeTTS(opts));
  }

  public async synthesize(text: string, options: TtsOptions): Promise<TtsAudioResult> {
    if (options.signal?.aborted) {
      throw new Error('TTS synthesis aborted');
    }
    const cleanText = text.trim();
    if (!cleanText) {
      return { audioBase64: '', mimeType: 'audio/mpeg', fallbackTextOnly: true };
    }

    const voice = options.voice || 'zh-CN-XiaoxiaoNeural';
    const escaped = escapeXml(cleanText);
    const ratePct = formatSsmlRate(options.rate);

    this.inFlightCount += 1;
    this.clearIdleTimer();

    try {
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (options.signal?.aborted) {
          throw new Error('TTS synthesis aborted');
        }
        const client = await this.getOrInitClient(voice, options.signal);
        try {
          const buffer = await this.synthesizeOnce(client, escaped, ratePct, options.signal);
          if (buffer.length === 0) {
            throw new Error('Edge Neural TTS returned empty audio');
          }
          return {
            audioBase64: buffer.toString('base64'),
            mimeType: 'audio/mpeg',
          };
        } catch (err) {
          if (options.signal?.aborted) {
            throw err;
          }
          lastError = err;
          this.invalidateClient(client);
          if (attempt === 0) {
            await sleepAbortable(RETRY_BACKOFF_MS, options.signal);
          }
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    } finally {
      this.inFlightCount = Math.max(0, this.inFlightCount - 1);
      if (this.inFlightCount === 0 && !this.disposed) {
        this.scheduleIdleClose();
      }
    }
  }

  private async getOrInitClient(
    voice: string,
    signal?: AbortSignal
  ): Promise<MsEdgeTTSLike> {
    this.clearIdleTimer();
    if (signal?.aborted) {
      throw new Error('TTS synthesis aborted');
    }

    if (this.sharedClient && this.sharedVoice === voice && this.clientReadyPromise) {
      await awaitWithAbort(this.clientReadyPromise, signal);
      if (this.sharedClient && this.sharedVoice === voice) {
        return this.sharedClient;
      }
    }

    const prevClient = this.sharedClient;
    if (prevClient) {
      this.invalidateClient(prevClient);
    }

    const client = this.clientFactory({
      connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
      synthesisTimeoutMs: SYNTHESIS_TIMEOUT_MS,
    });
    this.sharedClient = client;
    this.sharedVoice = voice;

    const readyPromise = client
      .setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
      .catch((err) => {
        if (this.sharedClient === client) {
          this.invalidateClient(client);
        }
        throw err;
      });
    this.clientReadyPromise = readyPromise;

    await awaitWithAbort(readyPromise, signal);
    return client;
  }

  private async synthesizeOnce(
    client: MsEdgeTTSLike,
    escapedText: string,
    ratePct: string,
    signal?: AbortSignal
  ): Promise<Buffer> {
    if (signal?.aborted) {
      throw new Error('TTS synthesis aborted');
    }

    const { audioStream } = client.toStream(escapedText, { rate: ratePct });

    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;

      const cleanup = (timer: ReturnType<typeof setTimeout>): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup(timer);
        audioStream.destroy();
        reject(new Error('TTS synthesis aborted'));
      };

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup(timer);
          audioStream.destroy();
          reject(new Error('Edge Neural TTS timed out'));
        }
      }, HARD_DEADLINE_MS);
      timer.unref?.();

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      audioStream.on('data', (chunk: Buffer | Uint8Array) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      audioStream.on('end', () => {
        cleanup(timer);
        if (!settled) {
          settled = true;
          resolve(Buffer.concat(chunks));
        }
      });
      audioStream.on('error', (err: Error) => {
        cleanup(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  private invalidateClient(failedClient: MsEdgeTTSLike): void {
    if (this.sharedClient === failedClient) {
      this.sharedClient = undefined;
      this.sharedVoice = undefined;
      this.clientReadyPromise = undefined;
    }
    try {
      failedClient.close();
    } catch {
      // ignore
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    const clientToClose = this.sharedClient;
    if (!clientToClose) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.inFlightCount === 0 && this.sharedClient === clientToClose) {
        this.invalidateClient(clientToClose);
      }
    }, IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  public dispose(): void {
    this.disposed = true;
    this.clearIdleTimer();
    if (this.sharedClient) {
      this.invalidateClient(this.sharedClient);
    }
  }
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new Error('TTS synthesis aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error('TTS synthesis aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error('TTS synthesis aborted'));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('TTS synthesis aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatSsmlRate(rate: number): string {
  const clamped = Math.max(0.5, Math.min(2.0, rate || 1.0));
  const pct = Math.round((clamped - 1) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}
