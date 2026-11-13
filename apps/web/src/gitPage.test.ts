import type { GitBranch, GitPageStatus, GitSync } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import {
  gitRefetchMs,
  releaseBlockedText,
  remoteStateText,
  splitBranches,
  syncText,
  tabFromHash,
  tagsDifferText,
} from './gitPage';

const sync = (over: Partial<GitSync>): GitSync => ({
  state: 'idle',
  at: null,
  branch: null,
  files: [],
  message: null,
  ...over,
});
const status = (over: object = {}) =>
  ({
    isGitRepo: true,
    release: { ok: true, reason: null },
    releaseJob: null,
    releaseDraft: null,
    ...over,
  }) as unknown as GitPageStatus;

describe('remoteStateText', () => {
  it.each([
    ['up_to_date', undefined, undefined, 'Up to date with origin'],
    ['behind', null, 3, '3 new commits on origin'],
    ['behind', null, 1, '1 new commit on origin'],
    ['ahead', 2, null, '2 commits not on origin yet'],
    ['diverged', 1, 1, 'Origin and Emberline both have new commits'],
    ['rewritten', null, null, "Origin's history was rewritten"],
    ['unpublished', null, null, 'Not on origin yet'],
    ['unknown', null, null, 'Not read yet'],
  ] as const)('%s', (state, ahead, behind, text) => {
    expect(remoteStateText(state, ahead, behind)).toBe(text);
  });
});

describe('syncText', () => {
  it.each([
    [sync({ state: 'conflict', files: ['a.ts', 'b.ts'] }), 'Pull stopped: a.ts, b.ts conflict'],
    [sync({ state: 'workspace_dirty' }), 'Pull waits: the main workspace has uncommitted changes'],
    [sync({ state: 'main_unpushed' }), 'Main has commits origin lacks; push or promote first'],
    [
      sync({ state: 'main_unpushed', message: 'Retry or Undo promote on the Release tab, then pull again.' }),
      'Retry or Undo promote on the Release tab, then pull again.',
    ],
    [
      sync({ state: 'rewritten' }),
      "Origin's history was rewritten. Match origin keeps your old commits under a backup.",
    ],
    // Core says how many of the branch's commits origin has under new hashes.
    [
      sync({ state: 'rewritten', message: 'Nothing was pulled into main: 36 of your 37 commits…' }),
      'Nothing was pulled into main: 36 of your 37 commits…',
    ],
    [sync({ state: 'error', message: 'Origin refused' }), 'Origin refused'],
    [sync({ state: 'idle', message: 'Checking the merge' }), 'Checking the merge'],
    [sync({ state: 'idle' }), null],
    [sync({ state: 'up_to_date' }), null],
    [sync({ state: 'no_remote', message: 'no origin' }), null],
  ])('%j', (s, text) => {
    expect(syncText(s)).toBe(text);
  });

  it('says how many commits a pull brought in', () => {
    expect(syncText(sync({ state: 'pulled' }), 4)).toBe('Pulled 4 commits');
    expect(syncText(sync({ state: 'pulled' }), 1)).toBe('Pulled 1 commit');
  });
});

describe('releaseBlockedText', () => {
  it('is null when a release can start', () => {
    expect(releaseBlockedText(status())).toBeNull();
  });
  it('gives the reason the core reports', () => {
    expect(releaseBlockedText(status({ release: { ok: false, reason: 'Checks are red.' } }))).toBe(
      'Checks are red.',
    );
  });
  it('says so while a release runs', () => {
    expect(releaseBlockedText(status({ releaseJob: { state: 'running' } }))).toBe('A release is running.');
  });
});

describe('splitBranches', () => {
  it('keeps run branches apart', () => {
    const b = (name: string, kind: GitBranch['kind']) => ({ name, kind }) as GitBranch;
    const { shown, runBranches } = splitBranches([
      b('main', 'main'),
      b('emberline/x', 'run'),
      b('me/y', 'person'),
    ]);
    expect(shown.map((x) => x.name)).toEqual(['main', 'me/y']);
    expect(runBranches.map((x) => x.name)).toEqual(['emberline/x']);
  });
});

describe('tabFromHash and gitRefetchMs', () => {
  it('reads the tab from the hash', () => {
    expect(tabFromHash('#branches')).toBe('branches');
    expect(tabFromHash('#release')).toBe('release');
    expect(tabFromHash('')).toBe('commits');
    expect(tabFromHash('#nope')).toBe('commits');
  });
  it('polls fast only while work is in progress', () => {
    expect(gitRefetchMs(undefined)).toBe(60_000);
    expect(gitRefetchMs(status())).toBe(60_000);
    expect(gitRefetchMs(status({ releaseJob: { state: 'running' } }))).toBe(5_000);
    expect(gitRefetchMs(status({ releaseDraft: { status: 'drafting' } }))).toBe(5_000);
  });
});

describe('tagsDifferText', () => {
  it('names the tags that differ from origin, at most five', () => {
    expect(tagsDifferText([])).toBeNull();
    expect(tagsDifferText(['v0.7.0'])).toBe(
      "The tag v0.7.0 here is not the same as origin's v0.7.0. Emberline never moves a local tag, so it stays as it is.",
    );
    expect(tagsDifferText(['v7', 'v6', 'v5', 'v4', 'v3', 'v2', 'v1'])).toBe(
      "7 tags here are not the same as origin's tags of the same name: v7, v6, v5, v4, v3 and 2 more. Emberline never moves a local tag, so they stay as they are.",
    );
  });
});
