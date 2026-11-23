import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { resolveBinary } from '../resolveBinary';
import type { ISttProvider, SttOptions } from '../types';

const execFileAsync = promisify(execFile);

export const DEFAULT_WHISPER_MODEL_FILENAME = 'ggml-small-q5_1.bin';
export const DEFAULT_WHISPER_MODEL_URLS = [
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
  'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
] as const;
export const DEFAULT_WHISPER_MODEL_URL = DEFAULT_WHISPER_MODEL_URLS[0];
const MIN_VALID_WHISPER_MODEL_BYTES = 1_000_000;

export class WhisperModelMissingError extends Error {
  public readonly code = 'WHISPER_MODEL_MISSING';
  constructor(message = '尚未下载本地 Whisper 语音识别模型 (ggml-small-q5_1.bin)。') {
    super(message);
    this.name = 'WhisperModelMissingError';
  }
}

export interface SttReadinessResult {
  ready: boolean;
  reason?: 'whisper_model_missing' | 'no_engine' | 'cloud_key_missing';
  whisperBin?: string;
  modelPath?: string;
}

const MACOS_SPEECH_SWIFT_SOURCE = `
import Foundation
import Speech

let args = CommandLine.arguments
guard args.count >= 2 else {
  fputs("Usage: macos-stt <wav-path> [locale]\\n", stderr)
  exit(2)
}

let filePath = args[1]
let localeId = args.count >= 3 ? args[2] : "zh-CN"

let authSemaphore = DispatchSemaphore(value: 0)
var authStatus = SFSpeechRecognizer.authorizationStatus()
if authStatus == .notDetermined {
  SFSpeechRecognizer.requestAuthorization { status in
    authStatus = status
    authSemaphore.signal()
  }
  _ = authSemaphore.wait(timeout: .now() + 10)
}

guard authStatus == .authorized else {
  fputs("macOS Speech Recognition permission not authorized (status=\\(authStatus.rawValue)). Enable in System Settings -> Privacy & Security -> Speech Recognition.\\n", stderr)
  exit(3)
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) ?? SFSpeechRecognizer() else {
  fputs("Unable to create SFSpeechRecognizer for locale \\(localeId).\\n", stderr)
  exit(4)
}

if !recognizer.isAvailable {
  fputs("SFSpeechRecognizer is currently unavailable.\\n", stderr)
  exit(5)
}

let url = URL(fileURLWithPath: filePath)
let request = SFSpeechURLRecognitionRequest(url: url)
request.shouldReportPartialResults = false

let doneSemaphore = DispatchSemaphore(value: 0)
var finalTranscript = ""
var recError: Error?

recognizer.recognitionTask(with: request) { result, error in
  if let error = error {
    recError = error
    doneSemaphore.signal()
    return
  }
  if let result = result, result.isFinal {
    finalTranscript = result.bestTranscription.formattedString
    doneSemaphore.signal()
  }
}

let waitResult = doneSemaphore.wait(timeout: .now() + 20)
if waitResult == .timedOut {
  fputs("Speech recognition timed out.\\n", stderr)
  exit(6)
}
if let err = recError {
  fputs("\\(err.localizedDescription)\\n", stderr)
  exit(7)
}

print(finalTranscript)
`;

export interface SystemNativeSttConfig {
  storageDir: string;
  whisperModelPath?: string;
}

export class SystemNativeStt implements ISttProvider {
  public readonly id = 'system-native';
  public readonly displayName = 'Local / System Native STT (whisper-cli / macOS Speech)';
  private compiledHelperPath: string | null = null;

  constructor(private readonly config: SystemNativeSttConfig) {}

  public async checkReadiness(): Promise<SttReadinessResult> {
    const [whisperBin, modelPath] = await Promise.all([
      resolveBinary(['whisper-cli', 'whisper-cpp']),
      this.findWhisperModel(),
    ]);
    if (whisperBin && modelPath) {
      return { ready: true, whisperBin, modelPath };
    }
    if (whisperBin && !modelPath) {
      return { ready: false, reason: 'whisper_model_missing', whisperBin };
    }
    if (
      process.platform === 'darwin' &&
      !process.env.VSCODE_PID &&
      (await resolveBinary(['/usr/bin/swiftc', 'swiftc']))
    ) {
      return { ready: true };
    }
    return { ready: false, reason: 'no_engine' };
  }

  public async downloadDefaultWhisperModel(
    onProgress?: (pct: number, downloadedMb: number, totalMb: number) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const modelsDir = path.join(this.config.storageDir, 'models');
    await fs.mkdir(modelsDir, { recursive: true });
    const destPath = path.join(modelsDir, DEFAULT_WHISPER_MODEL_FILENAME);
    const tmpPath = `${destPath}.tmp`;

    let lastError: unknown;
    for (const url of DEFAULT_WHISPER_MODEL_URLS) {
      if (signal?.aborted) {
        throw new Error('Download aborted');
      }
      try {
        await this.downloadFromUrl(url, tmpPath, destPath, onProgress, signal);
        return destPath;
      } catch (err) {
        lastError = err;
        await fs.unlink(tmpPath).catch(() => undefined);
        if (signal?.aborted) {
          throw err;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('下载 Whisper 模型失败');
  }

  private async downloadFromUrl(
    url: string,
    tmpPath: string,
    destPath: string,
    onProgress?: (pct: number, downloadedMb: number, totalMb: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const resp = await fetch(url, {
      redirect: 'follow',
      signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`下载 Whisper 模型失败 (HTTP ${resp.status})`);
    }

    const totalBytes = Number.parseInt(
      resp.headers.get('content-length') ?? '0',
      10
    );
    const writeStream = fsSync.createWriteStream(tmpPath);
    let streamError: Error | null = null;
    writeStream.on('error', (err) => {
      streamError = err;
    });
    const reader = resp.body.getReader();
    let downloadedBytes = 0;
    let lastReportMs = 0;

    try {
      while (true) {
        if (streamError) {
          throw streamError;
        }
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value && value.length > 0) {
          downloadedBytes += value.length;
          if (!writeStream.write(value)) {
            await new Promise<void>((res, rej) => {
              writeStream.once('drain', res);
              writeStream.once('error', rej);
            });
          }
          const now = Date.now();
          if (onProgress && now - lastReportMs >= 200) {
            lastReportMs = now;
            const totalMb = totalBytes > 0 ? totalBytes / (1024 * 1024) : 181;
            const downloadedMb = downloadedBytes / (1024 * 1024);
            const pct =
              totalBytes > 0
                ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100))
                : 0;
            onProgress(pct, downloadedMb, totalMb);
          }
        }
      }

      await new Promise<void>((res, rej) => {
        writeStream.on('error', rej);
        writeStream.end(() => res());
      });
      await fs.rename(tmpPath, destPath);
      onProgress?.(
        100,
        downloadedBytes / (1024 * 1024),
        (totalBytes || downloadedBytes) / (1024 * 1024)
      );
    } catch (err) {
      writeStream.destroy();
      await fs.unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  public async transcribe(audioWav: Buffer, options: SttOptions): Promise<string> {
    const tmpWav = path.join(
      os.tmpdir(),
      `review-agents-stt-${crypto.randomUUID()}.wav`
    );
    await fs.writeFile(tmpWav, audioWav);

    try {
      const [whisperBin, whisperModel] = await Promise.all([
        resolveBinary(['whisper-cli', 'whisper-cpp']),
        this.findWhisperModel(),
      ]);

      if (whisperBin && whisperModel) {
        return await this.runWhisperCli(
          whisperBin,
          tmpWav,
          whisperModel,
          options.locale,
          options.signal
        );
      }

      if (whisperBin && !whisperModel) {
        throw new WhisperModelMissingError(
          `检测到本地 whisper-cli，但尚未下载语音模型（${DEFAULT_WHISPER_MODEL_FILENAME}）。`
        );
      }

      if (process.platform === 'darwin') {
        if (process.env.VSCODE_PID) {
          throw new Error(
            '当前 VS Code 缺少系统 SpeechRecognition 权限声明，请通过 `brew install whisper-cpp` + 下载本地 Whisper 模型，或在设置中配置云端 STT API Key。'
          );
        }
        const helper = await this.ensureMacOsHelper();
        if (helper) {
          try {
            return await this.runMacOsHelper(
              helper,
              tmpWav,
              options.locale,
              options.signal
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('SIGABRT')) {
              throw new Error(
                '宿主应用缺少 macOS NSSpeechRecognitionUsageDescription 权限，请改用 whisper-cli 本地模型或云端 STT。'
              );
            }
            throw err;
          }
        }
      }

      throw new Error(
        'No local STT model/engine available. Configure a whisper-cli model path (reviewAgents.speech.whisperModelPath) or a Cloud STT API key.'
      );
    } finally {
      await fs.unlink(tmpWav).catch(() => undefined);
    }
  }

  private async runWhisperCli(
    whisperBin: string,
    wavPath: string,
    modelPath: string,
    locale: string,
    signal?: AbortSignal
  ): Promise<string> {
    const lang = locale.split('-')[0] || 'auto';
    const args = [
      '-m',
      modelPath,
      '-f',
      wavPath,
      '-l',
      lang,
      '-nt',
      '--no-prints',
    ];
    if (lang.toLowerCase().startsWith('zh')) {
      args.push(
        '--prompt',
        '以下是简体中文代码评审对话，常见词：记一个 action、记录批注、待办、源码、Diff、函数、类、模块、逻辑、过滤、保护、偏移、触发。'
      );
    }
    const { stdout } = await execFileAsync(whisperBin, args, {
      signal,
      timeout: 20000,
      encoding: 'utf8',
    });
    return stdout.trim();
  }

  private async runMacOsHelper(
    helperBin: string,
    wavPath: string,
    locale: string,
    signal?: AbortSignal
  ): Promise<string> {
    const { stdout } = await execFileAsync(helperBin, [wavPath, locale || 'zh-CN'], {
      signal,
      timeout: 20000,
      encoding: 'utf8',
    });
    return stdout.trim();
  }

  public async findWhisperModel(overrideCustomPath?: string): Promise<string | null> {
    const configured = (overrideCustomPath ?? this.config.whisperModelPath)?.trim();
    if (configured) {
      try {
        const stat = await fs.stat(configured);
        if (stat.isFile() && stat.size > 0) {
          return configured;
        }
      } catch {
        // fall through
      }
    }

    const candidateDirs = [
      path.join(this.config.storageDir, 'models'),
      path.join(os.homedir(), '.cache', 'whisper'),
      path.join(os.homedir(), 'models', 'whisper'),
      '/opt/homebrew/share/whisper-cpp',
      '/usr/local/share/whisper-cpp',
    ];
    for (const dir of candidateDirs) {
      try {
        const entries = await fs.readdir(dir);
        for (const entry of entries) {
          if (!/^ggml-.*\.bin$/i.test(entry)) {
            continue;
          }
          const full = path.join(dir, entry);
          const stat = await fs.stat(full).catch(() => null);
          if (stat?.isFile() && stat.size >= MIN_VALID_WHISPER_MODEL_BYTES) {
            return full;
          }
        }
      } catch {
        // ignore missing dir
      }
    }
    return null;
  }

  private async ensureMacOsHelper(): Promise<string | null> {
    if (this.compiledHelperPath) {
      return this.compiledHelperPath;
    }

    const binDir = path.join(this.config.storageDir, 'bin');
    const srcPath = path.join(binDir, 'macos-stt.swift');
    const binPath = path.join(binDir, 'macos-stt');

    try {
      await fs.access(binPath);
      this.compiledHelperPath = binPath;
      return binPath;
    } catch {
      // compile once
    }

    const swiftcPath = await resolveBinary(['/usr/bin/swiftc', 'swiftc']);
    if (!swiftcPath) {
      return null;
    }

    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(srcPath, MACOS_SPEECH_SWIFT_SOURCE, 'utf8');
    await execFileAsync(swiftcPath, ['-O', srcPath, '-o', binPath], {
      timeout: 30000,
    });
    this.compiledHelperPath = binPath;
    return binPath;
  }
}
