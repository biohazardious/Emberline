import type { RunEvent } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { handoffTarget, payloadSummary } from './components/RunInspector';
import { conflictEventInfo } from './components/RunOutcome';

describe('payloadSummary', () => {
  it('shows why a merge failed', () => {
    expect(
      payloadSummary({ summary: 'fatal: .git/index: index file open failed: Permission denied' }).detail,
    ).toBe('fatal: .git/index: index file open failed: Permission denied');
  });

  it('prefers the message over the summary', () => {
    expect(payloadSummary({ message: 'the message', summary: 'the summary' }).detail).toBe('the message');
  });
});

describe('conflictEventInfo & handoffTarget', () => {
  it('extracts files and commit sha for conflict_auto_resolved', () => {
    const info = conflictEventInfo('conflict_auto_resolved', {
      files: ['Makefile', '.github/workflows/ci.yml'],
      commitSha: '9a8b7c6d5e4f',
    });
    expect(info).toEqual({
      type: 'conflict_auto_resolved',
      summary: 'Auto-resolved additive conflicts in 2 files (9a8b7c6)',
      files: ['Makefile', '.github/workflows/ci.yml'],
      unresolved: [],
      commitSha: '9a8b7c6d5e4f',
      mainHead: null,
      resolverRunId: null,
      gateFailure: null,
    });
  });

  it('extracts message, files, unresolved and gateFailure for conflict_heal_failed', () => {
    const info = conflictEventInfo('conflict_heal_failed', {
      reason: 'gate_failed',
      files: ['Makefile', 'apps/core/src/index.ts'],
      unresolved: ['apps/core/src/index.ts'],
      message: 'Build gate failed after auto-resolving additive hunks',
      gateFailure: 'tsc exited with code 2',
    });
    expect(info).toEqual({
      type: 'conflict_heal_failed',
      summary: 'Build gate failed after auto-resolving additive hunks',
      files: ['Makefile', 'apps/core/src/index.ts'],
      unresolved: ['apps/core/src/index.ts'],
      commitSha: null,
      mainHead: null,
      resolverRunId: null,
      gateFailure: 'tsc exited with code 2',
    });
  });

  it('extracts conflicts list and links the resolver run for conflict_resolver_started', () => {
    const payload = {
      runId: 'run-resolver-88',
      conflicts: ['Makefile', 'ci.yml'],
      mainHead: '1234567890abcdef',
    };
    const info = conflictEventInfo('conflict_resolver_started', payload);
    expect(info).toEqual({
      type: 'conflict_resolver_started',
      summary: 'Started resolver run for 2 conflicted files against 1234567',
      files: ['Makefile', 'ci.yml'],
      unresolved: [],
      commitSha: null,
      mainHead: '1234567890abcdef',
      resolverRunId: 'run-resolver-88',
      gateFailure: null,
    });

    const ev: RunEvent = {
      id: 7,
      runId: 'run-1',
      ts: '2026-11-12T00:00:00.000Z',
      source: 'system',
      type: 'conflict_resolver_started',
      state: null,
      payload,
    };
    expect(handoffTarget(ev)).toBe('run-resolver-88');
  });

  it('returns null for unrelated timeline events', () => {
    expect(conflictEventInfo('tool_use', { files: ['a.ts'] })).toBeNull();
  });
});
