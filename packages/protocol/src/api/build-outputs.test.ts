import { describe, expect, it } from 'vitest';
import {
  CollectBuildOutputsResponse,
  ProjectBuildOutput,
  ProjectBuildOutputsResponse,
  UpdateBuildOutputBody,
} from './build-outputs.js';
import { RunBuildOutputsResponse } from './review.js';
import { GarbageCollectRunsResponse } from './runs.js';

const output = {
  id: 'o1',
  name: 'app-release.apk',
  sizeBytes: 1234,
  archivedAt: '2026-10-17T10:00:00.000Z',
  sourceMtime: '2026-10-17T09:59:00.000Z',
  pinned: false,
  runId: 'r1',
  runExists: true,
  ticketId: 't1',
  ticketKey: 'EMB-1',
  ticketTitle: 'Build it',
  persona: 'coder',
  agent: 'claude',
  hostPath: '/srv/ws/.emberline-outputs/p1/r1/app-release.apk',
  containerPath: '/workspaces/.emberline-outputs/p1/r1/app-release.apk',
};

describe('build output contracts', () => {
  it('parses a project build output and its list response', () => {
    expect(ProjectBuildOutput.parse(output).name).toBe('app-release.apk');
    const res = ProjectBuildOutputsResponse.parse({
      collecting: false,
      lastCollect: { archived: 1, skipped: 0, failed: 0, finishedAt: '2026-10-17T00:00:00.000Z' },
      quotaBytes: 5e9,
      usedBytes: 1234,
      hostArchiveDir: '/srv/ws/.emberline-outputs/p1',
      archiveDir: '/workspaces/.emberline-outputs/p1',
      runChain: null,
      outputs: [
        output,
        {
          ...output,
          id: 'o2',
          ticketId: null,
          ticketKey: null,
          ticketTitle: null,
          persona: null,
          runExists: false,
        },
      ],
    });
    expect(res.outputs).toHaveLength(2);
  });

  it('has no host path without the workspaces host mapping, and the run filter chain when asked', () => {
    expect(ProjectBuildOutput.parse({ ...output, hostPath: null }).hostPath).toBeNull();
    const res = ProjectBuildOutputsResponse.parse({
      collecting: false,
      lastCollect: null,
      quotaBytes: 5e9,
      usedBytes: 0,
      hostArchiveDir: null,
      archiveDir: '/workspaces/.emberline-outputs/p1',
      runChain: ['r1', 'r2'],
      outputs: [],
    });
    expect(res.runChain).toEqual(['r1', 'r2']);
    expect(() => ProjectBuildOutput.parse({ ...output, containerPath: undefined })).toThrow();
  });

  it('the run build outputs response counts what the handoff chain archived', () => {
    const res = RunBuildOutputsResponse.parse({
      worktreePath: '/workspaces/.worktrees/p/r1',
      hostWorktreePath: null,
      outputs: [],
      archivedCount: 2,
    });
    expect(res.archivedCount).toBe(2);
    expect(() => RunBuildOutputsResponse.parse({ ...res, archivedCount: -1 })).toThrow();
  });

  it('garbage collection can keep a worktree whose outputs are still being archived', () => {
    const res = GarbageCollectRunsResponse.parse({
      removedRuns: 0,
      closedSessions: 0,
      prunedWorktrees: 0,
      keptWorktrees: [{ runId: 'r1', reason: 'archive_pending' }],
      remainingRuns: 1,
    });
    expect(res.keptWorktrees[0]?.reason).toBe('archive_pending');
  });

  it('rejects a negative size', () => {
    expect(() => ProjectBuildOutput.parse({ ...output, sizeBytes: -1 })).toThrow();
  });

  it('update body needs a boolean pinned', () => {
    expect(UpdateBuildOutputBody.parse({ pinned: true })).toEqual({ pinned: true });
    expect(() => UpdateBuildOutputBody.parse({})).toThrow();
    expect(() => UpdateBuildOutputBody.parse({ pinned: 'yes' })).toThrow();
  });

  it('collect response carries a status', () => {
    expect(CollectBuildOutputsResponse.parse({ status: 'started' })).toEqual({ status: 'started' });
    expect(() => CollectBuildOutputsResponse.parse({ status: 'x' })).toThrow();
  });
});
