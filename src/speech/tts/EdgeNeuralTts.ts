import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { ITtsProvider, TtsAudioResult, TtsOptions } from '../types';

export class EdgeNeuralTts implements ITtsProvider {
  public readonly id = 'edge-neural';
  public readonly displayName = 'Edge Neural TTS (Free)';
  private activeClients = new Set<MsEdgeTTS>();

  public async synthesize(text: string, options: TtsOptions): Promise<TtsAudioResult> {
    if (options.signal?.aborted) {
      throw new Error('TTS synthesis aborted');
    }
    const cleanText = text.trim();
    if (!cleanText) {
      return { audioBase64: '', mimeType: 'audio/mpeg', fallbackTextOnly: true };
    }

    const voice = options.voice || 'zh-CN-XiaoxiaoNeural';
    const client = new MsEdgeTTS({
      connectionTimeoutMs: 4000,
      synthesisTimeoutMs: 8000,
    });
    this.activeClients.add(client);

    try {
      await client.setMetadata(
        voice,
        OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
      );

      if (options.signal?.aborted) {
        throw new Error('TTS synthesis aborted');
      }

      const escaped = escapeXml(cleanText);
      const ratePct = formatSsmlRate(options.rate);
      const { audioStream } = client.toStream(escaped, { rate: ratePct });

      const buffer = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let settled = false;

        const onAbort = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          audioStream.destroy();
          reject(new Error('TTS synthesis aborted'));
        };

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            audioStream.destroy();
            reject(new Error('Edge Neural TTS timed out'));
          }
        }, 9000);

        if (options.signal) {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }

        audioStream.on('data', (chunk: Buffer | Uint8Array) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        audioStream.on('end', () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          if (!settled) {
            settled = true;
            resolve(Buffer.concat(chunks));
          }
        });
        audioStream.on('error', (err: Error) => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
      });

      return {
        audioBase64: buffer.toString('base64'),
        mimeType: 'audio/mpeg',
      };
    } finally {
      this.activeClients.delete(client);
      try {
        client.close();
      } catch {
        // ignore
      }
    }
  }

  public dispose(): void {
    for (const client of this.activeClients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    this.activeClients.clear();
  }
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
