#!/usr/bin/env node
/**
 * Isolation regression suite, agent side (make e2e, through e2e/isolation.sh): SECURITY.md's "The
 * shared runner" guarantees checked from an agent terminal, which core starts in the runner's ptyd
 * as node, as it starts every agent. Each test is named SR-nn after the claim it guards (the table in
 * docs/TESTING.md); e2e/isolation.sh runs the checks that need another container (SR-14 on).
 *
 * Usage: node e2e/isolation/run.mjs http://core:7420 [--print-session]. With --print-session, the
 * last line is the signed-in cookie (`E2E_SESSION_COOKIE=…`) for e2e/isolation.sh's replays from the
 * other containers.
 */
import assert from 'node:assert/strict';
import {
  agentShell,
  api,
  BASE,
  failures,
  forge,
  openTerminal,
  seedForgeRepo,
  session,
  signIn,
  test,
  until,
} from './lib.mjs';

const printSession = process.argv.includes('--print-session');
const RUN = Date.now().toString(36);
const REPO = `isolation-${RUN}`;

await signIn();
const created = await api('POST', '/api/projects', {
  name: `E2E Isolation ${RUN}`,
  mode: 'wizard',
  appType: 'web_saas',
  description: 'isolation regression suite',
  initGit: true,
  seedStarterTickets: false,
});
assert.equal(created.status, 201, created.text);
const project = created.json.project;
await seedForgeRepo(REPO);
// Core holds an SSH key: SR-09 looks for it (or any other) where agents and ops can read.
const key = await api('POST', '/api/ssh-key');
assert.equal(key.status, 200, key.text);
// The browser daemon runs once a project's Live Browser is asked for (SR-10 looks at it).
await until(
  async () => (await api('GET', `/api/projects/${project.id}/browser-viewport`)).json?.source === 'cdp_live',
  'the browser daemon never answered',
);

// Another session stays open throughout: its pty master lives in ptyd, where a session or command
// started later could inherit it (0.7.0's fix: SR-05, SR-06).
const holder = await openTerminal();
await holder.ready();

// An import clone runs in the ops container meanwhile, held at the forge with a one-time gateway
// address in its command line (SR-08).
await forge('hold', 'POST');
let seen;
let imported;
try {
  imported = await api('POST', '/api/projects', {
    name: `E2E Isolation Import ${RUN}`,
    source: 'import_url',
    repoUrl: `http://forge:3000/e2e/${REPO}.git`,
  });
  assert.equal(imported.status, 201, imported.text);
  await until(async () => (await forge('held')).held > 0, 'the import never fetched from the forge');
  seen = await agentShell('bash /e2e/isolation/agent-facts.sh');
} finally {
  await forge('release', 'POST');
}
const facts = (...keys) => Object.fromEntries(keys.map((k) => [k, seen[k]]));

await test("SR-01 agent sessions run as node, with node's groups and never emberline-core", () => {
  const groups = (seen.groups ?? '').split(' ');
  assert.deepEqual(
    {
      user: seen.user,
      dialout: groups.includes('dialout'),
      core: groups.includes('emberline-core'),
      joinCoreGroup: seen.joinCoreGroup,
      ownCaps: seen.ownCaps,
    },
    {
      user: 'node',
      dialout: true,
      core: false,
      joinCoreGroup: 'refused',
      ownCaps:
        'CapInh:=0000000000000000 CapPrm:=0000000000000000 CapEff:=0000000000000000 CapAmb:=0000000000000000 ',
    },
  );
});

await test('SR-02 ptyd runs as its own user with only setuid, setgid, setpcap, kill and chown', () => {
  assert.ok(Number(seen.ptydCount) >= 1, 'no process of the ptyd user');
  // chown (0), kill (5), setgid (6), setuid (7), setpcap (8): 0x1e1, effective and bounding.
  assert.equal(seen.ptydCaps, 'eff=00000000000001e1 bnd=00000000000001e1 ');
});

await test("SR-03 an agent cannot connect to ptyd's socket (list, attach to, type into or stop sessions)", () => {
  assert.deepEqual(facts('ptydSocket', 'ptydDir'), {
    ptydSocket: 'EACCES',
    ptydDir: 'ptyd:emberline-core 2750',
  });
});

await test('SR-04 an agent cannot stop ptyd or read its environment', () => {
  assert.deepEqual(facts('ptydKill', 'ptydEnviron'), { ptydKill: 'refused ', ptydEnviron: 'refused ' });
});

await test("SR-05 an agent's terminal holds no other session's terminal (0.7.0 inheritance fix)", () => {
  assert.match(seen.ownTerminal ?? '', /^\/dev\/pts\/\d+$/, JSON.stringify(seen));
  assert.deepEqual(facts('stdioTerminals', 'foreignTerminals'), {
    stdioTerminals: '1',
    foreignTerminals: 'none',
  });
});

await test("SR-06 a command core runs in the runner holds no session's terminal (0.7.0 inheritance fix)", async () => {
  const pkg = {
    name: 'e2e-isolation',
    private: true,
    scripts: { build: 'bash /e2e/isolation/command-fds.sh' },
  };
  const write = await api('PUT', `/api/projects/${project.id}/files/content`, {
    path: 'package.json',
    content: JSON.stringify(pkg, null, 2),
  });
  assert.equal(write.status, 200, write.text);
  const build = await api('POST', `/api/projects/${project.id}/build-demo`, { targetId: 'main' });
  assert.equal(build.status, 200, build.text);
  assert.equal(build.json.ok, true, build.json.output);
  assert.match(build.json.output, /command-terminals=none/);
});

await test("SR-07 the ops service's socket volume is not in the runner", () => {
  assert.equal(seen.opsDir, 'absent');
});

await test("SR-08 an agent sees no process, command line or environment of core's or ops'", () => {
  // Pid namespaces: only the runner's own users (docker-init as root, ptyd, browser, the agents).
  const users = (seen.users ?? '').trim().split(' ');
  assert.deepEqual(
    users.filter((u) => !['root', 'ptyd', 'browser', 'node'].includes(u)),
    [],
    seen.users,
  );
  assert.ok(Number(seen.environsRead) > 0, 'the scan read no environment at all');
  assert.equal(seen.secretLeaks, 'none');
});

await test('SR-09 no private SSH key is readable in what the runner mounts', () => {
  assert.deepEqual(facts('sshKeys', 'logDirReadable'), { sshKeys: 'none', logDirReadable: 'refused' });
  assert.ok(!key.text.includes('PRIVATE KEY'), 'the API returned a private key');
});

await test('SR-10 an agent cannot replace or stop the browser daemon', () => {
  assert.deepEqual(
    facts('browserFiles', 'browserScriptDir', 'browserRunning', 'browserCaps', 'browserKill'),
    {
      browserFiles: ' refused refused refused',
      browserScriptDir: 'root:root 755',
      browserRunning: 'yes',
      browserCaps: '0000000000000000 ',
      browserKill: 'refused ',
    },
  );
});

await test('SR-11 the runner makes its service directories afresh and follows no planted link', () => {
  // Over the volumes as 0.6.x left them (e2e/seed-0.6-volumes.sh): only ptyd's and the browser
  // daemon's parts are re-owned, and the agents' files stay node's.
  assert.deepEqual(facts('runDir', 'browserDir', 'eventsDir', 'oldSocket', 'logDir', 'agentFiles'), {
    runDir: 'root:root 755',
    browserDir: 'browser:browser 755',
    eventsDir: 'node:node 755',
    oldSocket: 'absent',
    logDir: 'ptyd:ptyd 700',
    agentFiles: 'node:node node:node node:node node:node node:node ',
  });
});

const probe = async (kind, expected, env = '') =>
  (await agentShell(`env ${env} node /e2e/isolation/probe.mjs ${BASE} ${kind} '${expected}'`)).probe;

await test('SR-12 a session cookie replayed from the runner is refused', async () => {
  assert.equal(
    await probe('cookie', '403 session_from_container', `E2E_COOKIE='${session.cookie}'`),
    '403 session_from_container',
  );
});

await test('SR-13 the git gateway refuses the runner', async () => {
  assert.equal(await probe('gateway', '403'), '403');
});

await holder.close();
const id = imported.json.project.id;
await test('the held import still completes through the gateway from ops', async () => {
  let status;
  await until(
    async () => (status = (await api('GET', `/api/projects/${id}/import-status`)).json).status !== 'cloning',
    'the import never finished',
  );
  assert.equal(status.status, 'ready', JSON.stringify(status));
});
await api('DELETE', `/api/projects/${id}`);

if (printSession) console.log(`E2E_SESSION_COOKIE=${session.cookie}`);
process.exit(failures() === 0 ? 0 : 1);
