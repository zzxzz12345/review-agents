import { describe, expect, it } from 'vitest';
import { SystemNativeTts } from '../tts/SystemNativeTts';

describe('SystemNativeTts', () => {
  it('synthesizes non-empty RIFF WAV audio via macOS say', async () => {
    if (process.platform !== 'darwin') {
      return;
    }
    const tts = new SystemNativeTts();
    const res = await tts.synthesize('你好，开始代码导读。', {
      voice: 'default',
      rate: 1.1,
    });
    expect(res.fallbackTextOnly).toBeFalsy();
    expect(res.mimeType).toBe('audio/wav');
    const wav = Buffer.from(res.audioBase64, 'base64');
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.length).toBeGreaterThan(1000);
  });
});
