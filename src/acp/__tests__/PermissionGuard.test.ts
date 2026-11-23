import { describe, expect, it } from 'vitest';
import { evaluatePermission } from '../PermissionGuard';

const SAMPLE_OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
];

describe('PermissionGuard', () => {
  it('approves read-only inspection tools and read-only git commands', () => {
    const readRes = evaluatePermission({
      toolCall: { kind: 'read', title: 'Read src/auth.ts' },
      options: SAMPLE_OPTIONS,
    });
    expect(readRes.allowed).toBe(true);
    expect(readRes.optionId).toBe('allow_once');

    const gitDiffRes = evaluatePermission({
      toolCall: {
        kind: 'execute',
        title: 'git diff HEAD~1',
        rawInput: { command: 'git diff HEAD~1' },
      },
      options: SAMPLE_OPTIONS,
    });
    expect(gitDiffRes.allowed).toBe(true);
    expect(gitDiffRes.optionId).toBe('allow_once');
  });

  it('rejects mutating file writes and dangerous shell commands during review', () => {
    const editRes = evaluatePermission({
      toolCall: { kind: 'edit', title: 'Edit src/auth.ts' },
      options: SAMPLE_OPTIONS,
    });
    expect(editRes.allowed).toBe(false);
    expect(editRes.optionId).toBe('reject_once');

    const rmRes = evaluatePermission({
      toolCall: {
        kind: 'execute',
        title: 'rm -rf src',
        rawInput: { command: 'rm -rf src' },
      },
      options: SAMPLE_OPTIONS,
    });
    expect(rmRes.allowed).toBe(false);
    expect(rmRes.optionId).toBe('reject_once');

    const chainedCmd = evaluatePermission({
      toolCall: {
        kind: 'execute',
        title: 'git status && rm foo',
        rawInput: { command: 'git status && rm foo' },
      },
      options: SAMPLE_OPTIONS,
    });
    expect(chainedCmd.allowed).toBe(false);
  });
});
