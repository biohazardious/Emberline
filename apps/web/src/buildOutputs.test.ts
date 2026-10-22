import type { ProjectBuildOutput } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import {
  clampQuotaGb,
  filterOutputs,
  formatBytes,
  outputGroup,
  outputPath,
  outputsBadge,
  usageFraction,
  usageText,
} from './buildOutputs';

const out = (overrides: Partial<ProjectBuildOutput> = {}): ProjectBuildOutput => ({
  id: 'o1',
  name: 'app-release.apk',
  sizeBytes: 1000,
  archivedAt: '2026-10-17T10:00:00.000Z',
  sourceMtime: '2026-10-17T09:00:00.000Z',
  pinned: false,
  runId: 'run-1',
  runExists: true,
  ticketId: 't1',
  ticketKey: 'EMB-7',
  ticketTitle: 'Ship the thing',
  persona: null,
  agent: 'claude',
  hostPath: '/srv/x/app-release.apk',
  containerPath: '/workspaces/x/app-release.apk',
  ...overrides,
});

describe('outputGroup', () => {
  it.each([
    ['app.apk', 'android'],
    ['App.AAB', 'android'],
    ['setup.exe', 'installer'],
    ['x.msi', 'installer'],
    ['x.dmg', 'installer'],
    ['x.deb', 'installer'],
    ['x.AppImage', 'installer'],
    ['x.ipa', 'installer'],
    ['fw.hex', 'firmware'],
    ['fw.UF2', 'firmware'],
    ['fw.elf', 'firmware'],
    ['fw.bin', 'firmware'],
    ['readme', 'other'],
    ['thing.zip', 'other'],
  ])('%s is %s', (name, group) => {
    expect(outputGroup(name)).toBe(group);
  });
});

describe('formatBytes', () => {
  it('scales units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
    expect(formatBytes(1023.96 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1023 * 1024)).toBe('1023.0 KB');
  });
});

describe('usageText / usageFraction', () => {
  it('reads like "1.2 GB of 5 GB"', () => {
    expect(usageText(1.2 * 1024 ** 3, 5 * 1024 ** 3)).toBe('1.2 GB of 5 GB');
    expect(usageText(0, 0.5 * 1024 ** 3)).toBe('0 B of 512 MB');
  });
  it('clamps the bar to 0..1 and survives a zero quota', () => {
    expect(usageFraction(50, 100)).toBe(0.5);
    expect(usageFraction(500, 100)).toBe(1);
    expect(usageFraction(5, 0)).toBe(0);
  });
});

describe('filterOutputs', () => {
  const list = [
    out(),
    out({ id: 'o2', name: 'setup.exe', runId: 'run-2', ticketKey: 'EMB-9', ticketTitle: 'Installer' }),
    out({ id: 'o3', name: 'fw.hex', runId: 'run-2', ticketId: null, ticketKey: null, ticketTitle: null }),
  ];
  it('keeps everything with no filter', () => {
    expect(filterOutputs(list, { group: 'all', query: '', runIds: null })).toHaveLength(3);
  });
  it('filters by group', () => {
    expect(filterOutputs(list, { group: 'firmware', query: '', runIds: null }).map((o) => o.id)).toEqual([
      'o3',
    ]);
  });
  it('searches name, ticket key and title case-insensitively', () => {
    expect(filterOutputs(list, { group: 'all', query: 'SETUP', runIds: null }).map((o) => o.id)).toEqual([
      'o2',
    ]);
    expect(filterOutputs(list, { group: 'all', query: 'emb-7', runIds: null }).map((o) => o.id)).toEqual([
      'o1',
    ]);
    expect(filterOutputs(list, { group: 'all', query: 'installer', runIds: null }).map((o) => o.id)).toEqual([
      'o2',
    ]);
  });
  it('filters by run, matching every run of its handoff chain', () => {
    expect(filterOutputs(list, { group: 'all', query: '', runIds: ['run-2'] }).map((o) => o.id)).toEqual([
      'o2',
      'o3',
    ]);
    expect(
      filterOutputs(list, { group: 'all', query: '', runIds: ['run-3', 'run-1'] }).map((o) => o.id),
    ).toEqual(['o1']);
    expect(filterOutputs(list, { group: 'all', query: '', runIds: [] })).toEqual([]);
  });
});

describe('clampQuotaGb', () => {
  it('clamps to 0.5-1000 and falls back to the default', () => {
    expect(clampQuotaGb('0.1')).toBe(0.5);
    expect(clampQuotaGb('2000')).toBe(1000);
    expect(clampQuotaGb('7.5')).toBe(7.5);
    expect(clampQuotaGb('7.3')).toBe(7.3);
    expect(clampQuotaGb('')).toBe(5);
    expect(clampQuotaGb('abc')).toBe(5);
  });
});

describe('outputsBadge', () => {
  it('links to the run-filtered page and pluralises', () => {
    expect(outputsBadge('p1', 'r 1', { live: 1, archived: 0 })).toEqual({
      href: '/projects/p1/outputs?run=r%201',
      label: '1 output',
    });
    expect(outputsBadge('p1', 'r1', { live: 3, archived: 1 })?.label).toBe('3 outputs');
  });
  it('counts the archived outputs once the worktree has none', () => {
    expect(outputsBadge('p1', 'r1', { live: 0, archived: 1 })?.label).toBe('1 archived output');
    expect(outputsBadge('p1', 'r1', { live: 0, archived: 2 })?.label).toBe('2 archived outputs');
  });
  it('renders nothing for zero', () => {
    expect(outputsBadge('p1', 'r1', { live: 0, archived: 0 })).toBeNull();
  });
});

describe('outputPath', () => {
  it('prefers the host path and falls back to the container path', () => {
    expect(outputPath(out())).toEqual({ path: '/srv/x/app-release.apk', where: 'host' });
    expect(outputPath(out({ hostPath: null }))).toEqual({
      path: '/workspaces/x/app-release.apk',
      where: 'container',
    });
  });
});
