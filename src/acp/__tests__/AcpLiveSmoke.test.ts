import { afterEach, describe, expect, it } from 'vitest';
import { AcpClientManager } from '../AcpClientManager';
import { resolveAcpProfile } from '../profiles';

describe.runIf(process.env.LIVE_ACP_SMOKE === '1')('Live agy acp --sandbox smoke test', () => {
  const clients: AcpClientManager[] = [];

  afterEach(() => {
    for (const c of clients) {
      c.dispose();
    }
    clients.length = 0;
  });

  it('connects to real agy acp, enforces thought_level=low, streams deltas, and supports session/cancel', async () => {
    const client = new AcpClientManager();
    clients.push(client);

    const profile = resolveAcpProfile({ profile: 'agy' });
    const { initResult, sessionResult, configOptions } = await client.connect({
      cwd: process.cwd(),
      profile,
      systemPromptAppend: 'End every response with [LIVE_SMOKE_OK].',
      thoughtLevel: 'low',
    });

    expect(initResult.protocolVersion).toBe(1);
    expect(sessionResult.sessionId).toBeTruthy();

    const thoughtOpt = configOptions.find(
      (opt) => opt.id === 'thought_level' || opt.category === 'thought_level'
    );
    expect(thoughtOpt?.currentValue).toBe('low');

    let streamedText = '';
    const promptRes = await client.sendPrompt('Reply with exactly two words: hello world', {
      onTextDelta: (delta) => {
        streamedText += delta;
      },
    });

    expect(streamedText.trim().length).toBeGreaterThan(0);
    expect(streamedText).toContain('[LIVE_SMOKE_OK]');
    expect(promptRes.stopReason).toBe('end_turn');

    // Verify cancel on a longer generation does not hang
    let cancelledText = '';
    const longPromise = client.sendPrompt(
      'Write a 200-word detailed essay explaining TCP congestion control step by step.',
      {
        onTextDelta: (d) => {
          cancelledText += d;
          if (cancelledText.length >= 20) {
            client.cancel();
          }
        },
      }
    );

    const cancelTimer = setTimeout(() => client.cancel(), 4000);
    const cancelRes = await longPromise.finally(() => clearTimeout(cancelTimer));
    expect(cancelRes.stopReason).toBeTruthy();
  }, 45000);
});
