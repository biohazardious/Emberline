import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { type ExecRequest, localCommandExecutor, setCommandExecutor } from '../command-exec.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, createTestApp, setupAndLogin, startGitGateway, type TestApp } from '../test-utils.js';

let t: TestApp;
let cookie: string;
let projectId: string;
let projectPath: string;
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
    encoding: 'utf8',
  }).trim();
const send = (method: 'GET', url: string) => t.app.inject({ method, url, headers: authHeaders(cookie) });
const commit = (dir: string, file: string, subject = file, content = `${file}\n`) => {
  writeFileSync(path.join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', subject);
};

beforeEach(async () => {
  t = await createTestApp();
  await startGitGateway(t);
  cookie = await setupAndLogin(t.app);
  const made = (await send0('POST', '/api/projects', { name: 'Git App', initGit: true })).json();
  projectId = made.project.id;
  projectPath = made.project.path;
});
afterEach(async () => {
  await t.close();
});
function send0(method: 'POST', url: string, payload: object) {
  return t.app.inject({ method, url, headers: authHeaders(cookie), payload });
}

describe('git history', () => {
  it('lists the working branch newest first with ticket keys, labels and the next cursor', async () => {
    for (let i = 0; i < 52; i++) commit(projectPath, `f${i}.txt`, `feat(EMB-${i}): file ${i}`);
    git(projectPath, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
    const page = (await send('GET', `/api/projects/${projectId}/git/commits`)).json();
    expect(page.commits).toHaveLength(50);
    expect(page.nextCursor).toBe(50);
    expect(page.commits[0]).toMatchObject({ subject: 'feat(EMB-51): file 51', ticketKey: 'EMB-51' });
    expect(page.commits[0].labels).toEqual(
      expect.arrayContaining([
        { kind: 'working', name: 'main' },
        { kind: 'tag', name: 'v0.1.0' },
      ]),
    );
    // main is the working branch: one label for it, not two.
    expect(page.commits[0].labels.filter((l: { name: string }) => l.name === 'main')).toEqual([
      { kind: 'working', name: 'main' },
    ]);
    const next = (await send('GET', `/api/projects/${projectId}/git/commits?cursor=50`)).json();
    expect(next.nextCursor).toBeNull();
    expect(next.commits.length).toBeGreaterThan(0);
  });

  it('refuses an abbreviated sha, an option-looking ref and a path outside the tree', async () => {
    expect((await send('GET', `/api/projects/${projectId}/git/commits/abc123`)).statusCode).toBe(400);
    expect((await send('GET', `/api/projects/${projectId}/git/commits?ref=--all`)).statusCode).toBe(400);
    const sha = git(projectPath, 'rev-parse', 'HEAD');
    for (const bad of ['../x', '-x', '/etc/passwd', '.git/config']) {
      const res = await send(
        'GET',
        `/api/projects/${projectId}/git/commits/${sha}/file?path=${encodeURIComponent(bad)}`,
      );
      expect(res.statusCode).toBe(400);
    }
  });

  it('answers 404 for an unknown project, ref or commit', async () => {
    expect((await send('GET', '/api/projects/nope/git/commits')).statusCode).toBe(404);
    expect((await send('GET', `/api/projects/${projectId}/git/commits?ref=nothing`)).statusCode).toBe(404);
    const missing = 'a'.repeat(40);
    expect((await send('GET', `/api/projects/${projectId}/git/commits/${missing}`)).statusCode).toBe(404);
  });

  it('shows a commit as its files with counts and a file as both sides', async () => {
    commit(projectPath, 'a.txt', 'docs: a', 'one\ntwo\n');
    const sha = git(projectPath, 'rev-parse', 'HEAD');
    const detail = (await send('GET', `/api/projects/${projectId}/git/commits/${sha}`)).json();
    expect(detail.files).toEqual([
      expect.objectContaining({ path: 'a.txt', status: 'added', additions: 2, deletions: 0 }),
    ]);
    const file = (await send('GET', `/api/projects/${projectId}/git/commits/${sha}/file?path=a.txt`)).json();
    expect(file).toMatchObject({ original: '', modified: 'one\ntwo\n', binary: false, truncated: false });
  });

  it('reads a rename from the old path, a binary file as binary and an oversized side as truncated', async () => {
    commit(projectPath, 'old.txt', 'docs: old', 'a\nb\nc\nd\ne\n');
    git(projectPath, 'mv', 'old.txt', 'new.txt');
    git(projectPath, 'commit', '-q', '-m', 'refactor: rename');
    let sha = git(projectPath, 'rev-parse', 'HEAD');
    const detail = (await send('GET', `/api/projects/${projectId}/git/commits/${sha}`)).json();
    expect(detail.files[0]).toMatchObject({ path: 'new.txt', oldPath: 'old.txt', status: 'renamed' });
    const renamed = (
      await send('GET', `/api/projects/${projectId}/git/commits/${sha}/file?path=new.txt`)
    ).json();
    expect(renamed.original).toBe('a\nb\nc\nd\ne\n');
    writeFileSync(path.join(projectPath, 'b.bin'), Buffer.from([1, 0, 2]));
    writeFileSync(path.join(projectPath, 'big.txt'), 'x'.repeat(1024 * 1024 + 1));
    git(projectPath, 'add', '.');
    git(projectPath, 'commit', '-q', '-m', 'chore: blobs');
    sha = git(projectPath, 'rev-parse', 'HEAD');
    const bin = (await send('GET', `/api/projects/${projectId}/git/commits/${sha}/file?path=b.bin`)).json();
    expect(bin).toMatchObject({ binary: true, modified: '' });
    const big = (await send('GET', `/api/projects/${projectId}/git/commits/${sha}/file?path=big.txt`)).json();
    expect(big).toMatchObject({ truncated: true, modified: '' });
  });

  it('compares two branches from their merge base', async () => {
    git(projectPath, 'branch', 'develop');
    git(projectPath, 'switch', '-q', 'develop');
    commit(projectPath, 'd.txt', 'feat: d');
    const cmp = (await send('GET', `/api/projects/${projectId}/git/compare?base=main&head=develop`)).json();
    expect(cmp).toMatchObject({ ahead: 1, behind: 0 });
    expect(cmp.files.map((f: { path: string }) => f.path)).toEqual(['d.txt']);
    const file = (
      await send('GET', `/api/projects/${projectId}/git/compare/file?base=main&head=develop&path=d.txt`)
    ).json();
    expect(file).toMatchObject({ original: '', modified: 'd.txt\n' });
  });

  it('takes only branches, tags, backups and full ids as refs, never a revision expression', async () => {
    commit(projectPath, 'a.txt');
    commit(projectPath, 'b.txt');
    for (const ref of ['main~1', 'main^', 'main@{1}', 'main..main', 'HEAD:a.txt']) {
      const res = await send('GET', `/api/projects/${projectId}/git/commits?ref=${encodeURIComponent(ref)}`);
      expect(res.statusCode, ref).toBe(400);
    }
    const cmp = await send(
      'GET',
      `/api/projects/${projectId}/git/compare?base=main&head=${encodeURIComponent('main@{1}')}`,
    );
    expect(cmp.statusCode).toBe(400);
  });

  it('reads a path a tree lacks as empty, but lets a failing git call surface', async () => {
    commit(projectPath, 'a.txt', 'docs: a', 'one\n');
    const sha = git(projectPath, 'rev-parse', 'HEAD');
    const gone = await send('GET', `/api/projects/${projectId}/git/commits/${sha}/file?path=missing.txt`);
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toMatchObject({ original: '', modified: '' });
    const failOn = (word: string) =>
      setCommandExecutor(async (request: ExecRequest) => {
        if (request.args.includes(word)) throw new Error('git failed');
        return localCommandExecutor(request);
      });
    try {
      for (const word of ['diff', 'ls-tree']) {
        failOn(word);
        const url =
          word === 'diff'
            ? `/api/projects/${projectId}/git/commits/${sha}`
            : `/api/projects/${projectId}/git/commits/${sha}/file?path=a.txt`;
        expect((await send('GET', url)).statusCode, word).toBe(500);
      }
    } finally {
      setCommandExecutor(localCommandExecutor);
    }
  });
});
