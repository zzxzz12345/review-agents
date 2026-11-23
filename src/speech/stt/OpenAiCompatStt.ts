import type { ISttProvider, SttOptions } from '../types';

export interface OpenAiCompatSttConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class OpenAiCompatStt implements ISttProvider {
  public readonly id = 'openai-compat';
  public readonly displayName = 'Cloud OpenAI-Compatible STT';

  constructor(private readonly config: OpenAiCompatSttConfig) {}

  public async transcribe(audioWav: Buffer, options: SttOptions): Promise<string> {
    if (!this.config.apiKey.trim()) {
      throw new Error(
        'Cloud STT API key is not configured. Run "Review Agents: Configure Speech Provider API Key".'
      );
    }

    const base = this.config.baseUrl.replace(/\/+$/, '');
    const form = new FormData();
    const blob = new Blob([new Uint8Array(audioWav)], { type: 'audio/wav' });
    form.append('file', blob, 'utterance.wav');
    form.append('model', this.config.model || 'whisper-1');
    if (options.locale) {
      form.append('language', options.locale.split('-')[0]);
    }

    const res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey.trim()}`,
      },
      body: form,
      signal: options.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Cloud STT failed (${res.status}): ${errText.slice(0, 240)}`);
    }

    const json = (await res.json()) as { text?: string };
    return (json.text ?? '').trim();
  }
}
