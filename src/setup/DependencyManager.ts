import { spawn } from 'node:child_process';
import type { AcpProfile, AcpProfileId } from '../acp/types';
import { resolveBinary } from '../speech/resolveBinary';
import {
  DEFAULT_WHISPER_MODEL_FILENAME,
  SystemNativeStt,
} from '../speech/stt/SystemNativeStt';

export type DependencyId =
  | 'acp-cli'
  | 'mic-cli'
  | 'whisper-cli'
  | 'whisper-model';

export type DependencyInstallAction =
  | 'brew-sox'
  | 'brew-whisper-cpp'
  | 'download-whisper-model'
  | 'npm-acp';

export interface DependencyCheckItem {
  id: DependencyId;
  label: string;
  installed: boolean;
  resolvedPath?: string;
  autoInstallable: boolean;
  installAction?: DependencyInstallAction;
  installPackage?: string;
  manualHint?: string;
}

export interface DependencyCheckReport {
  items: DependencyCheckItem[];
  missingAutoInstallable: DependencyCheckItem[];
  missingManual: DependencyCheckItem[];
  brewPath: string | null;
  npmPath: string | null;
}

export interface DependencyProgressEvent {
  itemId: DependencyId;
  label: string;
  message: string;
  pct?: number;
}

export type RunCommandFn = (
  cmd: string,
  args: string[],
  onOutput?: (line: string) => void,
  signal?: AbortSignal
) => Promise<void>;

export interface DependencyManagerOptions {
  storageDir: string;
  resolveBin?: typeof resolveBinary;
  runCommand?: RunCommandFn;
  findModel?: (customPath?: string) => Promise<string | null>;
  downloadModel?: (
    onProgress?: (pct: number, dlMb: number, totalMb: number) => void,
    signal?: AbortSignal
  ) => Promise<string>;
  platform?: NodeJS.Platform;
}

const NPM_ACP_PACKAGES: Partial<Record<AcpProfileId, string>> = {
  'claude-code': '@zed-industries/claude-code-acp',
  codex: '@zed-industries/codex-acp',
  gemini: '@google/gemini-cli',
};

export class DependencyManager {
  private readonly resolveBin: typeof resolveBinary;
  private readonly runCommand: RunCommandFn;
  private readonly findModel: (customPath?: string) => Promise<string | null>;
  private readonly downloadModel: (
    onProgress?: (pct: number, dlMb: number, totalMb: number) => void,
    signal?: AbortSignal
  ) => Promise<string>;
  private readonly platform: NodeJS.Platform;

  private lastReport: DependencyCheckReport | null = null;

  constructor(options: DependencyManagerOptions) {
    const sttHelper = new SystemNativeStt({ storageDir: options.storageDir });
    this.resolveBin = options.resolveBin ?? resolveBinary;
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.findModel =
      options.findModel ??
      ((customPath?: string) => sttHelper.findWhisperModel(customPath));
    this.downloadModel =
      options.downloadModel ??
      ((onProgress, signal) =>
        sttHelper.downloadDefaultWhisperModel(onProgress, signal));
    this.platform = options.platform ?? process.platform;
  }

  public async checkDependencies(options: {
    acpProfile: AcpProfile;
    sttProvider: 'system-native' | 'openai-compat';
    whisperModelPath?: string;
  }): Promise<DependencyCheckReport> {
    const [brewPath, npmPath, acpBin, micBin, whisperBin, whisperModel] =
      await Promise.all([
        this.platform === 'darwin' ? this.resolveBin(['brew']) : Promise.resolve(null),
        this.resolveBin(['npm']),
        this.resolveBin([options.acpProfile.command]),
        this.resolveBin(
          this.platform === 'linux' ? ['arecord', 'rec', 'sox'] : ['rec', 'sox']
        ),
        options.sttProvider === 'system-native'
          ? this.resolveBin(['whisper-cli', 'whisper-cpp'])
          : Promise.resolve(null),
        options.sttProvider === 'system-native'
          ? this.findModel(options.whisperModelPath)
          : Promise.resolve(null),
      ]);

    const items: DependencyCheckItem[] = [];

    // 1. ACP Harness CLI
    const npmPkg = NPM_ACP_PACKAGES[options.acpProfile.id];
    items.push({
      id: 'acp-cli',
      label: `ACP CLI (${options.acpProfile.command})`,
      installed: Boolean(acpBin),
      resolvedPath: acpBin ?? undefined,
      autoInstallable: Boolean(!acpBin && npmPkg && npmPath),
      installAction: !acpBin && npmPkg && npmPath ? 'npm-acp' : undefined,
      installPackage: npmPkg,
      manualHint: acpBin
        ? undefined
        : npmPkg
          ? `运行 \`npm install -g ${npmPkg}\` 安装 ${options.acpProfile.displayName} CLI`
          : `请确保 \`${options.acpProfile.command}\` 已安装且在 PATH 或 ~/.local/bin 中`,
    });

    // 2. Local Mic Capture CLI
    items.push({
      id: 'mic-cli',
      label: this.platform === 'linux' ? '本地录音 CLI (arecord / sox)' : '本地录音 CLI (sox / rec)',
      installed: Boolean(micBin),
      resolvedPath: micBin ?? undefined,
      autoInstallable: Boolean(!micBin && this.platform === 'darwin' && brewPath),
      installAction:
        !micBin && this.platform === 'darwin' && brewPath ? 'brew-sox' : undefined,
      manualHint: micBin
        ? undefined
        : this.platform === 'darwin'
          ? '请先安装 Homebrew 后运行 `brew install sox`'
          : '请安装 alsa-utils (arecord) 或 sox',
    });

    // 3. Local Whisper CLI + Model (only required for system-native STT)
    if (options.sttProvider === 'system-native') {
      items.push({
        id: 'whisper-cli',
        label: '本地语音转文字 CLI (whisper-cli)',
        installed: Boolean(whisperBin),
        resolvedPath: whisperBin ?? undefined,
        autoInstallable: Boolean(
          !whisperBin && this.platform === 'darwin' && brewPath
        ),
        installAction:
          !whisperBin && this.platform === 'darwin' && brewPath
            ? 'brew-whisper-cpp'
            : undefined,
        manualHint: whisperBin
          ? undefined
          : this.platform === 'darwin'
            ? '请先安装 Homebrew 后运行 `brew install whisper-cpp`，或在设置中改用云端 STT'
            : '请安装 whisper.cpp (whisper-cli) 或配置云端 STT API Key',
      });

      items.push({
        id: 'whisper-model',
        label: `Whisper 本地语音模型 (${DEFAULT_WHISPER_MODEL_FILENAME})`,
        installed: Boolean(whisperModel),
        resolvedPath: whisperModel ?? undefined,
        autoInstallable: !whisperModel,
        installAction: !whisperModel ? 'download-whisper-model' : undefined,
        manualHint: whisperModel
          ? undefined
          : `可执行命令 Download Local Whisper STT Model 下载 ${DEFAULT_WHISPER_MODEL_FILENAME}`,
      });
    }

    const report: DependencyCheckReport = {
      items,
      missingAutoInstallable: items.filter((i) => !i.installed && i.autoInstallable),
      missingManual: items.filter((i) => !i.installed && !i.autoInstallable),
      brewPath,
      npmPath,
    };
    this.lastReport = report;
    return report;
  }

  public async installDependency(
    item: DependencyCheckItem,
    onProgress?: (ev: DependencyProgressEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (item.installed || !item.installAction) {
      return;
    }

    const report = this.lastReport;
    const emitLine = (line: string) => {
      onProgress?.({
        itemId: item.id,
        label: item.label,
        message: line,
      });
    };

    switch (item.installAction) {
      case 'brew-sox': {
        const brewCmd = report?.brewPath ?? (await this.resolveBin(['brew'])) ?? 'brew';
        emitLine('正在通过 Homebrew 安装 sox...');
        await this.runCommand(brewCmd, ['install', 'sox'], emitLine, signal);
        return;
      }
      case 'brew-whisper-cpp': {
        const brewCmd = report?.brewPath ?? (await this.resolveBin(['brew'])) ?? 'brew';
        emitLine('正在通过 Homebrew 安装 whisper-cpp...');
        await this.runCommand(brewCmd, ['install', 'whisper-cpp'], emitLine, signal);
        return;
      }
      case 'npm-acp': {
        if (!item.installPackage) {
          throw new Error(`Missing npm package name for ${item.label}`);
        }
        const npmCmd = report?.npmPath ?? (await this.resolveBin(['npm'])) ?? 'npm';
        emitLine(`正在通过 npm 安装 ${item.installPackage}...`);
        await this.runCommand(
          npmCmd,
          ['install', '-g', item.installPackage],
          emitLine,
          signal
        );
        return;
      }
      case 'download-whisper-model': {
        emitLine(`正在下载离线 Whisper 模型 (${DEFAULT_WHISPER_MODEL_FILENAME})...`);
        await this.downloadModel((pct, dlMb, totalMb) => {
          onProgress?.({
            itemId: item.id,
            label: item.label,
            message: `${dlMb.toFixed(1)} / ${totalMb.toFixed(1)} MB (${pct}%)`,
            pct,
          });
        }, signal);
        return;
      }
    }
  }

  public async installMissing(
    report: DependencyCheckReport,
    onProgress?: (ev: DependencyProgressEvent) => void,
    signal?: AbortSignal
  ): Promise<{
    installed: DependencyId[];
    failed: Array<{ id: DependencyId; label: string; error: string }>;
  }> {
    this.lastReport = report;
    const installed: DependencyId[] = [];
    const failed: Array<{ id: DependencyId; label: string; error: string }> = [];

    for (const item of report.missingAutoInstallable) {
      if (signal?.aborted) {
        failed.push({
          id: item.id,
          label: item.label,
          error: '已取消安装',
        });
        break;
      }
      try {
        await this.installDependency(item, onProgress, signal);
        installed.push(item.id);
      } catch (err) {
        failed.push({
          id: item.id,
          label: item.label,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { installed, failed };
  }
}

async function defaultRunCommand(
  cmd: string,
  args: string[],
  onOutput?: (line: string) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' },
    });

    const tailLines: string[] = [];
    const pushLines = (chunk: string) => {
      for (const raw of chunk.split(/\r?\n/)) {
        const line = raw.trim();
        if (line) {
          tailLines.push(line);
          if (tailLines.length > 20) {
            tailLines.shift();
          }
          onOutput?.(line);
        }
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', pushLines);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', pushLines);

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (err) => {
      cleanup();
      reject(new Error(`执行 ${cmd} 失败: ${err.message}`));
    });

    child.on('exit', (code, sig) => {
      cleanup();
      if (aborted) {
        reject(new Error(`已取消执行 ${cmd}`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const detail = tailLines.slice(-4).join(' | ');
      reject(
        new Error(
          `${cmd} ${args.join(' ')} 退出 (code=${code ?? 'null'}, signal=${sig ?? 'null'})${
            detail ? `: ${detail}` : ''
          }`
        )
      );
    });
  });
}
