/**
 * The browser daemon's script and the agents' Playwright hook, as the runner image carries them. The
 * build writes both to `dist/browser/` (scripts/emit-browser-files.mjs) and the runner image copies
 * them to /opt/emberline/browser, root's: no agent can replace them, and core writes neither.
 * Kept apart from browser-daemon.ts so that the build can load it without the rest of core.
 */
import path from 'node:path';
import { PLAYTEST_HELD_MESSAGE } from '@emberline/protocol';

export const BROWSER_DAEMON_VERSION = '1.6.0';

/** Where the runner image keeps the daemon's script and the hook (root's, 0644). */
export const RUNNER_BROWSER_FILES_DIR = '/opt/emberline/browser';
export const BROWSER_DAEMON_SCRIPT_PATH = `${RUNNER_BROWSER_FILES_DIR}/browser-daemon.mjs`;
export const PLAYWRIGHT_HOOK_PATH = `${RUNNER_BROWSER_FILES_DIR}/playwright-hook.cjs`;
/**
 * The dev stack's (compose.dev.yaml): the checkout is /workspace in core and in the dev ptyd alike,
 * and the image's files are not there. Core writes them from its own sources.
 */
export const DEV_BROWSER_FILES_DIR = '/workspace/apps/core/dist/browser';
/**
 * The browser daemon's socket and state (`browser`'s directory, made afresh by the runner's
 * entrypoint; core sees the same path through the ptyd-socket volume).
 */
export const RUNNER_BROWSER_DIR = '/run/emberline/browser';
/**
 * Where the agents' Playwright hook reports a Chromium it started (`node`'s directory: agents write
 * it, so the daemon reads it as untrusted input).
 */
export const AGENT_BROWSER_EVENTS_FILE = '/run/emberline/agent-events/agent-browser-events.jsonl';

/** Where the daemon's script and the agents' hook are, and as whom ptyd starts the daemon. */
export interface BrowserFiles {
  script: string;
  hook: string;
  /** Null: as ptyd's own user (the dev stack's ptyd runs as node and has no other user). */
  runAs: 'browser' | null;
  /**
   * Set in the dev stack: core writes the script and the hook here from its own sources, and makes
   * the daemon's and the agents' directories, which no runner entrypoint made.
   */
  dev: { dir: string; dirs: string[] } | null;
}

/** The runner image's (root's files, the daemon as `browser`). */
export const IMAGE_BROWSER_FILES: BrowserFiles = {
  script: BROWSER_DAEMON_SCRIPT_PATH,
  hook: PLAYWRIGHT_HOOK_PATH,
  runAs: 'browser',
  dev: null,
};

/** The dev stack's: files in the checkout, written by core, and the daemon as node. */
export function devBrowserFiles(
  dir = DEV_BROWSER_FILES_DIR,
  dirs = [RUNNER_BROWSER_DIR, path.posix.dirname(AGENT_BROWSER_EVENTS_FILE)],
): BrowserFiles {
  return {
    script: path.posix.join(dir, 'browser-daemon.mjs'),
    hook: path.posix.join(dir, 'playwright-hook.cjs'),
    runAs: null,
    dev: { dir, dirs },
  };
}

/**
 * The image's files, except in the dev stack (EMBERLINE_ALLOW_UNSECURED_RUNNER=1), whose ptyd runs from
 * source without the runner image.
 */
export function browserFilesFor(config: { requireSecuredRunner: boolean }): BrowserFiles {
  return config.requireSecuredRunner ? IMAGE_BROWSER_FILES : devBrowserFiles();
}

/**
 * Preload hook (`NODE_OPTIONS="--require /opt/emberline/browser/playwright-hook.cjs"`) injected into
 * agent processes so any custom Playwright script (`chromium.launch()`) or `npx playwright test`
 * executed via `Bash` automatically exposes `--remote-debugging-port=9223` for live streaming.
 * It runs as the agent and reports to {@link AGENT_BROWSER_EVENTS_FILE}.
 */
export const PLAYWRIGHT_HOOK_SCRIPT = `'use strict';
try {
  const cp = require('node:child_process');
  const fs = require('node:fs');
  const origSpawn = cp.spawn;
  cp.spawn = function patchedSpawn(file, args, options) {
    try {
      if (
        typeof file === 'string' &&
        /(?:^|\\/|\\\\)(?:chrome|chromium|chromium-browser|headless_shell|google-chrome)$/i.test(file) &&
        Array.isArray(args) &&
        !args.some((a) => String(a).startsWith('--remote-debugging-port='))
      ) {
        args = [...args, '--remote-debugging-port=9223'];
        try {
          fs.appendFileSync(
            ${JSON.stringify(AGENT_BROWSER_EVENTS_FILE)},
            JSON.stringify({
              ts: new Date().toISOString(),
              toolName: 'playwright_launch',
              summary: 'Agent spawned headless Chromium via Playwright (streaming on CDP :9223)',
            }) + '\\n',
          );
        } catch {}
      }
    } catch {}
    return origSpawn.call(this, file, args, options);
  };
} catch {}
`;

/**
 * Self-contained Node 22 ESM script executed inside the `runner` container, as the runner's
 * `browser` user (started by core through ptyd with `runAs: 'browser'`).
 *
 * Responsibilities:
 * 1. Bridges `127.0.0.1:7420 -> core:7420` inside `runner` so `http://localhost:7420/...`
 *    works seamlessly inside Chromium and Playwright MCP.
 * 2. Launches and supervises a shared Chromium instance on `127.0.0.1:9222` (`1280x720`),
 *    and also detects any ephemeral Playwright Chromium instance on `127.0.0.1:9223`. Each
 *    project's Live Browser has its own tabs (labelled in `browser-tabs.json`); any other tab is
 *    an agent's.
 * 3. Runs the built-in Live AI Playtest Bot (`start_playtest` / `stop_playtest`) so users and
 *    agents can watch an autonomous AI playtest games and web apps live in the browser.
 * 4. Exposes `/health`, `/state` and `/action` over `/run/emberline/browser/browser.sock` (0666:
 *    core and the agents' tools; only `browser` can write its directory).
 */
export const BROWSER_DAEMON_SCRIPT = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const DAEMON_VERSION = '${BROWSER_DAEMON_VERSION}';
const SOCKET_PATH = process.env.EMBERLINE_BROWSER_SOCKET || '/run/emberline/browser/browser.sock';
const CDP_PORT = 9222;
const CDP_BASE = 'http://127.0.0.1:' + CDP_PORT;
const EPHEMERAL_CDP_BASE = 'http://127.0.0.1:9223';
// Chromium's profile is the daemon's own, beside its socket: a /tmp path could be an agent's first.
const PROFILE_DIR = SOCKET_PATH.replace(/[^/]+$/, 'chrome-profile');
const AGENT_EVENTS_FILE = ${JSON.stringify(AGENT_BROWSER_EVENTS_FILE)};
const TABS_FILE = SOCKET_PATH.replace(/[^/]+$/, 'browser-tabs.json');
/** tab id -> project id: tabs the daemon opened for a project's Live Browser. Any other tab is an agent's. */
const tabProjects = new Map(loadTabProjects());
/**
 * Which agent tab a following view shows: the one at the agent's last navigation, else the newest
 * one seen with a page loaded, or the one whose page changed last (\`urls\`: each tab's URL last round).
 */
const agentFollow = { seen: new Set(), last: null, urls: new Map() };
/** Project tabs being opened (\`/json/new\` answered, label not set yet): a following view holds new tabs. */
let pendingOpens = 0;
let playtestTabId = null;
/** The project whose Live Browser started the Auto-Interact loop: only it can stop or replace it. */
let playtestProjectId = null;
/** tab id -> its newest console lines (60 per tab): a chatty page never pushes out another tab's. */
const consoleByTab = new Map();
/** tab id -> its newest Auto-Interact and navigation actions (40 per tab). */
const actionsByTab = new Map();
/** Tabs of an agent's own Playwright Chromium (:9223) last seen: their buffers are kept too. */
let ephemeralTabIds = new Set();
/** When that Chromium last answered: its tabs' buffers are kept for 10 s after, no longer. */
let ephemeralSeenAt = 0;
let nextActionId = 900000;
const attachedTabs = new Set();
let launchingBrowser = null;
let playtestTimer = null;
let playtestEndsAt = 0;
let playtestTickCount = 0;

function loadTabProjects() {
  try {
    return Object.entries(JSON.parse(fs.readFileSync(TABS_FILE, 'utf8')));
  } catch {
    return [];
  }
}

function saveTabProjects() {
  try {
    fs.writeFileSync(TABS_FILE + '.tmp', JSON.stringify(Object.fromEntries(tabProjects)));
    fs.renameSync(TABS_FILE + '.tmp', TABS_FILE);
  } catch {}
}

function pushCapped(buffers, tabId, entry, cap) {
  if (tabId == null) return;
  let list = buffers.get(tabId);
  if (!list) {
    list = [];
    buffers.set(tabId, list);
  }
  list.push(entry);
  if (list.length > cap) list.splice(0, list.length - cap);
}

/** Drops the buffers of tabs that are gone: only those that existed before the tab list was asked for. */
function pruneTabBuffers(buffers, before, live) {
  for (const id of before) if (!live.has(id)) buffers.delete(id);
}

function pushDaemonAction(toolName, summary, persona = 'qa', tabId = null) {
  pushCapped(
    actionsByTab,
    tabId,
    {
      id: nextActionId++,
      runId: 'live-browser',
      runTitle: 'Live Browser AI Bot',
      persona,
      toolName,
      summary,
      timestamp: new Date().toISOString(),
    },
    40,
  );
}

/**
 * The newest launches the agents' hook reported. The agents write that file: it is opened without
 * following a link, only its last 64 KiB are read, and only strings of bounded length are kept.
 */
function readHookEvents() {
  let fd = null;
  try {
    fd = fs.openSync(AGENT_EVENTS_FILE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return [];
    const len = Math.min(st.size, 64 * 1024);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, st.size - len);
    let text = buf.subarray(0, n).toString('utf8');
    if (st.size > len) text = text.slice(text.indexOf('\\n') + 1);
    const text200 = (v, fallback) => (typeof v === 'string' && v ? v.slice(0, 200) : fallback);
    return text
      .trim()
      .split('\\n')
      .slice(-15)
      .map((line, idx) => {
        try {
          const item = JSON.parse(line);
          if (!item || typeof item !== 'object') return null;
          const ts = typeof item.ts === 'string' && Number.isFinite(Date.parse(item.ts)) ? item.ts : null;
          return {
            id: 800000 + idx,
            runId: 'playwright-script',
            runTitle: 'Playwright Script',
            persona: 'qa',
            toolName: text200(item.toolName, 'playwright'),
            summary: text200(item.summary, 'Playwright browser session'),
            timestamp: ts ? new Date(ts).toISOString() : new Date().toISOString(),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function pushConsole(level, text, tabId) {
  if (!text) return;
  const clean = String(text).slice(0, 600);
  pushCapped(
    consoleByTab,
    tabId,
    {
      level: ['log', 'info', 'warn', 'error'].includes(level) ? level : 'log',
      text: clean,
      timestamp: new Date().toISOString(),
    },
    60,
  );
}

/** Why the localhost:7420 bridge does not listen (an error code), reported by \`/health\`; null while it does. */
let bridgeError = null;

/**
 * Listens on \`port\`, retrying for a bounded time while the port is taken: a daemon that stopped
 * answering and was started again may still hold it for a moment. Any other error, or the port still
 * taken once the retries run out, goes to \`onGiveUp\`.
 */
function listenWithRetry(server, port, host, tries, delayMs, onGiveUp) {
  let left = tries;
  server.on('listening', () => {
    bridgeError = null;
  });
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && left > 0) {
      left--;
      setTimeout(() => server.listen(port, host), delayMs);
      return;
    }
    if (typeof onGiveUp === 'function') onGiveUp(err);
  });
  server.listen(port, host);
}

// 1. Bridge 127.0.0.1:7420 -> core:7420 inside runner (waits up to 10 s for a previous daemon to let go)
try {
  const bridge = net.createServer((client) => {
    const upstream = net.connect(7420, 'core');
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  listenWithRetry(bridge, 7420, '127.0.0.1', 40, 250, (err) => {
    bridgeError = String((err && err.code) || err);
  });
} catch {}

async function isCdpAlive(baseUrl = CDP_BASE, timeoutMs = 1200) {
  try {
    const res = await fetch(baseUrl + '/json/version', { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureChromium() {
  if (await isCdpAlive()) return true;
  if (launchingBrowser) return launchingBrowser;

  launchingBrowser = (async () => {
    try {
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try { fs.rmSync(PROFILE_DIR + '/' + lock, { force: true }); } catch {}
      }
      const bins = ['/usr/bin/chromium', 'chromium', 'chromium-browser', 'google-chrome'];
      let spawned = false;
      for (const bin of bins) {
        try {
          const proc = spawn(
            bin,
            [
              '--headless',
              '--no-sandbox',
              '--disable-gpu',
              '--disable-dev-shm-usage',
              '--hide-scrollbars',
              '--remote-debugging-port=' + CDP_PORT,
              '--window-size=1280,720',
              '--user-data-dir=' + PROFILE_DIR,
              'about:blank',
            ],
            { detached: true, stdio: 'ignore' },
          );
          proc.on('error', () => {});
          proc.unref();
          spawned = true;
          break;
        } catch {}
      }
      if (!spawned) return false;
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (await isCdpAlive()) return true;
      }
      return false;
    } finally {
      launchingBrowser = null;
    }
  })();

  return launchingBrowser;
}

function normalizeNavigateUrl(rawUrl) {
  let u = String(rawUrl || '').trim();
  if (!u || u === 'about:blank') return 'about:blank';
  // A bare host ("localhost:5173", "example.com") gets http://; "host:port" is not a scheme.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u) || /^[^:/]+:[0-9]/.test(u)) {
    u = 'http://' + u;
  }
  // S17: only web pages. file:, javascript:, data: or chrome: URLs would expose the runner's files.
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error('invalid URL: ' + u);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http(s) URLs can be opened, not ' + parsed.protocol);
  }
  return parsed.href;
}

function attachConsoleListener(tab) {
  if (!tab || !tab.webSocketDebuggerUrl || attachedTabs.has(tab.id)) return;
  attachedTabs.add(tab.id);
  try {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable', params: {} }));
      ws.send(JSON.stringify({ id: 2, method: 'Log.enable', params: {} }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.method === 'Runtime.consoleAPICalled') {
          const type = msg.params?.type || 'log';
          const args = (msg.params?.args || [])
            .map((a) => a.value ?? a.description ?? '')
            .filter(Boolean)
            .join(' ');
          pushConsole(type === 'warning' ? 'warn' : type, args, tab.id);
        } else if (msg.method === 'Runtime.exceptionThrown') {
          const desc =
            msg.params?.exceptionDetails?.exception?.description ||
            msg.params?.exceptionDetails?.text ||
            'Uncaught page error';
          pushConsole('error', desc, tab.id);
        } else if (msg.method === 'Log.entryAdded') {
          const entry = msg.params?.entry;
          if (entry?.text) {
            pushConsole(entry.level === 'warning' ? 'warn' : entry.level || 'info', entry.text, tab.id);
          }
        }
      } catch {}
    };
    ws.onclose = () => attachedTabs.delete(tab.id);
    ws.onerror = () => attachedTabs.delete(tab.id);
  } catch {
    attachedTabs.delete(tab.id);
  }
}

function isUserPage(t) {
  return (
    t.type === 'page' &&
    typeof t.url === 'string' &&
    !t.url.startsWith('chrome://') &&
    !t.url.startsWith('devtools://') &&
    !t.url.startsWith('chrome-extension://')
  );
}

/** An agent's own Playwright Chromium on :9223 (started through the preload hook), when one runs. */
async function ephemeralPages() {
  try {
    const res = await fetch(EPHEMERAL_CDP_BASE + '/json/list', { signal: AbortSignal.timeout(350) });
    if (!res.ok) return null;
    const pages = (await res.json()).filter(isUserPage);
    for (const p of pages) attachConsoleListener(p);
    ephemeralTabIds = new Set(pages.map((p) => p.id));
    ephemeralSeenAt = Date.now();
    return pages.length > 0 ? pages : null;
  } catch {
    ephemeralTabIds = new Set();
    return null;
  }
}

/**
 * The shared Chromium's pages (one blank agent tab is opened when none is left); labels of closed
 * tabs are dropped. Only labels that existed before the list was asked for: a tab another request
 * opens meanwhile is not in this list yet.
 */
async function sharedPages() {
  // Nobody follows the agent's own Chromium any more (or it is gone): its tabs' buffers go too.
  if (Date.now() - ephemeralSeenAt > 10_000) ephemeralTabIds = new Set();
  const labelled = [...tabProjects.keys()];
  const buffered = { console: [...consoleByTab.keys()], actions: [...actionsByTab.keys()] };
  const res = await fetch(CDP_BASE + '/json/list', { signal: AbortSignal.timeout(2000) });
  let pages = (await res.json()).filter(isUserPage);
  if (pages.length === 0) {
    const created = await fetch(CDP_BASE + '/json/new?about:blank', { method: 'PUT', signal: AbortSignal.timeout(2000) });
    if (created.ok) pages = [await created.json()];
  }
  for (const p of pages) attachConsoleListener(p);
  let changed = false;
  for (const id of labelled) {
    if (tabProjects.has(id) && !pages.some((p) => p.id === id)) {
      tabProjects.delete(id);
      changed = true;
    }
  }
  if (changed) saveTabProjects();
  const live = new Set([...pages.map((p) => p.id), ...ephemeralTabIds]);
  pruneTabBuffers(consoleByTab, buffered.console, live);
  pruneTabBuffers(actionsByTab, buffered.actions, live);
  return pages;
}

/**
 * The agent tab a following view shows. The tab at the agent's last navigation (\`agentUrl\`, hash
 * ignored) wins; else the newest tab, or the one whose page changed. Labelled tabs are projects'.
 * With \`holdNew\` (a project tab is being opened and not labelled yet) a tab not seen before is left
 * out and stays unseen, so it is judged once its label is known.
 */
function pickAgentTab(pages, labels, follow, agentUrl, holdNew) {
  const fresh = (p) => !follow.seen.has(p.id);
  const candidates = pages.filter((p) => !labels.has(p.id) && p.url && p.url !== 'about:blank' && !(holdNew && fresh(p)));
  const strip = (u) => {
    try {
      const x = new URL(u);
      x.hash = '';
      return x.href;
    } catch {
      return u;
    }
  };
  const hit = agentUrl ? candidates.find((p) => strip(p.url) === strip(agentUrl)) : null;
  if (hit) follow.last = hit.id;
  else for (const p of candidates) if (fresh(p) || follow.urls.get(p.id) !== strip(p.url)) follow.last = p.id;
  follow.seen = new Set(pages.filter((p) => !(holdNew && fresh(p))).map((p) => p.id));
  follow.urls = new Map(pages.map((p) => [p.id, strip(p.url)]));
  return candidates.find((p) => p.id === follow.last) || candidates[0] || null;
}

function pickShownTab(pages, labels, follow, q) {
  if (q.follow) {
    const agent = pickAgentTab(pages, labels, follow, q.agentUrl, pendingOpens > 0);
    if (agent) return { tab: agent, following: true };
  }
  const own = q.tabId ? pages.find((p) => p.id === q.tabId && labels.get(p.id) === q.projectId) : null;
  return own ? { tab: own, following: false } : null;
}

/** What a request shows: while following, the agent's own Chromium (:9223) or its tab; else the project's tab; tab null when that tab is gone. */
async function resolveShown(q) {
  const pages = await sharedPages();
  if (q.follow) {
    const eph = await ephemeralPages();
    if (eph) {
      const tab = eph.find((p) => p.url && p.url !== 'about:blank') || eph[0];
      return { pages, tab, following: true, ephemeral: true };
    }
  }
  const shown = pickShownTab(pages, tabProjects, agentFollow, q);
  return shown ? { pages, ...shown, ephemeral: false } : { pages, tab: null, following: false, ephemeral: false };
}

async function withCdpPage(tab, fn) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP WebSocket connect timeout')), 2500);
    ws.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    ws.onerror = (err) => {
      clearTimeout(t);
      reject(err);
    };
  });

  let nextId = 10;
  const call = (method, params = {}, timeoutMs = 3500) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        ws.removeEventListener('message', onMsg);
        reject(new Error('CDP call timeout: ' + method));
      }, timeoutMs);
      const onMsg = (ev) => {
        try {
          const data = JSON.parse(String(ev.data));
          if (data.id === id) {
            clearTimeout(timer);
            ws.removeEventListener('message', onMsg);
            if (data.error) reject(new Error(data.error.message || 'CDP error'));
            else resolve(data.result);
          }
        } catch {}
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });

  try {
    return await fn(call);
  } finally {
    try { ws.close(); } catch {}
  }
}

const KEY_MAP = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\\r' },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
};

function stopPlaytestLoop(reason = 'Stopped Live AI Playtest Bot') {
  if (playtestTimer) {
    clearInterval(playtestTimer);
    playtestTimer = null;
    playtestEndsAt = 0;
    pushDaemonAction('ai_playtest_stop', reason, 'qa', playtestTabId);
    playtestTabId = null;
    playtestProjectId = null;
  }
}

/** True while another project's Auto-Interact loop runs: one project's view never stops or replaces it. */
function playtestHeldByOther(running, owner, projectId) {
  return Boolean(running) && owner !== projectId;
}

async function runPlaytestTick() {
  if (Date.now() > playtestEndsAt) {
    stopPlaytestLoop('Completed 45s Live AI Playtest session');
    return;
  }
  playtestTickCount++;
  try {
    const tab = (await sharedPages()).find((p) => p.id === playtestTabId);
    if (!tab) {
      stopPlaytestLoop('Tab closed');
      return;
    }
    await withCdpPage(tab, async (call) => {
      // 1. Evaluate smart DOM/Canvas helper inside the page
      const evalRes = await call(
        'Runtime.evaluate',
        {
          expression: \`(() => {
            const buttons = Array.from(document.querySelectorAll('button, [role="button"], .btn'));
            // Click start / play / retry / restart buttons if visible
            for (const b of buttons) {
              const txt = (b.textContent || '').trim().toLowerCase();
              const style = window.getComputedStyle(b);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
              if (/^(start|play|play again|restart|retry|try again|new game|launch)/i.test(txt)) {
                b.click();
                return { action: 'clicked_button', label: (b.textContent || '').trim() };
              }
            }
            // Enable built-in autopilot button if the game has one and it's not active yet
            const autoBtn = document.querySelector('#autopilot-btn, [data-autopilot], .autopilot-btn');
            if (autoBtn && autoBtn.getAttribute('aria-pressed') !== 'true' && !autoBtn.classList.contains('active')) {
              autoBtn.click();
              return { action: 'enabled_autopilot', label: (autoBtn.textContent || 'Autopilot').trim() };
            }
            const scoreEl = document.querySelector('#hud-score, .score, [data-score], #score');
            const scoreText = scoreEl ? (scoreEl.textContent || '').trim() : null;
            return { action: 'flap', score: scoreText };
          })()\`,
          returnByValue: true,
        },
        1200,
      ).catch(() => null);

      const info = evalRes?.result?.value;
      if (info?.action === 'clicked_button') {
        pushDaemonAction('auto_interact_click', 'Clicked "' + info.label + '" button', 'qa', playtestTabId);
      } else if (info?.action === 'enabled_autopilot') {
        pushDaemonAction('auto_interact_autopilot', 'Activated Autopilot (' + info.label + ')', 'qa', playtestTabId);
      }

      // 2. Dispatch Space key when interacting with an active page
      const shouldPress = playtestTickCount % 2 === 0;
      if (shouldPress) {
        const k = KEY_MAP.Space;
        await call('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: k.key,
          code: k.code,
          text: k.text,
          unmodifiedText: k.text,
          windowsVirtualKeyCode: k.keyCode,
          nativeVirtualKeyCode: k.keyCode,
        });
        await call('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: k.key,
          code: k.code,
          windowsVirtualKeyCode: k.keyCode,
          nativeVirtualKeyCode: k.keyCode,
        });
        if (playtestTickCount % 8 === 0) {
          const scoreNote = info?.score ? ' · Metric: ' + info.score : '';
          pushDaemonAction('auto_interact_key', 'Sent Space key' + scoreNote, 'qa', playtestTabId);
        }
      }
    });
  } catch {}
}

async function startPlaytestLoop(tab, targetUrl, projectId) {
  stopPlaytestLoop();
  await ensureChromium();
  playtestTabId = tab.id;
  playtestProjectId = projectId;
  if (targetUrl && (!tab.url || tab.url === 'about:blank')) {
    const navUrl = normalizeNavigateUrl(targetUrl);
    await withCdpPage(tab, async (call) => {
      await call('Page.enable');
      await call('Page.navigate', { url: navUrl });
      await new Promise((r) => setTimeout(r, 500));
    }).catch(() => {});
  }
  playtestEndsAt = Date.now() + 45_000;
  playtestTickCount = 0;
  pushDaemonAction('auto_interact_start', 'Started Browser Auto-Interact session (45s)', 'qa', playtestTabId);
  await runPlaytestTick();
  playtestTimer = setInterval(() => {
    void runPlaytestTick();
  }, 260);
}

async function captureState(q) {
  const nowIso = new Date().toISOString();
  const ok = await ensureChromium();
  if (!ok) {
    return {
      available: false,
      source: 'none',
      targetUrl: null,
      imageDataUrl: null,
      capturedAt: nowIso,
      message: 'Chromium could not be started inside runner.',
    };
  }

  const { pages, tab, following, ephemeral } = await resolveShown(q);
  const tabs = pages.map((p) => ({
    id: p.id,
    title: p.title || 'Untitled',
    url: p.url,
    active: Boolean(tab) && p.id === tab.id,
    projectId: tabProjects.get(p.id) ?? null,
  }));
  if (!tab) {
    return { available: false, source: 'none', targetUrl: null, imageDataUrl: null, capturedAt: nowIso, message: null, tabs, tabMissing: true };
  }

  let imageDataUrl = null;
  let liveTitle = tab.title || '';
  let liveUrl = tab.url || '';

  await withCdpPage(tab, async (call) => {
    await call('Page.enable');
    try {
      const evalRes = await call(
        'Runtime.evaluate',
        {
          expression: '({ title: document.title || "", url: location.href || "" })',
          returnByValue: true,
        },
        1500,
      );
      if (evalRes?.result?.value) {
        liveTitle = evalRes.result.value.title || liveTitle;
        liveUrl = evalRes.result.value.url || liveUrl;
      }
    } catch {}
    const snap = await call('Page.captureScreenshot', { format: 'png' }, 3500);
    if (snap?.data) {
      imageDataUrl = 'data:image/png;base64,' + snap.data;
    }
  }).catch(() => {});

  const shownEntry = tabs.find((t) => t.id === tab.id);
  if (shownEntry) {
    shownEntry.title = liveTitle || shownEntry.title;
    shownEntry.url = liveUrl || shownEntry.url;
  }

  const playtestRunning = Boolean(playtestTimer && Date.now() < playtestEndsAt);
  const playtestHere = playtestRunning && playtestTabId === tab.id;

  return {
    available: Boolean(imageDataUrl),
    source: 'cdp_live',
    targetUrl: liveUrl || tab.url || null,
    pageTitle: liveTitle || tab.title || null,
    activeTabId: tab.id,
    tabs,
    consoleLogs: (consoleByTab.get(tab.id) || []).slice(-30),
    agentActions: [...(following ? readHookEvents() : []), ...(actionsByTab.get(tab.id) || [])]
      .slice(-25)
      .reverse(),
    agentActive: Boolean(ephemeral || playtestHere),
    playtestActive: playtestHere,
    playtestElsewhere: playtestHeldByOther(playtestRunning, playtestProjectId, q.projectId),
    following,
    imageDataUrl,
    capturedAt: nowIso,
    message: playtestHere
      ? '🤖 Browser Auto-Interact is active!'
      : ephemeral
        ? '⚡ Streaming Agent Playwright session (:9223) live!'
        : imageDataUrl
          ? 'Live Chromium CDP stream (1280×720) · Shared with Playwright MCP'
          : 'Waiting for browser frame…',
  };
}

async function handleAction(body, q) {
  await ensureChromium();
  const action = body?.action;

  if (action === 'open_tab' || action === 'new_tab') {
    const url = normalizeNavigateUrl(body.url || q.defaultUrl || 'about:blank');
    // Until it is labelled, the new tab looks like an agent's: following views hold new tabs meanwhile.
    pendingOpens++;
    let created = null;
    try {
      const res = await fetch(CDP_BASE + '/json/new?' + encodeURIComponent(url), { method: 'PUT' }).catch(() => null);
      if (res && res.ok) {
        created = await res.json();
        tabProjects.set(created.id, q.projectId);
        saveTabProjects();
      }
    } finally {
      pendingOpens--;
    }
    if (created) {
      await new Promise((r) => setTimeout(r, 400));
      return captureState({ ...q, tabId: created.id, follow: false });
    }
    return captureState(q);
  }

  if (action === 'close_project_tabs') {
    for (const [id, owner] of [...tabProjects]) {
      if (owner !== q.projectId) continue;
      if (playtestTabId === id) stopPlaytestLoop('Project removed');
      await fetch(CDP_BASE + '/json/close/' + encodeURIComponent(id)).catch(() => {});
      tabProjects.delete(id);
    }
    if (playtestProjectId === q.projectId) stopPlaytestLoop('Project removed');
    saveTabProjects();
    return captureState(q);
  }

  if (action === 'select_tab' && body.tabId) {
    if (tabProjects.get(body.tabId) !== q.projectId) return captureState(q);
    await fetch(CDP_BASE + '/json/activate/' + encodeURIComponent(body.tabId)).catch(() => {});
    return captureState({ ...q, tabId: body.tabId, follow: false });
  }

  if (action === 'close_tab' && body.tabId) {
    await sharedPages(); // drops labels of tabs closed by hand, so they are not counted below
    const own = [...tabProjects.values()].filter((p) => p === q.projectId).length;
    if (tabProjects.get(body.tabId) === q.projectId && own > 1) {
      if (playtestTabId === body.tabId) stopPlaytestLoop('Tab closed');
      await fetch(CDP_BASE + '/json/close/' + encodeURIComponent(body.tabId)).catch(() => {});
      tabProjects.delete(body.tabId);
      saveTabProjects();
      await new Promise((r) => setTimeout(r, 150));
    }
    return captureState(q);
  }

  if (action === 'stop_playtest') {
    if (playtestHeldByOther(playtestTimer, playtestProjectId, q.projectId)) {
      return { ...(await captureState(q)), message: ${JSON.stringify(PLAYTEST_HELD_MESSAGE)}, playtestHeldByOther: true };
    }
    stopPlaytestLoop('Stopped by user');
    return captureState(q);
  }

  const { tab, ephemeral } = await resolveShown(q);
  if (!tab) {
    // Nothing to start Auto-Interact on: the answer says why it did not start.
    if (action === 'start_playtest') return { ...(await captureState(q)), playtestNotStarted: 'no_tab' };
    return captureState(q);
  }

  if (action === 'start_playtest') {
    if (playtestHeldByOther(playtestTimer, playtestProjectId, q.projectId)) {
      return { ...(await captureState(q)), message: ${JSON.stringify(PLAYTEST_HELD_MESSAGE)}, playtestHeldByOther: true };
    }
    // Auto-Interact runs on shared-Chromium tabs only, not in an agent's own Playwright Chromium.
    if (ephemeral) return { ...(await captureState(q)), playtestNotStarted: 'agent_browser' };
    await startPlaytestLoop(tab, body.url || q.defaultUrl, q.projectId);
    return captureState(q);
  }

  await withCdpPage(tab, async (call) => {
    await call('Page.enable');
    if (action === 'navigate') {
      const url = normalizeNavigateUrl(body.url || q.defaultUrl || 'about:blank');
      await call('Page.navigate', { url });
      pushDaemonAction('browser_navigate', 'Navigated to ' + url, 'coder', tab.id);
      await new Promise((r) => setTimeout(r, 450));
    } else if (action === 'reload') {
      await call('Page.reload', { ignoreCache: true });
      await new Promise((r) => setTimeout(r, 350));
    } else if (action === 'back') {
      await call('Runtime.evaluate', { expression: 'window.history.back()' });
      await new Promise((r) => setTimeout(r, 250));
    } else if (action === 'forward') {
      await call('Runtime.evaluate', { expression: 'window.history.forward()' });
      await new Promise((r) => setTimeout(r, 250));
    } else if (action === 'click') {
      const x = Math.max(0, Math.min(1280, Math.round(Number(body.x) || 0)));
      const y = Math.max(0, Math.min(720, Math.round(Number(body.y) || 0)));
      const button = body.button === 'right' ? 'right' : 'left';
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button });
      await call('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button,
        clickCount: 1,
      });
      await call('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button,
        clickCount: 1,
      });
      await new Promise((r) => setTimeout(r, 180));
    } else if (action === 'type') {
      const text = String(body.text ?? '');
      if (text) {
        await call('Input.insertText', { text });
      }
      if (body.submit) {
        const k = KEY_MAP.Enter;
        await call('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: k.key,
          code: k.code,
          windowsVirtualKeyCode: k.keyCode,
          nativeVirtualKeyCode: k.keyCode,
        });
        await call('Input.dispatchKeyEvent', {
          type: 'char',
          text: '\\r',
          key: k.key,
          code: k.code,
        });
        await call('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: k.key,
          code: k.code,
          windowsVirtualKeyCode: k.keyCode,
          nativeVirtualKeyCode: k.keyCode,
        });
      }
      await new Promise((r) => setTimeout(r, 180));
    } else if (action === 'key') {
      const rawKey = String(body.key || 'Space');
      const mapped = KEY_MAP[rawKey] || {
        key: rawKey,
        code: rawKey.length === 1 ? 'Key' + rawKey.toUpperCase() : rawKey,
        keyCode: rawKey.length === 1 ? rawKey.toUpperCase().charCodeAt(0) : 0,
        text: rawKey.length === 1 ? rawKey : undefined,
      };
      await call('Input.dispatchKeyEvent', {
        type: mapped.text ? 'keyDown' : 'rawKeyDown',
        key: mapped.key,
        code: mapped.code,
        text: mapped.text,
        unmodifiedText: mapped.text,
        windowsVirtualKeyCode: mapped.keyCode,
        nativeVirtualKeyCode: mapped.keyCode,
      });
      await call('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: mapped.key,
        code: mapped.code,
        windowsVirtualKeyCode: mapped.keyCode,
        nativeVirtualKeyCode: mapped.keyCode,
      });
      await new Promise((r) => setTimeout(r, 150));
    }
  }).catch(() => {});

  return captureState(q);
}

try { fs.rmSync(SOCKET_PATH, { force: true }); } catch {}

function browserQuery(u) {
  return {
    projectId: u.searchParams.get('projectId') || '',
    tabId: u.searchParams.get('tabId') || null,
    follow: u.searchParams.get('follow') === '1',
    defaultUrl: u.searchParams.get('defaultUrl') || null,
    agentUrl: u.searchParams.get('agentUrl') || null,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET' && u.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: DAEMON_VERSION, bridgeError }));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/state') {
      const snap = await captureState(browserQuery(u));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snap));
      return;
    }
    if (req.method === 'POST' && u.pathname === '/action') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const snap = await handleAction(body, browserQuery(u));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snap));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

server.listen(SOCKET_PATH, () => {
  try { fs.chmodSync(SOCKET_PATH, 0o666); } catch {}
  void ensureChromium();
});
`;
