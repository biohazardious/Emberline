import { describe, expect, it } from 'vitest';
import { SyncWorktreeResponse } from './project-status.js';

const legacy = { ok: true, runId: 'r1', filesSynced: 3, commitSha: 'abc1234', summary: 'merged' };

describe('SyncWorktreeResponse resolution fields', () => {
  it('parses an older response without resolution or autoResolved', () => {
    const parsed = SyncWorktreeResponse.parse(legacy);
    expect(parsed.resolution).toBeNull();
    expect(parsed.autoResolved).toEqual([]);
    expect(parsed.conflicts).toEqual([]);
  });

  it('accepts every resolution kind with the auto-resolved files', () => {
    for (const resolution of ['auto_resolved', 'agent_resolving', 'resolver_started', 'manual'] as const) {
      const parsed = SyncWorktreeResponse.parse({ ...legacy, resolution, autoResolved: ['CHANGELOG.md'] });
      expect(parsed.resolution).toBe(resolution);
      expect(parsed.autoResolved).toEqual(['CHANGELOG.md']);
    }
  });

  it('rejects an unknown resolution value', () => {
    expect(SyncWorktreeResponse.safeParse({ ...legacy, resolution: 'merged_by_magic' }).success).toBe(false);
  });
});
