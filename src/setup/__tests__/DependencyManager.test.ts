import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DependencyManager } from '../DependencyManager';

describe('DependencyManager', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((d) => fs.rm(d, { recursive: true, force: true }))
    );
    tempDirs.length = 0;
  });

  it('detects missing auto-installable CLI and model dependencies and skips stub <1MB models', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-deps-'));
    tempDirs.push(dir);
    const modelsDir = path.join(dir, 'models');
    await fs.mkdir(modelsDir, { recursive: true });
    // Small <1MB stub must be ignored
    await fs.writeFile(path.join(modelsDir, 'ggml-tiny.bin'), Buffer.alloc(1024));

    const mgr = new DependencyManager({
      storageDir: dir,
      platform: 'darwin',
      resolveBin: async (names) => {
        if (names.includes('brew')) return '/opt/homebrew/bin/brew';
        if (names.includes('npm')) return '/opt/homebrew/bin/npm';
        return null;
      },
    });

    const report = await mgr.checkDependencies({
      acpProfile: {
        id: 'claude-code',
        displayName: 'Claude Code',
        command: 'claude-code-acp',
        args: [],
      },
      sttProvider: 'system-native',
    });

    expect(report.items.map((i) => i.id)).toEqual([
      'acp-cli',
      'mic-cli',
      'whisper-cli',
      'whisper-model',
    ]);
    expect(report.missingAutoInstallable.map((i) => i.installAction)).toEqual([
      'npm-acp',
      'brew-sox',
      'brew-whisper-cpp',
      'download-whisper-model',
    ]);
    expect(report.missingManual).toEqual([]);
  });

  it('skips whisper CLI and model checks when STT provider is openai-compat', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-deps-cloud-'));
    tempDirs.push(dir);

    const mgr = new DependencyManager({
      storageDir: dir,
      platform: 'darwin',
      resolveBin: async (names) => {
        if (names.includes('agy')) return '/Users/me/.local/bin/agy';
        if (names.includes('rec') || names.includes('sox')) return '/opt/homebrew/bin/rec';
        return null;
      },
    });

    const report = await mgr.checkDependencies({
      acpProfile: {
        id: 'agy',
        displayName: 'Antigravity',
        command: 'agy',
        args: ['acp'],
      },
      sttProvider: 'openai-compat',
    });

    expect(report.items.map((i) => i.id)).toEqual(['acp-cli', 'mic-cli']);
    expect(report.missingAutoInstallable).toEqual([]);
    expect(report.missingManual).toEqual([]);
  });

  it('runs mocked installers sequentially and isolates partial failures', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-deps-install-'));
    tempDirs.push(dir);
    const executedCmds: string[] = [];
    const downloadSpy = vi.fn().mockRejectedValue(new Error('network timeout'));

    const mgr = new DependencyManager({
      storageDir: dir,
      platform: 'darwin',
      resolveBin: async (names) => {
        if (names.includes('brew')) return '/opt/homebrew/bin/brew';
        if (names.includes('npm')) return '/opt/homebrew/bin/npm';
        if (names.includes('agy')) return '/Users/me/.local/bin/agy';
        return null;
      },
      runCommand: async (cmd, args) => {
        executedCmds.push(`${cmd} ${args.join(' ')}`);
      },
      findModel: async () => null,
      downloadModel: downloadSpy,
    });

    const report = await mgr.checkDependencies({
      acpProfile: {
        id: 'agy',
        displayName: 'Antigravity',
        command: 'agy',
        args: ['acp'],
      },
      sttProvider: 'system-native',
    });

    const res = await mgr.installMissing(report);
    expect(executedCmds).toEqual([
      '/opt/homebrew/bin/brew install sox',
      '/opt/homebrew/bin/brew install whisper-cpp',
    ]);
    expect(downloadSpy).toHaveBeenCalledTimes(1);
    expect(res.installed).toEqual(['mic-cli', 'whisper-cli']);
    expect(res.failed).toEqual([
      {
        id: 'whisper-model',
        label: expect.stringContaining('ggml-small-q5_1.bin'),
        error: 'network timeout',
      },
    ]);
  });
});
