import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmTemp } from '../test-rm.js';
import { auditWorktreeSlop } from './slop-guard.js';

// Built at run time, so no secret scanner reads a key in this file.
const fakeKey = (seed: string) => ['sk', 'proj', seed.repeat(24)].join('-');

describe('auditWorktreeSlop with an upstream (the pull ticket merging origin in)', () => {
  let dir: string;
  let upstream: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
      encoding: 'utf8',
    }).trim();
  const commitFile = (file: string, content: string, message: string) => {
    writeFileSync(path.join(dir, file), content);
    git('add', file);
    git('commit', '-q', '-m', message);
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'slop-upstream-'));
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    commitFile('a.ts', 'export const a = 1;\n', 'base');
    // Origin's history: a test fixture with a fake key, already published there.
    git('switch', '-q', '-c', 'origin-side');
    commitFile('fixture.test.ts', `export const key = '${fakeKey('a')}';\n`, 'fixture');
    upstream = git('rev-parse', 'HEAD');
    // The run's branch off main merges origin's history in.
    git('switch', '-q', 'main');
    git('switch', '-q', '-c', 'emberline/pull');
    git('merge', '-q', '--no-ff', '--no-edit', 'origin-side');
  });
  afterEach(() => rmTemp(dir));

  const leaks = (report: Awaited<ReturnType<typeof auditWorktreeSlop>>) =>
    report.issues.filter((i) => i.category === 'secret_leak').map((i) => i.file);

  it("does not judge upstream's lines, and still finds a leak the run wrote", async () => {
    commitFile('own.ts', `export const mine = '${fakeKey('b')}';\n`, 'own work');
    const without = await auditWorktreeSlop({ runId: 'r1', workspacePath: dir });
    expect(leaks(without).sort()).toEqual(['fixture.test.ts', 'own.ts']);
    const withUpstream = await auditWorktreeSlop({ runId: 'r1', workspacePath: dir, upstream });
    expect(leaks(withUpstream)).toEqual(['own.ts']);
    expect(withUpstream.secretGuardPassed).toBe(false);
  });

  it("a line the run changed in upstream's file is its own", async () => {
    commitFile('fixture.test.ts', `export const key = '${fakeKey('c')}';\n`, 'edit the fixture');
    const report = await auditWorktreeSlop({ runId: 'r1', workspacePath: dir, upstream });
    expect(leaks(report)).toEqual(['fixture.test.ts']);
  });

  it("a merge that brought in only upstream's lines passes, without auditing the whole workspace", async () => {
    const report = await auditWorktreeSlop({ runId: 'r1', workspacePath: dir, upstream });
    expect(report.secretGuardPassed).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('an upstream that cannot be read leaves nothing out', async () => {
    const report = await auditWorktreeSlop({ runId: 'r1', workspacePath: dir, upstream: 'f'.repeat(40) });
    expect(leaks(report)).toEqual(['fixture.test.ts']);
  });
});
