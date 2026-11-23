import type { AcpPermissionOption, AcpPermissionRequest } from './types';

export interface PermissionDecision {
  allowed: boolean;
  optionId?: string;
  reason: string;
}

const READ_ONLY_KINDS = new Set([
  'read',
  'search',
  'grep',
  'glob',
  'list',
  'fetch',
  'think',
  'inspect',
]);

const MUTATING_KINDS = new Set([
  'edit',
  'write',
  'delete',
  'move',
  'patch',
]);

const SAFE_READ_COMMAND_PREFIXES = [
  'git status',
  'git diff',
  'git show',
  'git log',
  'git branch',
  'git rev-parse',
  'git ls-files',
  'ls',
  'cat ',
  'head ',
  'tail ',
  'rg ',
  'grep ',
  'find ',
  'wc ',
  'pwd',
];

const DANGEROUS_SHELL_TOKENS = /[;&|`$<>]|>\s*|\b(rm|mv|cp|chmod|chown|sudo|curl\s+.*-X\s*(POST|PUT|DELETE)|git\s+(push|commit|checkout|reset|clean|rebase|merge|apply|am)|npm\s+install|pnpm\s+add)\b/i;

function pickOption(
  options: AcpPermissionOption[] | undefined,
  preferredKinds: string[]
): AcpPermissionOption | undefined {
  if (!options || options.length === 0) {
    return undefined;
  }
  for (const kind of preferredKinds) {
    const match = options.find((opt) => opt.kind === kind);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function isSafeReadOnlyCommand(rawInput: unknown, title?: string): boolean {
  let commandStr = '';
  if (typeof rawInput === 'string') {
    commandStr = rawInput;
  } else if (rawInput && typeof rawInput === 'object') {
    const rec = rawInput as Record<string, unknown>;
    if (typeof rec.command === 'string') {
      commandStr = rec.command;
    } else if (typeof rec.cmd === 'string') {
      commandStr = rec.cmd;
    }
  }
  if (!commandStr && title) {
    commandStr = title;
  }
  const normalized = commandStr.trim();
  if (!normalized || DANGEROUS_SHELL_TOKENS.test(normalized)) {
    return false;
  }
  return SAFE_READ_COMMAND_PREFIXES.some(
    (prefix) => normalized === prefix.trim() || normalized.startsWith(prefix)
  );
}

/**
 * Evaluates an ACP tool permission request during a code review session.
 * Read-only code inspection is auto-approved; workspace mutations are denied.
 */
export function evaluatePermission(
  req: AcpPermissionRequest,
  allowMutations = false
): PermissionDecision {
  const options = req.options ?? [];
  const allowOpt = pickOption(options, ['allow_once', 'allow_always']) ??
    options.find((o) => /allow|approve|yes/i.test(o.optionId));
  const rejectOpt = pickOption(options, ['reject_once', 'reject_always']) ??
    options.find((o) => /reject|deny|cancel|no/i.test(o.optionId));

  if (allowMutations) {
    return {
      allowed: true,
      optionId: allowOpt?.optionId,
      reason: 'Mutations explicitly enabled.',
    };
  }

  const kind = (req.toolCall?.kind ?? '').toLowerCase();
  const title = req.toolCall?.title ?? '';

  if (MUTATING_KINDS.has(kind)) {
    return {
      allowed: false,
      optionId: rejectOpt?.optionId,
      reason: `Blocked mutating tool call (${kind}) during read-only review.`,
    };
  }

  if (READ_ONLY_KINDS.has(kind)) {
    return {
      allowed: true,
      optionId: allowOpt?.optionId,
      reason: `Auto-approved read-only tool call (${kind}).`,
    };
  }

  if (kind === 'execute' || kind === 'bash' || kind === 'shell' || kind === 'terminal') {
    if (isSafeReadOnlyCommand(req.toolCall?.rawInput, title)) {
      return {
        allowed: true,
        optionId: allowOpt?.optionId,
        reason: 'Auto-approved read-only inspection command.',
      };
    }
    return {
      allowed: false,
      optionId: rejectOpt?.optionId,
      reason: 'Blocked shell execution command that is not strictly read-only.',
    };
  }

  if (/read|search|list|inspect|view|find|grep/i.test(title) && !/write|edit|delete|remove/i.test(title)) {
    return {
      allowed: true,
      optionId: allowOpt?.optionId,
      reason: `Auto-approved read-like operation: ${title}`,
    };
  }

  return {
    allowed: false,
    optionId: rejectOpt?.optionId,
    reason: `Denied unclassified tool call (${kind || 'unknown'}: ${title}).`,
  };
}
