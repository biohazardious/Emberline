import type { SyncWorktreeResponse } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { findResolverRunId, syncWorktreeOutcome } from './syncResolution';

const baseSync = (overrides: Partial<SyncWorktreeResponse>): SyncWorktreeResponse => ({
  ok: false,
  runId: 'run-10',
  filesSynced: 0,
  commitSha: null,
  alreadyMerged: false,
  summary: 'Could not merge EMB-36 into the main workspace',
  conflicts: [],
  resolution: null,
  autoResolved: [],
  ...overrides,
});

describe('syncWorktreeOutcome', () => {
  it('formats auto_resolved merges with the resolved file list', () => {
    const out = syncWorktreeOutcome(
      baseSync({
        ok: true,
        filesSynced: 2,
        commitSha: 'abc1234',
        resolution: 'auto_resolved',
        autoResolved: ['Makefile', 'ci.yml'],
        summary: 'Merged into main',
      }),
    );
    expect(out).toEqual({
      kind: 'merged',
      toast: 'Merged; auto-resolved additive conflicts in Makefile, ci.yml',
    });
  });

  it('preserves summary toast on a clean merge without auto-resolution', () => {
    const out = syncWorktreeOutcome(
      baseSync({
        ok: true,
        filesSynced: 1,
        commitSha: 'abc1234',
        resolution: null,
        summary: 'Merged EMB-36 into main.',
      }),
    );
    expect(out).toEqual({
      kind: 'merged',
      toast: 'Merged EMB-36 into main.',
    });
  });

  it('maps agent_resolving to an info notice linking the run with conflict count', () => {
    const plural = syncWorktreeOutcome(
      baseSync({
        ok: false,
        runId: 'run-42',
        resolution: 'agent_resolving',
        conflicts: ['Makefile', 'ci.yml'],
      }),
    );
    expect(plural).toEqual({
      kind: 'resolving',
      resolution: 'agent_resolving',
      text: 'The agent is merging main and resolving 2 conflicts; the ticket merges when it finishes',
      runId: 'run-42',
      href: '/runs/run-42/review',
      linkLabel: 'Open run →',
    });

    const singular = syncWorktreeOutcome(
      baseSync({
        ok: false,
        runId: 'run-42',
        resolution: 'agent_resolving',
        conflicts: ['Makefile'],
      }),
    );
    expect(singular).toMatchObject({
      kind: 'resolving',
      text: 'The agent is merging main and resolving 1 conflict; the ticket merges when it finishes',
    });
  });

  it('maps resolver_started to the resolving notice linking the new resolver run', () => {
    const out = syncWorktreeOutcome(
      baseSync({
        ok: false,
        runId: 'run-old',
        resolution: 'resolver_started',
        conflicts: ['Makefile', 'ci.yml', 'package.json'],
      }),
      { resolverRunId: 'run-resolver-99' },
    );
    expect(out).toEqual({
      kind: 'resolving',
      resolution: 'resolver_started',
      text: 'The agent is merging main and resolving 3 conflicts; the ticket merges when it finishes',
      runId: 'run-resolver-99',
      href: '/runs/run-resolver-99/review',
      linkLabel: 'Open resolver run →',
    });
  });

  it('maps manual or null conflicts to Hold Recovery fallback instead of a raw error', () => {
    expect(
      syncWorktreeOutcome(
        baseSync({
          ok: false,
          resolution: 'manual',
          conflicts: ['src/app.ts'],
          summary: 'Conflicts in src/app.ts',
        }),
      ),
    ).toEqual({
      kind: 'manual_conflict',
      conflicts: ['src/app.ts'],
      summary: 'Conflicts in src/app.ts',
    });

    expect(
      syncWorktreeOutcome(
        baseSync({
          ok: false,
          resolution: null,
          conflicts: ['src/app.ts'],
          summary: 'Conflicts in src/app.ts',
        }),
      ),
    ).toEqual({
      kind: 'manual_conflict',
      conflicts: ['src/app.ts'],
      summary: 'Conflicts in src/app.ts',
    });
  });

  it('maps non-conflict sync failures to error', () => {
    expect(
      syncWorktreeOutcome(
        baseSync({
          ok: false,
          resolution: null,
          conflicts: [],
          summary: 'Main workspace has uncommitted changes.',
        }),
      ),
    ).toEqual({
      kind: 'error',
      text: 'Main workspace has uncommitted changes.',
    });
  });
});

describe('findResolverRunId', () => {
  it('prefers handedOffTo or successor run from live runs, falling back to detail events', () => {
    expect(
      findResolverRunId([{ id: 'run-1', handedOffTo: 'run-2', predecessorRunId: null }], null, 'run-1'),
    ).toBe('run-2');

    expect(
      findResolverRunId([{ id: 'run-3', handedOffTo: null, predecessorRunId: 'run-1' }], null, 'run-1'),
    ).toBe('run-3');

    expect(
      findResolverRunId(
        [],
        {
          handedOffTo: null,
          events: [
            {
              id: 1,
              runId: 'run-1',
              ts: '2026-11-12T00:00:00.000Z',
              source: 'system',
              type: 'conflict_resolver_started',
              state: null,
              payload: { runId: 'run-4', conflicts: ['Makefile'], mainHead: 'abc1234' },
            },
          ],
        },
        'run-1',
      ),
    ).toBe('run-4');

    expect(findResolverRunId([], null, 'run-1')).toBeNull();
  });
});
