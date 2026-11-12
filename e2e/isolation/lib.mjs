/**
 * Helpers of the isolation suite (e2e/isolation/run.mjs): a signed-in API client, the fake forge,
 * terminals started through core's API (the runner's ptyd, as node: what every agent gets) and a test
 * runner that records every result instead of stopping at the first failure.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const BASE = process.argv[2] ?? 'http://127.0.0.1:7498';
export const FORGE = 'http://forge:3000';
const PASSWORD = 'e2e password long enough';
const FORGE_TOKEN = 'e2e-forge-token';

export const session = { cookie: '', key: '' };

export async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(method === 'GET' ? {} : { 'x-emberline-csrf': session.key || '1' }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(session.cookie ? { cookie: session.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** Polls `fn` until it returns a truthy value; fails with `message` after `ms`. */
export async function until(fn, message, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(message);
}

/** Sets the admin password on a fresh stack (or logs in on one smoke.mjs already set up). */
export async function signIn() {
  await until(
    async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok,
    'core never became healthy',
  );
  await api('POST', '/api/auth/setup', { password: PASSWORD, setupToken: 'e2e-setup-token' });
  const login = await api('POST', '/api/auth/login', { password: PASSWORD });
  assert.equal(login.status, 200, login.text);
  session.cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  session.key = login.json.sessionKey;
  await until(
    async () => (await api('GET', '/api/system')).json?.ptyd === 'connected',
    'ptyd never connected',
  );
}

/** A gitea account on the fake forge and a new repository `e2e/<name>` with one commit on main. */
export async function seedForgeRepo(name) {
  const added = await api('POST', '/api/forge/accounts', {
    provider: 'gitea',
    serverUrl: FORGE,
    token: FORGE_TOKEN,
    allowHttp: true,
  });
  assert.ok(added.status === 201 || added.status === 409, added.text);
  const created = await fetch(`${FORGE}/api/v1/user/repos`, {
    method: 'POST',
    headers: { authorization: `token ${FORGE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(created.status, 201, await created.text());
  const dir = mkdtempSync(path.join(tmpdir(), 'seed-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.email=seed@e2e', '-c', 'user.name=seed', ...args], {
      cwd: dir,
      stdio: 'pipe',
    });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'README.md'), 'isolation\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial commit');
  git('push', '-q', `http://e2e:${FORGE_TOKEN}@forge:3000/e2e/${name}.git`, 'main');
}

export const forge = (route, method = 'GET') =>
  fetch(`${FORGE}/_e2e/${route}`, { method }).then((r) => r.json());

/**
 * A shell terminal started through core's API, attached over its WebSocket. `output` collects what
 * it prints; `exited` settles when the session ends.
 */
export async function openTerminal() {
  const terminal = await api('POST', '/api/terminals', { kind: 'shell' });
  assert.equal(terminal.status, 201, terminal.text);
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/terminals/${terminal.json.id}/ws`, {
    protocols: ['emberline', `emberline.key.${session.key}`],
    headers: { cookie: session.cookie, origin: BASE },
  });
  const state = { output: '' };
  let answered;
  const firstOutput = new Promise((resolve) => (answered = resolve));
  const exited = new Promise((resolve, reject) => {
    ws.addEventListener('message', (message) => {
      const event = JSON.parse(String(message.data));
      if (event.type === 'snapshot' || event.type === 'output') {
        state.output += event.data;
        answered();
      }
      if (event.type === 'exit' || event.type === 'error') resolve();
    });
    ws.addEventListener('error', () => reject(new Error('terminal socket failed')));
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('terminal socket refused')));
  });
  return {
    state,
    exited,
    ready: () => withTimeout(firstOutput, 30_000, 'the terminal never answered'),
    type: (data) => ws.send(JSON.stringify({ type: 'input', data })),
    close: async () => {
      ws.close();
      await api('DELETE', `/api/terminals/${terminal.json.id}`);
    },
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms))),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Runs `command` in a new agent terminal (`exec`, so the session ends with it) and returns what it
 * reported as `E2E:key=value` lines.
 */
export async function agentShell(command) {
  const terminal = await openTerminal();
  try {
    await terminal.ready();
    terminal.type(`exec ${command}\r`);
    await withTimeout(
      terminal.exited,
      120_000,
      `the shell did not finish:\n${terminal.state.output.slice(-2000)}`,
    );
  } finally {
    await terminal.close();
  }
  // Anywhere in a line: the terminal may put escape sequences before the first one.
  const found = {};
  for (const m of terminal.state.output.matchAll(/E2E:(\w+)=([^\r\n]*)/g)) found[m[1]] = m[2];
  if (Object.keys(found).length === 0) {
    throw new Error(`the shell reported nothing:\n${terminal.state.output.slice(-2000)}`);
  }
  return found;
}

const results = [];

/** Runs one named check; a failure is recorded and the suite goes on. */
export async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ ok: true, line: `ok   ${name} (${Date.now() - started} ms)` });
  } catch (error) {
    results.push({ ok: false, line: `FAIL ${name}: ${error.message}` });
  }
  console.log(results.at(-1).line);
}

export const failures = () => results.filter((r) => !r.ok).length;
