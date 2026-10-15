#!/usr/bin/env node
/**
 * End-to-end smoke test against a running core + runner stack (see `make e2e`). Dependency-free:
 * Node's fetch and WebSocket only. Usage: node e2e/smoke.mjs http://core:7420
 */
import assert from 'node:assert/strict';

const BASE = process.argv[2] ?? 'http://127.0.0.1:7498';
const PASSWORD = 'e2e password long enough';
let cookie = '';
const results = [];

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(method === 'GET' ? {} : { 'x-emberline-csrf': '1' }),
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

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
    console.log(results.join('\n'));
    process.exit(1);
  }
}

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('core never became healthy');
}

let project;

await step('core is healthy', waitForHealth);

await step('first-run setup needs the setup token, then login works', async () => {
  assert.equal((await api('POST', '/api/auth/setup', { password: PASSWORD })).status, 400);
  assert.equal((await api('POST', '/api/auth/setup', { password: PASSWORD, setupToken: 'e2e-setup-token' })).status, 200);
  const login = await api('POST', '/api/auth/login', { password: PASSWORD });
  assert.equal(login.status, 200);
  cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert.equal((await api('GET', '/%61pi/projects')).status, 200, 'session works through the normalized route');
});

await step('unauthenticated requests are refused (route-based auth)', async () => {
  const saved = cookie;
  cookie = '';
  assert.equal((await api('GET', '/%61pi/projects')).status, 401);
  cookie = saved;
});

await step('core sees an up-to-date runner', async () => {
  for (let i = 0; i < 20; i++) {
    const system = (await api('GET', '/api/system')).json;
    if (system.ptyd === 'connected') {
      assert.equal(system.runnerOutdated, false);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('ptyd never connected');
});

await step('wizard project: git init runs in the runner', async () => {
  const res = await api('POST', '/api/projects', {
    name: 'E2E Smoke',
    mode: 'wizard',
    appType: 'web_saas',
    description: 'end-to-end smoke test',
    initGit: true,
    seedStarterTickets: false,
  });
  assert.equal(res.status, 201, res.text);
  project = res.json.project;
  const checkpoints = (await api('GET', `/api/projects/${project.id}/checkpoints`)).json;
  assert.ok(Array.isArray(checkpoints) && checkpoints.length >= 1, 'initial commit is visible');
});

await step('build gate runs workspace scripts in the runner, not in core', async () => {
  const pkg = {
    name: 'e2e-smoke',
    private: true,
    scripts: {
      // /opt/emberline/ptyd only exists in the runner image.
      build:
        "node -e \"const fs=require('fs');console.log('ran-in-runner='+fs.existsSync('/opt/emberline/ptyd'));fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<h1>e2e demo</h1>')\"",
    },
  };
  const write = await api('PUT', `/api/projects/${project.id}/files/content`, {
    path: 'package.json',
    content: JSON.stringify(pkg, null, 2),
  });
  assert.equal(write.status, 200, write.text);
  const build = await api('POST', `/api/projects/${project.id}/build-demo`, { targetId: 'main' });
  assert.equal(build.status, 200, build.text);
  assert.equal(build.json.ok, true, build.json.output);
  assert.match(build.json.output, /ran-in-runner=true/);
});

await step('demo is served sandboxed through a capability URL', async () => {
  const entry = await api('GET', `/api/projects/${project.id}/demo/main/`);
  assert.equal(entry.status, 302);
  const location = entry.headers.get('location');
  assert.match(location, /^\/api\/demo\/[^/]+\//);
  const saved = cookie;
  cookie = '';
  const page = await api('GET', location);
  cookie = saved;
  assert.equal(page.status, 200);
  assert.match(page.text, /e2e demo/);
  assert.match(page.headers.get('content-security-policy') ?? '', /sandbox/);
});

await step('ticket changes are pushed over /api/events', async () => {
  const wsUrl = `${BASE.replace(/^http/, 'ws')}/api/events`;
  const origin = BASE;
  const ws = new WebSocket(wsUrl, { headers: { cookie, origin } });
  const seen = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ticket event within 5 s')), 5_000);
    ws.addEventListener('message', (message) => {
      const event = JSON.parse(String(message.data));
      if (event.type === 'ticket' && event.ticket.title === 'Pushed by e2e') {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.addEventListener('error', () => reject(new Error('event socket failed')));
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('event socket refused')));
  });
  const created = await api('POST', `/api/projects/${project.id}/tickets`, { title: 'Pushed by e2e', status: 'backlog' });
  assert.equal(created.status, 201, created.text);
  await seen;
  ws.close();
});

console.log(results.join('\n'));
console.log(`\n${results.length} e2e checks passed against ${BASE}`);
