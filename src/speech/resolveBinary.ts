import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const DEFAULT_EXTRA_BIN_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
];

/**
 * Resolves the first executable binary path matching any of `names` across
 * PATH and fallback system/Homebrew directories (for Dock-launched apps).
 */
export async function resolveBinary(
  names: string[],
  extraDirs: string[] = DEFAULT_EXTRA_BIN_DIRS
): Promise<string | null> {
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const searchDirs = Array.from(new Set([...pathDirs, ...extraDirs]));

  for (const name of names) {
    if (!name) {
      continue;
    }
    if (path.isAbsolute(name)) {
      if (await isExecutable(name)) {
        return name;
      }
      continue;
    }

    for (const dir of searchDirs) {
      const candidate = path.join(dir, name);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
