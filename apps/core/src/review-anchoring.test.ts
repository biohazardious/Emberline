import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ReviewComment, Run, RunDiffSummary, RunReviewState } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

beforeEach(async () => {
  t = await createTestApp();
  const fake = path.join(t.dir, 'fake-claude.sh');
  writeFileSync(fake, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  t.config.claudeCommand = fake;
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  cookie = await setupAndLogin(t.app);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await ptydServer.close();
  await t.close();
});

const api = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

const SRC = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** A project with a committed repo (text, to-be-deleted file) and a run whose worktree we edit. */
async function setup(): Promise<{ run: Run; wt: string }> {
  const { project } = (await api('POST', '/api/projects', { name: 'Anchors', initGit: false })).json() as {
    project: { id: string; path: string };
  };
  const git = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(project.path, 'a.txt'), SRC);
  writeFileSync(path.join(project.path, 'gone.txt'), 'bye\n');
  git('add', '.');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  const run: Run = (await api('POST', '/api/runs', { projectId: project.id, prompt: 'x' })).json();
  return { run, wt: run.worktreePath };
}

const diff = async (run: Run): Promise<RunDiffSummary> =>
  (await api('GET', `/api/runs/${run.id}/diff`)).json();
const hashOf = async (run: Run, file: string) => (await diff(run)).files.find((f) => f.path === file)?.hash;
const state = async (run: Run): Promise<RunReviewState> =>
  (await api('GET', `/api/runs/${run.id}/review`)).json();
const comment = async (run: Run, body: object): Promise<ReviewComment> => {
  const res = await api('POST', `/api/runs/${run.id}/review/comments`, body);
  expect(res.statusCode).toBe(201);
  return res.json();
};

describe('file hashes', () => {
  it('changes with content even when line counts stay equal, covers deleted and binary files', async () => {
    const { run, wt } = await setup();
    writeFileSync(path.join(wt, 'a.txt'), SRC.replace('line 3', 'LINE 3'));
    const h1 = await hashOf(run, 'a.txt');
    expect(h1).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(path.join(wt, 'a.txt'), SRC.replace('line 3', 'lINE 3'));
    const h2 = await hashOf(run, 'a.txt');
    expect(h2).toMatch(/^[0-9a-f]{40}$/);
    expect(h2).not.toBe(h1);

    rmSync(path.join(wt, 'gone.txt'));
    const blob = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD:gone.txt']).toString().trim();
    expect(await hashOf(run, 'gone.txt')).toBe(`deleted:${blob}`);

    writeFileSync(path.join(wt, 'img.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
    expect(await hashOf(run, 'img.bin')).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('typed and file-level comments', () => {
  it('defaults intent/priority, stores the anchor and allows file-level comments on deleted files', async () => {
    const { run, wt } = await setup();
    writeFileSync(path.join(wt, 'a.txt'), SRC.replace('line 3', 'line three'));
    rmSync(path.join(wt, 'gone.txt'));
    const hash = await hashOf(run, 'a.txt');
    const c = await comment(run, {
      filePath: 'a.txt',
      line: 3,
      body: 'why?',
      intent: 'question',
      priority: 'blocking',
    });
    expect(c).toMatchObject({
      intent: 'question',
      priority: 'blocking',
      anchorText: 'line three',
      anchorHash: hash,
      round: 0,
      line: 3,
    });
    const d = await comment(run, { filePath: 'a.txt', line: 5, body: 'plain' });
    expect(d).toMatchObject({ intent: 'fix', priority: 'important' });

    const file = await comment(run, { filePath: 'gone.txt', body: 'Why delete this?' });
    expect(file).toMatchObject({ line: null, anchorText: null, anchorHash: await hashOf(run, 'gone.txt') });
    const bin = await comment(run, { filePath: 'img.bin', line: null, body: 'binary' });
    expect(bin.line).toBeNull();

    expect(
      (
        await api('POST', `/api/runs/${run.id}/review/comments`, {
          filePath: 'a.txt',
          line: 1,
          body: 'x',
          intent: 'nope',
        })
      ).statusCode,
    ).toBe(400);
    const patched = await api('PATCH', `/api/runs/${run.id}/review/comments/${c.id}`, {
      intent: 'change',
      priority: 'suggestion',
    });
    expect(patched.json()).toMatchObject({ intent: 'change', priority: 'suggestion' });

    const s = await state(run);
    const fl = s.comments.find((x) => x.id === file.id)!;
    expect(fl).toMatchObject({ currentLine: null, outdated: false });
  });

  it('caps the anchor text at 500 characters', async () => {
    const { run, wt } = await setup();
    writeFileSync(path.join(wt, 'a.txt'), `  ${'y'.repeat(800)}  \n`);
    const c = await comment(run, { filePath: 'a.txt', line: 1, body: 'long' });
    expect(c.anchorText).toBe('y'.repeat(500));
  });
});

describe('re-anchoring on read', () => {
  it('leaves comments alone while the file hash is unchanged', async () => {
    const { run, wt } = await setup();
    writeFileSync(path.join(wt, 'a.txt'), SRC.replace('line 3', 'line three'));
    const c = await comment(run, { filePath: 'a.txt', line: 3, body: 'x' });
    expect((await state(run)).comments[0]).toMatchObject({ id: c.id, currentLine: 3, outdated: false });
  });

  it('follows moved lines, flags missing ones and files that left the diff', async () => {
    const { run, wt } = await setup();
    writeFileSync(path.join(wt, 'a.txt'), SRC.replace('line 3', 'line three'));
    const moved = await comment(run, { filePath: 'a.txt', line: 3, body: 'moved' });
    const gone = await comment(run, { filePath: 'a.txt', line: 3, side: 'original', body: 'orig' });
    const removed = await comment(run, { filePath: 'a.txt', line: 8, body: 'removed' });
    // insert two lines on top, delete "line 8"
    writeFileSync(
      path.join(wt, 'a.txt'),
      'new 1\nnew 2\n' + SRC.replace('line 3', 'line three').replace('line 8\n', ''),
    );
    let s = await state(run);
    const by = (id: string) => s.comments.find((x) => x.id === id)!;
    expect(by(moved.id)).toMatchObject({ currentLine: 5, outdated: false, line: 3 });
    expect(by(removed.id)).toMatchObject({ currentLine: null, outdated: true });
    // original side reads base content: "line 3" is still at 3
    expect(by(gone.id)).toMatchObject({ currentLine: 3, outdated: false });

    // revert the file entirely: it leaves the diff
    writeFileSync(path.join(wt, 'a.txt'), SRC);
    s = await state(run);
    expect(by(moved.id)).toMatchObject({ outdated: true, currentLine: null });
  });

  it('falls back to the stored line when the file cannot be read within the cap', async () => {
    const { run, wt } = await setup();
    writeFileSync(path.join(wt, 'a.txt'), SRC.replace('line 3', 'line three'));
    const c = await comment(run, { filePath: 'a.txt', line: 3, body: 'x' });
    writeFileSync(path.join(wt, 'a.txt'), 'line three\n' + 'z'.repeat(2 * 1024 * 1024 + 10));
    expect((await state(run)).comments.find((x) => x.id === c.id)).toMatchObject({
      currentLine: 3,
      outdated: false,
    });
  });

  it('stores no anchor for a blank line and returns re-anchored fields from PATCH', async () => {
    const { run, wt } = await setup();
    writeFileSync(path.join(wt, 'a.txt'), 'first\n\nthird\n');
    const blank = await comment(run, { filePath: 'a.txt', line: 2, body: 'blank' });
    expect(blank.anchorText).toBeNull();
    const c = await comment(run, { filePath: 'a.txt', line: 3, body: 'x' });
    writeFileSync(path.join(wt, 'a.txt'), 'new\nfirst\n\nthird\n');
    const patched = (
      await api('PATCH', `/api/runs/${run.id}/review/comments/${c.id}`, { priority: 'blocking' })
    ).json();
    expect(patched).toMatchObject({ priority: 'blocking', currentLine: 4, outdated: false });
  });

  it('re-anchors only unresolved comments, hashing only the commented files instead of the whole diff', async () => {
    const { run, wt } = await setup();
    writeFileSync(path.join(wt, 'a.txt'), SRC.replace('line 3', 'line three'));
    writeFileSync(path.join(wt, 'other.txt'), 'other\n');
    writeFileSync(path.join(wt, 'new.txt'), 'alpha\nbeta\n');
    const open = await comment(run, { filePath: 'a.txt', line: 3, body: 'open' });
    const done = await comment(run, { filePath: 'a.txt', line: 5, body: 'done' });
    const fresh = await comment(run, { filePath: 'new.txt', line: 2, body: 'untracked' });
    expect(
      (await api('PATCH', `/api/runs/${run.id}/review/comments/${done.id}`, { status: 'resolved' }))
        .statusCode,
    ).toBe(200);
    writeFileSync(path.join(wt, 'a.txt'), 'new 1\nnew 2\n' + SRC.replace('line 3', 'line three'));
    writeFileSync(path.join(wt, 'new.txt'), 'zero\nalpha\nbeta\n');

    const fullDiff = vi.spyOn(t.runs, 'diff');
    const hashed = vi.spyOn(t.runs, 'reviewHashes');
    let s = await state(run);
    const by = (id: string) => s.comments.find((x) => x.id === id)!;
    expect(by(open.id)).toMatchObject({ currentLine: 5, outdated: false });
    expect(by(fresh.id)).toMatchObject({ currentLine: 3, outdated: false });
    // A resolved comment keeps its stored line.
    expect(by(done.id)).toMatchObject({ currentLine: 5, outdated: false });
    expect(hashed).toHaveBeenCalledTimes(1);
    expect([...(hashed.mock.calls[0]?.[1] ?? [])].sort()).toEqual(['a.txt', 'new.txt']);

    // Marking a file viewed reads the state the same way.
    expect(
      (
        await api('PUT', `/api/runs/${run.id}/review/viewed`, {
          filePath: 'other.txt',
          signature: 'x',
          viewed: true,
        })
      ).statusCode,
    ).toBe(200);
    expect(fullDiff).not.toHaveBeenCalled();

    // A commented file that left the diff is outdated.
    writeFileSync(path.join(wt, 'a.txt'), SRC);
    s = await state(run);
    expect(by(open.id)).toMatchObject({ currentLine: null, outdated: true });
  });
});
