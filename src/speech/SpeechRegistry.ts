import type * as vscode from 'vscode';
import { OpenAiCompatStt } from './stt/OpenAiCompatStt';
import { SystemNativeStt, type SttReadinessResult } from './stt/SystemNativeStt';
import { EdgeNeuralTts } from './tts/EdgeNeuralTts';
import { OpenAiCompatTts } from './tts/OpenAiCompatTts';
import { SystemNativeTts } from './tts/SystemNativeTts';
import type { ISttProvider, ITtsProvider, TtsAudioResult, TtsOptions } from './types';

export const SPEECH_API_KEY_SECRET = 'reviewAgents.speech.cloudApiKey';

export interface SpeechConfigSnapshot {
  ttsProvider: 'edge-neural' | 'system-native' | 'openai-compat';
  sttProvider: 'system-native' | 'openai-compat';
  ttsVoice: string;
  ttsRate: number;
  sttLocale: string;
  whisperModelPath: string;
  cloudBaseUrl: string;
  cloudTtsModel: string;
  cloudSttModel: string;
}

export class SpeechRegistry {
  private ttsProvider: ITtsProvider;
  private sttProvider: ISttProvider;
  private fallbackTts: ITtsProvider = new SystemNativeTts();
  private hasWarnedTtsFallback = false;
  private consecutivePrimaryFailures = 0;

  constructor(
    private readonly storageDir: string,
    private readonly secrets: vscode.SecretStorage,
    initialConfig: SpeechConfigSnapshot,
    overrides?: {
      ttsProvider?: ITtsProvider;
      fallbackTts?: ITtsProvider;
      sttProvider?: ISttProvider;
    }
  ) {
    this.ttsProvider = overrides?.ttsProvider ?? new EdgeNeuralTts();
    if (overrides?.fallbackTts) {
      this.fallbackTts = overrides.fallbackTts;
    }
    this.sttProvider =
      overrides?.sttProvider ??
      new SystemNativeStt({
        storageDir,
        whisperModelPath: initialConfig.whisperModelPath,
      });
  }

  public async configure(
    cfg: SpeechConfigSnapshot
  ): Promise<{ tts: ITtsProvider; stt: ISttProvider }> {
    const apiKey = (await this.secrets.get(SPEECH_API_KEY_SECRET)) ?? '';
    this.hasWarnedTtsFallback = false;
    this.consecutivePrimaryFailures = 0;

    this.ttsProvider.dispose?.();
    if (cfg.ttsProvider === 'openai-compat') {
      this.ttsProvider = new OpenAiCompatTts({
        baseUrl: cfg.cloudBaseUrl,
        apiKey,
        model: cfg.cloudTtsModel,
        voice: cfg.ttsVoice,
      });
    } else if (cfg.ttsProvider === 'system-native') {
      this.ttsProvider = new SystemNativeTts();
    } else {
      this.ttsProvider = new EdgeNeuralTts();
    }

    this.sttProvider.dispose?.();
    if (cfg.sttProvider === 'openai-compat') {
      this.sttProvider = new OpenAiCompatStt({
        baseUrl: cfg.cloudBaseUrl,
        apiKey,
        model: cfg.cloudSttModel,
      });
    } else {
      this.sttProvider = new SystemNativeStt({
        storageDir: this.storageDir,
        whisperModelPath: cfg.whisperModelPath,
      });
    }

    return { tts: this.ttsProvider, stt: this.sttProvider };
  }

  public async synthesizeWithFallback(
    text: string,
    options: TtsOptions,
    onFallbackWarning?: (msg: string) => void
  ): Promise<TtsAudioResult> {
    if (
      this.ttsProvider.id !== 'system-native' &&
      this.consecutivePrimaryFailures >= 2
    ) {
      const fbRes = await this.fallbackTts.synthesize(text, options);
      return {
        ...fbRes,
        fallbackUsed: true,
        fallbackReason: 'circuit_open',
      };
    }

    try {
      const res = await this.ttsProvider.synthesize(text, options);
      this.consecutivePrimaryFailures = 0;
      return res;
    } catch (err) {
      if (options.signal?.aborted) {
        throw err;
      }
      if (this.ttsProvider.id !== 'system-native') {
        this.consecutivePrimaryFailures += 1;
        const reason = err instanceof Error ? err.message : String(err);
        if (!this.hasWarnedTtsFallback) {
          this.hasWarnedTtsFallback = true;
          onFallbackWarning?.(
            `Primary TTS (${this.ttsProvider.displayName}) failed (${reason}); falling back to local System Native TTS.`
          );
        }
        const fbRes = await this.fallbackTts.synthesize(text, options);
        return {
          ...fbRes,
          fallbackUsed: true,
          fallbackReason: reason,
        };
      }
      throw err;
    }
  }

  public async transcribe(audioWav: Buffer, locale: string, signal?: AbortSignal): Promise<string> {
    return this.sttProvider.transcribe(audioWav, { locale, signal });
  }

  public async checkSttReadiness(): Promise<SttReadinessResult> {
    if (this.sttProvider instanceof SystemNativeStt) {
      return this.sttProvider.checkReadiness();
    }
    const apiKey = (await this.secrets.get(SPEECH_API_KEY_SECRET)) ?? '';
    return apiKey.trim()
      ? { ready: true }
      : { ready: false, reason: 'cloud_key_missing' };
  }

  public async downloadDefaultWhisperModel(
    onProgress?: (pct: number, downloadedMb: number, totalMb: number) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const helper =
      this.sttProvider instanceof SystemNativeStt
        ? this.sttProvider
        : new SystemNativeStt({ storageDir: this.storageDir });
    return helper.downloadDefaultWhisperModel(onProgress, signal);
  }

  public dispose(): void {
    this.ttsProvider.dispose?.();
    this.sttProvider.dispose?.();
    this.fallbackTts.dispose?.();
  }
}
