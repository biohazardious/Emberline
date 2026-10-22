import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { IssueSyncSettings, type Run, type RunDetail, type Ticket } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localCommandExecutor, setCommandExecutor } from './command-exec.js';
import { writeIssueSync, writeWizardTickets } from './db/project-settings.js';
import { projects, runs, tickets } from './db/schema.js';
import { HOLD_EVENTS } from './runs/hold-events.js';
import { PRUNE_PROTECTED_EVENT_TYPES } from './runs/service.js';
import { CSRF, createTestApp, seedForgeAccount, setupAndLogin, type TestApp } from './test-utils.js';
import {
  DEPENDENCY_BLOCK_MAX,
  DEPENDENCY_SECTION_MAX,
  dependencyContextSection,
  type FinishedDependency,
} from './tickets/dependency-context.js';
import type { TicketService } from './tickets/service.js';

const NUDGE =
  'You stopped without calling `ticket_complete`. If the ticket is finished, call it now with a summary and handoff. If something blocks you, call it with `blockers`. If you need an answer from a person, ask the question plainly and stop.';

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

/** Claude stand-in that stays alive and logs every line typed into it (the start prompt is an argument). */
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
  t = await createTestApp();
  t.config.claudeCommand = writeLivingClaude(t.dir);
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  cookie = await setupAndLogin(t.app);
});

afterEach(async () => {
  // ptyd first: a fake agent still writing into the temp dir makes t.close fail to remove it (ENOTEMPTY).
  await ptydServer.close();
  await t.close();
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

async function waitFile(name: string): Promise<string> {
  const file = path.join(t.dir, name);
  await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
  return readFileSync(file, 'utf8');
}

const wgit = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-C', cwd, ...args], { encoding: 'utf8' });

async function createProject(name = 'Gate Project') {
  const { project } = (await api('POST', '/api/projects', { name, initGit: false })).json();
  wgit(project.path, 'init', '-q', '-b', 'main');
  wgit(project.path, 'commit', '-q', '--allow-empty', '-m', 'init');
  return project as { id: string; path: string };
}

const createTicket = async (projectId: string, body: object): Promise<Ticket> =>
  (await api('POST', `/api/projects/${projectId}/tickets`, body)).json();
const statusOf = async (id: string) => ((await api('GET', `/api/tickets/${id}`)).json() as Ticket).status;
const runsFor = (ticketId: string) => t.runs.list().filter((r) => r.ticketId === ticketId);
const eventTypes = async (run: Run) =>
  ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.map((e) => e.type);
const eventPayload = async (run: Run, type: string) =>
  ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.find((e) => e.type === type)?.payload;
/** A note of the completion gate itself (the tool check-in is not one). */
const isGateNote = (type: string) => type.startsWith('completion_') && type !== 'completion_tool_ready';
const followups = (run: Run) => {
  const file = path.join(t.dir, `followups-${run.id}`);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
};

const complete = async (run: Run, body: { summary: string; handoff?: string; blockers?: string[] }) => {
  const token = await waitFile(`token-${run.id}`);
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/internal/runs/${run.id}/complete`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
  expect(res.statusCode).toBe(200);
};

/** Records every pipeline pass so a test can wait for all of them. */
function trackPipelines(service: TicketService = t.tickets): Promise<void>[] {
  const passes: Promise<void>[] = [];
  const svc = service as unknown as { handleRunCompleted(r: Run, opts?: object): Promise<void> };
  const original = svc.handleRunCompleted.bind(service);
  svc.handleRunCompleted = (r, opts) => {
    const pass = original(r, opts);
    passes.push(pass);
    return pass;
  };
  return passes;
}

/** What `emberline-mcp` does when the agent's CLI starts it: the run's agent has the tool. */
async function checkIn(run: Run): Promise<void> {
  const token = await waitFile(`token-${run.id}`);
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/internal/runs/${run.id}/completion-tool`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
}

/** Starts the agent's session (its `emberline-mcp` checks in unless `tool: false`) and its first turn. */
async function begin(run: Run, { tool = true }: { tool?: boolean } = {}): Promise<string> {
  await waitFile(`ready-${run.id}`);
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
  if (tool) await checkIn(run);
  await hook(run.id, 'UserPromptSubmit', token);
  return token;
}

/** Ends the current turn; `signal` calls ticket_complete first. */
async function stop(run: Run, signal?: { summary: string; handoff?: string; blockers?: string[] }) {
  if (signal) await complete(run, signal);
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'Stop', token);
}

/** A new turn (a person's reply or an automatic prompt reaching the agent), then its stop. */
async function nextTurn(run: Run, signal?: { summary: string; handoff?: string; blockers?: string[] }) {
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'UserPromptSubmit', token);
  await stop(run, signal);
}

/** A factory ticket run with one commit of work in its worktree. */
async function factoryTicket(title = 'A') {
  const project = await createProject();
  const ticket = await createTicket(project.id, { title, status: 'ready' });
  await t.tickets.dispatchNextReadyTicket(project.id);
  const run = runsFor(ticket.id)[0] as Run;
  writeFileSync(path.join(run.worktreePath, `${title}.txt`), `${title}\n`);
  wgit(run.worktreePath, 'add', '-A');
  wgit(run.worktreePath, 'commit', '-q', '-m', title);
  return { project, ticket, run };
}

const settled = async (passes: Promise<void>[], n: number) => {
  await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(n);
  await Promise.all(passes);
};

describe('completion gate', () => {
  it('1. a valid signal without blockers continues: merged and Done', async () => {
    const { project, ticket, run } = await factoryTicket();
    await begin(run);
    await stop(run, { summary: 'did A', handoff: 'A.txt exists' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).toContain('merged_to_main');
    expect(await eventTypes(run)).toContain('completion_accepted');
    expect(await eventTypes(run)).not.toContain('completion_nudged');
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(true);
    // The merge note names the merge commit (the issue write-back quotes it).
    const sha = wgit(project.path, 'rev-parse', '--short', 'HEAD').trim();
    expect(await eventPayload(run, 'merged_to_main')).toMatchObject({ commitSha: sha });
  });

  it('2. a signal with blockers holds the ticket in Review without merging', async () => {
    const { project, ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    await begin(run);
    await stop(run, { summary: 'half', blockers: ['No signing key'] });
    await settled(passes, 1);
    const types = await eventTypes(run);
    expect(types).toContain('completion_blocked');
    expect(types).not.toContain('merged_to_main');
    expect(types).not.toContain('completion_nudged');
    expect(await eventPayload(run, 'completion_blocked')).toEqual({ blockers: ['No signing key'] });
    expect(await statusOf(ticket.id)).toBe('review');
    expect(followups(run)).toEqual([]);
    // Held: a later dispatch does not merge it behind the hold.
    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(passes).toHaveLength(1);
    expect(await statusOf(ticket.id)).toBe('review');
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(false);
  });

  it('3. no signal: one automatic nudge, the ticket waits', async () => {
    const { ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    await begin(run);
    await stop(run);
    await settled(passes, 1);
    await expect.poll(() => followups(run), { timeout: 10_000 }).toEqual([NUDGE]);
    const types = await eventTypes(run);
    expect(types).toContain('completion_nudged');
    expect(types).not.toContain('completion_missing');
    expect(types).not.toContain('merged_to_main');
    expect(await statusOf(ticket.id)).not.toBe('done');
    expect(t.runs.get(run.id).endedAt).toBeNull();
  });

  it('a valid signal after the nudge continues normally', async () => {
    const { ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    await begin(run);
    await stop(run);
    await settled(passes, 1);
    await expect.poll(() => followups(run).length, { timeout: 10_000 }).toBe(1);
    await nextTurn(run, { summary: 'confirmed' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).toContain('merged_to_main');
    expect(followups(run)).toHaveLength(1);
  });

  it('a signal from before the nudge does not count for the next turn', async () => {
    const { ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    await begin(run);
    // Signalled, then the person (or a gate) spoke: the old signal is stale.
    await complete(run, { summary: 'stale' });
    await nextTurn(run);
    await settled(passes, 1);
    expect(await eventTypes(run)).toContain('completion_nudged');
    expect(await statusOf(ticket.id)).not.toBe('done');
  });

  it('4. still no signal after the nudge: held, no second nudge, a later dispatch does not merge', async () => {
    const { project, ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    await begin(run);
    await stop(run);
    await settled(passes, 1);
    await expect.poll(() => followups(run).length, { timeout: 10_000 }).toBe(1);
    await nextTurn(run);
    await settled(passes, 2);
    const types = await eventTypes(run);
    expect(types).toContain('completion_missing');
    expect(types.filter((x) => x === 'completion_nudged')).toHaveLength(1);
    expect(types).not.toContain('merged_to_main');
    expect(await statusOf(ticket.id)).toBe('review');
    expect(followups(run)).toHaveLength(1);

    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(passes).toHaveLength(2);
    expect(await statusOf(ticket.id)).toBe('review');
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(false);

    // A second unsignalled turn (e.g. the agent answered a person without finishing): held again, no nudge.
    await nextTurn(run);
    await settled(passes, 3);
    expect((await eventTypes(run)).filter((x) => x === 'completion_missing')).toHaveLength(2);
    expect((await eventTypes(run)).filter((x) => x === 'completion_nudged')).toHaveLength(1);
    expect(followups(run)).toHaveLength(1);

    // The person's reply leads to a signalled turn: the hold is lifted and the ticket goes through.
    await nextTurn(run, { summary: 'finished after the answer' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(true);
  });

  it('a hold that was later merged does not keep the run a factory run: a follow-up in a quiet project is not piped', async () => {
    const { project, ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    // The pipeline closes a finished CLI (which also makes it final); here it stays open, so a
    // person can still continue the session after the ticket reached Done.
    const runsSvc = t.runs as unknown as { stop(id: string, opts?: { reason?: string }): Promise<Run> };
    const realStop = runsSvc.stop.bind(t.runs);
    runsSvc.stop = async (id, opts) => (opts?.reason === 'factory_step_finished' ? t.runs.get(id) : realStop(id, opts));
    await begin(run);
    await stop(run);
    await settled(passes, 1);
    await expect.poll(() => followups(run).length, { timeout: 10_000 }).toBe(1);
    await nextTurn(run, { summary: 'confirmed' });
    await settled(passes, 2);
    expect(await statusOf(ticket.id)).toBe('done');
    // Quiet project: the chain ended with the empty queue, no ready or [Factory] tickets.
    expect(t.tickets.isAutoChainActive(project.id)).toBe(false);

    // A person continues the Done ticket's session later.
    await t.tickets.prompt(ticket.id, 'one more tweak');
    const before = await eventTypes(run);
    await nextTurn(run);
    await settled(passes, 3);
    const after = await eventTypes(run);
    const count = (types: string[], type: string) => types.filter((x) => x === type).length;
    expect(count(after, 'merged_to_main')).toBe(count(before, 'merged_to_main'));
    expect(count(after, 'completion_missing')).toBe(0);
    expect(count(after, 'completion_nudged')).toBe(1);
    expect(followups(run)).toEqual([NUDGE, 'one more tweak']);
  });

  it('without merge and Done (both off), an accepted signal ends the hold: a later follow-up is not piped or paged', async () => {
    await api('PATCH', '/api/factory/settings', { autoSyncToMain: false, autoMoveToDone: false });
    const { project, ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    // Keep the CLI open after the step, so a person can continue the session.
    const runsSvc = t.runs as unknown as { stop(id: string, opts?: { reason?: string }): Promise<Run> };
    const realStop = runsSvc.stop.bind(t.runs);
    runsSvc.stop = async (id, opts) => (opts?.reason === 'factory_step_finished' ? t.runs.get(id) : realStop(id, opts));
    await begin(run);
    await stop(run);
    await settled(passes, 1);
    await expect.poll(() => followups(run).length, { timeout: 10_000 }).toBe(1);
    await nextTurn(run, { summary: 'confirmed' });
    await settled(passes, 2);
    const accepted = await eventTypes(run);
    expect(accepted).toContain('completion_accepted');
    expect(accepted).not.toContain('merged_to_main');
    expect(await statusOf(ticket.id)).toBe('review');
    expect(t.tickets.isAutoChainActive(project.id)).toBe(false);

    await t.tickets.prompt(ticket.id, 'one more tweak');
    await nextTurn(run);
    await settled(passes, 3);
    const after = await eventTypes(run);
    expect(after).not.toContain('completion_missing');
    expect(after.filter((x) => x === 'completion_nudged')).toHaveLength(1);
    expect(after.filter((x) => x === 'completion_accepted')).toHaveLength(1);
    expect(followups(run)).toEqual([NUDGE, 'one more tweak']);
  });

  it('completion_accepted is no hold, and pruning keeps it', () => {
    expect(HOLD_EVENTS).not.toContain('completion_accepted');
    expect(PRUNE_PROTECTED_EVENT_TYPES).toContain('completion_accepted');
  });

  it('a run that cannot take a prompt any more is held at once instead of nudged', async () => {
    const { ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    await begin(run);
    // Not promptable: the process is gone and its session cannot be resumed.
    const svc = t.tickets as unknown as { runPipeline(r: Run, o: object): Promise<void> };
    const original = svc.runPipeline.bind(t.tickets);
    svc.runPipeline = (r, o) => original({ ...r, endedAt: new Date().toISOString(), resumable: false }, o);
    await stop(run);
    await settled(passes, 1);
    const types = await eventTypes(run);
    expect(types).toContain('completion_missing');
    expect(types).not.toContain('completion_nudged');
    expect(await statusOf(ticket.id)).toBe('review');
  });

  it('a nudge that cannot be delivered holds the ticket for a person', async () => {
    const { project, ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    (t.runs as unknown as { prompt(id: string, text: string): Promise<Run> }).prompt = async () => {
      throw new Error('no live session');
    };
    await begin(run);
    await stop(run);
    await settled(passes, 1);
    const types = await eventTypes(run);
    expect(types).toContain('completion_nudged');
    expect(types).toContain('completion_missing');
    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(passes).toHaveLength(1);
    expect(await statusOf(ticket.id)).toBe('review');
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(false);
  });

  it('while the agent answers the nudge, a dispatch does not finalize the ticket behind it', async () => {
    const { project, ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    await begin(run);
    await stop(run);
    await settled(passes, 1);
    // The nudge was typed but its UserPromptSubmit has not arrived: the run is still `done`, and
    // its ticket may sit in Review (here put back by hand), where a dispatch finalizes leftovers.
    expect(t.runs.get(run.id).state).toBe('done');
    t.db.update(tickets).set({ status: 'review' }).where(eq(tickets.id, ticket.id)).run();
    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(passes).toHaveLength(1);
    expect(await eventTypes(run)).not.toContain('completion_missing');
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(await statusOf(ticket.id)).toBe('review');
  });

  describe('exemptions keep the old behaviour', () => {
    it('setting off: Stop alone advances the ticket', async () => {
      await api('PATCH', '/api/factory/settings', { requireCompletionSignal: false });
      const { ticket, run } = await factoryTicket();
      await begin(run);
      await stop(run);
      await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
      const types = await eventTypes(run);
      expect(types).toContain('merged_to_main');
      expect(types.some(isGateNote)).toBe(false);
      expect(followups(run)).toEqual([]);
    });

    it('the project overriding the setting off (global still on): Stop alone advances the ticket', async () => {
      const { project, ticket, run } = await factoryTicket();
      await api('PATCH', `/api/projects/${project.id}/settings`, { gates: { requireCompletionSignal: false } });
      await begin(run);
      await stop(run);
      await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
      expect((await eventTypes(run)).some(isGateNote)).toBe(false);
    });

    it('a run whose agent never got the tool (no emberline-mcp check-in): Stop alone advances the ticket', async () => {
      const { ticket, run } = await factoryTicket();
      await begin(run, { tool: false });
      await stop(run);
      await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
      const types = await eventTypes(run);
      expect(types).toContain('merged_to_main');
      expect(types.some(isGateNote)).toBe(false);
      expect(followups(run)).toEqual([]);
    });

    it('the same run is gated once its emberline-mcp has checked in', async () => {
      const { ticket, run } = await factoryTicket();
      const passes = trackPipelines();
      await begin(run, { tool: false });
      await checkIn(run);
      await stop(run);
      await settled(passes, 1);
      expect(await eventTypes(run)).toContain('completion_nudged');
      expect(await statusOf(ticket.id)).not.toBe('done');
    });

    it('a secondary CLI run (its exit code is its signal)', async () => {
      const { ticket, run } = await factoryTicket();
      await begin(run);
      t.db.update(runs).set({ agent: 'codex' }).where(eq(runs.id, run.id)).run();
      await stop(run);
      await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
      expect((await eventTypes(run)).some(isGateNote)).toBe(false);
    });

    it('the [Factory] product-owner orchestrator ticket (its tickets file is its signal)', async () => {
      const project = await createProject();
      const po = await createTicket(project.id, { title: '[Factory] Plan it', status: 'ready', persona: 'product_owner' });
      const { run } = (await api('POST', `/api/tickets/${po.id}/start`, { persona: 'product_owner' })).json() as { run: Run };
      mkdirSync(path.join(run.worktreePath, '.emberline'), { recursive: true });
      writeFileSync(
        path.join(run.worktreePath, '.emberline', 'new-tickets.json'),
        JSON.stringify({ autoDispatch: false, tickets: [{ title: 'Child' }] }),
      );
      await begin(run);
      await stop(run);
      await expect.poll(() => statusOf(po.id), { timeout: 10_000 }).toBe('done');
      expect((await eventTypes(run)).some(isGateNote)).toBe(false);
    });

    it('a run without a ticket', async () => {
      const project = await createProject();
      t.tickets.setAutoChain(project.id, true);
      const passes = trackPipelines();
      const run = (await api('POST', '/api/runs', { projectId: project.id, prompt: 'look around' })).json() as Run;
      await begin(run);
      await stop(run);
      await settled(passes, 1);
      expect((await eventTypes(run)).some(isGateNote)).toBe(false);
      expect(followups(run)).toEqual([]);
    });

    it('a brainstorm run', async () => {
      const project = await createProject();
      await createTicket(project.id, { title: '[Factory] Plan it', status: 'done' });
      const passes = trackPipelines();
      const run = await t.tickets.startBrainstormRun(project.id, { prompt: 'ideas' });
      await begin(run);
      await stop(run);
      await settled(passes, 1);
      expect((await eventTypes(run)).some(isGateNote)).toBe(false);
      expect(followups(run)).toEqual([]);
    });
  });
});

describe('gate re-prompts and the completion tool', () => {
  const AGAIN = 'When finished, call `ticket_complete` again.';
  async function sloppyTicket() {
    const made = await factoryTicket();
    writeFileSync(path.join(made.run.worktreePath, 'slop.ts'), 'export const x: any = 1;\n// @ts-ignore\nexport const y = x.z;\n');
    wgit(made.run.worktreePath, 'add', '-A');
    wgit(made.run.worktreePath, 'commit', '-q', '-m', 'slop');
    return made;
  }

  it('a Claude run is asked to call ticket_complete again after the clean-up', async () => {
    const { run } = await sloppyTicket();
    const passes = trackPipelines();
    await begin(run);
    await stop(run, { summary: 'did A' });
    await settled(passes, 1);
    expect(await eventTypes(run)).toContain('slop_guard_blocked');
    await expect.poll(() => followups(run).join('\n'), { timeout: 10_000 }).toContain(AGAIN);
  });

  it('a codex run (no such tool) gets the clean-up request without the tool', async () => {
    const { run } = await sloppyTicket();
    const passes = trackPipelines();
    await begin(run);
    t.db.update(runs).set({ agent: 'codex' }).where(eq(runs.id, run.id)).run();
    await stop(run);
    await settled(passes, 1);
    expect(await eventTypes(run)).toContain('slop_guard_blocked');
    await expect.poll(() => followups(run).length, { timeout: 10_000 }).toBeGreaterThan(0);
    // The whole request has arrived once the follow-up file stops growing.
    let last = -1;
    await expect
      .poll(
        () => {
          const now = followups(run).length;
          const stable = now === last;
          last = now;
          return stable;
        },
        { timeout: 10_000, interval: 300 },
      )
      .toBe(true);
    expect(followups(run).join('\n')).not.toContain('ticket_complete');
  });
});

describe('dependency context in the dependent prompt', () => {
  const setCompletion = (id: string, summary: string, handoff: string, at: string) =>
    t.db
      .update(tickets)
      .set({ completion: { runId: 'r', summary, handoff, blockers: [], at } })
      .where(eq(tickets.id, id))
      .run();

  it('lists the finished direct dependencies, oldest first; not transitive ones', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'Schema', status: 'done' });
    const b = await createTicket(project.id, { title: 'API', status: 'done' });
    const c = await createTicket(project.id, { title: 'Auth', status: 'done' });
    const d = await createTicket(project.id, { title: 'Screen', status: 'backlog', body: 'Build the screen.' });
    await api('PATCH', `/api/tickets/${b.id}`, { dependsOn: [a.id] });
    await api('PATCH', `/api/tickets/${d.id}`, { dependsOn: [b.id, c.id] });
    setCompletion(a.id, 'made the schema', 'tables: users', '2026-10-17T10:00:00.000Z');
    setCompletion(b.id, 'added /api/users', 'GET /api/users returns a list', '2026-10-17T12:00:00.000Z');
    setCompletion(c.id, 'login works', '', '2026-10-17T11:00:00.000Z');

    const { run } = (await api('POST', `/api/tickets/${d.id}/start`, {})).json() as { run: Run };
    await waitFile(`token-${run.id}`);
    const prompt = t.runs.get(run.id).prompt;
    expect(prompt).toBe(
      [
        `${d.key}: Screen`,
        '',
        'Build the screen.',
        '',
        '## Context from finished dependencies',
        '',
        `### ${c.key}: Auth`,
        'Summary: login works',
        '',
        `### ${b.key}: API`,
        'Summary: added /api/users',
        'Handoff: GET /api/users returns a list',
      ].join('\n'),
    );
    expect(prompt).not.toContain('made the schema');
  });

  it('passes a dependency\'s blockers on to the dependent prompt', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'Schema', status: 'done' });
    const d = await createTicket(project.id, { title: 'Screen', status: 'backlog' });
    await api('PATCH', `/api/tickets/${d.id}`, { dependsOn: [a.id] });
    t.db
      .update(tickets)
      .set({ completion: { runId: 'r', summary: 'partial', handoff: '', blockers: ['no API key', 'pick a DB'], at: '2026-10-17T10:00:00.000Z' } })
      .where(eq(tickets.id, a.id))
      .run();
    const { run } = (await api('POST', `/api/tickets/${d.id}/start`, {})).json() as { run: Run };
    await waitFile(`token-${run.id}`);
    expect(t.runs.get(run.id).prompt).toContain(`### ${a.key}: Schema\nSummary: partial\nBlockers: no API key; pick a DB`);
  });

  it('adds nothing when no dependency has a completion', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'Schema', status: 'done' });
    const d = await createTicket(project.id, { title: 'Screen', status: 'backlog' });
    await api('PATCH', `/api/tickets/${d.id}`, { dependsOn: [a.id] });
    const { run } = (await api('POST', `/api/tickets/${d.id}/start`, {})).json() as { run: Run };
    await waitFile(`token-${run.id}`);
    expect(t.runs.get(run.id).prompt).toBe(`${d.key}: Screen`);
  });

  it('keeps the whole prompt within the run prompt limit', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'Schema', status: 'done' });
    const d = await createTicket(project.id, { title: 'Screen', status: 'backlog', body: 'x'.repeat(15_000) });
    await api('PATCH', `/api/tickets/${d.id}`, { dependsOn: [a.id] });
    setCompletion(a.id, 's'.repeat(4000), 'h'.repeat(8000), '2026-10-17T10:00:00.000Z');
    const res = await api('POST', `/api/tickets/${d.id}/start`, {});
    expect(res.statusCode).toBeLessThan(300);
    const { run } = res.json() as { run: Run };
    await waitFile(`token-${run.id}`);
    const prompt = t.runs.get(run.id).prompt;
    expect(prompt.length).toBeLessThanOrEqual(20_000);
    expect(prompt).toContain('## Context from finished dependencies');
  });
});

describe('the ticket completion and a new run', () => {
  it('a fresh run of the ticket clears its old completion and broadcasts the ticket', async () => {
    const project = await createProject();
    const ticket = await createTicket(project.id, { title: 'Again', status: 'review' });
    t.db
      .update(tickets)
      .set({ completion: { runId: 'old', summary: 'old work', handoff: '', blockers: ['stuck'], at: '2026-10-17T10:00:00.000Z' } })
      .where(eq(tickets.id, ticket.id))
      .run();
    const seen: Ticket[] = [];
    t.tickets.on('ticket', (x) => seen.push(x));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { run } = (await api('POST', `/api/tickets/${ticket.id}/start`, {})).json() as { run: Run };
    await waitFile(`token-${run.id}`);
    const got = (await api('GET', `/api/tickets/${ticket.id}`)).json() as Ticket;
    expect(got.completion).toBeNull();
    expect(Date.parse(got.updatedAt)).toBeGreaterThan(Date.parse(ticket.updatedAt));
    const pushed = seen.filter((x) => x.id === ticket.id).at(-1);
    expect(pushed?.completion).toBeNull();
  });

  it('a follow-up in the same run keeps the completion', async () => {
    const { ticket, run } = await factoryTicket();
    await begin(run);
    await complete(run, { summary: 'kept' });
    await t.tickets.prompt(ticket.id, 'one more thing');
    expect(((await api('GET', `/api/tickets/${ticket.id}`)).json() as Ticket).completion).toMatchObject({ summary: 'kept' });
  });
});

describe('dependencyContextSection', () => {
  const dep = (key: string, at: string, summary: string, handoff = ''): FinishedDependency => ({
    key,
    title: `Title ${key}`,
    completion: { summary, handoff, at },
  });

  it('is empty without dependencies', () => {
    expect(dependencyContextSection([])).toBe('');
  });

  it('orders oldest first and omits an empty handoff', () => {
    const section = dependencyContextSection([
      dep('B', '2026-10-17T12:00:00.000Z', 'b sum', 'b hand'),
      dep('A', '2026-10-17T10:00:00.000Z', 'a sum'),
    ]);
    expect(section).toBe(
      '## Context from finished dependencies\n\n### A: Title A\nSummary: a sum\n\n### B: Title B\nSummary: b sum\nHandoff: b hand',
    );
  });

  it('adds the blockers of a dependency as one line under its block', () => {
    const blocked: FinishedDependency = {
      key: 'A',
      title: 'Title A',
      completion: { summary: 'half', handoff: 'see a.ts', blockers: ['no signing key', ' needs a decision '], at: '2026-10-17T10:00:00.000Z' },
    };
    const clean: FinishedDependency = {
      key: 'B',
      title: 'Title B',
      completion: { summary: 'b sum', handoff: '', blockers: [], at: '2026-10-17T11:00:00.000Z' },
    };
    expect(dependencyContextSection([blocked, clean])).toBe(
      '## Context from finished dependencies\n\n### A: Title A\nSummary: half\nHandoff: see a.ts\nBlockers: no signing key; needs a decision\n\n### B: Title B\nSummary: b sum',
    );
  });

  it('keeps a dependency with long blockers within its cap', () => {
    const section = dependencyContextSection([
      {
        key: 'A',
        title: 'Title A',
        completion: { summary: 's', handoff: 'h', blockers: Array.from({ length: 10 }, () => 'b'.repeat(500)), at: '2026-10-17T10:00:00.000Z' },
      },
    ]);
    const block = section.split('\n\n').slice(1).join('\n\n');
    expect(block.length).toBe(DEPENDENCY_BLOCK_MAX);
    expect(block).toContain('\nBlockers: bbb');
    expect(block.endsWith('…')).toBe(true);
  });

  it('caps each dependency at 3000 chars with an ellipsis', () => {
    const section = dependencyContextSection([dep('A', '2026-10-17T10:00:00.000Z', 's'.repeat(4000), 'h'.repeat(8000))]);
    const block = section.split('\n\n').slice(1).join('\n\n');
    expect(block.length).toBe(DEPENDENCY_BLOCK_MAX);
    expect(block.startsWith('### A: Title A\nSummary: sss')).toBe(true);
    expect(block.endsWith('…')).toBe(true);
  });

  it('caps the section at 10000 chars, shortening the oldest dependencies first', () => {
    const deps = ['A', 'B', 'C', 'D', 'E'].map((key, i) =>
      dep(key, `2026-10-17T1${i}:00:00.000Z`, key.toLowerCase().repeat(4000)),
    );
    const section = dependencyContextSection(deps);
    expect(section.length).toBeLessThanOrEqual(DEPENDENCY_SECTION_MAX);
    const blocks = section.split('\n\n').slice(1);
    // Every dependency still has its heading.
    expect(blocks.map((b) => b.split('\n')[0])).toEqual(['A', 'B', 'C', 'D', 'E'].map((k) => `### ${k}: Title ${k}`));
    // The newest ones are whole (at the per-dependency cap), the oldest ones were shortened.
    expect(blocks[4]?.length).toBe(DEPENDENCY_BLOCK_MAX);
    expect(blocks[3]?.length).toBe(DEPENDENCY_BLOCK_MAX);
    expect((blocks[0]?.length ?? 0) < (blocks[4]?.length ?? 0)).toBe(true);
    expect(blocks[0]?.endsWith('…')).toBe(true);
  });

  it('honours a smaller budget and returns nothing when not even the heading fits', () => {
    const deps = [dep('A', '2026-10-17T10:00:00.000Z', 'a'.repeat(2000))];
    const small = dependencyContextSection(deps, 500);
    expect(small.length).toBe(500);
    expect(small.startsWith('## Context from finished dependencies\n\n### A: Title A\nSummary: aaa')).toBe(true);
    expect(small.endsWith('…')).toBe(true);
    expect(dependencyContextSection(deps, 20)).toBe('');
  });
});

describe('issue write-back in the pipeline', () => {
  /** A factory ticket linked to issue #5 of acme/widget, with label sync settings. */
  async function linkedFactoryTicket(settings: Partial<IssueSyncSettings>) {
    const made = await factoryTicket();
    t.db.update(projects).set({ repoUrl: 'https://github.com/acme/widget.git' }).where(eq(projects.id, made.project.id)).run();
    t.db
      .update(tickets)
      .set({ externalSource: 'github', externalId: '9005', externalNumber: 5, externalUrl: 'https://github.com/acme/widget/issues/5', externalState: 'open', externalLabels: [] })
      .where(eq(tickets.id, made.ticket.id))
      .run();
    writeIssueSync(t.db, made.project.id, IssueSyncSettings.parse({ closeOnDone: true, ...settings }));
    seedForgeAccount(t.db, { provider: 'github', serverUrl: 'https://github.com', token: 'secret' });
    return made;
  }

  it('a merged, Done ticket comments the merge and closes its issue', async () => {
    const seen: { method: string; path: string; body: unknown }[] = [];
    t.forgeFetch.current = async (url, init) => {
      seen.push({ method: init?.method ?? 'GET', path: new URL(url).pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { project, ticket, run } = await linkedFactoryTicket({});
    await begin(run);
    await stop(run, { summary: 'did A' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    await t.issueSync.settled();
    await expect.poll(() => seen.length, { timeout: 5_000 }).toBe(3);
    const sha = wgit(project.path, 'rev-parse', '--short', 'HEAD').trim();
    expect(seen).toEqual(
      expect.arrayContaining([
        {
          method: 'POST',
          path: '/repos/acme/widget/issues/5/comments',
          body: { body: `Emberline merged ${ticket.key} into \`main\` locally (${sha}). It reaches the remote when the branch is pushed.` },
        },
        { method: 'PATCH', path: '/repos/acme/widget/issues/5', body: { state: 'closed' } },
      ]),
    );
    expect(await eventTypes(run)).toEqual(expect.arrayContaining(['issue_commented', 'issue_closed']));
  });

  it('a failing forge is noted and the pipeline still finishes', async () => {
    t.forgeFetch.current = async () => {
      throw new TypeError('fetch failed');
    };
    const { project, ticket, run } = await linkedFactoryTicket({});
    await begin(run);
    await stop(run, { summary: 'did A' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    await t.issueSync.settled();
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(true);
    await expect.poll(() => eventTypes(run), { timeout: 5_000 }).toEqual(expect.arrayContaining(['issue_comment_failed', 'issue_close_failed']));
  });
});

describe('issue triage', () => {
  it('auto-pickup never starts an untrusted label-sync import; once a person moves it to Ready it dispatches', async () => {
    const project = await createProject('Triage Project');
    t.db.update(projects).set({ repoUrl: 'https://github.com/acme/widget.git' }).where(eq(projects.id, project.id)).run();
    seedForgeAccount(t.db, { provider: 'github', serverUrl: 'https://github.com', token: 'secret' });
    const issue = {
      id: 9001,
      number: 1,
      title: 'Run me',
      body: 'please',
      state: 'open',
      labels: [{ name: 'emberline' }],
      html_url: 'https://github.com/acme/widget/issues/1',
      user: { login: 'mallory' },
      updated_at: '2026-10-18T10:00:00Z',
    };
    t.forgeFetch.current = async (url) =>
      new Response(JSON.stringify(new URL(url).pathname === '/repos/acme/widget/issues' ? [issue] : {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    writeIssueSync(
      t.db,
      project.id,
      IssueSyncSettings.parse({ enabled: true, label: 'emberline', status: 'ready', trustedAuthors: ['octo'], repo: { provider: 'github', repoPath: 'acme/widget' } }),
    );
    await api('PATCH', '/api/factory/settings', { autoPickupBacklog: true });
    expect((await api('POST', `/api/projects/${project.id}/issue-sync/run`)).json().lastError).toBeNull();
    const [ticket] = t.tickets.list(project.id);
    expect(ticket).toMatchObject({ status: 'backlog', external: { number: 1, triage: true } });

    // "Run pipeline", a chaining dispatch and a restart's resumeChains all pass it by.
    const run = (await api('POST', `/api/projects/${project.id}/run-pipeline`)).json() as { dispatched: unknown[] };
    expect(run.dispatched).toEqual([]);
    t.tickets.setAutoChain(project.id, true);
    expect(await t.tickets.dispatchNextReadyTicket(project.id)).toEqual([]);
    t.tickets.setAutoChain(project.id, true);
    await t.tickets.resumeChains();
    expect(runsFor(ticket!.id)).toEqual([]);
    expect(await statusOf(ticket!.id)).toBe('backlog');

    // A person moves it to Ready: that is the triage.
    const moved = (await api('PATCH', `/api/tickets/${ticket!.id}`, { status: 'ready' })).json() as Ticket;
    expect(moved.external).toMatchObject({ triage: false });
    const again = (await api('POST', `/api/projects/${project.id}/run-pipeline`)).json() as { dispatched: { ticket: Ticket }[] };
    expect(again.dispatched.map((d) => d.ticket.id)).toEqual([ticket!.id]);
    expect(runsFor(ticket!.id)).toHaveLength(1);
  });
});

describe('a person’s merge from the Board', () => {
  it('drag to Done (sync-worktree, then the move) comments the merge and closes the issue', async () => {
    const seen: { method: string; path: string; body: unknown }[] = [];
    t.forgeFetch.current = async (url, init) => {
      seen.push({ method: init?.method ?? 'GET', path: new URL(url).pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const project = await createProject('Person Merge');
    t.db.update(projects).set({ repoUrl: 'https://github.com/acme/widget.git' }).where(eq(projects.id, project.id)).run();
    seedForgeAccount(t.db, { provider: 'github', serverUrl: 'https://github.com', token: 'secret' });
    writeIssueSync(t.db, project.id, IssueSyncSettings.parse({ closeOnDone: true }));
    const ticket = await createTicket(project.id, { title: 'Hand work', status: 'backlog' });
    t.db
      .update(tickets)
      .set({ externalSource: 'github', externalId: '9005', externalNumber: 5, externalUrl: 'https://github.com/acme/widget/issues/5', externalState: 'open', externalLabels: [], externalTriage: true })
      .where(eq(tickets.id, ticket.id))
      .run();
    // A person starts it by hand: that is its triage too.
    const started = (await api('POST', `/api/tickets/${ticket.id}/start`, { permissionMode: 'auto' })).json() as { ticket: Ticket; run: Run };
    expect(started.ticket.external).toMatchObject({ triage: false });
    const run = started.run;
    await waitFile(`ready-${run.id}`);
    writeFileSync(path.join(run.worktreePath, 'hand.txt'), 'hand\n');
    wgit(run.worktreePath, 'add', '-A');
    wgit(run.worktreePath, 'commit', '-q', '-m', 'hand');

    const merged = await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: run.id });
    expect(merged.json()).toMatchObject({ ok: true });
    const sha = wgit(project.path, 'rev-parse', '--short', 'HEAD').trim();
    expect(await eventPayload(run, 'merged_by_person')).toEqual({ commitSha: sha });
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect((await api('PATCH', `/api/tickets/${ticket.id}`, { status: 'done' })).statusCode).toBe(200);
    await expect.poll(() => seen.filter((c) => c.method !== 'GET').length, { timeout: 5_000 }).toBe(3);
    await t.issueSync.settled();
    // The merge comment and the close run side by side: any order.
    expect(seen.filter((c) => c.method !== 'GET')).toEqual(
      expect.arrayContaining([
        {
          method: 'POST',
          path: '/repos/acme/widget/issues/5/comments',
          body: { body: `Emberline merged ${ticket.key} into \`main\` locally (${sha}). It reaches the remote when the branch is pushed.` },
        },
        { method: 'PATCH', path: '/repos/acme/widget/issues/5', body: { state: 'closed' } },
        { method: 'POST', path: '/repos/acme/widget/issues/5/comments', body: { body: `Emberline closed this issue because ${ticket.key} is done.` } },
      ]),
    );

    // Someone reopens the issue and main moves on; the person drags the ticket back and to Done
    // again. Nothing new is merged: no second note, no comment, and the reopened issue stays open.
    const personNotes = async () => (await eventTypes(run)).filter((type) => type === 'merged_by_person').length;
    t.tickets.syncIssueLinks(project.id, 'github', [{ externalId: '9005', state: 'open', labels: [] }]);
    writeFileSync(path.join(project.path, 'later.txt'), 'later\n');
    wgit(project.path, 'add', '-A');
    wgit(project.path, 'commit', '-q', '-m', 'later');
    await api('PATCH', `/api/tickets/${ticket.id}`, { status: 'review' });
    const again = await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: run.id });
    expect(again.json()).toMatchObject({ ok: true, alreadyMerged: true });
    await api('PATCH', `/api/tickets/${ticket.id}`, { status: 'done' });
    await t.issueSync.settled();
    expect(await personNotes()).toBe(1);
    expect(seen.filter((c) => c.method !== 'GET')).toHaveLength(3);
  });

  it('a merge that fails notes nothing', async () => {
    const project = await createProject('No Ticket Merge');
    const ticket = await createTicket(project.id, { title: 'Conflict', status: 'backlog' });
    const { run } = (await api('POST', `/api/tickets/${ticket.id}/start`, { permissionMode: 'auto' })).json() as { run: Run };
    await waitFile(`ready-${run.id}`);
    writeFileSync(path.join(run.worktreePath, 'c.txt'), 'run\n');
    wgit(run.worktreePath, 'add', '-A');
    wgit(run.worktreePath, 'commit', '-q', '-m', 'run side');
    writeFileSync(path.join(project.path, 'c.txt'), 'main\n');
    wgit(project.path, 'add', '-A');
    wgit(project.path, 'commit', '-q', '-m', 'main side');
    expect((await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: run.id })).json()).toMatchObject({ ok: false });
    expect(await eventTypes(run)).not.toContain('merged_by_person');
  });
});

describe('a run that changed nothing', () => {
  /** A factory ticket run whose agent writes nothing. */
  async function emptyFactoryTicket(title = 'E') {
    const project = await createProject();
    const ticket = await createTicket(project.id, { title, status: 'ready' });
    await t.tickets.dispatchNextReadyTicket(project.id);
    return { project, ticket, run: runsFor(ticket.id)[0] as Run };
  }
  const asCodex = (run: Run) => t.db.update(runs).set({ agent: 'codex' }).where(eq(runs.id, run.id)).run();
  const runDetail = async (run: Run) => (await api('GET', `/api/runs/${run.id}`)).json() as RunDetail;

  it('a secondary CLI run without commits or a completion is held (no_changes), not merged or Done', async () => {
    const { project, ticket, run } = await emptyFactoryTicket();
    const passes = trackPipelines();
    const mainBefore = wgit(project.path, 'rev-parse', 'HEAD').trim();
    await begin(run);
    asCodex(run);
    await stop(run);
    await settled(passes, 1);
    const types = await eventTypes(run);
    expect(types).toContain('no_changes');
    expect(types).not.toContain('merged_to_main');
    expect(await eventPayload(run, 'no_changes')).toEqual({ autoFix: false });
    expect(await statusOf(ticket.id)).toBe('review');
    expect(wgit(project.path, 'rev-parse', 'HEAD').trim()).toBe(mainBefore);
    expect((await runDetail(run)).attention).toMatchObject({ reason: 'held', detail: 'Finished without changes' });
    // The session is closed like other holds' (kept resumable), and a later dispatch leaves it held.
    await expect.poll(async () => (await runDetail(run)).endedAt, { timeout: 5_000 }).not.toBeNull();
    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(passes).toHaveLength(1);
    expect(await statusOf(ticket.id)).toBe('review');
  });

  it('a Claude run without the completion gate and without changes is held too', async () => {
    await api('PATCH', '/api/factory/settings', { requireCompletionSignal: false });
    const { ticket, run } = await emptyFactoryTicket();
    const passes = trackPipelines();
    await begin(run);
    await stop(run);
    await settled(passes, 1);
    expect(await eventTypes(run)).toContain('no_changes');
    expect(await statusOf(ticket.id)).toBe('review');
  });

  it('a completion summary explains an empty run: Done', async () => {
    const { ticket, run } = await emptyFactoryTicket();
    await begin(run);
    await stop(run, { summary: 'Nothing to change: the page already has the link.' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).not.toContain('no_changes');
  });

  it('uncommitted output counts as a change: merged and Done', async () => {
    const { project, ticket, run } = await emptyFactoryTicket();
    writeFileSync(path.join(run.worktreePath, 'loose.txt'), 'loose\n');
    await begin(run);
    asCodex(run);
    await stop(run);
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).toContain('merged_to_main');
    expect(existsSync(path.join(project.path, 'loose.txt'))).toBe(true);
  });

  it('own commits a person already merged before the pipeline ran still reach Done', async () => {
    const { project, ticket, run } = await factoryTicket();
    await begin(run);
    expect((await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: run.id })).json()).toMatchObject({ ok: true });
    asCodex(run);
    await stop(run);
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).not.toContain('no_changes');
  });

  it('a run whose tickets file created tickets is not held (it produced board work)', async () => {
    const { project, ticket, run } = await emptyFactoryTicket();
    mkdirSync(path.join(run.worktreePath, '.emberline'), { recursive: true });
    writeFileSync(
      path.join(run.worktreePath, '.emberline', 'new-tickets.json'),
      JSON.stringify({ autoDispatch: false, tickets: [{ title: 'Follow-up' }] }),
    );
    await begin(run);
    asCodex(run);
    await stop(run);
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).not.toContain('no_changes');
    const titles = ((await api('GET', `/api/projects/${project.id}/tickets`)).json() as Ticket[]).map((x) => x.title);
    expect(titles).toContain('Follow-up');
  });

  it('a later pass of a run whose tickets file created tickets earlier is not held either', async () => {
    const { project, ticket, run } = await emptyFactoryTicket();
    mkdirSync(path.join(run.worktreePath, '.emberline'), { recursive: true });
    writeFileSync(
      path.join(run.worktreePath, '.emberline', 'new-tickets.json'),
      JSON.stringify({ autoDispatch: false, tickets: [{ title: 'Follow-up' }] }),
    );
    // Something else stops the first pass before the merge: an invalid worktree.yml the agent is asked to fix.
    writeFileSync(path.join(run.worktreePath, '.emberline', 'worktree.yml'), 'version: 1\nchecks:\n  container: npm run test:container\n');
    const passes = trackPipelines();
    await begin(run);
    asCodex(run);
    await stop(run);
    await settled(passes, 1);
    expect(await eventTypes(run)).toContain('build_gate_failed');
    const titles = ((await api('GET', `/api/projects/${project.id}/tickets`)).json() as Ticket[]).map((x) => x.title);
    expect(titles).toContain('Follow-up');

    // The agent removes its change: the next pass finds no tickets file and no change, only the tickets made before.
    rmSync(path.join(run.worktreePath, '.emberline', 'worktree.yml'));
    await nextTurn(run);
    await settled(passes, 2);
    expect(await eventTypes(run)).not.toContain('no_changes');
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
  });

  /** The run's own commit, fast-forwarded into main by hand: its tip is now on main's first-parent line. */
  const fastForwarded = async () => {
    const made = await factoryTicket();
    wgit(made.project.path, 'merge', '-q', '--ff-only', made.run.branch!);
    return made;
  };

  it('own commits fast-forwarded into main with a recorded merge reach Done', async () => {
    const { ticket, run } = await fastForwarded();
    t.runs.note(run.id, 'merged_by_person', {});
    await begin(run);
    asCodex(run);
    await stop(run);
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).not.toContain('no_changes');
  });

  it('the same fast-forward without a recorded merge is held: the merge note is what passes it', async () => {
    const { ticket, run } = await fastForwarded();
    const passes = trackPipelines();
    await begin(run);
    asCodex(run);
    await stop(run);
    await settled(passes, 1);
    expect(await eventTypes(run)).toContain('no_changes');
    expect(await statusOf(ticket.id)).toBe('review');
  });

  /** A run the current one took over from (handoff), on `branch`, whose merge into main was recorded. */
  const mergedPredecessor = (run: Run, branch: string | null) => {
    const row = t.db.select().from(runs).where(eq(runs.id, run.id)).get()!;
    const id = `pred-${run.id}`;
    t.db.insert(runs).values({ ...row, id, branch, ptydSessionId: null, hookTokenHash: `pred-${row.hookTokenHash}`, handedOffTo: run.id }).run();
    t.db.update(runs).set({ predecessorRunId: id }).where(eq(runs.id, run.id)).run();
    t.runs.note(id, 'merged_to_main', { summary: 'merged' });
  };

  it('a predecessor on the same branch already merged it: Done', async () => {
    const { ticket, run } = await fastForwarded();
    mergedPredecessor(run, run.branch);
    await begin(run);
    asCodex(run);
    await stop(run);
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).not.toContain('no_changes');
  });

  it("a predecessor's merge of another branch does not count", async () => {
    const { ticket, run } = await fastForwarded();
    mergedPredecessor(run, 'emberline/other');
    const passes = trackPipelines();
    await begin(run);
    asCodex(run);
    await stop(run);
    await settled(passes, 1);
    expect(await eventTypes(run)).toContain('no_changes');
    expect(await statusOf(ticket.id)).toBe('review');
  });

  it('the [Factory] orchestrator ticket (only a tickets file) is not held', async () => {
    const project = await createProject();
    const po = await createTicket(project.id, { title: '[Factory] Plan it', status: 'ready', persona: 'product_owner' });
    const { run } = (await api('POST', `/api/tickets/${po.id}/start`, { persona: 'product_owner' })).json() as { run: Run };
    mkdirSync(path.join(run.worktreePath, '.emberline'), { recursive: true });
    writeFileSync(
      path.join(run.worktreePath, '.emberline', 'new-tickets.json'),
      JSON.stringify({ autoDispatch: false, tickets: [{ title: 'Child' }] }),
    );
    await begin(run);
    asCodex(run);
    await stop(run);
    await expect.poll(() => statusOf(po.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).not.toContain('no_changes');
  });
});

describe('the worktree config check before the merge', () => {
  const YML = '.emberline/worktree.yml';
  const INVALID = 'version: 1\nchecks:\n  container: npm run test:container\n';
  const VALID = 'version: 1\nchecks:\n  test: npm test\n';
  const MESSAGE = 'checks: Unrecognized key: "container" (allowed: build, lint, test)';
  const HEADER = '[Worktree config check]';
  const AGAIN = 'When finished, call `ticket_complete` again.';

  /** A factory ticket run on a project whose main commits `mainYml` (if given) before the run branches. */
  async function ymlTicket(mainYml?: string) {
    const project = await createProject();
    if (mainYml !== undefined) {
      mkdirSync(path.join(project.path, '.emberline'), { recursive: true });
      writeFileSync(path.join(project.path, YML), mainYml);
      wgit(project.path, 'add', YML);
      wgit(project.path, 'commit', '-q', '-m', 'worktree.yml');
    }
    const ticket = await createTicket(project.id, { title: 'Y', status: 'ready' });
    await t.tickets.dispatchNextReadyTicket(project.id);
    return { project, ticket, run: runsFor(ticket.id)[0] as Run };
  }

  /** The agent writes the run's worktree.yml (and commits it unless `commit: false`). */
  const writeRunYml = (run: Run, text: string, { commit = true } = {}) => {
    mkdirSync(path.join(run.worktreePath, '.emberline'), { recursive: true });
    writeFileSync(path.join(run.worktreePath, YML), text);
    if (!commit) return;
    wgit(run.worktreePath, 'add', YML);
    wgit(run.worktreePath, 'commit', '-q', '-m', 'worktree.yml');
  };
  const checkPrompts = (run: Run) => followups(run).filter((line) => line.includes(HEADER)).length;
  const mainHas = (project: { path: string }, rel: string) => existsSync(path.join(project.path, rel));

  it('a run adding an unknown key is held with the message and asked to fix it; its fix then merges', async () => {
    const { project, ticket, run } = await ymlTicket();
    writeRunYml(run, INVALID);
    const passes = trackPipelines();
    await begin(run);
    await stop(run, { summary: 'added a container check' });
    await settled(passes, 1);
    const types = await eventTypes(run);
    expect(types).toContain('build_gate_failed');
    expect(types).not.toContain('merged_to_main');
    const note = (await eventPayload(run, 'build_gate_failed')) as { autoFix: boolean; output: string };
    expect(note.autoFix).toBe(true);
    expect(note.output).toContain(MESSAGE);
    // Not merged and not Done; the typed request puts the agent (and its ticket) back to work.
    expect(await statusOf(ticket.id)).not.toBe('done');
    expect(mainHas(project, YML)).toBe(false);
    await expect.poll(() => checkPrompts(run), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => followups(run).join('\n'), { timeout: 10_000 }).toContain(MESSAGE);
    await expect.poll(() => followups(run).join('\n'), { timeout: 10_000 }).toContain(AGAIN);
    expect(followups(run).join('\n')).toContain('Fix it (or remove your change)');

    // The agent fixes the file: the next stop passes the check and merges it.
    writeRunYml(run, VALID);
    await nextTurn(run, { summary: 'fixed the file' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).toContain('merged_to_main');
    expect(readFileSync(path.join(project.path, YML), 'utf8')).toBe(VALID);
  });

  it('an uncommitted invalid file is checked too (the merge would commit it)', async () => {
    const { project, ticket, run } = await ymlTicket();
    writeRunYml(run, INVALID, { commit: false });
    const passes = trackPipelines();
    await begin(run);
    await stop(run, { summary: 'added a container check' });
    await settled(passes, 1);
    expect(await eventTypes(run)).toContain('build_gate_failed');
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(await statusOf(ticket.id)).not.toBe('done');
    expect(mainHas(project, YML)).toBe(false);
  });

  it('a worktree.yml the run turned into a symbolic link is refused, never followed', async () => {
    const { project, ticket, run } = await ymlTicket();
    writeFileSync(path.join(run.worktreePath, 'elsewhere.yml'), VALID);
    mkdirSync(path.join(run.worktreePath, '.emberline'), { recursive: true });
    symlinkSync('../elsewhere.yml', path.join(run.worktreePath, YML));
    wgit(run.worktreePath, 'add', '-A');
    wgit(run.worktreePath, 'commit', '-q', '-m', 'link');
    const passes = trackPipelines();
    await begin(run);
    await stop(run, { summary: 'linked the file' });
    await settled(passes, 1);
    expect(((await eventPayload(run, 'build_gate_failed')) as { output: string }).output).toContain('.emberline/worktree.yml is a symbolic link');
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(await statusOf(ticket.id)).not.toBe('done');
    expect(mainHas(project, YML)).toBe(false);
  });

  it('a valid change passes and merges', async () => {
    const { project, ticket, run } = await ymlTicket();
    writeRunYml(run, VALID);
    await begin(run);
    await stop(run, { summary: 'added a test check' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).not.toContain('build_gate_failed');
    expect(readFileSync(path.join(project.path, YML), 'utf8')).toBe(VALID);
  });

  it('an invalid file already on main does not block a run that leaves it alone (Review Focus 4)', async () => {
    const { project, ticket, run } = await ymlTicket(INVALID);
    writeFileSync(path.join(run.worktreePath, 'A.txt'), 'A\n');
    wgit(run.worktreePath, 'add', '-A');
    wgit(run.worktreePath, 'commit', '-q', '-m', 'A');
    await begin(run);
    await stop(run, { summary: 'did A' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).not.toContain('build_gate_failed');
    expect(mainHas(project, 'A.txt')).toBe(true);
  });

  it('a file the run inherited unchanged passes after main fixed it meanwhile (the merge keeps main\'s)', async () => {
    const { project, ticket, run } = await ymlTicket(INVALID);
    writeFileSync(path.join(project.path, YML), VALID);
    wgit(project.path, 'commit', '-q', '-am', 'fix worktree.yml on main');
    writeFileSync(path.join(run.worktreePath, 'A.txt'), 'A\n');
    wgit(run.worktreePath, 'add', '-A');
    wgit(run.worktreePath, 'commit', '-q', '-m', 'A');
    await begin(run);
    await stop(run, { summary: 'did A' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).not.toContain('build_gate_failed');
    expect(readFileSync(path.join(project.path, YML), 'utf8')).toBe(VALID);
    expect(mainHas(project, 'A.txt')).toBe(true);
  });

  it('a run that changes an inherited invalid file into another invalid one is held', async () => {
    const { project, ticket, run } = await ymlTicket(INVALID);
    writeRunYml(run, 'version: 1\nchecks:\n  e2e: npm run e2e\n');
    const passes = trackPipelines();
    await begin(run);
    await stop(run, { summary: 'added an e2e check' });
    await settled(passes, 1);
    expect(((await eventPayload(run, 'build_gate_failed')) as { output: string }).output).toContain(
      'checks: Unrecognized key: "e2e" (allowed: build, lint, test)',
    );
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(await statusOf(ticket.id)).not.toBe('done');
    expect(readFileSync(path.join(project.path, YML), 'utf8')).toBe(INVALID);
  });

  it("main's file that git cannot read is a gate error for a person, not a silent stop", async () => {
    const { project, ticket, run } = await ymlTicket(VALID);
    writeRunYml(run, INVALID, { commit: false });
    // ls-tree lists main's blob, then reading it fails (e.g. the repository changed in between).
    const oid = wgit(project.path, 'rev-parse', `HEAD:${YML}`).trim();
    setCommandExecutor(async (request) =>
      request.args.includes('cat-file') && request.args.includes(oid)
        ? { exitCode: 128, signal: null, stdout: '', stderr: `fatal: git cat-file ${oid}: bad file`, timedOut: false, truncated: false }
        : localCommandExecutor(request),
    );
    try {
      const passes = trackPipelines();
      await begin(run);
      await stop(run, { summary: 'changed the file' });
      await settled(passes, 1);
    } finally {
      setCommandExecutor(localCommandExecutor);
    }
    const types = await eventTypes(run);
    expect(types).toContain('build_gate_error');
    expect(types).not.toContain('build_gate_failed');
    expect(types).not.toContain('merged_to_main');
    expect(((await eventPayload(run, 'build_gate_error')) as { message: string }).message).toContain(
      '.emberline/worktree.yml could not be checked',
    );
    expect(await statusOf(ticket.id)).not.toBe('done');
  });

  it("a valid file of the run's own is not checked against main's: git failing to read main's does not hold it", async () => {
    const { ticket, run } = await ymlTicket(VALID);
    writeRunYml(run, 'version: 1\nchecks:\n  build: npm run build\n');
    const oid = wgit(run.worktreePath, 'rev-parse', `main:${YML}`).trim();
    setCommandExecutor(async (request) =>
      request.args.includes('cat-file') && request.args.includes(oid)
        ? { exitCode: 128, signal: null, stdout: '', stderr: `fatal: git cat-file ${oid}: bad file`, timedOut: false, truncated: false }
        : localCommandExecutor(request),
    );
    try {
      const passes = trackPipelines();
      await begin(run);
      await stop(run, { summary: 'added a build check' });
      await settled(passes, 1);
    } finally {
      setCommandExecutor(localCommandExecutor);
    }
    const types = await eventTypes(run);
    expect(types).not.toContain('build_gate_error');
    expect(types).not.toContain('build_gate_failed');
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
  });

  it('a run that deletes the file passes (Review Focus 5)', async () => {
    const { project, ticket, run } = await ymlTicket(INVALID);
    wgit(run.worktreePath, 'rm', '-q', YML);
    wgit(run.worktreePath, 'commit', '-q', '-m', 'remove worktree.yml');
    await begin(run);
    await stop(run, { summary: 'removed the broken file' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).not.toContain('build_gate_failed');
    expect(mainHas(project, YML)).toBe(false);
  });

  it('with the self-healing gate off the invalid file still holds, for a person (autoFix: false)', async () => {
    await api('PATCH', '/api/factory/settings', { selfHealingBuildGate: false });
    const { project, ticket, run } = await ymlTicket();
    writeRunYml(run, INVALID);
    const passes = trackPipelines();
    await begin(run);
    await stop(run, { summary: 'added a container check' });
    await settled(passes, 1);
    const note = (await eventPayload(run, 'build_gate_failed')) as { autoFix: boolean; output: string };
    expect(note).toMatchObject({ autoFix: false });
    expect(note.output).toContain(MESSAGE);
    expect(checkPrompts(run)).toBe(0);
    expect(await statusOf(ticket.id)).toBe('review');
    // Closed like other holds for a person (kept resumable); a later dispatch does not merge it.
    await expect.poll(async () => t.runs.get(run.id).endedAt, { timeout: 5_000 }).not.toBeNull();
    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(mainHas(project, YML)).toBe(false);
  });

  it('a run that cannot take a prompt any more is held for a person', async () => {
    const { ticket, run } = await ymlTicket();
    writeRunYml(run, INVALID);
    const passes = trackPipelines();
    const svc = t.tickets as unknown as { runPipeline(r: Run, o: object): Promise<void> };
    const original = svc.runPipeline.bind(t.tickets);
    svc.runPipeline = (r, o) => original({ ...r, endedAt: new Date().toISOString(), resumable: false }, o);
    await begin(run);
    await stop(run, { summary: 'added a container check' });
    await settled(passes, 1);
    expect(await eventPayload(run, 'build_gate_failed')).toMatchObject({ autoFix: false });
    expect(checkPrompts(run)).toBe(0);
    expect(await statusOf(ticket.id)).toBe('review');
  });

  it('an agent that stops again with the file still invalid is not asked twice: held for a person', async () => {
    const { project, ticket, run } = await ymlTicket();
    writeRunYml(run, INVALID);
    const passes = trackPipelines();
    await begin(run);
    await stop(run, { summary: 'added a container check' });
    await settled(passes, 1);
    await expect.poll(() => checkPrompts(run), { timeout: 10_000 }).toBe(1);
    await nextTurn(run, { summary: 'still my way' });
    await settled(passes, 2);
    const notes = (await api('GET', `/api/runs/${run.id}`)).json() as RunDetail;
    const gateNotes = notes.events.filter((e) => e.type === 'build_gate_failed').map((e) => (e.payload as { autoFix: boolean }).autoFix);
    expect(gateNotes).toEqual([true, false]);
    expect(checkPrompts(run)).toBe(1);
    expect(await statusOf(ticket.id)).toBe('review');
    expect(mainHas(project, YML)).toBe(false);
  });
});

describe('an Auto Bootstrap writes the worktree commands', () => {
  const HEADER = '[Worktree commands]';
  const YML = '.emberline/worktree.yml';
  const PROMPT =
    'This ticket asks you to write the setup, build, lint and test commands and the preview service for the chosen stack into `.emberline/worktree.yml`, and the file still has none. Add them, make them pass, then commit before finishing.';
  const promptCount = (run: Run) => followups(run).filter((line) => line.includes(HEADER)).length;
  async function bootstrapRun(writes = true) {
    const project = await createProject();
    const ticket = await createTicket(project.id, { title: 'Bootstrap', status: 'ready', persona: 'architect' });
    writeWizardTickets(t.db, project.id, { bootstrap: ticket.id, bootstrapWritesWorktree: writes });
    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = runsFor(ticket.id)[0] as Run;
    writeFileSync(path.join(run.worktreePath, 'index.html'), '<h1>x</h1>\n');
    wgit(run.worktreePath, 'add', '-A');
    wgit(run.worktreePath, 'commit', '-q', '-m', 'skeleton');
    return { project, ticket, run };
  }
  const writeYml = (run: Run, text: string) => {
    mkdirSync(path.join(run.worktreePath, '.emberline'), { recursive: true });
    writeFileSync(path.join(run.worktreePath, YML), text);
  };

  it('without commands: held, asked once with the exact prompt; with them the next stop merges', async () => {
    const { ticket, run } = await bootstrapRun();
    const passes = trackPipelines();
    await begin(run);
    await stop(run, { summary: 'skeleton' });
    await settled(passes, 1);
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(await eventPayload(run, 'build_gate_failed')).toMatchObject({ autoFix: true });
    await expect.poll(() => followups(run).join('\n'), { timeout: 10_000 }).toContain(`${HEADER} ${PROMPT}`);
    writeYml(run, 'version: 1\nchecks:\n  test: "true"\n');
    await nextTurn(run, { summary: 'commands' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
  });

  it('still none after the prompt: held for a person (autoFix false), session closed, no second prompt', async () => {
    const { ticket, run } = await bootstrapRun();
    const passes = trackPipelines();
    await begin(run);
    await stop(run, { summary: 'skeleton' });
    await settled(passes, 1);
    await expect.poll(() => promptCount(run), { timeout: 10_000 }).toBe(1);
    await nextTurn(run, { summary: 'did nothing' });
    await expect
      .poll(
        async () =>
          ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.filter((e) => e.type === 'build_gate_failed').map((e) => (e.payload as { autoFix: boolean }).autoFix),
        { timeout: 10_000 },
      )
      .toEqual([true, false]);
    expect(promptCount(run)).toBe(1);
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(await statusOf(ticket.id)).not.toBe('done');
    await expect.poll(async () => t.runs.get(run.id).endedAt, { timeout: 5_000 }).not.toBeNull();
  });

  it('selfHealingBuildGate off: held at once with autoFix false', async () => {
    await api('PATCH', '/api/factory/settings', { selfHealingBuildGate: false });
    const { ticket, run } = await bootstrapRun();
    const passes = trackPipelines();
    await begin(run);
    await stop(run, { summary: 'skeleton' });
    await settled(passes, 1);
    expect(await eventPayload(run, 'build_gate_failed')).toMatchObject({ autoFix: false });
    expect(promptCount(run)).toBe(0);
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(await statusOf(ticket.id)).not.toBe('done');
  });

  it('an empty `version: 1` file counts as none', async () => {
    const { run } = await bootstrapRun();
    writeYml(run, 'version: 1\n');
    wgit(run.worktreePath, 'add', '-A');
    wgit(run.worktreePath, 'commit', '-q', '-m', 'empty config');
    const passes = trackPipelines();
    await begin(run);
    await stop(run, { summary: 'skeleton' });
    await settled(passes, 1);
    expect(await eventPayload(run, 'build_gate_failed')).toMatchObject({ autoFix: true });
    expect(await eventTypes(run)).not.toContain('merged_to_main');
  });

  it('a decided preset (bootstrapWritesWorktree false) is not checked', async () => {
    const { ticket, run } = await bootstrapRun(false);
    writeYml(run, 'version: 1\n');
    wgit(run.worktreePath, 'add', '-A');
    wgit(run.worktreePath, 'commit', '-q', '-m', 'empty config');
    await begin(run);
    await stop(run, { summary: 'skeleton' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).not.toContain('build_gate_failed');
  });

  it('another ticket of the project is not checked', async () => {
    const { project } = await bootstrapRun();
    const other = await createTicket(project.id, { title: 'Other', status: 'ready', persona: 'architect' });
    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = runsFor(other.id)[0] as Run;
    writeFileSync(path.join(run.worktreePath, 'other.txt'), 'x\n');
    wgit(run.worktreePath, 'add', '-A');
    wgit(run.worktreePath, 'commit', '-q', '-m', 'other');
    await begin(run);
    await stop(run, { summary: 'other' });
    await expect.poll(() => statusOf(other.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).not.toContain('build_gate_failed');
  });
});
