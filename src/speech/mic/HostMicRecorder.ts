import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { VoiceMode } from '../../shared/protocol';
import { resolveBinary } from '../resolveBinary';

const execFileAsync = promisify(execFile);

export const PCM_SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = 1024;
export const FRAME_BYTES = FRAME_SAMPLES * 2; // 16-bit signed LE = 2048 bytes (64ms)
const FRAME_MS = (FRAME_SAMPLES / PCM_SAMPLE_RATE) * 1000;
const MIN_UTTERANCE_BYTES = PCM_SAMPLE_RATE * 2 * 0.25; // 250ms = 8000 bytes
const SILENT_FRAMES_WARNING_THRESHOLD = 40; // ~2.56s consecutive all-zero frames

const MACOS_MIC_SWIFT_SOURCE = `
import AVFoundation
import Foundation

let authStatus = AVCaptureDevice.authorizationStatus(for: .audio)
if authStatus == .notDetermined {
  let sem = DispatchSemaphore(value: 0)
  var granted = false
  AVCaptureDevice.requestAccess(for: .audio) { ok in
    granted = ok
    sem.signal()
  }
  _ = sem.wait(timeout: .now() + 15)
  if !granted {
    fputs("Microphone permission denied by macOS.\\n", stderr)
    exit(3)
  }
} else if authStatus != .authorized {
  fputs("Microphone permission not authorized (status=\\(authStatus.rawValue)).\\n", stderr)
  exit(3)
}

let engine = AVAudioEngine()
let inputNode = engine.inputNode
let hwFormat = inputNode.outputFormat(forBus: 0)
guard hwFormat.channelCount > 0 && hwFormat.sampleRate > 0 else {
  fputs("No active microphone input format available.\\n", stderr)
  exit(4)
}

guard let targetFormat = AVAudioFormat(
  commonFormat: .pcmFormatInt16,
  sampleRate: 16000,
  channels: 1,
  interleaved: true
), let converter = AVAudioConverter(from: hwFormat, to: targetFormat) else {
  fputs("Unable to create 16kHz PCM audio converter.\\n", stderr)
  exit(5)
}

signal(SIGPIPE, SIG_IGN)
let stdoutHandle = FileHandle.standardOutput

inputNode.installTap(onBus: 0, bufferSize: 1024, format: hwFormat) { buffer, _ in
  let ratio = targetFormat.sampleRate / hwFormat.sampleRate
  let cap = max(256, AVAudioFrameCount(ceil(Double(buffer.frameLength) * ratio)) + 16)
  guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: cap) else {
    return
  }
  var consumed = false
  var err: NSError?
  converter.convert(to: outBuffer, error: &err) { _, outStatus in
    if consumed {
      outStatus.pointee = .noDataNow
      return nil
    }
    consumed = true
    outStatus.pointee = .haveData
    return buffer
  }
  if err != nil || outBuffer.frameLength == 0 {
    return
  }
  guard let int16Ptr = outBuffer.int16ChannelData?[0] else {
    return
  }
  let byteCount = Int(outBuffer.frameLength) * 2
  let data = Data(bytes: int16Ptr, count: byteCount)
  stdoutHandle.write(data)
}

do {
  try engine.start()
} catch {
  fputs("Failed to start AVAudioEngine: \\(error.localizedDescription)\\n", stderr)
  exit(6)
}

RunLoop.main.run()
`;

export interface PcmVadCallbacks {
  onLevel: (level: number) => void;
  onUserSpeakingChange: (speaking: boolean) => void;
  onBargeIn: () => void;
  onUtteranceReady: (wavBuffer: Buffer) => void;
  onSilentInputWarning: () => void;
}

export interface PcmVadOptions {
  voiceMode: VoiceMode;
  vadBargeInMs: number;
  vadSilenceMs: number;
  maxDurationSec?: number;
  callbacks: PcmVadCallbacks;
}

export interface HostMicCallbacks extends PcmVadCallbacks {
  onError: (message: string) => void;
}

export interface HostMicStartOptions {
  voiceMode: VoiceMode;
  vadBargeInMs: number;
  vadSilenceMs: number;
}

export function computePcm16Rms(frame: Buffer): { rms: number; maxAbs: number } {
  const sampleCount = Math.floor(frame.length / 2);
  if (sampleCount === 0) {
    return { rms: 0, maxAbs: 0 };
  }
  let sumSq = 0;
  let maxAbs = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = frame.readInt16LE(i * 2) / 32768;
    const abs = Math.abs(sample);
    if (abs > maxAbs) {
      maxAbs = abs;
    }
    sumSq += sample * sample;
  }
  return {
    rms: Math.sqrt(sumSq / sampleCount),
    maxAbs,
  };
}

export function encodePcm16ToWav(
  pcmChunks: Buffer[],
  sampleRate = PCM_SAMPLE_RATE
): Buffer {
  const pcmData = Buffer.concat(pcmChunks);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8, 4, 'ascii');
  header.write('fmt ', 12, 4, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format = 1
  header.writeUInt16LE(1, 22); // Mono = 1 channel
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // Byte rate
  header.writeUInt16LE(2, 32); // Block align
  header.writeUInt16LE(16, 34); // Bits per sample
  header.write('data', 36, 4, 'ascii');
  header.writeUInt32LE(pcmData.length, 40);
  return Buffer.concat([header, pcmData]);
}

export class PcmVadProcessor {
  private voiceMode: VoiceMode;
  private vadBargeInMs: number;
  private vadSilenceMs: number;
  private readonly maxBytes: number;
  private callbacks: PcmVadCallbacks;

  private assistantSpeaking = false;
  private pttPressed = false;
  private pendingRemainder: Buffer = Buffer.alloc(0);

  private preRoll: Buffer[] = [];
  private capturedChunks: Buffer[] = [];
  private capturedBytes = 0;
  private activeUtterance = false;
  private bargeInTriggered = false;
  private speechAccumMs = 0;
  private silenceAccumMs = 0;

  private lastLevelEmitMs = 0;
  private consecutiveZeroFrames = 0;
  private hasSeenNonZeroSample = false;
  private warnedSilentInput = false;

  constructor(options: PcmVadOptions) {
    this.voiceMode = options.voiceMode;
    this.vadBargeInMs = options.vadBargeInMs;
    this.vadSilenceMs = options.vadSilenceMs;
    this.maxBytes = PCM_SAMPLE_RATE * 2 * (options.maxDurationSec ?? 30);
    this.callbacks = options.callbacks;
  }

  public setCallbacks(callbacks: PcmVadCallbacks): void {
    this.callbacks = callbacks;
  }

  public setVoiceMode(mode: VoiceMode): void {
    if (this.voiceMode === mode) {
      return;
    }
    this.voiceMode = mode;
    if (this.pttPressed) {
      this.endPtt();
    } else if (this.activeUtterance) {
      this.flushUtterance();
    }
  }

  public setAssistantSpeaking(speaking: boolean): void {
    this.assistantSpeaking = speaking;
    if (!speaking) {
      this.bargeInTriggered = false;
    }
  }

  public setVadConfig(bargeInMs: number, silenceMs: number): void {
    this.vadBargeInMs = bargeInMs;
    this.vadSilenceMs = silenceMs;
  }

  public startPtt(): void {
    if (this.pttPressed) {
      return;
    }
    this.pttPressed = true;
    this.capturedChunks = [];
    this.capturedBytes = 0;
    this.activeUtterance = false;
    this.preRoll = [];
    this.callbacks.onUserSpeakingChange(true);
  }

  public endPtt(): void {
    if (!this.pttPressed) {
      return;
    }
    this.pttPressed = false;
    this.callbacks.onUserSpeakingChange(false);
    this.flushCapturedChunks();
  }

  public pushChunk(chunk: Buffer): void {
    if (!chunk || chunk.length === 0) {
      return;
    }
    const combined =
      this.pendingRemainder.length > 0
        ? Buffer.concat([this.pendingRemainder, chunk])
        : chunk;

    let offset = 0;
    while (offset + FRAME_BYTES <= combined.length) {
      const frame = Buffer.from(combined.subarray(offset, offset + FRAME_BYTES));
      this.processFrame(frame);
      offset += FRAME_BYTES;
    }
    this.pendingRemainder =
      offset < combined.length
        ? Buffer.from(combined.subarray(offset))
        : Buffer.alloc(0);
  }

  public reset(): void {
    const wasSpeaking = this.pttPressed || this.activeUtterance;
    this.pttPressed = false;
    this.pendingRemainder = Buffer.alloc(0);
    this.preRoll = [];
    this.capturedChunks = [];
    this.capturedBytes = 0;
    this.activeUtterance = false;
    this.bargeInTriggered = false;
    this.speechAccumMs = 0;
    this.silenceAccumMs = 0;
    this.consecutiveZeroFrames = 0;
    this.hasSeenNonZeroSample = false;
    this.warnedSilentInput = false;
    if (wasSpeaking) {
      this.callbacks.onUserSpeakingChange(false);
    }
    this.callbacks.onLevel(0);
  }

  private processFrame(frame: Buffer): void {
    const { rms, maxAbs } = computePcm16Rms(frame);

    if (maxAbs > 0) {
      this.hasSeenNonZeroSample = true;
      this.consecutiveZeroFrames = 0;
    } else if (!this.hasSeenNonZeroSample && !this.warnedSilentInput) {
      this.consecutiveZeroFrames += 1;
      if (this.consecutiveZeroFrames >= SILENT_FRAMES_WARNING_THRESHOLD) {
        this.warnedSilentInput = true;
        this.callbacks.onSilentInputWarning();
      }
    }

    const now = Date.now();
    if (now - this.lastLevelEmitMs >= 120) {
      this.lastLevelEmitMs = now;
      this.callbacks.onLevel(Math.min(1, rms * 10));
    }

    if (this.voiceMode === 'ptt') {
      if (this.pttPressed) {
        this.appendFrame(frame);
      }
      return;
    }

    // Full-duplex VAD mode
    const threshold = this.assistantSpeaking ? 0.04 : 0.018;
    const isSpeechFrame = rms >= threshold;

    if (!this.activeUtterance) {
      if (isSpeechFrame) {
        this.speechAccumMs += FRAME_MS;
        const requiredMs = this.assistantSpeaking ? this.vadBargeInMs : 128;
        if (this.speechAccumMs >= requiredMs) {
          this.activeUtterance = true;
          this.silenceAccumMs = 0;
          this.capturedChunks = [...this.preRoll, frame];
          this.capturedBytes = this.capturedChunks.reduce(
            (sum, c) => sum + c.length,
            0
          );
          this.preRoll = [];
          this.callbacks.onUserSpeakingChange(true);

          if (this.assistantSpeaking && !this.bargeInTriggered) {
            this.bargeInTriggered = true;
            this.callbacks.onBargeIn();
          }
          return;
        }
      } else {
        this.speechAccumMs = 0;
      }

      this.preRoll.push(frame);
      if (this.preRoll.length > 5) {
        this.preRoll.shift();
      }
      return;
    }

    const appended = this.appendFrame(frame);
    if (!appended) {
      this.flushUtterance();
      return;
    }

    if (isSpeechFrame) {
      this.silenceAccumMs = 0;
    } else {
      this.silenceAccumMs += FRAME_MS;
      if (this.silenceAccumMs >= this.vadSilenceMs) {
        this.flushUtterance();
      }
    }
  }

  private appendFrame(frame: Buffer): boolean {
    if (this.capturedBytes + frame.length > this.maxBytes) {
      return false;
    }
    this.capturedChunks.push(frame);
    this.capturedBytes += frame.length;
    return true;
  }

  private flushUtterance(): void {
    this.activeUtterance = false;
    this.bargeInTriggered = false;
    this.speechAccumMs = 0;
    this.silenceAccumMs = 0;
    this.callbacks.onUserSpeakingChange(false);
    this.flushCapturedChunks();
  }

  private flushCapturedChunks(): void {
    const chunks = this.capturedChunks;
    const totalBytes = this.capturedBytes;
    this.capturedChunks = [];
    this.capturedBytes = 0;
    if (chunks.length === 0 || totalBytes < MIN_UTTERANCE_BYTES) {
      return;
    }
    this.callbacks.onUtteranceReady(encodePcm16ToWav(chunks, PCM_SAMPLE_RATE));
  }
}

export class HostMicRecorder {
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private processor: PcmVadProcessor | null = null;
  private backendName: string | undefined;
  private compiledSwiftMicPath: string | null = null;
  private active = false;

  constructor(private readonly storageDir: string) {}

  public isActive(): boolean {
    return this.active && this.proc !== null && !this.proc.killed;
  }

  public get activeBackend(): string | undefined {
    return this.backendName;
  }

  public async start(
    callbacks: HostMicCallbacks,
    options: HostMicStartOptions
  ): Promise<{ backend: string }> {
    if (this.isActive() && this.processor) {
      this.processor.setCallbacks(callbacks);
      this.processor.setVoiceMode(options.voiceMode);
      this.processor.setVadConfig(options.vadBargeInMs, options.vadSilenceMs);
      return { backend: this.backendName ?? 'native' };
    }

    this.stop();

    const spec = await this.resolveBackendCommand();
    const processor = new PcmVadProcessor({
      voiceMode: options.voiceMode,
      vadBargeInMs: options.vadBargeInMs,
      vadSilenceMs: options.vadSilenceMs,
      callbacks,
    });
    this.processor = processor;
    this.backendName = spec.backend;

    const child = spawn(spec.command, spec.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = child;
    this.active = true;

    const stderrLines: string[] = [];

    return new Promise<{ backend: string }>((resolve, reject) => {
      let settled = false;
      let startupTimer: NodeJS.Timeout | undefined;

      const finishResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (startupTimer) {
          clearTimeout(startupTimer);
        }
        resolve({ backend: spec.backend });
      };

      const finishReject = (msg: string) => {
        if (settled) {
          return;
        }
        settled = true;
        if (startupTimer) {
          clearTimeout(startupTimer);
        }
        this.cleanupChild(child);
        reject(new Error(msg));
      };

      child.stdout.on('data', (chunk: Buffer) => {
        if (this.proc !== child) {
          return;
        }
        if (!settled) {
          finishResolve();
        }
        processor.pushChunk(chunk);
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (this.proc !== child) {
          return;
        }
        for (const line of chunk.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) {
            stderrLines.push(trimmed);
            if (stderrLines.length > 20) {
              stderrLines.shift();
            }
          }
        }
      });

      child.on('spawn', () => {
        if (this.proc !== child) {
          return;
        }
        startupTimer = setTimeout(() => {
          if (this.proc === child) {
            finishResolve();
          }
        }, 160);
      });

      child.on('error', (err) => {
        if (this.proc !== child) {
          return;
        }
        const message = formatMicPermissionOrSpawnError(err.message, stderrLines);
        this.cleanupChild(child);
        if (!settled) {
          finishReject(message);
        } else {
          callbacks.onError(message);
        }
      });

      child.on('exit', (code, signal) => {
        if (this.proc !== child) {
          return;
        }
        const wasActive = this.active;
        this.cleanupChild(child);
        const detail = stderrLines.slice(-4).join(' | ');
        if (!settled) {
          finishReject(
            formatMicPermissionOrSpawnError(
              `录音进程退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
              stderrLines
            )
          );
          return;
        }
        if (wasActive && code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
          callbacks.onError(
            formatMicPermissionOrSpawnError(
              detail || `录音意外中断 (code=${code ?? 'null'})`,
              stderrLines
            )
          );
        }
      });
    });
  }

  public stop(): void {
    this.active = false;
    const child = this.proc;
    this.proc = null;
    this.backendName = undefined;
    if (this.processor) {
      this.processor.reset();
      this.processor = null;
    }
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null && !child.killed) {
            child.kill('SIGKILL');
          }
        } catch {
          // ignore
        }
      }, 500);
    }
  }

  public setVoiceMode(mode: VoiceMode): void {
    this.processor?.setVoiceMode(mode);
  }

  public setAssistantSpeaking(speaking: boolean): void {
    this.processor?.setAssistantSpeaking(speaking);
  }

  public setVadConfig(bargeInMs: number, silenceMs: number): void {
    this.processor?.setVadConfig(bargeInMs, silenceMs);
  }

  public startPtt(): void {
    this.processor?.startPtt();
  }

  public endPtt(): void {
    this.processor?.endPtt();
  }

  public dispose(): void {
    this.stop();
  }

  private cleanupChild(child: ChildProcessByStdio<null, Readable, Readable>): void {
    if (this.proc === child) {
      this.proc = null;
      this.active = false;
      this.backendName = undefined;
      this.processor?.reset();
      this.processor = null;
    }
  }

  private async resolveBackendCommand(): Promise<{
    backend: string;
    command: string;
    args: string[];
  }> {
    const recPath = await resolveBinary(['rec']);
    if (recPath) {
      return {
        backend: 'sox-rec',
        command: recPath,
        args: [
          '-q',
          '--buffer',
          '2048',
          '-t',
          'raw',
          '-b',
          '16',
          '-e',
          'signed-integer',
          '-L',
          '-c',
          '1',
          '-r',
          String(PCM_SAMPLE_RATE),
          '-',
        ],
      };
    }

    const soxPath = await resolveBinary(['sox']);
    if (soxPath) {
      return {
        backend: 'sox',
        command: soxPath,
        args: [
          '-q',
          '--buffer',
          '2048',
          '-d',
          '-t',
          'raw',
          '-b',
          '16',
          '-e',
          'signed-integer',
          '-L',
          '-c',
          '1',
          '-r',
          String(PCM_SAMPLE_RATE),
          '-',
        ],
      };
    }

    if (process.platform === 'darwin') {
      const swiftMic = await this.ensureMacOsMicHelper();
      if (swiftMic) {
        return {
          backend: 'macos-avfoundation',
          command: swiftMic,
          args: [],
        };
      }
    }

    if (process.platform === 'linux') {
      const arecordPath = await resolveBinary(['arecord']);
      if (arecordPath) {
        return {
          backend: 'alsa-arecord',
          command: arecordPath,
          args: ['-q', '-t', 'raw', '-f', 'S16_LE', '-c', '1', '-r', String(PCM_SAMPLE_RATE), '-'],
        };
      }
    }

    throw new Error(
      '未找到可用的本地录音工具（macOS 请运行 `brew install sox` 或安装 Xcode CLI Tools，Linux 请安装 `alsa-utils`）。'
    );
  }

  private async ensureMacOsMicHelper(): Promise<string | null> {
    if (this.compiledSwiftMicPath) {
      return this.compiledSwiftMicPath;
    }
    const binDir = path.join(this.storageDir, 'bin');
    const srcPath = path.join(binDir, 'macos-mic.swift');
    const binPath = path.join(binDir, 'macos-mic');

    try {
      await fs.access(binPath);
      this.compiledSwiftMicPath = binPath;
      return binPath;
    } catch {
      // compile once
    }

    const swiftcPath = await resolveBinary(['/usr/bin/swiftc', 'swiftc']);
    if (!swiftcPath) {
      return null;
    }

    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(srcPath, MACOS_MIC_SWIFT_SOURCE, 'utf8');
    await execFileAsync(swiftcPath, ['-O', srcPath, '-o', binPath], {
      timeout: 30000,
    });
    this.compiledSwiftMicPath = binPath;
    return binPath;
  }
}

function formatMicPermissionOrSpawnError(
  base: string,
  stderrLines: string[]
): string {
  const combined = `${base} ${stderrLines.join(' ')}`.toLowerCase();
  if (
    combined.includes('permission') ||
    combined.includes('not authorized') ||
    combined.includes('denied') ||
    combined.includes('coreaudio') ||
    combined.includes('open audio')
  ) {
    return `无法开启本地麦克风 (${base})。请在 macOS「系统设置 → 隐私与安全性 → 麦克风」中允许 Visual Studio Code 后重试。`;
  }
  return `本地麦克风启动失败: ${stderrLines.slice(-2).join(' ') || base}`;
}
