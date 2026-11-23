import type { AcpProfile, AcpProfileId } from './types';

export interface AcpProfileConfigInput {
  profile: AcpProfileId;
  customCommand?: string;
  customArgs?: string[];
}

const PRESET_PROFILES: Record<Exclude<AcpProfileId, 'custom'>, Omit<AcpProfile, 'id'>> = {
  agy: {
    displayName: 'Antigravity (agy acp)',
    command: 'agy',
    args: ['acp', '--sandbox'],
  },
  'claude-code': {
    displayName: 'Claude Code ACP',
    command: 'claude-code-acp',
    args: [],
  },
  codex: {
    displayName: 'Codex ACP',
    command: 'codex-acp',
    args: [],
  },
  gemini: {
    displayName: 'Gemini CLI ACP',
    command: 'gemini',
    args: ['--experimental-acp'],
  },
};

export function resolveAcpProfile(input: AcpProfileConfigInput): AcpProfile {
  const trimmedCmd = input.customCommand?.trim();
  const customArgs = Array.isArray(input.customArgs) ? input.customArgs : [];

  if (input.profile === 'custom') {
    if (!trimmedCmd) {
      throw new Error(
        'ACP profile is set to "custom", but reviewAgents.acp.command is empty.'
      );
    }
    return {
      id: 'custom',
      displayName: `Custom (${trimmedCmd})`,
      command: trimmedCmd,
      args: customArgs,
    };
  }

  const preset = PRESET_PROFILES[input.profile] ?? PRESET_PROFILES.agy;
  return {
    id: input.profile,
    displayName: preset.displayName,
    command: trimmedCmd || preset.command,
    args: customArgs.length > 0 ? customArgs : preset.args,
  };
}
