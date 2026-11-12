import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run, Ticket } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';
import {
  BranchFootprints,
  busyFootprint,
  claimedPaths,
  globToRegExp,
  isHotPath,
  overlapWait,
  pathsOverlap,
} from './tickets/overlap.js';

describe('claimedPaths', () => {
  it('reads list items and backticked paths of the Target Files section only', () => {
    const body = [
      '## Objective',
      'Touch `apps/other/never.ts` here, not a claim.',
      '',
      '## Target Files',
      '- new `apps/core/src/tickets/overlap.ts` (+ `apps/core/src/ticket-overlap.test.ts`)',
      '- `apps/core/src/tickets/service.ts` — only `dispatchNextReadyTicketUnlocked` (the `for (const next of queue)` loop)',
      '* packages/protocol/src/api/tickets.ts',
      '1. `apps/web/src/board/**`',
      '- `Makefile`, `.github/workflows/ci.yml`',
      '- `./scripts/run.sh` and `apps/web/src/` and `apps/web/src/lib`',
      '',
      '## Spec',
      '- `apps/spec/not-claimed.ts`',
    ].join('\n');
    expect(claimedPaths(body)).toEqual([
      'apps/core/src/tickets/overlap.ts',
      'apps/core/src/ticket-overlap.test.ts',
      'apps/core/src/tickets/service.ts',
      'packages/protocol/src/api/tickets.ts',
      'apps/web/src/board/**',
      'Makefile',
      '.github/workflows/ci.yml',
      'scripts/run.sh',
      'apps/web/src/**',
      'apps/web/src/lib/**',
    ]);
  });

  it('resolves a bare `(+ x.test.ts)` mention next to the path it belongs to', () => {
    expect(claimedPaths('## Target Files\n- `apps/x/src/a.ts` (+ a.test.ts)')).toEqual([
      'apps/x/src/a.ts',
      'apps/x/src/a.test.ts',
    ]);
  });

  it('ignores URLs, absolute and parent paths', () => {
    const body = [
      '### Target files',
      '- https://example.com/a.ts',
      '- `/etc/passwd`',
      '- `~/notes.md`',
      '- `../outside/x.ts`',
      '- `C:/win/x.ts`',
      '- `apps/ok.ts`',
    ].join('\n');
    expect(claimedPaths(body)).toEqual(['apps/ok.ts']);
  });

  it('is empty without the section', () => {
    expect(claimedPaths('## Objective\n- `apps/x/a.ts`')).toEqual([]);
  });
});

describe('hot shared paths', () => {
  it('never count, at any depth or under docs/ and .emberline/', () => {
    for (const hot of [
      'PROJECT.md',
      'CHANGELOG.md',
      'README.md',
      'CLAUDE.md',
      'apps/web/README.md',
      'docs/guide.md',
      'docs/**',
      '.emberline/new-tickets.json',
      'pnpm-lock.yaml',
      'apps/x/package-lock.json',
      'Cargo.lock',
      'go.sum',
    ]) {
      expect(isHotPath(hot), hot).toBe(true);
    }
    for (const code of ['Makefile', 'apps/x/a.ts', '**/*.md', 'package.json', 'docsite/a.ts']) {
      expect(isHotPath(code), code).toBe(false);
    }
  });

  it('are left out of a busy footprint, so a PROJECT.md claim alone never waits', () => {
    const paths = busyFootprint(['PROJECT.md', 'apps/x/a.ts'], ['PROJECT.md', 'pnpm-lock.yaml', 'docs/a.md']);
    expect(paths).toEqual(['apps/x/a.ts']);
    const busy = [{ ticketId: 'b', key: 'P-2', paths }];
    expect(overlapWait({ id: 'a', body: '## Target Files\n- `PROJECT.md`\n- `docs/x.md`' }, busy)).toBeNull();
  });
});

describe('glob overlap', () => {
  it('matches globs against paths', () => {
    expect(globToRegExp('apps/**').test('apps/x/y/z.ts')).toBe(true);
    expect(globToRegExp('apps/*/a.ts').test('apps/x/a.ts')).toBe(true);
    expect(globToRegExp('apps/*/a.ts').test('apps/x/y/a.ts')).toBe(false);
    expect(globToRegExp('**/a.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('src/*.{ts,tsx}').test('src/v.tsx')).toBe(true);
    expect(globToRegExp('src/?.ts').test('src/ab.ts')).toBe(false);
  });

  it('compares paths, globs and pairs of globs', () => {
    expect(pathsOverlap('apps/x/a.ts', 'apps/x/a.ts')).toBe(true);
    expect(pathsOverlap('apps/x/a.ts', 'apps/x/b.ts')).toBe(false);
    expect(pathsOverlap('apps/x/**', 'apps/x/deep/b.ts')).toBe(true);
    expect(pathsOverlap('apps/x/deep/b.ts', 'apps/x/**')).toBe(true);
    expect(pathsOverlap('apps/x/**', 'apps/y/b.ts')).toBe(false);
    expect(pathsOverlap('apps/x/**', 'apps/x/sub/*.ts')).toBe(true);
    expect(pathsOverlap('apps/x/**', 'apps/y/**')).toBe(false);
  });

  it('names the first overlapping busy ticket with the claimed paths that overlap', () => {
    const busy = [
      { ticketId: 'one', key: 'P-1', paths: ['apps/y/c.ts'] },
      { ticketId: 'two', key: 'P-2', paths: ['apps/x/a.ts', 'apps/x/b.ts'] },
    ];
    const body = '## Target Files\n- `apps/x/**`\n- `apps/z/q.ts`';
    expect(overlapWait({ id: 'me', body }, busy)).toEqual({
      ticketId: 'two',
      key: 'P-2',
      paths: ['apps/x/**'],
    });
    expect(overlapWait({ id: 'two', body }, busy)).toBeNull();
  });
});

describe('BranchFootprints', () => {
  it('reads the diff once per branch tip and keeps claims only when git fails', async () => {
    const calls: string[][] = [];
    let tip = 'aaa';
    let fail = false;
    const footprints = new BranchFootprints(async (args) => {
      calls.push(args);
      if (fail) throw new Error('not a git repository');
      return args[0] === 'rev-parse' ? `${tip}\n` : 'apps/x/a.ts\0apps/x/b.ts\0';
    });
    const run = { id: 'r1', worktreePath: '/wt' };
    await footprints.refresh(run, 'main');
    await footprints.refresh(run, 'main');
    expect(calls.filter((c) => c[0] === 'diff')).toHaveLength(1);
    expect(calls.find((c) => c[0] === 'diff')).toEqual(['diff', '--name-only', '-z', 'main...HEAD', '--']);
    expect(footprints.changed('r1')).toEqual(['apps/x/a.ts', 'apps/x/b.ts']);
    tip = 'bbb';
    await footprints.refresh(run, 'main');
    expect(calls.filter((c) => c[0] === 'diff')).toHaveLength(2);
    fail = true;
    await footprints.refresh(run, 'main');
    expect(footprints.changed('r1')).toEqual([]);
    footprints.retain(new Set());
    expect(footprints.changed('r1')).toEqual([]);
  });
});

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

/** Claude stand-in: leaks its hook token and waits for a line (the run stays busy). */
function writeFakeClaude(dir: string): string {
  const file = path.join(dir, 'fake-claude.sh');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${dir}/.token-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.token-$EMBERLINE_RUN_ID" "${dir}/token-$EMBERLINE_RUN_ID"`,
      'echo "fake claude ready"',
      'read line',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return file;
}

const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

async function createProject(): Promise<{ id: string; path: string }> {
  const { project } = (
    await api('POST', '/api/projects', { name: 'Overlap Project', initGit: false })
  ).json();
  const git = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return project as { id: string; path: string };
}

const createTicket = async (projectId: string, body: object): Promise<Ticket> =>
  (await api('POST', `/api/projects/${projectId}/tickets`, body)).json();

const listTickets = async (projectId: string): Promise<Ticket[]> =>
  (await api('GET', `/api/projects/${projectId}/tickets`)).json();

const runsFor = (ticketId: string) => t.runs.list().filter((r) => r.ticketId === ticketId);

async function waitFile(name: string): Promise<string> {
  const file = path.join(t.dir, name);
  await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
  return readFileSync(file, 'utf8');
}

/** A ticket started by hand whose agent committed `files` on its branch and keeps working. */
async function busyRunThatChanged(projectId: string, files: string[]): Promise<{ ticket: Ticket; run: Run }> {
  const ticket = await createTicket(projectId, { title: 'Busy', status: 'ready' });
  const { run } = (await api('POST', `/api/tickets/${ticket.id}/start`, {})).json() as { run: Run };
  for (const file of files) {
    mkdirSync(path.dirname(path.join(run.worktreePath, file)), { recursive: true });
    writeFileSync(path.join(run.worktreePath, file), 'changed\n');
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', run.worktreePath, ...args]);
  git('add', '-A');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'work');
  await waitFile(`token-${run.id}`);
  return { ticket: await (await api('GET', `/api/tickets/${ticket.id}`)).json(), run };
}

describe('overlap-aware dispatch (AC-5.6)', () => {
  beforeEach(async () => {
    t = await createTestApp();
    t.config.claudeCommand = writeFakeClaude(t.dir);
    ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
    await ptydServer.listen();
    t.ptyd.start();
    await t.ptyd.waitUntilConnected();
    cookie = await setupAndLogin(t.app);
    await api('PATCH', '/api/factory/settings', { autoPickupReady: false, maxParallelTicketsPerProject: 2 });
  });

  afterEach(async () => {
    await ptydServer.close();
    await t.close();
  });

  it('defers a ticket claiming a file a busy run changed and starts a lower-priority one instead', async () => {
    const project = await createProject();
    const busy = await busyRunThatChanged(project.id, ['apps/x/a.ts', 'PROJECT.md']);
    const waiting = await createTicket(project.id, {
      title: 'Edits a.ts',
      status: 'ready',
      priority: 3,
      body: '## Objective\nx\n\n## Target Files\n- `apps/x/a.ts`\n',
    });
    const free = await createTicket(project.id, {
      title: 'Edits c.ts',
      status: 'ready',
      priority: 1,
      body: '## Target Files\n- `apps/y/c.ts`\n- `PROJECT.md`\n',
    });

    const started = await t.tickets.dispatchNextReadyTicket(project.id);
    expect(started.map((s) => s.ticket.id)).toEqual([free.id]);
    expect(runsFor(waiting.id)).toHaveLength(0);

    const board = await listTickets(project.id);
    expect(board.find((x) => x.id === waiting.id)?.waitingOn).toEqual({
      ticketId: busy.ticket.id,
      key: busy.ticket.key,
      paths: ['apps/x/a.ts'],
    });
    expect(board.find((x) => x.id === free.id)?.waitingOn).toBeNull();
    await waitFile(`token-${started[0]?.run.id}`);

    // The busy run ends: the deferred ticket is dispatched again and takes the freed slot.
    await api('PATCH', '/api/factory/settings', { autoPickupReady: true });
    await api('POST', `/api/runs/${busy.run.id}/stop`, {});
    await expect.poll(() => runsFor(waiting.id).length, { timeout: 10_000 }).toBe(1);
    expect((await listTickets(project.id)).find((x) => x.id === waiting.id)?.waitingOn).toBeNull();
    await waitFile(`token-${runsFor(waiting.id)[0]?.id}`);
  });

  it('never defers a ticket that claims only PROJECT.md', async () => {
    const project = await createProject();
    await busyRunThatChanged(project.id, ['PROJECT.md', 'docs/a.md']);
    const projectDoc = await createTicket(project.id, {
      title: 'Milestone notes',
      status: 'ready',
      body: '## Target Files\n- `PROJECT.md`\n',
    });
    const started = await t.tickets.dispatchNextReadyTicket(project.id);
    expect(started.map((s) => s.ticket.id)).toEqual([projectDoc.id]);
    await waitFile(`token-${started[0]?.run.id}`);
  });

  it('starts overlapping tickets when serializeOverlappingTickets is off', async () => {
    await api('PATCH', '/api/factory/settings', { serializeOverlappingTickets: false });
    const project = await createProject();
    await busyRunThatChanged(project.id, ['apps/x/a.ts']);
    const ticket = await createTicket(project.id, {
      title: 'Edits a.ts',
      status: 'ready',
      body: '## Target Files\n- `apps/x/**`\n',
    });
    expect((await listTickets(project.id)).find((x) => x.id === ticket.id)?.waitingOn).toBeNull();
    const started = await t.tickets.dispatchNextReadyTicket(project.id);
    expect(started.map((s) => s.ticket.id)).toEqual([ticket.id]);
    await waitFile(`token-${started[0]?.run.id}`);
  });
});
