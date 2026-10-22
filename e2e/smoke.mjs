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

await step('container preview: the engine is off, so the box is not offered and says why', async () => {
  const res = await api('GET', `/api/projects/${project.id}/container-preview`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, {
    available: false,
    reason: 'The Docker engine is turned off (EMBERLINE_DOCKER_ENGINE=0 in .env). Remove that line and restart to turn it on.',
    file: null,
    services: [],
    commandPreview: false, // no stack picked: the wizard's worktree.yml has no preview service
  });
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

await step('repository: a forge account creates the repository and main is pushed', async () => {
  const added = await api('POST', '/api/forge/accounts', { provider: 'gitea', serverUrl: 'http://forge:3000', token: 'e2e-forge-token', allowHttp: true });
  assert.equal(added.status, 201, added.text);
  assert.equal(added.json.username, 'e2e');
  assert.ok(!added.text.includes('e2e-forge-token'), 'the token never comes back');
  const owners = await api('GET', `/api/forge/accounts/${added.json.id}/owners`);
  assert.equal(owners.json.owners[0].id, 'e2e');
  const created = await api('POST', `/api/projects/${project.id}/repository/create`, { accountId: added.json.id, owner: 'e2e', name: 'smoke', private: true });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.json.originUrl, 'http://forge:3000/e2e/smoke.git');
  assert.equal(created.json.mainState, 'unpublished');
  const pushed = await api('POST', `/api/projects/${project.id}/repository/push-main`);
  assert.equal(pushed.status, 200, pushed.text);
  assert.equal(pushed.json.mainState, 'up_to_date');
  const refreshed = await api('POST', `/api/projects/${project.id}/repository/refresh`);
  assert.equal(refreshed.status, 200, refreshed.text);
  assert.equal(refreshed.json.mainState, 'up_to_date');
  assert.ok(!`${created.text}${pushed.text}${refreshed.text}`.includes('e2e-forge-token'), 'the token never comes back');
  const head = await (await fetch('http://forge:3000/_e2e/head/e2e/smoke')).json();
  assert.match(head.main ?? '', /^[0-9a-f]{40}$/);
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

await step('Live Browser keeps one tab per project', async () => {
  const other = await api('POST', '/api/projects', { name: 'E2E Browser B', mode: 'wizard', appType: 'web_saas', description: 'second project', initGit: false, seedStarterTickets: false });
  assert.equal(other.status, 201, other.text);
  const b = other.json.project;
  const viewport = async (id) => {
    for (let i = 0; i < 20; i++) {
      const res = await api('GET', `/api/projects/${id}/browser-viewport`);
      assert.equal(res.status, 200, res.text);
      if (res.json.source === 'cdp_live' && res.json.activeTabId) return res.json;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('the runner browser did not answer');
  };
  const a1 = await viewport(project.id);
  const b1 = await viewport(b.id);
  assert.notEqual(a1.activeTabId, b1.activeTabId);
  const nav = await api('POST', `/api/projects/${b.id}/browser-action`, { action: 'navigate', url: 'http://core:7420/api/health' });
  assert.equal(nav.status, 200, nav.text);
  const a2 = await viewport(project.id);
  assert.equal(a2.activeTabId, a1.activeTabId);
  assert.equal(a2.targetUrl, a1.targetUrl);
  assert.deepEqual(a2.tabs.map((t) => t.id), [a1.activeTabId]);
  const removed = await api('DELETE', `/api/projects/${b.id}`);
  assert.equal(removed.status, 200, removed.text);
  assert.equal((await viewport(project.id)).activeTabId, a1.activeTabId);
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

await step('deep health is green and metrics need the bearer token', async () => {
  const deep = await api('GET', '/api/health/deep');
  assert.equal(deep.status, 200, deep.text);
  assert.equal((await fetch(`${BASE}/metrics`)).status, 401);
  const metrics = await fetch(`${BASE}/metrics`, { headers: { authorization: 'Bearer e2e-metrics-token' } });
  assert.equal(metrics.status, 200);
  const text = await metrics.text();
  assert.match(text, /emberline_runner_connected 1/);
  assert.match(text, /emberline_tickets\{status="backlog"\} 1/);
});

console.log(results.join('\n'));
console.log(`\n${results.length} e2e checks passed against ${BASE}`);
