export interface TtsOptions {
  voice: string;
  rate: number;
  signal?: AbortSignal;
}

export interface TtsAudioResult {
  audioBase64: string;
  mimeType: string;
  fallbackTextOnly?: boolean;
  fallbackUsed?: boolean;
  fallbackReason?: string;
}

export interface ITtsProvider {
  readonly id: string;
  readonly displayName: string;
  synthesize(text: string, options: TtsOptions): Promise<TtsAudioResult>;
  dispose?(): void;
}

export interface SttOptions {
  locale: string;
  signal?: AbortSignal;
}

export interface ISttProvider {
  readonly id: string;
  readonly displayName: string;
  transcribe(audioWav: Buffer, options: SttOptions): Promise<string>;
  dispose?(): void;
}
