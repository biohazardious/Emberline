import { describe, expect, it } from 'vitest';
import {
  ALL_PROJECTS_KEYS,
  fleetBulkTitles,
  type FlagStorage,
  inboxSubtitle,
  inScope,
  moreInOtherProjects,
  outOfScope,
  readAllProjects,
  writeAllProjects,
} from './projectScope';

const memory = (): FlagStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};
const throwing: FlagStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('All projects toggle storage', () => {
  it('is remembered per view', () => {
    const s = memory();
    expect(readAllProjects('inbox', s)).toBe(false);
    writeAllProjects('inbox', true, s);
    expect(s.data.get(ALL_PROJECTS_KEYS.inbox)).toBe('1');
    expect(readAllProjects('inbox', s)).toBe(true);
    expect(readAllProjects('fleet', s)).toBe(false);
    writeAllProjects('inbox', false, s);
    expect(s.data.has(ALL_PROJECTS_KEYS.inbox)).toBe(false);
  });
  it('storage missing or throwing: off, and writing does not throw (Review Focus 5)', () => {
    expect(readAllProjects('docker', throwing)).toBe(false);
    expect(() => writeAllProjects('docker', true, throwing)).not.toThrow();
    expect(readAllProjects('docker', null)).toBe(false);
    expect(() => writeAllProjects('docker', true, null)).not.toThrow();
  });
});

describe('inScope / outOfScope', () => {
  const items = [{ p: 'a' }, { p: 'b' }, { p: null }, { p: 'a' }];
  const of = (i: { p: string | null }) => i.p;
  it("the active project's items by default", () => {
    expect(inScope(items, of, { activeProjectId: 'a', all: false })).toEqual([{ p: 'a' }, { p: 'a' }]);
    expect(outOfScope(items, of, { activeProjectId: 'a', all: false })).toBe(2);
  });
  it('everything with All projects on; unknown projects only there', () => {
    expect(inScope(items, of, { activeProjectId: 'a', all: true })).toEqual(items);
    expect(outOfScope(items, of, { activeProjectId: 'a', all: true })).toBe(0);
  });
  it('no active project: everything, nothing hidden (Review Focus 4)', () => {
    expect(inScope(items, of, { activeProjectId: null, all: false })).toEqual(items);
    expect(outOfScope(items, of, { activeProjectId: null, all: false })).toBe(0);
  });
});

describe('moreInOtherProjects', () => {
  it("is the spec's line", () => {
    expect(moreInOtherProjects(3)).toBe('3 more in other projects');
    expect(moreInOtherProjects(1)).toBe('1 more in other projects');
    expect(moreInOtherProjects(0)).toBeNull();
  });
});

describe('fleetBulkTitles', () => {
  it('the bulk buttons say which projects they act on', () => {
    expect(fleetBulkTitles({ activeProjectId: 'a', all: false })).toEqual({
      stopAll: 'Stop every running or queued session in this project',
      cleanUp:
        'Purge finished and failed sessions, close their exited terminals, and prune their temporary git worktrees in this project',
    });
    const everywhere = {
      stopAll: 'Stop every running or queued session in all projects',
      cleanUp:
        'Purge finished and failed sessions, close their exited terminals, and prune their temporary git worktrees in all projects',
    };
    expect(fleetBulkTitles({ activeProjectId: 'a', all: true })).toEqual(everywhere);
    // No active project yet: the views show (and the buttons act on) every project.
    expect(fleetBulkTitles({ activeProjectId: null, all: false })).toEqual(everywhere);
  });
});

describe('inboxSubtitle', () => {
  it('names the scope', () => {
    expect(inboxSubtitle(true, undefined)).toBe('Runs that need you in this project · Alt+N opens the oldest in any project');
    expect(inboxSubtitle(true, 'Alpha')).toBe('Runs that need you in Alpha · Alt+N opens the oldest in any project');
    expect(inboxSubtitle(false, 'Alpha')).toBe('Runs that need you, across all projects · Alt+N opens the oldest');
  });
});
