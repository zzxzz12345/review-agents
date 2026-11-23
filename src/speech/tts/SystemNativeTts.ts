import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { ITtsProvider, TtsAudioResult, TtsOptions } from '../types';

const execFileAsync = promisify(execFile);

export class SystemNativeTts implements ITtsProvider {
  public readonly id = 'system-native';
  public readonly displayName = 'System Native TTS (macOS say / Browser fallback)';
  private cachedZhVoice: string | null | undefined = undefined;

  public async synthesize(text: string, options: TtsOptions): Promise<TtsAudioResult> {
    if (options.signal?.aborted) {
      throw new Error('TTS synthesis aborted');
    }
    const cleanText = text.trim();
    if (!cleanText) {
      return { audioBase64: '', mimeType: 'audio/wav', fallbackTextOnly: true };
    }

    if (process.platform !== 'darwin') {
      return { audioBase64: '', mimeType: '', fallbackTextOnly: true };
    }

    const tmpPath = path.join(
      os.tmpdir(),
      `review-agents-say-${crypto.randomUUID()}.wav`
    );

    const args: string[] = [];
    if (/[\u4e00-\u9fff]/.test(cleanText)) {
      const zhVoice = await this.detectChineseVoice();
      if (zhVoice) {
        args.push('-v', zhVoice);
      }
    }

    const wordsPerMin = Math.round(180 * Math.max(0.5, Math.min(2.0, options.rate || 1.0)));
    args.push('-r', String(wordsPerMin), '-o', tmpPath, '--data-format=LEI16@22050', cleanText);

    try {
      await execFileAsync('/usr/bin/say', args, {
        signal: options.signal,
        timeout: 15000,
      });
      const wavBuf = await fs.readFile(tmpPath);
      return {
        audioBase64: wavBuf.toString('base64'),
        mimeType: 'audio/wav',
      };
    } catch {
      return { audioBase64: '', mimeType: '', fallbackTextOnly: true };
    } finally {
      await fs.unlink(tmpPath).catch(() => undefined);
    }
  }

  private async detectChineseVoice(): Promise<string | null> {
    if (this.cachedZhVoice !== undefined) {
      return this.cachedZhVoice;
    }
    try {
      const { stdout } = await execFileAsync('/usr/bin/say', ['-v', '?'], {
        timeout: 5000,
        encoding: 'utf8',
      });
      const lines = stdout.split(/\r?\n/);
      const preferredOrder = ['Tingting', 'Ting-Ting', 'Eddy (中文（中国大陆）)', 'Reed (中文（中国大陆）)', 'Meijia'];
      for (const candidate of preferredOrder) {
        if (lines.some((l) => l.startsWith(candidate))) {
          this.cachedZhVoice = candidate;
          return candidate;
        }
      }
      const anyZhLine = lines.find((l) => /\bzh_(CN|TW|HK)\b/.test(l));
      if (anyZhLine) {
        const match = anyZhLine.match(/^(.+?)\s+zh_/);
        if (match) {
          this.cachedZhVoice = match[1].trim();
          return this.cachedZhVoice;
        }
      }
    } catch {
      // ignore
    }
    this.cachedZhVoice = null;
    return null;
  }
}
