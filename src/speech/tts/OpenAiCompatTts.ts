import type { ITtsProvider, TtsAudioResult, TtsOptions } from '../types';

export interface OpenAiCompatTtsConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice?: string;
}

export class OpenAiCompatTts implements ITtsProvider {
  public readonly id = 'openai-compat';
  public readonly displayName = 'Cloud OpenAI-Compatible TTS';

  constructor(private readonly config: OpenAiCompatTtsConfig) {}

  public async synthesize(text: string, options: TtsOptions): Promise<TtsAudioResult> {
    if (!this.config.apiKey.trim()) {
      throw new Error(
        'Cloud TTS API key is not configured. Run "Review Agents: Configure Speech Provider API Key".'
      );
    }

    const base = this.config.baseUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: this.config.model || 'tts-1',
        input: text,
        voice: options.voice || this.config.voice || 'alloy',
        speed: Math.max(0.25, Math.min(4.0, options.rate || 1.0)),
        response_format: 'mp3',
      }),
      signal: options.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Cloud TTS failed (${res.status}): ${errText.slice(0, 240)}`);
    }

    const arrBuf = await res.arrayBuffer();
    return {
      audioBase64: Buffer.from(arrBuf).toString('base64'),
      mimeType: 'audio/mpeg',
    };
  }
}
