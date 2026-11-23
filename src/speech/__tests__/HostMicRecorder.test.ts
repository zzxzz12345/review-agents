import { describe, expect, it, vi } from 'vitest';
import {
  encodePcm16ToWav,
  FRAME_BYTES,
  FRAME_SAMPLES,
  PCM_SAMPLE_RATE,
  PcmVadProcessor,
} from '../mic/HostMicRecorder';

function makeToneFrame(amplitudeInt16 = 8000): Buffer {
  const buf = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const val = i % 2 === 0 ? amplitudeInt16 : -amplitudeInt16;
    buf.writeInt16LE(val, i * 2);
  }
  return buf;
}

function makeSilentFrame(): Buffer {
  return Buffer.alloc(FRAME_BYTES);
}

describe('HostMicRecorder PCM & VAD engine', () => {
  it('encodes 16kHz mono 16-bit PCM chunks into a valid RIFF/WAVE header', () => {
    const chunkA = makeToneFrame(4000);
    const chunkB = makeToneFrame(6000);
    const wav = encodePcm16ToWav([chunkA, chunkB], PCM_SAMPLE_RATE);

    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + FRAME_BYTES * 2);
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(28)).toBe(32000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(FRAME_BYTES * 2);
    expect(wav.length).toBe(44 + FRAME_BYTES * 2);
  });

  it('includes pre-roll, triggers barge-in while assistant speaks, and finalizes WAV on trailing silence in VAD mode', () => {
    const speakingStates: boolean[] = [];
    const onBargeIn = vi.fn();
    const utterances: Buffer[] = [];
    const levels: number[] = [];

    const proc = new PcmVadProcessor({
      voiceMode: 'vad',
      vadBargeInMs: 120,
      vadSilenceMs: 200,
      callbacks: {
        onLevel: (lvl) => levels.push(lvl),
        onUserSpeakingChange: (s) => speakingStates.push(s),
        onBargeIn,
        onUtteranceReady: (wav) => utterances.push(wav),
        onSilentInputWarning: vi.fn(),
      },
    });

    proc.setAssistantSpeaking(true);

    // 2 low-amplitude background frames into pre-roll
    proc.pushChunk(makeToneFrame(100));
    proc.pushChunk(makeToneFrame(100));

    // 2 speech frames (128ms >= 120ms) -> barge-in triggers on frame 2
    proc.pushChunk(makeToneFrame(9000));
    proc.pushChunk(makeToneFrame(9000));
    expect(onBargeIn).toHaveBeenCalledTimes(1);
    expect(speakingStates).toEqual([true]);

    // 3 more speech frames + 4 silent frames (256ms >= 200ms) -> finalize utterance
    proc.pushChunk(makeToneFrame(9000));
    proc.pushChunk(makeToneFrame(9000));
    proc.pushChunk(makeToneFrame(9000));
    for (let i = 0; i < 4; i++) {
      proc.pushChunk(makeSilentFrame());
    }

    expect(speakingStates).toEqual([true, false]);
    expect(utterances.length).toBe(1);
    const payloadBytes = utterances[0].length - 44;
    // 4 frames (2 pre-roll + 2 speech trigger) + 3 speech + 4 trailing silence = 11 frames
    expect(payloadBytes).toBe(11 * FRAME_BYTES);
    expect(levels.some((l) => l > 0)).toBe(true);
  });

  it('ignores <250ms clips and emits valid WAV for >=250ms clips in PTT mode', () => {
    const utterances: Buffer[] = [];
    const speakingStates: boolean[] = [];

    const proc = new PcmVadProcessor({
      voiceMode: 'ptt',
      vadBargeInMs: 300,
      vadSilenceMs: 900,
      callbacks: {
        onLevel: vi.fn(),
        onUserSpeakingChange: (s) => speakingStates.push(s),
        onBargeIn: vi.fn(),
        onUtteranceReady: (wav) => utterances.push(wav),
        onSilentInputWarning: vi.fn(),
      },
    });

    // Short clip (2 frames = 128ms < 250ms) -> ignored
    proc.startPtt();
    proc.pushChunk(makeToneFrame(5000));
    proc.pushChunk(makeToneFrame(5000));
    proc.endPtt();
    expect(utterances.length).toBe(0);

    // Valid clip (6 frames = 384ms >= 250ms)
    proc.startPtt();
    for (let i = 0; i < 6; i++) {
      proc.pushChunk(makeToneFrame(5000));
    }
    proc.endPtt();

    expect(utterances.length).toBe(1);
    expect(utterances[0].length).toBe(44 + 6 * FRAME_BYTES);
    expect(speakingStates).toEqual([true, false, true, false]);
  });

  it('emits onSilentInputWarning once after ~2.5s of consecutive all-zero frames', () => {
    const onSilentInputWarning = vi.fn();

    const proc = new PcmVadProcessor({
      voiceMode: 'vad',
      vadBargeInMs: 300,
      vadSilenceMs: 900,
      callbacks: {
        onLevel: vi.fn(),
        onUserSpeakingChange: vi.fn(),
        onBargeIn: vi.fn(),
        onUtteranceReady: vi.fn(),
        onSilentInputWarning,
      },
    });

    for (let i = 0; i < 39; i++) {
      proc.pushChunk(makeSilentFrame());
    }
    expect(onSilentInputWarning).not.toHaveBeenCalled();

    proc.pushChunk(makeSilentFrame());
    expect(onSilentInputWarning).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 40; i++) {
      proc.pushChunk(makeSilentFrame());
    }
    expect(onSilentInputWarning).toHaveBeenCalledTimes(1);
  });
});
