import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run, RunDetail, SchedulerState } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateFactorySettings } from './factory/settings.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;
let projectId = '';

/** A CLI stand-in: writes its token, args and env, then echoes lines until "exit". */
function writeFake(dir: string, name: string): string {
  const file = path.join(dir, name);
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${dir}/.token-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.token-$EMBERLINE_RUN_ID" "${dir}/token-$EMBERLINE_RUN_ID"`,
      `echo "${name} $*" >> "${dir}/args-$EMBERLINE_RUN_ID"`,
      `echo "key=\${ANTHROPIC_API_KEY:-none}" >> "${dir}/env-$EMBERLINE_RUN_ID"`,
      `echo "credits=\${EMBERLINE_USE_CREDITS:-unset}" >> "${dir}/env-$EMBERLINE_RUN_ID"`,
      'while read line; do',
      `  echo "$line" >> "${dir}/lines-$EMBERLINE_RUN_ID"`,
      '  [ "$line" = "exit" ] && exit 0',
      'done',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return file;
}

beforeEach(async () => {
  t = await createTestApp();
  t.config.claudeCommand = writeFake(t.dir, 'fake-claude');
  process.env.EMBERLINE_ANTIGRAVITY_COMMAND = writeFake(t.dir, 'fake-agy');
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  cookie = await setupAndLogin(t.app);
  projectId = (await api('POST', '/api/projects', { name: 'Quota' })).json().project.id;
  updateFactorySettings(t.db, {
    enabledProviders: ['claude', 'antigravity'],
    personaRoutes: {
      ui_ux: [
        { agent: 'antigravity', model: 'argon', credential: 'login' },
        { agent: 'claude', model: 'opus', credential: 'login' },
      ],
    },
  });
});

afterEach(async () => {
  delete process.env.EMBERLINE_ANTIGRAVITY_COMMAND;
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
async function waitFile(name: string): Promise<string> {
  const file = path.join(t.dir, name);
  await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
  return readFileSync(file, 'utf8');
}
const getRun = async (id: string): Promise<RunDetail> => (await api('GET', `/api/runs/${id}`)).json();
const scheduler = async (): Promise<SchedulerState> => (await api('GET', '/api/scheduler')).json();
async function work(run: Run): Promise<string> {
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'SessionStart', token, { session_id: `sess-${run.id.slice(0, 4)}` });
  await hook(run.id, 'UserPromptSubmit', token);
  return token;
}
async function startTicket(title: string, persona = 'ui_ux'): Promise<{ ticketId: string; run: Run }> {
  const ticket = (await api('POST', `/api/projects/${projectId}/tickets`, { title, status: 'ready', persona })).json();
  const res = await api('POST', `/api/tickets/${ticket.id}/start`, {});
  expect(res.statusCode).toBe(201);
  return { ticketId: ticket.id, run: res.json().run };
}
const AGY_QUOTA = {
  error: 'cli_exit',
  message: 'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 31h43m5s. AGY_ERROR: RESOURCE_EXHAUSTED (code 429)',
};

describe('runs carry their route', () => {
  it('stores the persona chain, the route and starts the route\'s CLI', async () => {
    const { run } = await startTicket('Colour-blind cats');
    expect(run).toMatchObject({ agent: 'antigravity', model: 'argon', credential: 'login', routeIndex: 0 });
    expect(run.routes).toEqual([
      { agent: 'antigravity', model: 'argon', credential: 'login' },
      { agent: 'claude', model: 'opus', credential: 'login' },
    ]);
    expect(run.prompt).not.toContain('[Preferred Agent:');
    expect(await waitFile(`args-${run.id}`)).toContain('fake-agy');
  });

  it('a login route gets no API key even when one is stored; an api_key route does', async () => {
    updateFactorySettings(t.db, {
      anthropicApiKey: 'sk-ant-test',
      personaRoutes: { coder: [{ agent: 'claude', model: 'opus', credential: 'login' }] },
    });
    const { run } = await startTicket('Login only', 'coder');
    expect(await waitFile(`env-${run.id}`)).toContain('key=none');

    updateFactorySettings(t.db, { personaRoutes: { qa: [{ agent: 'claude', model: 'sonnet', credential: 'api_key' }] } });
    const { run: paid } = await startTicket('Paid', 'qa');
    expect(await waitFile(`env-${paid.id}`)).toContain('key=sk-ant-test');
  });

  it('tells the agy seed whether this run may use AI credits', async () => {
    updateFactorySettings(t.db, { personaRoutes: { ui_ux: [{ agent: 'antigravity', model: 'argon', credential: 'credits' }] } });
    const { run } = await startTicket('Credits run');
    expect(run.credential).toBe('credits');
    expect(await waitFile(`env-${run.id}`)).toContain('credits=1');
  });
});

export { api, AGY_QUOTA, getRun, hook, scheduler, startTicket, waitFile, work };
