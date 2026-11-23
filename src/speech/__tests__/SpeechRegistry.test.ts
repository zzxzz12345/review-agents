import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { SpeechRegistry, type SpeechConfigSnapshot } from '../SpeechRegistry';
import type { ITtsProvider } from '../types';

const BASE_SPEECH_CFG: SpeechConfigSnapshot = {
  ttsProvider: 'edge-neural',
  sttProvider: 'system-native',
  ttsVoice: 'zh-CN-XiaoxiaoNeural',
  ttsRate: 1.1,
  sttLocale: 'zh-CN',
  whisperModelPath: '',
  cloudBaseUrl: 'https://api.openai.com/v1',
  cloudTtsModel: 'tts-1',
  cloudSttModel: 'whisper-1',
};

const FAKE_SECRETS = {
  get: vi.fn().mockResolvedValue(undefined),
  store: vi.fn(),
  delete: vi.fn(),
  onDidChange: vi.fn(),
} as unknown as vscode.SecretStorage;

describe('SpeechRegistry circuit breaker & fallback telemetry', () => {
  it('opens circuit after 3 consecutive failures and auto-recovers via half-open probe after cooldown', async () => {
    let shouldFail = true;
    let clockMs = 1_000;
    let primaryCalls = 0;
    const primary: ITtsProvider = {
      id: 'edge-neural',
      displayName: 'Mock Edge TTS',
      synthesize: vi.fn(async (text: string) => {
        primaryCalls += 1;
        if (shouldFail) {
          throw new Error('socket timeout');
        }
        return {
          audioBase64: Buffer.from(`edge:${text}`).toString('base64'),
          mimeType: 'audio/mpeg',
        };
      }),
    };

    const fallback: ITtsProvider = {
      id: 'system-native',
      displayName: 'Mock Say TTS',
      synthesize: vi.fn(async (text: string) => ({
        audioBase64: Buffer.from(`say:${text}`).toString('base64'),
        mimeType: 'audio/wav',
      })),
    };

    const registry = new SpeechRegistry('/tmp', FAKE_SECRETS, BASE_SPEECH_CFG, {
      ttsProvider: primary,
      fallbackTts: fallback,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 30_000,
      now: () => clockMs,
    });

    const warnings: string[] = [];

    const r1 = await registry.synthesizeWithFallback('第一句', { voice: 'v', rate: 1 }, (w) =>
      warnings.push(w)
    );
    expect(r1.fallbackUsed).toBe(true);
    expect(r1.fallbackReason).toBe('socket timeout');
    expect(warnings.length).toBe(1);
    expect(primaryCalls).toBe(1);

    const r2 = await registry.synthesizeWithFallback('第二句', { voice: 'v', rate: 1 }, (w) =>
      warnings.push(w)
    );
    expect(r2.fallbackUsed).toBe(true);
    expect(r2.fallbackReason).toBe('socket timeout');
    expect(warnings.length).toBe(1);
    expect(primaryCalls).toBe(2);

    const r3 = await registry.synthesizeWithFallback('第三句', { voice: 'v', rate: 1 }, (w) =>
      warnings.push(w)
    );
    expect(r3.fallbackUsed).toBe(true);
    expect(r3.fallbackReason).toBe('socket timeout');
    expect(primaryCalls).toBe(3);

    // 4th call during cooldown hits open circuit -> skips primary completely
    clockMs += 10_000;
    const r4 = await registry.synthesizeWithFallback('第四句', { voice: 'v', rate: 1 }, (w) =>
      warnings.push(w)
    );
    expect(r4.fallbackUsed).toBe(true);
    expect(r4.fallbackReason).toBe('circuit_open');
    expect(primaryCalls).toBe(3);

    // After 30s cooldown, half-open probe fails -> extends cooldown without incrementing threshold
    clockMs += 20_001;
    const r5 = await registry.synthesizeWithFallback('第五句', { voice: 'v', rate: 1 });
    expect(r5.fallbackUsed).toBe(true);
    expect(r5.fallbackReason).toBe('socket timeout');
    expect(primaryCalls).toBe(4);

    clockMs += 5_000;
    const r6 = await registry.synthesizeWithFallback('第六句', { voice: 'v', rate: 1 });
    expect(r6.fallbackReason).toBe('circuit_open');
    expect(primaryCalls).toBe(4);

    // After next cooldown elapses and primary recovers, auto-switches back to Edge TTS
    shouldFail = false;
    clockMs += 30_000;
    const r7 = await registry.synthesizeWithFallback('第七句', { voice: 'v', rate: 1 });
    expect(r7.fallbackUsed).toBeUndefined();
    expect(Buffer.from(r7.audioBase64, 'base64').toString('utf8')).toBe('edge:第七句');
    expect(primaryCalls).toBe(5);
  });

  it('resets failure count when primary recovers before threshold', async () => {
    let callIdx = 0;
    const primary: ITtsProvider = {
      id: 'edge-neural',
      displayName: 'Flaky Edge TTS',
      synthesize: vi.fn(async () => {
        callIdx += 1;
        if (callIdx === 1 || callIdx === 3) {
          throw new Error('transient error');
        }
        return { audioBase64: 'b2s=', mimeType: 'audio/mpeg' };
      }),
    };

    const fallback: ITtsProvider = {
      id: 'system-native',
      displayName: 'Mock Say TTS',
      synthesize: vi.fn(async () => ({
        audioBase64: 'ZmI=',
        mimeType: 'audio/wav',
      })),
    };

    const registry = new SpeechRegistry('/tmp', FAKE_SECRETS, BASE_SPEECH_CFG, {
      ttsProvider: primary,
      fallbackTts: fallback,
    });

    const r1 = await registry.synthesizeWithFallback('s1', { voice: 'v', rate: 1 });
    expect(r1.fallbackUsed).toBe(true);

    const r2 = await registry.synthesizeWithFallback('s2', { voice: 'v', rate: 1 });
    expect(r2.fallbackUsed).toBeUndefined();
    expect(r2.audioBase64).toBe('b2s=');

    const r3 = await registry.synthesizeWithFallback('s3', { voice: 'v', rate: 1 });
    expect(r3.fallbackUsed).toBe(true);

    // Call 4 still attempts primary because failure streak was reset on call 2
    const r4 = await registry.synthesizeWithFallback('s4', { voice: 'v', rate: 1 });
    expect(r4.fallbackUsed).toBeUndefined();
    expect(callIdx).toBe(4);
  });
});
