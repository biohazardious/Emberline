import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run, RunDetail, Ticket } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

/** Claude stand-in: leaks its hook token, echoes the first line it reads, then exits. */
function writeFakeClaude(dir: string): string {
  const file = path.join(dir, 'fake-claude.sh');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      // Written whole and then renamed: the test reads the file as soon as it exists.
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${dir}/.token-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.token-$EMBERLINE_RUN_ID" "${dir}/token-$EMBERLINE_RUN_ID"`,
      'echo "fake claude ready"',
      'read line',
      `printf %s "$line" > "${dir}/.line-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.line-$EMBERLINE_RUN_ID" "${dir}/line-$EMBERLINE_RUN_ID"`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return file;
}

beforeEach(async () => {
  t = await createTestApp();
  t.config.claudeCommand = writeFakeClaude(t.dir);
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  cookie = await setupAndLogin(t.app);
});

afterEach(async () => {
  await t.close();
  await ptydServer.close();
});

const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: { ...CSRF, cookie } });

const hook = (runId: string, event: string, token: string, payload: object = {}) =>
  t.app.inject({
    method: 'POST',
    url: '/api/internal/hooks',
    headers: { authorization: `Bearer ${token}` },
    payload: { runId, event, receivedAt: new Date().toISOString(), payload },
  });

async function createProject(name = 'Demo Project') {
  const { project } = (await api('POST', '/api/projects', { name, initGit: false })).json();
  const git = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return project as { id: string; path: string };
}

const createTicket = async (projectId: string, body: object): Promise<Ticket> =>
  (await api('POST', `/api/projects/${projectId}/tickets`, body)).json();

const getTicket = async (id: string): Promise<Ticket> => (await api('GET', `/api/tickets/${id}`)).json();

async function waitFile(name: string): Promise<string> {
  const file = path.join(t.dir, name);
  await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
  return readFileSync(file, 'utf8');
}


type Draft = { ref?: string; title: string; persona?: string; dependsOn?: string[] };

/** Runs a PO ticket that writes `drafts` into its worktree and lets its Stop ingest them. */
async function ingestDrafts(projectId: string, drafts: Draft[]): Promise<{ run: Run; tickets: Ticket[] }> {
  await api('PATCH', '/api/factory/settings', { autoPickupReady: false });
  const po = await createTicket(projectId, { title: 'Plan the work', status: 'ready' });
  const { run } = (await api('POST', `/api/tickets/${po.id}/start`, {})).json() as { run: Run };
  mkdirSync(path.join(run.worktreePath, '.emberline'), { recursive: true });
  writeFileSync(
    path.join(run.worktreePath, '.emberline', 'new-tickets.json'),
    JSON.stringify({ autoDispatch: false, tickets: drafts }),
  );
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
  await hook(run.id, 'UserPromptSubmit', token);
  await hook(run.id, 'Stop', token);
  const list = async () =>
    ((await api('GET', `/api/projects/${projectId}/tickets`)).json() as Ticket[]).filter((x) => x.id !== po.id);
  await expect.poll(async () => (await list()).length).toBe(drafts.length);
  // The edges are written right after the tickets: wait for the run note.
  await expect
    .poll(async () => ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.map((e) => e.type))
    .toContain('dependencies_applied');
  return { run, tickets: await list() };
}

const byTitle = (tickets: Ticket[], title: string) => tickets.find((x) => x.title === title) as Ticket;

describe('ticket dependencies', () => {
  it('ingests PO drafts with refs into dependsOn edges and blockedBy', async () => {
    const project = await createProject();
    const { run, tickets } = await ingestDrafts(project.id, [
      { ref: 'brand-assets', title: 'Brand assets', persona: 'ui_ux' },
      { ref: 'android-shell', title: 'Android shell', persona: 'coder' },
      { ref: 'apk-build', title: 'APK build', persona: 'coder', dependsOn: ['brand-assets', 'android-shell'] },
      { ref: 'qa', title: 'QA pass', persona: 'qa', dependsOn: ['apk-build'] },
    ]);
    expect(tickets).toHaveLength(4);
    const [assets, shell, apk, qa] = ['Brand assets', 'Android shell', 'APK build', 'QA pass'].map((x) => byTitle(tickets, x));
    expect([...(apk as Ticket).dependsOn].sort()).toEqual([(assets as Ticket).id, (shell as Ticket).id].sort());
    expect((qa as Ticket).blockedBy.map((b) => b.key)).toEqual([(apk as Ticket).key]);
    expect((assets as Ticket).blockedBy).toEqual([]);
    const detail: RunDetail = (await api('GET', `/api/runs/${run.id}`)).json();
    const applied = detail.events.find((e) => e.type === 'dependencies_applied');
    expect(applied?.payload).toMatchObject({
      edges: expect.arrayContaining([{ ticket: (qa as Ticket).key, dependsOn: (apk as Ticket).key }]),
    });
  });

  it('creates every ticket and drops unknown refs and cycles with notes', async () => {
    const project = await createProject();
    const { run, tickets } = await ingestDrafts(project.id, [
      { ref: 'a', title: 'A', dependsOn: ['b', 'ghost'] },
      { ref: 'b', title: 'B', dependsOn: ['a'] },
    ]);
    const a = byTitle(tickets, 'A');
    const b = byTitle(tickets, 'B');
    expect(a.dependsOn).toEqual([b.id]);
    expect(b.dependsOn).toEqual([]);
    const detail: RunDetail = (await api('GET', `/api/runs/${run.id}`)).json();
    const dropped = detail.events.filter((e) => e.type === 'dependency_dropped').map((e) => e.payload);
    expect(dropped).toEqual(
      expect.arrayContaining([
        { ticket: a.key, ref: 'ghost', reason: 'unknown' },
        { ticket: b.key, ref: 'a', reason: 'cycle' },
      ]),
    );
  });

  it('applies the default tiers when no draft declares dependsOn', async () => {
    const project = await createProject();
    const { tickets } = await ingestDrafts(project.id, [
      { title: 'Build', persona: 'coder' },
      { title: 'Design', persona: 'ui_ux' },
      { title: 'Verify', persona: 'qa' },
    ]);
    const verify = byTitle(tickets, 'Verify');
    expect([...verify.dependsOn].sort()).toEqual([byTitle(tickets, 'Build').id, byTitle(tickets, 'Design').id].sort());
    expect(byTitle(tickets, 'Build').dependsOn).toEqual([]);
    expect(byTitle(tickets, 'Design').dependsOn).toEqual([]);
  });

  it('sets dependencies through PATCH by key or id and reports errors', async () => {
    const project = await createProject();
    const other = await createProject('Other Project');
    const a = await createTicket(project.id, { title: 'A' });
    const b = await createTicket(project.id, { title: 'B' });
    const c = await createTicket(project.id, { title: 'C' });
    const foreign = await createTicket(other.id, { title: 'Foreign' });

    const ok = await api('PATCH', `/api/tickets/${c.id}`, { dependsOn: [a.key.toLowerCase(), b.id] });
    expect(ok.statusCode).toBe(200);
    const patched = ok.json() as Ticket;
    expect([...patched.dependsOn].sort()).toEqual([a.id, b.id].sort());
    expect(patched.blockedBy.map((x) => x.key).sort()).toEqual([a.key, b.key].sort());
    expect((await getTicket(c.id)).blockedBy).toHaveLength(2);

    const unknown = await api('PATCH', `/api/tickets/${c.id}`, { dependsOn: ['NOPE-99'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: 'unknown_dependency' });
    expect((await api('PATCH', `/api/tickets/${c.id}`, { dependsOn: [foreign.id] })).statusCode).toBe(400);
    expect((await api('PATCH', `/api/tickets/${c.id}`, { dependsOn: [foreign.key] })).statusCode).toBe(400);

    const self = await api('PATCH', `/api/tickets/${c.id}`, { dependsOn: [c.key] });
    expect(self.statusCode).toBe(409);
    expect(self.json()).toMatchObject({ error: 'dependency_cycle' });
    // c waits for a and b: a waiting for c closes a cycle.
    expect((await api('PATCH', `/api/tickets/${a.id}`, { dependsOn: [c.id] })).statusCode).toBe(409);
    // A rejected update leaves the stored set alone.
    expect([...(await getTicket(c.id)).dependsOn].sort()).toEqual([a.id, b.id].sort());

    const cleared = (await api('PATCH', `/api/tickets/${c.id}`, { dependsOn: [] })).json() as Ticket;
    expect(cleared.dependsOn).toEqual([]);
    expect(cleared.blockedBy).toEqual([]);
  });

  it('drops a blocker from blockedBy once the dependency is done', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A' });
    const b = await createTicket(project.id, { title: 'B' });
    await api('PATCH', `/api/tickets/${b.id}`, { dependsOn: [a.id] });
    const list = async () => (await api('GET', `/api/projects/${project.id}/tickets`)).json() as Ticket[];
    expect((await list()).find((x) => x.id === b.id)?.blockedBy.map((x) => x.id)).toEqual([a.id]);
    await api('PATCH', `/api/tickets/${a.id}`, { status: 'done' });
    const after = (await list()).find((x) => x.id === b.id) as Ticket;
    expect(after.blockedBy).toEqual([]);
    expect(after.dependsOn).toEqual([a.id]);
    expect((await getTicket(b.id)).blockedBy).toEqual([]);
  });
});
