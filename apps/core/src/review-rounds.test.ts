import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ReviewComment, Run, RunReviewState, Ticket } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEvents, runs } from './db/schema.js';
import { conflict } from './errors.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

beforeEach(async () => {
  t = await createTestApp();
  // Agent stand-in: leaks its hook token and stays at its prompt.
  const fake = path.join(t.dir, 'fake-claude.sh');
  writeFileSync(
    fake,
    [
      '#!/bin/sh',
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${t.dir}/.token-$EMBERLINE_RUN_ID"`,
      `mv "${t.dir}/.token-$EMBERLINE_RUN_ID" "${t.dir}/token-$EMBERLINE_RUN_ID"`,
      'sleep 20',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
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

const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: { ...CSRF, cookie } });

async function token(run: Run): Promise<string> {
  const file = path.join(t.dir, `token-${run.id}`);
  await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
  return readFileSync(file, 'utf8');
}

const hook = async (run: Run, event: string, payload: object = {}) =>
  t.app.inject({
    method: 'POST',
    url: '/api/internal/hooks',
    headers: { authorization: `Bearer ${await token(run)}` },
    payload: { runId: run.id, event, receivedAt: new Date().toISOString(), payload },
  });

async function project(name: string): Promise<{ id: string; path: string }> {
  const { project } = (await api('POST', '/api/projects', { name, initGit: false })).json();
  const git = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return project;
}

/** An ad-hoc run at its prompt (`waiting_input`). */
async function adHocRun(): Promise<Run> {
  const p = await project('Rounds');
  const run: Run = (await api('POST', '/api/runs', { projectId: p.id, prompt: 'x' })).json();
  expect((await hook(run, 'SessionStart', { session_id: 's' })).json().state).toBe('waiting_input');
  return run;
}

async function ticketRun(): Promise<{ ticket: Ticket; run: Run }> {
  const p = await project('Ticketed');
  const ticket: Ticket = (await api('POST', `/api/projects/${p.id}/tickets`, { title: 'Add a parser', body: 'Parse it.' })).json();
  const res = await api('POST', `/api/tickets/${ticket.id}/start`, {});
  expect(res.statusCode).toBe(201);
  return res.json();
}

const comment = async (run: Run, body: object): Promise<ReviewComment> => {
  const res = await api('POST', `/api/runs/${run.id}/review/comments`, { filePath: 'src/a.ts', ...body });
  expect(res.statusCode).toBe(201);
  return res.json();
};
const comments = async (run: Run): Promise<ReviewComment[]> =>
  ((await api('GET', `/api/runs/${run.id}/review`)).json() as RunReviewState).comments;
const byBody = async (run: Run) => Object.fromEntries((await comments(run)).map((c) => [c.body, c]));
const requestChanges = (run: Run, body: object = {}) => api('POST', `/api/runs/${run.id}/review/request-changes`, body);

/** Captures prompts instead of typing them into the PTY. */
function capturePrompts(): string[] {
  const sent: string[] = [];
  vi.spyOn(t.runs, 'prompt').mockImplementation(async (id: string, text: string) => {
    sent.push(text);
    return t.runs.getRun(id);
  });
  return sent;
}

describe('review rounds (target same)', () => {
  it('moves sent comments to addressed on the next done and pins them until resolved', async () => {
    const run = await adHocRun();
    const sent = capturePrompts();
    await comment(run, { line: 3, body: 'Null deref', priority: 'blocking' });
    await comment(run, { line: 9, body: 'Rename', priority: 'suggestion', intent: 'change' });

    const first = await requestChanges(run, { note: 'Nearly there' });
    expect(first.statusCode).toBe(200);
    expect(first.json().sent).toBe(2);
    expect(sent[0]).toContain('Blocking — Must be fixed before this can merge:');
    expect(sent[0]).toContain('- `src/a.ts:3` (fix) Null deref');
    // A run without the completion tool gets no ticket_complete hint.
    expect(sent[0]).not.toContain('ticket_complete');
    let all = await byBody(run);
    expect(all['Null deref']).toMatchObject({ status: 'sent', round: 1 });
    expect(all['Null deref']!.sentAt).toBeTruthy();

    // The agent's turn ends: what it was sent waits for the person's verification.
    await hook(run, 'UserPromptSubmit');
    await hook(run, 'Stop');
    all = await byBody(run);
    expect(all['Null deref']!.status).toBe('addressed');
    expect(all['Rename']!.status).toBe('addressed');

    // Next round: the new comment plus the unverified ones, pinned.
    await comment(run, { line: 12, body: 'Add a test' });
    const second = await requestChanges(run);
    expect(second.json().sent).toBe(3);
    expect(sent[1]).toContain(
      'Blocking — Must be fixed before this can merge:\nFrom the previous round — please check this is done:\n- `src/a.ts:3` (fix) Null deref',
    );
    expect(sent[1]).toContain('Important:\n- `src/a.ts:12` (fix) Add a test');
    expect(sent[1]).toContain('Suggestions:\nFrom the previous round — please check this is done:\n- `src/a.ts:9` (change) Rename');
    all = await byBody(run);
    expect(all['Null deref']).toMatchObject({ status: 'sent', round: 2 });
    expect(all['Add a test']).toMatchObject({ status: 'sent', round: 1 });

    await hook(run, 'UserPromptSubmit');
    await hook(run, 'Stop');
    all = await byBody(run);
    // Verify: resolved and verified, never sent again.
    const verified: ReviewComment = (
      await api('PATCH', `/api/runs/${run.id}/review/comments/${all['Null deref']!.id}`, { status: 'resolved' })
    ).json();
    expect(verified.status).toBe('resolved');
    expect(verified.verifiedAt).toBeTruthy();
    // Not done: back to open (kept round), so it goes out as a new comment.
    const notDone: ReviewComment = (
      await api('PATCH', `/api/runs/${run.id}/review/comments/${all['Rename']!.id}`, { status: 'open' })
    ).json();
    expect(notDone).toMatchObject({ status: 'open', round: 2 });

    const third = await requestChanges(run);
    expect(third.json().sent).toBe(2);
    expect(sent[2]).not.toContain('Null deref');
    expect(sent[2]).toContain('Suggestions:\n- `src/a.ts:9` (change) Rename');
    expect(sent[2]).toContain('Important:\nFrom the previous round — please check this is done:\n- `src/a.ts:12` (fix) Add a test');
    all = await byBody(run);
    expect(all['Rename']).toMatchObject({ status: 'sent', round: 3 });
  });

  it('does not move comments to addressed for a done that came before the send', async () => {
    const run = await adHocRun();
    capturePrompts();
    await hook(run, 'UserPromptSubmit');
    await hook(run, 'Stop');
    await comment(run, { line: 1, body: 'Fix it' });
    await requestChanges(run);
    // Another update of the done run (no new turn) must not count as the agent's revision.
    await hook(run, 'Stop');
    expect((await byBody(run))['Fix it']!.status).toBe('sent');
  });

  it('reminds of sent comments the run ended without addressing, and only then', async () => {
    const run = await adHocRun();
    const sent = capturePrompts();
    await comment(run, { line: 1, body: 'First' });
    await requestChanges(run);
    await comment(run, { line: 2, body: 'Second' });
    // Still working on the first: it is not repeated.
    await hook(run, 'UserPromptSubmit');
    await requestChanges(run);
    expect(sent[1]).not.toContain('First');
    expect(sent[1]).toContain('Second');
    // The run fails without addressing them: both come back as reminders.
    t.db.update(runs).set({ state: 'failed', endedAt: new Date() }).where(eq(runs.id, run.id)).run();
    await requestChanges(run, { note: 'Try again' });
    expect(sent[2]).toContain('From the previous round — not yet addressed:\n- `src/a.ts:1` (fix) First\n- `src/a.ts:2` (fix) Second');
    expect((await byBody(run))['First']).toMatchObject({ status: 'sent', round: 2 });
  });

  it('leaves statuses unchanged when the send fails, with a plain 409 for a run without a ticket', async () => {
    const run = await adHocRun();
    vi.spyOn(t.runs, 'prompt').mockRejectedValue(conflict('this run was stopped; start a new run'));
    await comment(run, { line: 1, body: 'Keep me open' });
    const res = await requestChanges(run);
    expect(res.statusCode).toBe(409);
    expect(res.json().canStartNew).toBeUndefined();
    expect((await byBody(run))['Keep me open']).toMatchObject({ status: 'open', round: 0, sentAt: null });
  });
});

describe('review rounds (send target)', () => {
  it('offers a new run when the ticket run cannot take a prompt, and carries the feedback into it', async () => {
    const { ticket, run } = await ticketRun();
    await hook(run, 'SessionStart', { session_id: 's' });
    await comment(run, { line: 4, body: 'Validate input', priority: 'blocking' });
    await comment(run, { line: null, body: 'Split this file' });
    await api('POST', `/api/runs/${run.id}/stop`);
    await expect.poll(() => t.runs.getRun(run.id).endedAt, { timeout: 5_000 }).toBeTruthy();

    const same = await requestChanges(run, { target: 'same' });
    expect(same.statusCode).toBe(409);
    expect(same.json().canStartNew).toBe(true);
    expect((await comments(run)).every((c) => c.status === 'open' && c.round === 0)).toBe(true);

    const res = await requestChanges(run, { note: 'Start over', target: 'new' });
    expect(res.statusCode).toBe(200);
    const { run: fresh, sent } = res.json() as { run: Run; sent: number };
    expect(sent).toBe(2);
    expect(fresh.id).not.toBe(run.id);
    expect(fresh.ticketId).toBe(ticket.id);
    expect(fresh.prompt.startsWith(`${ticket.key}: Add a parser\n\nParse it.\n\n## Review feedback`)).toBe(true);
    expect(fresh.prompt).toContain(`## Review feedback from the previous attempt (run ${run.id.slice(0, 8)})`);
    expect(fresh.prompt).toContain('not in this worktree');
    expect(fresh.prompt).toContain('Overall note: Start over');
    expect(fresh.prompt).toContain('Blocking — Must be fixed before this can merge:\n- `src/a.ts:4` (fix) Validate input');
    expect(fresh.prompt).toContain('- `src/a.ts` (whole file) (fix) Split this file');

    for (const c of await comments(run)) {
      expect(c).toMatchObject({ status: 'resolved', carriedTo: fresh.id });
      expect(c.resolvedAt).toBeTruthy();
    }
    // Nothing left to send on the old run.
    expect((await requestChanges(run, { target: 'new' })).statusCode).toBe(400);
  });

  it('gives a plain 409 when the run is only starting', async () => {
    const { run } = await ticketRun();
    await comment(run, { line: 1, body: 'Wait for it' });
    const res = await requestChanges(run);
    expect(res.statusCode).toBe(409);
    expect(res.json().canStartNew).toBeUndefined();
    expect((await byBody(run))['Wait for it']!.status).toBe('open');
  });

  it('refuses a new run for a run without a ticket', async () => {
    const run = await adHocRun();
    await comment(run, { line: 1, body: 'x' });
    const res = await requestChanges(run, { target: 'new' });
    expect(res.statusCode).toBe(409);
    expect((await byBody(run))['x']!.status).toBe('open');
  });

  it('clips a long feedback section to the run prompt limit instead of failing', async () => {
    const p = await project('Long');
    const ticket: Ticket = (await api('POST', `/api/projects/${p.id}/tickets`, { title: 'Big', body: 'b'.repeat(15_000) })).json();
    const { run } = await t.tickets.start(ticket.id, {}, { extraPromptSection: `## Feedback\n${'f'.repeat(30_000)}` });
    expect(run.prompt.length).toBeLessThanOrEqual(20_000);
    expect(run.prompt).toContain('## Feedback\nfff');
    expect(run.prompt.startsWith(`${ticket.key}: Big\n\n${'b'.repeat(15_000)}\n\n## Feedback`)).toBe(true);
  });
});

/** Records a run event the way core's own bookkeeping does (process exits are not reachable from a hook). */
const record = (runId: string, event: { source: 'system'; type: string; state?: Run['state']; patch?: object }) =>
  (t.runs as unknown as { record(id: string, e: typeof event): Run }).record(runId, event);

describe('review rounds (fix round 1)', () => {
  async function ticketWithBody(body: string, title = 'Big'): Promise<Ticket> {
    const p = await project(`Room ${Math.random().toString(36).slice(2, 7)}`);
    return (await api('POST', `/api/projects/${p.id}/tickets`, { title, body })).json();
  }

  async function idleTicketRun(body = 'Parse it.'): Promise<{ ticket: Ticket; run: Run }> {
    const ticket = await ticketWithBody(body);
    const { run } = (await api('POST', `/api/tickets/${ticket.id}/start`, {})).json() as { run: Run };
    await hook(run, 'SessionStart', { session_id: 's' });
    return { ticket, run };
  }

  it('carries only the comments that fit the room the ticket leaves, blocking first', async () => {
    const { run } = await idleTicketRun('b'.repeat(19_200));
    await comment(run, { line: 1, body: 'Validate input', priority: 'blocking' });
    await comment(run, { line: 2, body: 'i'.repeat(2_000) });
    const res = await requestChanges(run, { target: 'new' });
    expect(res.statusCode).toBe(200);
    const { run: fresh, sent } = res.json() as { run: Run; sent: number };
    expect(sent).toBe(1);
    expect(fresh.prompt.length).toBeLessThanOrEqual(20_000);
    expect(fresh.prompt).toContain('- `src/a.ts:1` (fix) Validate input');
    expect(fresh.prompt).not.toContain('iiii');
    expect(fresh.prompt.endsWith('(1 more comment not included)')).toBe(true);
    const all = await byBody(run);
    expect(all['Validate input']).toMatchObject({ status: 'resolved', carriedTo: fresh.id });
    expect(all['i'.repeat(2_000)]).toMatchObject({ status: 'open', carriedTo: null });
  });

  it('refuses a new run when the ticket text leaves no room for any feedback', async () => {
    const { ticket, run } = await idleTicketRun('b'.repeat(19_900));
    await comment(run, { line: 1, body: 'Validate input' });
    const res = await requestChanges(run, { target: 'new' });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('the ticket text leaves no room for review feedback');
    expect((await byBody(run))['Validate input']!.status).toBe('open');
    // The reviewed run was not stopped for nothing.
    expect(t.runs.getRun(run.id).cancelled).toBe(false);
    expect(t.runs.activeRunForTicket(ticket.id)?.id).toBe(run.id);
  });

  it('stops the idle reviewed run before starting the new one', async () => {
    const { run } = await idleTicketRun();
    await comment(run, { line: 1, body: 'Again' });
    const res = await requestChanges(run, { target: 'new' });
    expect(res.statusCode).toBe(200);
    const fresh = res.json().run as Run;
    expect(fresh.id).not.toBe(run.id);
    expect(t.runs.getRun(run.id).cancelled).toBe(true);
    const stop = t.db.select().from(runEvents).where(eq(runEvents.runId, run.id)).all().find((e) => e.type === 'stop_requested');
    expect(stop).toMatchObject({ source: 'system', payload: { reason: 'review_new_run' } });
  });

  it('refuses a new run while the reviewed run is working, and a failed start changes no status', async () => {
    const { ticket, run } = await idleTicketRun();
    await comment(run, { line: 1, body: 'Later' });
    await hook(run, 'UserPromptSubmit');
    const res = await requestChanges(run, { target: 'new' });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('the run is still working — stop it or wait');
    expect(t.runs.getRun(run.id).cancelled).toBe(false);
    expect((await byBody(run))['Later']).toMatchObject({ status: 'open', round: 0 });

    await hook(run, 'Stop');
    vi.spyOn(t.tickets, 'start').mockRejectedValue(new Error('scheduler down'));
    expect((await requestChanges(run, { target: 'new' })).statusCode).toBe(500);
    expect((await byBody(run))['Later']).toMatchObject({ status: 'open', round: 0, carriedTo: null, resolvedAt: null });
    expect(t.runs.activeRunForTicket(ticket.id)?.id).toBe(run.id);
  });

  it('settles comments sent before a quota handoff on the successor’s done, not on the handoff', async () => {
    const run = await adHocRun();
    capturePrompts();
    await comment(run, { line: 1, body: 'Carry on' });
    await requestChanges(run);
    await hook(run, 'UserPromptSubmit');
    t.db.update(runs).set({ state: 'rate_limited' }).where(eq(runs.id, run.id)).run();
    const successor = await t.runs.handOff(run.id, { agent: 'claude', model: 'opus', credential: 'login' }, {
      reason: 'Individual quota reached',
      source: 'system',
      automatic: true,
    });
    expect(t.runs.getRun(run.id)).toMatchObject({ state: 'done', handedOffTo: successor.id });
    expect((await byBody(run))['Carry on']!.status).toBe('sent');
    await t.scheduler.tick();
    await hook(successor, 'SessionStart', { session_id: 's2' });
    await hook(successor, 'UserPromptSubmit');
    expect((await byBody(run))['Carry on']!.status).toBe('sent');
    await hook(successor, 'Stop');
    expect((await byBody(run))['Carry on']!.status).toBe('addressed');
  });

  it('does not settle a prompt queued mid-turn on that turn’s Stop, only on the next turn', async () => {
    const run = await adHocRun();
    capturePrompts();
    await hook(run, 'UserPromptSubmit');
    await comment(run, { line: 1, body: 'Queued' });
    await requestChanges(run);
    await hook(run, 'Stop');
    expect((await byBody(run))['Queued']!.status).toBe('sent');
    await hook(run, 'UserPromptSubmit');
    await hook(run, 'Stop');
    expect((await byBody(run))['Queued']!.status).toBe('addressed');
  });

  it('does not count a done that came from the process exiting', async () => {
    const run = await adHocRun();
    capturePrompts();
    await comment(run, { line: 1, body: 'Exit' });
    await requestChanges(run);
    await hook(run, 'UserPromptSubmit');
    record(run.id, { source: 'system', type: 'process_exited', state: 'done', patch: { endedAt: new Date(), ptydSessionId: null } });
    expect((await byBody(run))['Exit']!.status).toBe('sent');
  });

  it('does not count a clean CLI exit mid-turn (SessionEnd) as the agent finishing the turn', async () => {
    const run = await adHocRun();
    capturePrompts();
    await comment(run, { line: 1, body: 'Session ended' });
    await requestChanges(run);
    await hook(run, 'UserPromptSubmit');
    await hook(run, 'SessionEnd', { reason: 'exit' });
    expect(t.runs.getRun(run.id).state).toBe('done');
    expect((await byBody(run))['Session ended']!.status).toBe('sent');
  });

  it('refuses a new run while the reviewed run waits for its quota', async () => {
    const { run } = await idleTicketRun();
    await comment(run, { line: 1, body: 'Quota' });
    t.db.update(runs).set({ state: 'rate_limited' }).where(eq(runs.id, run.id)).run();
    const res = await requestChanges(run, { target: 'new' });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('the run is waiting for its quota — stop it or wait');
    expect((await byBody(run))['Quota']!.status).toBe('open');
  });

  it('sends one batch when two requests race, counting the round once', async () => {
    const run = await adHocRun();
    let calls = 0;
    vi.spyOn(t.runs, 'prompt').mockImplementation(async (id: string) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return t.runs.getRun(id);
    });
    await comment(run, { line: 1, body: 'Once' });
    const [a, b] = await Promise.all([requestChanges(run), requestChanges(run)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    expect(calls).toBe(1);
    expect((await byBody(run))['Once']).toMatchObject({ status: 'sent', round: 1 });
  });

  it('does not overwrite a comment resolved while its batch was being sent', async () => {
    const run = await adHocRun();
    let id = '';
    vi.spyOn(t.runs, 'prompt').mockImplementation(async (runId: string) => {
      await api('PATCH', `/api/runs/${runId}/review/comments/${id}`, { status: 'resolved' });
      return t.runs.getRun(runId);
    });
    id = (await comment(run, { line: 1, body: 'Resolved meanwhile' })).id;
    expect((await requestChanges(run)).statusCode).toBe(200);
    expect((await byBody(run))['Resolved meanwhile']).toMatchObject({ status: 'resolved', round: 0 });
  });

  it('refuses a same-run batch over the prompt limit, counting pinned comments', async () => {
    const run = await adHocRun();
    capturePrompts();
    await comment(run, { line: 1, body: 'a'.repeat(9_000) });
    await requestChanges(run);
    await hook(run, 'UserPromptSubmit');
    await hook(run, 'Stop');
    await comment(run, { line: 2, body: 'b'.repeat(9_000) });
    await comment(run, { line: 3, body: 'c'.repeat(9_000) });
    const res = await requestChanges(run);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('too much feedback in one round — resolve or split');
    expect((await comments(run)).map((c) => c.status).sort()).toEqual(['addressed', 'open', 'open']);
  });

  it('reopens only addressed or resolved comments', async () => {
    const run = await adHocRun();
    capturePrompts();
    const open = await comment(run, { line: 1, body: 'o' });
    expect((await api('PATCH', `/api/runs/${run.id}/review/comments/${open.id}`, { status: 'open' })).statusCode).toBe(409);
    await requestChanges(run);
    expect((await api('PATCH', `/api/runs/${run.id}/review/comments/${open.id}`, { status: 'open' })).statusCode).toBe(409);
    await hook(run, 'UserPromptSubmit');
    await hook(run, 'Stop');
    expect((await api('PATCH', `/api/runs/${run.id}/review/comments/${open.id}`, { status: 'open' })).json().status).toBe('open');
  });

  it('clips an extra section without splitting a character', async () => {
    const ticket = await ticketWithBody('b'.repeat(15_001));
    const { run } = await t.tickets.start(ticket.id, {}, { extraPromptSection: `## Feedback\n${'😀'.repeat(10_000)}` });
    expect(run.prompt.length).toBeLessThanOrEqual(20_000);
    expect(run.prompt.endsWith('…')).toBe(true);
    expect(run.prompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
