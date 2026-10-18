import type { WorkspaceDemoTarget } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { builtLine, shouldAutoBuild, staleBadge } from './demoFreshness';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const SHA = '0123456789abcdef0123456789abcdef01234567';

type Fields = Pick<WorkspaceDemoTarget, 'kind' | 'exists' | 'demoBuild' | 'demoStale' | 'rebuilding'>;
const target = (over: Partial<Fields> = {}): Fields => ({
  kind: 'main',
  exists: true,
  demoBuild: { commit: SHA, builtAt: '2026-10-18T11:55:00.000Z', ok: true },
  demoStale: false,
  rebuilding: false,
  ...over,
});

describe('built line', () => {
  it('says when and from which commit the demo was built', () => {
    expect(builtLine(target(), NOW)).toBe('Built 5m ago from 0123456');
  });

  it('says a failed build failed', () => {
    expect(
      builtLine(target({ demoBuild: { commit: SHA, builtAt: '2026-10-18T09:00:00.000Z', ok: false } }), NOW),
    ).toBe('Build failed 3h ago from 0123456');
  });

  it('leaves the commit out when none was recorded (not a git repository)', () => {
    expect(
      builtLine(target({ demoBuild: { commit: null, builtAt: '2026-10-18T11:59:30.000Z', ok: true } }), NOW),
    ).toBe('Built 30s ago');
  });

  it('says so when nothing was built yet, and while a rebuild runs', () => {
    expect(builtLine(target({ demoBuild: null }), NOW)).toBe('Not built yet');
    expect(builtLine(target({ rebuilding: true }), NOW)).toBe('Rebuilding…');
  });
});

describe('stale badge', () => {
  it('names main for the main workspace and stays generic for runs', () => {
    expect(staleBadge(target({ demoStale: true }))).toBe('main changed since this build');
    expect(staleBadge(target({ kind: 'worktree', demoStale: true }))).toBe('changed since this build');
  });

  it('is absent while fresh or rebuilding', () => {
    expect(staleBadge(target())).toBeNull();
    expect(staleBadge(target({ demoStale: true, rebuilding: true }))).toBeNull();
  });
});

describe('auto-build on open', () => {
  const idle = { building: false, alreadyStarted: false };

  it('starts a build for a stale target once per open', () => {
    expect(shouldAutoBuild(target({ demoStale: true }), idle)).toBe(true);
    expect(shouldAutoBuild(target({ demoStale: true }), { ...idle, alreadyStarted: true })).toBe(false);
  });

  it('never while a build runs (here or in core) or for a fresh or missing workspace', () => {
    expect(shouldAutoBuild(target({ demoStale: true }), { ...idle, building: true })).toBe(false);
    expect(shouldAutoBuild(target({ demoStale: true, rebuilding: true }), idle)).toBe(false);
    expect(shouldAutoBuild(target(), idle)).toBe(false);
    expect(shouldAutoBuild(target({ demoStale: true, exists: false }), idle)).toBe(false);
  });
});
