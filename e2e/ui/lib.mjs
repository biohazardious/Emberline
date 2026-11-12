/**
 * Helpers of the Playwright regression suite (see e2e/ui/run.mjs): a signed-in API client, the fake forge,
 * and a scenario runner that records a Playwright trace per scenario and fails on page errors.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const BASE = process.argv[2] ?? 'http://127.0.0.1:7498';
export const FORGE = 'http://forge:3000';
export const PASSWORD = 'e2e password long enough';
const FORGE_TOKEN = 'e2e-forge-token';
const OUT = process.env.E2E_OUT ?? '/out';

const require = createRequire(import.meta.url);
/** playwright-core ships with the runner image's @playwright/mcp (global, not in the repo's lockfile). */
const { chromium } = require(
  require.resolve('playwright-core', {
    paths: ['/usr/local/lib/node_modules/@playwright/mcp', '/usr/local/lib/node_modules'],
  }),
);

let cookie = '';
let sessionKey = '';

export async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(method === 'GET' ? {} : { 'x-emberline-csrf': sessionKey || '1' }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
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
  return { status: res.status, headers: res.headers, json, text };
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

/** Waits for core, sets the admin password on a fresh stack (or logs in on one smoke.mjs already set up). */
export async function signInApi() {
  await until(
    async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok,
    'core never became healthy',
  );
  await api('POST', '/api/auth/setup', { password: PASSWORD, setupToken: 'e2e-setup-token' });
  const login = await api('POST', '/api/auth/login', { password: PASSWORD });
  assert.equal(login.status, 200, login.text);
  cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  sessionKey = login.json.sessionKey;
  await until(
    async () => (await api('GET', '/api/system')).json?.ptyd === 'connected',
    'ptyd never connected',
  );
}

/** The forge account every scenario's repositories use; created once. */
export async function ensureForgeAccount() {
  const added = await api('POST', '/api/forge/accounts', {
    provider: 'gitea',
    serverUrl: FORGE,
    token: FORGE_TOKEN,
    allowHttp: true,
  });
  assert.ok(added.status === 201 || added.status === 409, added.text);
}

/** Creates `e2e/<name>` on the fake forge and pushes a first commit holding `files` to its main branch. */
export async function seedForgeRepo(name, files) {
  const auth = { authorization: `token ${FORGE_TOKEN}`, 'content-type': 'application/json' };
  const created = await fetch(`${FORGE}/api/v1/user/repos`, {
    method: 'POST',
    headers: auth,
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
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(dir, file), content);
  git('add', '-A');
  git('commit', '-q', '-m', 'initial commit');
  git('push', '-q', `http://e2e:${FORGE_TOKEN}@forge:3000/e2e/${name}.git`, 'main');
}

/** The text of `file` on a project's main, read through core's file API. */
export async function mainFile(projectId, file) {
  const res = await api('GET', `/api/projects/${projectId}/files/content?path=${encodeURIComponent(file)}`);
  return res.status === 200 ? res.json.content : null;
}

/** Waits until the element's class attribute matches `pattern`. */
export async function hasClass(locator, pattern) {
  await until(
    async () => pattern.test((await locator.getAttribute('class').catch(() => null)) ?? ''),
    `no element with class ${pattern}`,
  );
}

export async function signInPage(page) {
  await page.goto(BASE);
  await page.locator('#login-password').fill(PASSWORD);
  await page.locator('#login-submit').click();
  await page.getByRole('navigation').first().waitFor();
}

const results = [];

/**
 * Runs one scenario in a fresh browser context signed in through the UI. A trace is kept when it
 * fails (E2E_OUT/traces/<name>.zip with a screenshot); a page error or console error fails it too.
 */
export async function scenario(name, fn) {
  const started = Date.now();
  const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const problems = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
      problems.push(`console error: ${message.text()}`);
    }
  });
  let failure = null;
  try {
    await signInPage(page);
    await fn(page);
    assert.deepEqual(problems, [], 'the browser console reported errors');
  } catch (error) {
    failure = error;
    mkdirSync(path.join(OUT, 'traces'), { recursive: true });
    await page
      .screenshot({ path: path.join(OUT, 'traces', `${slug}.png`), fullPage: true })
      .catch(() => undefined);
    await context.tracing.stop({ path: path.join(OUT, 'traces', `${slug}.zip`) }).catch(() => undefined);
  }
  if (!failure) await context.tracing.stop().catch(() => undefined);
  await browser.close();
  const line = `${failure ? 'FAIL' : 'ok  '} ${name} (${Date.now() - started} ms)`;
  results.push(failure ? `${line}: ${failure.message}` : line);
  console.log(results.at(-1));
  if (failure) process.exit(1);
}
