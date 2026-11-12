/**
 * M5 layer 3 guards (PROJECT.md §6, AC-5.3 to AC-5.5): a conflicting merge the deterministic heal
 * could not land goes to the run's agent or to a resolver run on the same branch, from the pipeline
 * and from a person's close alike. Real git repositories and the fake ptyd of the pipeline tests.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type Run, type RunDetail, SyncWorktreeResponse, type Ticket } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runs } from './db/schema.js';
import type * as FactoryService from './factory/service.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';
import { RESOLVER_REASON, RESOLVER_RUN_CAP } from './tickets/conflict-ladder.js';

/** Build gate results handed out in order (one per check run); an empty queue builds green. */
const build = vi.hoisted(() => ({ results: [] as Array<{ ok: boolean; output: string }>, calls: 0 }));
vi.mock('./factory/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof FactoryService>();
  return {
    ...actual,
    buildWorkspaceDemo: (async (params) => {
      build.calls += 1;
      const result = build.results.shift() ?? { ok: true, output: '' };
      return { ...result, targetId: params.targetId, demoEntryRelPath: null, demoUrl: null };
    }) as typeof actual.buildWorkspaceDemo,
  };
});

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

/** A Claude stand-in that stays alive and logs every line typed into it (its start prompt is an argument). */
function writeLivingClaude(dir: string): string {
  const file = path.join(dir, 'living-claude.sh');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${dir}/.token-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.token-$EMBERLINE_RUN_ID" "${dir}/token-$EMBERLINE_RUN_ID"`,
      'echo "fake claude ready"',
      `: > "${dir}/ready-$EMBERLINE_RUN_ID"`,
      `while read line; do printf '%s\\n' "$line" >> "${dir}/followups-$EMBERLINE_RUN_ID"; done`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return file;
}

beforeEach(async () => {
  build.results = [];
  build.calls = 0;
  t = await createTestApp();
  t.config.claudeCommand = writeLivingClaude(t.dir);
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  cookie = await setupAndLogin(t.app);
});

afterEach(async () => {
  await ptydServer.close();
  await t.close();
});

const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

const hook = (runId: string, event: string, token: string, payload: object = {}) =>
  t.app.inject({
    method: 'POST',
    url: '/api/internal/hooks',
    headers: { authorization: `Bearer ${token}` },
    payload: { runId, event, receivedAt: new Date().toISOString(), payload },
  });

/** The agent's `ticket_complete` call, after its `emberline-mcp` checked in. */
const signal = async (runId: string, token: string) => {
  const headers = { authorization: `Bearer ${token}` };
  await t.app.inject({ method: 'POST', url: `/api/internal/runs/${runId}/completion-tool`, headers });
  return t.app.inject({
    method: 'POST',
    url: `/api/internal/runs/${runId}/complete`,
    headers,
    payload: { summary: 'done' },
  });
};

const wgit = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-C', cwd, ...args], {
    encoding: 'utf8',
  });

async function waitFile(name: string): Promise<string> {
  const file = path.join(t.dir, name);
  await expect.poll(() => existsSync(file), { timeout: 10_000 }).toBe(true);
  return readFileSync(file, 'utf8');
}

const followups = (run: Run) => {
  const file = path.join(t.dir, `followups-${run.id}`);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};
const runsFor = (ticketId: string) => t.runs.list().filter((r) => r.ticketId === ticketId);
const statusOf = async (id: string) => ((await api('GET', `/api/tickets/${id}`)).json() as Ticket).status;
const events = async (run: Run) => ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events;
const eventTypes = async (run: Run) => (await events(run)).map((e) => e.type);
const noteOf = async (run: Run, type: string) =>
  (await events(run)).filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>);
const head = (dir: string) => wgit(dir, 'rev-parse', 'HEAD').trim();

/** Starts a dispatched run's agent session (it is reading typed lines from now on). */
async function started(run: Run): Promise<string> {
  await waitFile(`ready-${run.id}`);
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
  await hook(run.id, 'UserPromptSubmit', token);
  return token;
}

/** A finished, signalled turn. */
async function finishTurn(run: Run): Promise<void> {
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'UserPromptSubmit', token);
  await signal(run.id, token);
  await hook(run.id, 'Stop', token);
}

/**
 * A factory project whose tickets A and B both change `file`: A is merged into main, B's session is
 * live and its branch conflicts with main. `a` and `b` are the two sides' new file contents.
 */
async function conflictingPair(opts: {
  file: string;
  base: string;
  a: string;
  b: string;
  buildable?: boolean;
}) {
  const { project } = (
    await api('POST', '/api/projects', { name: 'M5 Conflicts', initGit: false })
  ).json() as {
    project: { id: string; path: string };
  };
  wgit(project.path, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(project.path, opts.file), opts.base);
  // A build target, so the build gate (and the heal's re-run of it) has something to check.
  if (opts.buildable)
    writeFileSync(path.join(project.path, 'package.json'), '{"scripts":{"build":"true"}}\n');
  wgit(project.path, 'add', '-A');
  wgit(project.path, 'commit', '-q', '-m', 'init');
  const create = async (body: object) =>
    (await api('POST', `/api/projects/${project.id}/tickets`, body)).json() as Ticket;
  await create({ title: '[Factory] Plan', status: 'done' });
  const a = await create({ title: 'A', status: 'ready' });
  const b = await create({ title: 'B', status: 'ready' });
  await t.tickets.dispatchNextReadyTicket(project.id);
  const runA = runsFor(a.id)[0] as Run;
  const runB = runsFor(b.id)[0] as Run;
  writeFileSync(path.join(runA.worktreePath, opts.file), opts.a);
  writeFileSync(path.join(runB.worktreePath, opts.file), opts.b);
  await Promise.all([started(runA), started(runB)]);
  await finishTurn(runA);
  await expect.poll(() => statusOf(a.id), { timeout: 15_000 }).toBe('done');
  return { project, a, b, runA, runB };
}

const EDIT_EDIT = {
  file: 'app.js',
  base: 'one\ntwo\nthree\n',
  a: 'one\nfrom-a\nthree\n',
  b: 'one\nfrom-b\nthree\n',
};

/** B's turn is signalled, then its session ends with nothing to resume (a one-shot agent gone for good). */
async function endWithoutResume(run: Run): Promise<void> {
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'UserPromptSubmit', token);
  await signal(run.id, token);
  t.db
    .update(runs)
    .set({ state: 'done', endedAt: new Date(), ptydSessionId: null, agentSessionId: null })
    .where(eq(runs.id, run.id))
    .run();
  expect(t.runs.getRun(run.id)).toMatchObject({ resumable: false, cancelled: false });
}

const pipeline = () => t.tickets as unknown as { handleRunCompleted(r: Run): Promise<void> };

describe('M5 layer 3: escalation to an agent (AC-5.3, AC-5.4)', () => {
  it('AC-5.3 a heal whose re-run gate fails is undone and the agent gets the gate failure; nothing reaches main', async () => {
    const { project, b, runB } = await conflictingPair({
      file: 'Makefile',
      base: 'all:\n',
      a: 'all:\n\nlint:\n\techo lint\n',
      b: 'all:\n\ntest:\n\techo test\n',
      buildable: true,
    });
    const mainBefore = head(project.path);
    // B's own gate passes; the gate on the healed tree (B plus main) fails.
    build.results = [
      { ok: true, output: '' },
      { ok: false, output: 'make: *** [test] Error 2 (healed tree)' },
    ];
    await finishTurn(runB);
    await expect
      .poll(() => noteOf(runB, 'conflict_resolution_requested'), { timeout: 15_000 })
      .toHaveLength(1);

    const healFailed = await noteOf(runB, 'conflict_heal_failed');
    expect(healFailed).toEqual([expect.objectContaining({ reason: 'gate_failed', files: ['Makefile'] })]);
    // The heal was undone: the branch tip is B's own output commit (no merge of main), the worktree
    // is clean and main is as before.
    expect(
      wgit(runB.worktreePath, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' '),
    ).toHaveLength(2);
    expect(() => wgit(runB.worktreePath, 'merge-base', '--is-ancestor', mainBefore, 'HEAD')).toThrow();
    expect(wgit(runB.worktreePath, 'status', '--porcelain')).toBe('');
    expect(head(project.path)).toBe(mainBefore);
    expect(readFileSync(path.join(project.path, 'Makefile'), 'utf8')).not.toContain('test:');
    expect(await eventTypes(runB)).not.toContain('conflict_auto_resolved');
    // The agent's request names the conflict and quotes the failed gate.
    await expect.poll(() => followups(runB), { timeout: 10_000 }).toContain('(healed tree)');
    expect(followups(runB)).toContain('conflicts in: Makefile');
    expect(await statusOf(b.id)).not.toBe('done');
  });

  it('AC-5.4 a conflicting run whose session ended for good gets a resolver run that merges and finishes the ticket', async () => {
    const { project, b, runB } = await conflictingPair(EDIT_EDIT);
    await endWithoutResume(runB);
    await pipeline().handleRunCompleted(t.runs.getRun(runB.id));

    const [started_] = await noteOf(runB, 'conflict_resolver_started');
    expect(started_).toMatchObject({ conflicts: ['app.js'], mainHead: head(project.path) });
    const resolverId = started_?.runId as string;
    const resolver = t.runs.getRun(resolverId);
    expect(resolver).toMatchObject({
      ticketId: b.id,
      worktreePath: runB.worktreePath,
      branch: runB.branch,
      persona: 'coder',
    });
    expect(t.runs.getRun(runB.id).handedOffTo).toBe(resolverId);
    expect(t.runs.get(resolverId).prompt).toContain('conflicts in: app.js');
    expect(t.runs.get(resolverId).prompt).toContain(`"B"`);
    expect((await noteOf(resolver, 'handoff_from'))[0]).toMatchObject({ reason: RESOLVER_REASON });
    // The held run is superseded: no person is asked about it.
    expect(t.runs.getRun(runB.id).attention).toBeNull();

    // The resolver merges main, resolves, commits and finishes through the normal pipeline.
    await started(resolver);
    try {
      wgit(runB.worktreePath, 'merge', '-q', 'main');
    } catch {
      // the conflict is expected
    }
    writeFileSync(path.join(runB.worktreePath, 'app.js'), 'one\nfrom-a\nfrom-b\nthree\n');
    wgit(runB.worktreePath, 'add', '-A');
    wgit(runB.worktreePath, 'commit', '-q', '-m', 'resolve');
    await finishTurn(resolver);

    await expect.poll(() => statusOf(b.id), { timeout: 15_000 }).toBe('done');
    expect(readFileSync(path.join(project.path, 'app.js'), 'utf8')).toBe('one\nfrom-a\nfrom-b\nthree\n');
    expect(await eventTypes(resolver)).toContain('merged_to_main');
    // Merged once, by the resolver: the original run is never merged itself.
    expect(await eventTypes(runB)).not.toContain('merged_to_main');
    expect(wgit(project.path, 'log', '--merges', '--format=%s').match(/Merge /g)).toHaveLength(2);
  });

  it('AC-5.4 one resolver run per ticket and main head, RESOLVER_RUN_CAP per ticket, then a person', async () => {
    const { project, b, runB } = await conflictingPair(EDIT_EDIT);
    await endWithoutResume(runB);
    const ladder = t.tickets.conflictLadder;
    const mainHead = head(project.path);
    const run = t.runs.getRun(runB.id);
    expect(ladder.plan(run, mainHead)).toBe('resolver');
    t.runs.note(runB.id, 'conflict_resolver_started', { runId: 'r1', conflicts: ['app.js'], mainHead });
    expect(ladder.plan(run, mainHead)).toBe('manual');
    expect(ladder.plan(run, 'another-main-head')).toBe('resolver');
    expect(RESOLVER_RUN_CAP).toBe(2);
    t.runs.note(runB.id, 'conflict_resolver_started', { runId: 'r2', conflicts: ['app.js'], mainHead: 'h2' });
    expect(ladder.plan(run, 'a-third-head')).toBe('manual');

    // With the cap spent, the pipeline leaves the conflict to a person.
    await pipeline().handleRunCompleted(t.runs.getRun(runB.id));
    const held = (await noteOf(runB, 'merge_failed')).at(-1);
    expect(held).toMatchObject({ conflicts: ['app.js'] });
    expect(held?.autoFix).toBeUndefined();
    expect(t.runs.getRun(runB.id).handedOffTo).toBeNull();
    expect(await statusOf(b.id)).not.toBe('done');
    expect(await eventTypes(runB)).not.toContain('conflict_resolution_requested');
  });

  it('a live session whose attempts are spent while main keeps moving gets a resolver run', async () => {
    const { project, runB } = await conflictingPair(EDIT_EDIT);
    for (const n of [1, 2, 3])
      t.runs.note(runB.id, 'conflict_resolution_requested', { conflicts: ['app.js'], mainHead: `old-${n}` });
    await finishTurn(runB);
    await expect.poll(() => noteOf(runB, 'conflict_resolver_started'), { timeout: 15_000 }).toHaveLength(1);
    expect((await noteOf(runB, 'conflict_resolver_started'))[0]).toMatchObject({
      mainHead: head(project.path),
    });
    expect(t.runs.getRun(runB.id).handedOffTo).not.toBeNull();
    expect(followups(runB)).not.toContain('conflicts in');
  });

  it("AC-5.5 a person's close of a run that cannot take a prompt starts the resolver and says so", async () => {
    const { project, b, runB } = await conflictingPair(EDIT_EDIT);
    await endWithoutResume(runB);
    const res = await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: runB.id });
    expect(res.statusCode).toBe(200);
    const body = SyncWorktreeResponse.parse(res.json());
    expect(body).toMatchObject({ ok: false, resolution: 'resolver_started', conflicts: ['app.js'] });
    const [note] = await noteOf(runB, 'conflict_resolver_started');
    expect(runsFor(b.id).map((r) => r.id)).toContain(note?.runId);
  });
});
