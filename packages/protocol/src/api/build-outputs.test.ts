import { describe, expect, it } from 'vitest';
import {
  CollectBuildOutputsResponse,
  ProjectBuildOutput,
  ProjectBuildOutputsResponse,
  UpdateBuildOutputBody,
} from './build-outputs.js';

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
};

describe('build output contracts', () => {
  it('parses a project build output and its list response', () => {
    expect(ProjectBuildOutput.parse(output).name).toBe('app-release.apk');
    const res = ProjectBuildOutputsResponse.parse({
      quotaBytes: 5e9,
      usedBytes: 1234,
      hostArchiveDir: '/srv/ws/.emberline-outputs/p1',
      outputs: [output, { ...output, id: 'o2', ticketId: null, ticketKey: null, ticketTitle: null, persona: null, runExists: false }],
    });
    expect(res.outputs).toHaveLength(2);
  });

  it('rejects a negative size', () => {
    expect(() => ProjectBuildOutput.parse({ ...output, sizeBytes: -1 })).toThrow();
  });

  it('update body needs a boolean pinned', () => {
    expect(UpdateBuildOutputBody.parse({ pinned: true })).toEqual({ pinned: true });
    expect(() => UpdateBuildOutputBody.parse({})).toThrow();
    expect(() => UpdateBuildOutputBody.parse({ pinned: 'yes' })).toThrow();
  });

  it('collect response carries three counts', () => {
    expect(CollectBuildOutputsResponse.parse({ archived: 1, skipped: 2, failed: 0 })).toEqual({ archived: 1, skipped: 2, failed: 0 });
    expect(() => CollectBuildOutputsResponse.parse({ archived: 1 })).toThrow();
  });
});
