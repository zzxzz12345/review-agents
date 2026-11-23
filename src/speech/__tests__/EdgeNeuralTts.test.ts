import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { EdgeNeuralTts, type MsEdgeTTSLike } from '../tts/EdgeNeuralTts';

describe('EdgeNeuralTts connection reuse & fast retry', () => {
  it('reuses a single MsEdgeTTS client across sequential and concurrent requests with the same voice', async () => {
    const clientsCreated: Array<{ setMetadataCalls: number; closed: boolean; voice?: string }> = [];

    const tts = new EdgeNeuralTts({
      clientFactory: () => {
        const record = { setMetadataCalls: 0, closed: false, voice: undefined as string | undefined };
        clientsCreated.push(record);
        const client: MsEdgeTTSLike = {
          setMetadata: vi.fn(async (voice: string) => {
            record.setMetadataCalls += 1;
            record.voice = voice;
            await new Promise((r) => setTimeout(r, 10));
          }),
          toStream: vi.fn((input: string) => {
            const stream = new PassThrough();
            queueMicrotask(() => {
              stream.end(Buffer.from(`audio:${input}`));
            });
            return { audioStream: stream };
          }),
          close: vi.fn(() => {
            record.closed = true;
          }),
        };
        return client;
      },
    });

    const [a, b] = await Promise.all([
      tts.synthesize('第一句', { voice: 'zh-CN-XiaoxiaoNeural', rate: 1.0 }),
      tts.synthesize('第二句', { voice: 'zh-CN-XiaoxiaoNeural', rate: 1.1 }),
    ]);
    const c = await tts.synthesize('第三句', { voice: 'zh-CN-XiaoxiaoNeural', rate: 1.0 });

    expect(clientsCreated.length).toBe(1);
    expect(clientsCreated[0].setMetadataCalls).toBe(1);
    expect(Buffer.from(a.audioBase64, 'base64').toString('utf8')).toBe('audio:第一句');
    expect(Buffer.from(b.audioBase64, 'base64').toString('utf8')).toBe('audio:第二句');
    expect(Buffer.from(c.audioBase64, 'base64').toString('utf8')).toBe('audio:第三句');

    // Switching voice cleanly replaces the shared client
    await tts.synthesize('Hello', { voice: 'en-US-JennyNeural', rate: 1.0 });
    expect(clientsCreated.length).toBe(2);
    expect(clientsCreated[0].closed).toBe(true);
    expect(clientsCreated[1].voice).toBe('en-US-JennyNeural');

    tts.dispose();
    expect(clientsCreated[1].closed).toBe(true);
  });

  it('invalidates broken client and recovers on 1 fast retry after transient error or empty buffer', async () => {
    let clientIdx = 0;
    const closedFlags: boolean[] = [];

    const tts = new EdgeNeuralTts({
      clientFactory: () => {
        const idx = clientIdx++;
        closedFlags[idx] = false;
        return {
          setMetadata: vi.fn(async () => undefined),
          toStream: vi.fn((input: string) => {
            const stream = new PassThrough();
            queueMicrotask(() => {
              if (idx === 0) {
                stream.destroy(new Error('ECONNRESET before TLS established'));
              } else if (idx === 1) {
                stream.end(Buffer.alloc(0));
              } else {
                stream.end(Buffer.from(`ok:${input}`));
              }
            });
            return { audioStream: stream };
          }),
          close: vi.fn(() => {
            closedFlags[idx] = true;
          }),
        };
      },
    });

    // Attempt 1 (idx 0) fails with ECONNRESET -> closes client 0, retries once on client 1 (empty), fails!
    await expect(
      tts.synthesize('测试', { voice: 'zh-CN-XiaoxiaoNeural', rate: 1.0 })
    ).rejects.toThrow(/empty audio/);
    expect(closedFlags).toEqual([true, true]);

    // Next call creates client 2 which succeeds on first attempt
    const ok = await tts.synthesize('恢复正常', { voice: 'zh-CN-XiaoxiaoNeural', rate: 1.0 });
    expect(Buffer.from(ok.audioBase64, 'base64').toString('utf8')).toBe('ok:恢复正常');

    tts.dispose();
  });

  it('aborts immediately without retrying when signal is aborted', async () => {
    let createCalls = 0;
    const ac = new AbortController();

    const tts = new EdgeNeuralTts({
      clientFactory: () => {
        createCalls += 1;
        return {
          setMetadata: vi.fn(async () => undefined),
          toStream: vi.fn(() => {
            const stream = new PassThrough();
            setTimeout(() => ac.abort(), 5);
            return { audioStream: stream };
          }),
          close: vi.fn(),
        };
      },
    });

    await expect(
      tts.synthesize('被取消的句子', {
        voice: 'zh-CN-XiaoxiaoNeural',
        rate: 1.0,
        signal: ac.signal,
      })
    ).rejects.toThrow(/aborted/);
    expect(createCalls).toBe(1);

    tts.dispose();
  });
});
