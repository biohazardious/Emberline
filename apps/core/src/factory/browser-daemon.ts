import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type {
  BrowserActionBody,
  BrowserAgentAction,
  BrowserViewportSnapshot,
  ClaudeTokenBucket,
  ClaudeUsageTelemetry,
  ProviderTokenTelemetry,
} from '@emberline/protocol';
import type { PtydBridge } from '../ptyd-bridge.js';

export const BROWSER_DAEMON_VERSION = '1.3.2';

/**
 * S17: the same rule the daemon applies before navigating (`normalizeNavigateUrl`), checked in core
 * so a refused URL comes back as a 400 the UI can show instead of a silent no-op.
 */
export function isBrowsableUrl(raw: string): boolean {
  const u = raw.trim();
  if (!u || u === 'about:blank') return true;
  const candidate = !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u) || /^[^:/]+:[0-9]/.test(u) ? `http://${u}` : u;
  try {
    const { protocol } = new URL(candidate);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Preload hook (`NODE_OPTIONS="--require /run/emberline/playwright-hook.cjs"`) injected into
 * agent processes so any custom Playwright script (`chromium.launch()`) or `npx playwright test`
 * executed via `Bash` automatically exposes `--remote-debugging-port=9223` for live streaming!
 */
const PLAYWRIGHT_HOOK_SCRIPT = `'use strict';
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
            '/run/emberline/agent-browser-events.jsonl',
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
 * Self-contained Node 22 ESM script executed inside the `runner` container.
 *
 * Responsibilities:
 * 1. Bridges `127.0.0.1:7420 -> core:7420` inside `runner` so `http://localhost:7420/...`
 *    works seamlessly inside Chromium and Playwright MCP.
 * 2. Launches and supervises a shared Chromium instance on `127.0.0.1:9222` (`1280x720`),
 *    and also detects any ephemeral Playwright Chromium instance on `127.0.0.1:9223`.
 * 3. Runs the built-in Live AI Playtest Bot (`start_playtest` / `stop_playtest`) so users and
 *    agents can watch an autonomous AI playtest games and web apps live in the browser.
 * 4. Exposes `/health`, `/state`, `/action`, and `/shutdown` over `/run/emberline/browser.sock`.
 */
export const BROWSER_DAEMON_SCRIPT = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const DAEMON_VERSION = '${BROWSER_DAEMON_VERSION}';
const SOCKET_PATH = process.env.EMBERLINE_BROWSER_SOCKET || '/run/emberline/browser.sock';
const CDP_PORT = 9222;
const CDP_BASE = 'http://127.0.0.1:' + CDP_PORT;
const EPHEMERAL_CDP_BASE = 'http://127.0.0.1:9223';
const PROFILE_DIR = '/tmp/emberline-chrome-profile';
const AGENT_EVENTS_FILE = '/run/emberline/agent-browser-events.jsonl';

let selectedTabId = null;
let knownTabIds = new Set();
const consoleLogs = [];
const daemonActions = [];
let nextActionId = 900000;
const attachedTabs = new Set();
let launchingBrowser = null;
let playtestTimer = null;
let playtestEndsAt = 0;
let playtestTickCount = 0;

function pushDaemonAction(toolName, summary, persona = 'qa') {
  daemonActions.push({
    id: nextActionId++,
    runId: 'live-browser',
    runTitle: 'Live Browser AI Bot',
    persona,
    toolName,
    summary,
    timestamp: new Date().toISOString(),
  });
  if (daemonActions.length > 40) {
    daemonActions.splice(0, daemonActions.length - 40);
  }
}

function readHookEvents() {
  try {
    if (!fs.existsSync(AGENT_EVENTS_FILE)) return [];
    const lines = fs.readFileSync(AGENT_EVENTS_FILE, 'utf8').trim().split('\\n').slice(-15);
    return lines
      .map((line, idx) => {
        try {
          const item = JSON.parse(line);
          return {
            id: 800000 + idx,
            runId: 'playwright-script',
            runTitle: 'Playwright Script',
            persona: 'qa',
            toolName: item.toolName || 'playwright',
            summary: item.summary || 'Playwright browser session',
            timestamp: item.ts || new Date().toISOString(),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function pushConsole(level, text) {
  if (!text) return;
  const clean = String(text).slice(0, 600);
  consoleLogs.push({
    level: ['log', 'info', 'warn', 'error'].includes(level) ? level : 'log',
    text: clean,
    timestamp: new Date().toISOString(),
  });
  if (consoleLogs.length > 60) {
    consoleLogs.splice(0, consoleLogs.length - 60);
  }
}

// 1. Bridge 127.0.0.1:7420 -> core:7420 inside runner if port 7420 is free
try {
  const bridge = net.createServer((client) => {
    const upstream = net.connect(7420, 'core');
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  bridge.on('error', () => {});
  bridge.listen(7420, '127.0.0.1');
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
          pushConsole(type === 'warning' ? 'warn' : type, args);
        } else if (msg.method === 'Runtime.exceptionThrown') {
          const desc =
            msg.params?.exceptionDetails?.exception?.description ||
            msg.params?.exceptionDetails?.text ||
            'Uncaught page error';
          pushConsole('error', desc);
        } else if (msg.method === 'Log.entryAdded') {
          const entry = msg.params?.entry;
          if (entry?.text) {
            pushConsole(entry.level === 'warning' ? 'warn' : entry.level || 'info', entry.text);
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

async function listPageTargets() {
  // 1. Check if an agent's custom Playwright script is currently running a browser on :9223
  try {
    const ephRes = await fetch(EPHEMERAL_CDP_BASE + '/json/list', {
      signal: AbortSignal.timeout(350),
    });
    if (ephRes.ok) {
      const ephAll = await ephRes.json();
      const ephPages = ephAll.filter(
        (t) =>
          t.type === 'page' &&
          typeof t.url === 'string' &&
          !t.url.startsWith('chrome://') &&
          !t.url.startsWith('devtools://') &&
          !t.url.startsWith('chrome-extension://'),
      );
      if (ephPages.length > 0) {
        for (const p of ephPages) attachConsoleListener(p);
        const real = ephPages.find((p) => p.url && p.url !== 'about:blank') || ephPages[0];
        return { pages: ephPages, active: real, ephemeralActive: true, cdpBase: EPHEMERAL_CDP_BASE };
      }
    }
  } catch {}

  // 2. Otherwise use the persistent shared Chromium on :9222
  const res = await fetch(CDP_BASE + '/json/list', { signal: AbortSignal.timeout(2000) });
  const all = await res.json();
  let pages = all.filter(
    (t) =>
      t.type === 'page' &&
      typeof t.url === 'string' &&
      !t.url.startsWith('chrome://') &&
      !t.url.startsWith('devtools://') &&
      !t.url.startsWith('chrome-extension://'),
  );
  if (pages.length === 0) {
    const created = await fetch(CDP_BASE + '/json/new?about:blank', {
      method: 'PUT',
      signal: AbortSignal.timeout(2000),
    });
    if (created.ok) {
      const t = await created.json();
      pages = [t];
    }
  }
  for (const p of pages) attachConsoleListener(p);

  for (const p of pages) {
    if (!knownTabIds.has(p.id) && p.url && p.url !== 'about:blank') {
      selectedTabId = p.id;
    }
  }
  knownTabIds = new Set(pages.map((p) => p.id));

  let active = pages.find((p) => p.id === selectedTabId);
  if ((!active || active.url === 'about:blank') && pages.some((p) => p.url && p.url !== 'about:blank')) {
    active = pages.find((p) => p.url && p.url !== 'about:blank') || pages[0];
  }
  if (!active) active = pages[0];
  if (active) selectedTabId = active.id;

  return { pages, active, ephemeralActive: false, cdpBase: CDP_BASE };
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
    pushDaemonAction('ai_playtest_stop', reason);
  }
}

async function runPlaytestTick() {
  if (Date.now() > playtestEndsAt) {
    stopPlaytestLoop('Completed 45s Live AI Playtest session');
    return;
  }
  playtestTickCount++;
  try {
    const { active } = await listPageTargets();
    if (!active) return;
    await withCdpPage(active, async (call) => {
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
        pushDaemonAction('auto_interact_click', 'Clicked "' + info.label + '" button');
      } else if (info?.action === 'enabled_autopilot') {
        pushDaemonAction('auto_interact_autopilot', 'Activated Autopilot (' + info.label + ')');
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
          pushDaemonAction('auto_interact_key', 'Sent Space key' + scoreNote);
        }
      }
    });
  } catch {}
}

async function startPlaytestLoop(targetUrl) {
  stopPlaytestLoop();
  await ensureChromium();
  let { active } = await listPageTargets();
  if (active && targetUrl && (!active.url || active.url === 'about:blank')) {
    const navUrl = normalizeNavigateUrl(targetUrl);
    await withCdpPage(active, async (call) => {
      await call('Page.enable');
      await call('Page.navigate', { url: navUrl });
      await new Promise((r) => setTimeout(r, 500));
    }).catch(() => {});
  }
  playtestEndsAt = Date.now() + 45_000;
  playtestTickCount = 0;
  pushDaemonAction('auto_interact_start', 'Started Browser Auto-Interact session (45s)');
  await runPlaytestTick();
  playtestTimer = setInterval(() => {
    void runPlaytestTick();
  }, 260);
}

async function captureState(defaultUrl) {
  const nowIso = new Date().toISOString();
  const ok = await ensureChromium();
  if (!ok) {
    return {
      available: false,
      source: 'none',
      targetUrl: defaultUrl || null,
      imageDataUrl: null,
      capturedAt: nowIso,
      message: 'Chromium could not be started inside runner.',
    };
  }

  let { pages, active, ephemeralActive } = await listPageTargets();
  if (!active) {
    return {
      available: false,
      source: 'none',
      targetUrl: defaultUrl || null,
      imageDataUrl: null,
      capturedAt: nowIso,
      message: 'No active browser tab available.',
    };
  }

  // Auto-open defaultUrl if all tabs are currently at about:blank
  if (
    !ephemeralActive &&
    defaultUrl &&
    pages.every((p) => !p.url || p.url === 'about:blank')
  ) {
    const navUrl = normalizeNavigateUrl(defaultUrl);
    await withCdpPage(active, async (call) => {
      await call('Page.enable');
      await call('Page.navigate', { url: navUrl });
      await new Promise((r) => setTimeout(r, 450));
    }).catch(() => {});
    const refreshed = await listPageTargets();
    pages = refreshed.pages;
    active = refreshed.active || active;
  }

  let imageDataUrl = null;
  let liveTitle = active.title || '';
  let liveUrl = active.url || '';

  await withCdpPage(active, async (call) => {
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

  const tabs = pages.map((p) => ({
    id: p.id,
    title: p.id === active.id ? liveTitle || p.title || 'Untitled' : p.title || 'Untitled',
    url: p.id === active.id ? liveUrl || p.url : p.url,
    active: p.id === active.id,
  }));

  const isPlaytestRunning = Boolean(playtestTimer && Date.now() < playtestEndsAt);
  const hookEvents = readHookEvents();
  const combinedDaemonActions = [...hookEvents, ...daemonActions].slice(-25).reverse();

  return {
    available: Boolean(imageDataUrl),
    source: 'cdp_live',
    targetUrl: liveUrl || active.url || defaultUrl || null,
    pageTitle: liveTitle || active.title || null,
    activeTabId: active.id,
    tabs,
    consoleLogs: consoleLogs.slice(-30),
    agentActions: combinedDaemonActions,
    agentActive: Boolean(ephemeralActive || isPlaytestRunning),
    playtestActive: isPlaytestRunning,
    imageDataUrl,
    capturedAt: nowIso,
    message: isPlaytestRunning
      ? '🤖 Browser Auto-Interact is active!'
      : ephemeralActive
        ? '⚡ Streaming Agent Playwright session (:9223) live!'
        : imageDataUrl
          ? 'Live Chromium CDP stream (1280×720) · Shared with Playwright MCP'
          : 'Waiting for browser frame…',
  };
}

async function handleAction(body, defaultUrl) {
  await ensureChromium();
  const { pages, active, cdpBase } = await listPageTargets();
  const action = body?.action;

  if (action === 'start_playtest') {
    await startPlaytestLoop(body.url || defaultUrl);
    return captureState(defaultUrl);
  }

  if (action === 'stop_playtest') {
    stopPlaytestLoop('Stopped by user');
    return captureState(defaultUrl);
  }

  if (action === 'select_tab' && body.tabId) {
    selectedTabId = body.tabId;
    await fetch(cdpBase + '/json/activate/' + encodeURIComponent(body.tabId)).catch(() => {});
    return captureState(defaultUrl);
  }

  if (action === 'new_tab') {
    const url = normalizeNavigateUrl(body.url || defaultUrl || 'about:blank');
    const res = await fetch(CDP_BASE + '/json/new?' + encodeURIComponent(url), { method: 'PUT' }).catch(() => null);
    if (res && res.ok) {
      const created = await res.json();
      selectedTabId = created.id;
      await new Promise((r) => setTimeout(r, 400));
    }
    return captureState(defaultUrl);
  }

  if (action === 'close_tab' && body.tabId) {
    if (pages.length > 1) {
      await fetch(cdpBase + '/json/close/' + encodeURIComponent(body.tabId)).catch(() => {});
      if (selectedTabId === body.tabId) selectedTabId = null;
      await new Promise((r) => setTimeout(r, 150));
    }
    return captureState(defaultUrl);
  }

  const targetTab = (body.tabId && pages.find((p) => p.id === body.tabId)) || active;
  if (!targetTab) return captureState(defaultUrl);

  await withCdpPage(targetTab, async (call) => {
    await call('Page.enable');
    if (action === 'navigate') {
      const url = normalizeNavigateUrl(body.url || defaultUrl || 'about:blank');
      await call('Page.navigate', { url });
      pushDaemonAction('browser_navigate', 'Navigated to ' + url, 'coder');
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

  return captureState(defaultUrl);
}

let cachedClaudeUsage = null;
let cachedClaudeUsageAt = 0;

function emptyBucket() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    turnCount: 0,
  };
}

function addUsageToBucket(bucket, u) {
  const inp = Number(u.input_tokens) || 0;
  const out = Number(u.output_tokens) || 0;
  const cr = Number(u.cache_read_input_tokens) || 0;
  const cc = Number(u.cache_creation_input_tokens) || 0;
  bucket.inputTokens += inp;
  bucket.outputTokens += out;
  bucket.cacheReadTokens += cr;
  bucket.cacheCreationTokens += cc;
  bucket.totalTokens += inp + out + cr + cc;
  bucket.turnCount += 1;
}

function scanTranscriptTokens(nowMs) {
  const hourly = emptyBucket();
  const daily = emptyBucket();
  const weekly = emptyBucket();
  const projectsRoot = '/home/node/.claude/projects';
  const cutoff7d = nowMs - 7 * 86400_000;
  const cutoff24h = nowMs - 86400_000;
  const cutoff1h = nowMs - 3600_000;

  try {
    if (!fs.existsSync(projectsRoot)) return { hourly, daily, weekly };
    const byMsgId = new Map();
    const dirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dirPath = projectsRoot + '/' + d.name;
      let files = [];
      try { files = fs.readdirSync(dirPath); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const fullPath = dirPath + '/' + f;
        let st;
        try { st = fs.statSync(fullPath); } catch { continue; }
        if (st.mtimeMs < cutoff7d) continue;
        let raw = '';
        try { raw = fs.readFileSync(fullPath, 'utf8'); } catch { continue; }
        const lines = raw.split('\\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line || !line.includes('"usage"')) continue;
          try {
            const obj = JSON.parse(line);
            const usage = obj?.message?.usage || obj?.usage;
            if (!usage || typeof usage !== 'object') continue;
            const ts = obj?.timestamp ? Date.parse(obj.timestamp) : st.mtimeMs;
            if (!Number.isFinite(ts) || ts < cutoff7d) continue;
            const key = obj?.message?.id || obj?.uuid || (fullPath + ':' + i);
            byMsgId.set(key, { ts, usage });
          } catch {}
        }
      }
    }

    for (const { ts, usage } of byMsgId.values()) {
      addUsageToBucket(weekly, usage);
      if (ts >= cutoff24h) addUsageToBucket(daily, usage);
      if (ts >= cutoff1h) addUsageToBucket(hourly, usage);
    }
  } catch {}

  return { hourly, daily, weekly };
}

// Antigravity quota: the same call agy makes for its own usage view (fetchAvailableModels returns a
// quotaInfo {remainingFraction, resetTime} per model). Read-only, with agy's own OAuth token, which
// agy refreshes while it runs; an expired token is reported instead of refreshed here.
let cachedAgyQuota = null;
let cachedAgyQuotaAt = 0;
const AGY_API = 'https://daily-cloudcode-pa.googleapis.com/v1internal:';

async function agyCall(method, body, accessToken) {
  const res = await fetch(AGY_API + method, {
    method: 'POST',
    // The service only answers requests that identify as the Antigravity client.
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'User-Agent': 'antigravity' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(method + ' HTTP ' + res.status);
  return res.json();
}

function agyGroupLabel(ids) {
  const text = ids.join(' ').toLowerCase();
  const parts = [];
  if (text.includes('gemini')) parts.push('Gemini');
  if (text.includes('claude')) parts.push('Claude');
  if (text.includes('gpt')) parts.push('GPT');
  return parts.length ? parts.join('/') : 'Models';
}

async function getAntigravityQuota(forceRefresh = false) {
  const nowMs = Date.now();
  if (!forceRefresh && cachedAgyQuota && nowMs - cachedAgyQuotaAt < 60_000) return cachedAgyQuota;
  const result = { available: false, groups: [], reason: null, updatedAt: new Date(nowMs).toISOString() };
  try {
    const tokenPath = '/home/node/.gemini/antigravity-cli/antigravity-oauth-token';
    if (!fs.existsSync(tokenPath)) {
      result.reason = 'not logged in';
    } else {
      const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'))?.token;
      const expiry = token?.expiry ? Date.parse(token.expiry) : NaN;
      if (!token?.access_token) {
        result.reason = 'not logged in';
      } else if (Number.isFinite(expiry) && expiry <= nowMs) {
        result.reason = 'token expired; start an Antigravity session to refresh it';
      } else {
        const load = await agyCall('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }, token.access_token);
        const project = typeof load?.cloudaicompanionProject === 'string' ? load.cloudaicompanionProject : load?.cloudaicompanionProject?.id;
        const data = await agyCall('fetchAvailableModels', project ? { project } : {}, token.access_token);
        const models = data?.models && typeof data.models === 'object' ? Object.entries(data.models) : [];
        // Models that share a pool report the same fraction and reset time; models without a reset
        // time are unmetered (fraction 1) and are left out.
        const pools = new Map();
        for (const [id, model] of models) {
          const q = model?.quotaInfo;
          if (!q || !q.resetTime || typeof q.remainingFraction !== 'number') continue;
          const key = q.resetTime + '|' + q.remainingFraction;
          const pool = pools.get(key) || { ids: [], remaining: q.remainingFraction, resetsAt: q.resetTime };
          pool.ids.push(id);
          pools.set(key, pool);
        }
        result.groups = [...pools.values()]
          .map((p) => ({
            label: agyGroupLabel(p.ids),
            usedPercent: Math.min(100, Math.max(0, Math.round((1 - p.remaining) * 1000) / 10)),
            resetsAt: p.resetsAt,
          }))
          .sort((a, b) => a.label.localeCompare(b.label));
        result.available = result.groups.length > 0;
        if (!result.available) result.reason = 'no metered models reported';
      }
    }
  } catch (err) {
    result.reason = 'quota request failed: ' + (err && err.message ? err.message : String(err));
  }
  cachedAgyQuota = result;
  cachedAgyQuotaAt = nowMs;
  return result;
}

async function getClaudeUsage(forceRefresh = false) {
  const nowMs = Date.now();
  if (!forceRefresh && cachedClaudeUsage && nowMs - cachedClaudeUsageAt < 25_000) {
    return cachedClaudeUsage;
  }

  const { hourly, daily, weekly } = scanTranscriptTokens(nowMs);
  let authenticated = false;
  let subscriptionType = null;
  let rateLimitTier = null;
  let tokenExpiresAt = null;
  let fiveHour = null;
  let sevenDay = null;
  let extraUsage = null;

  try {
    const credsPath = '/home/node/.claude/.credentials.json';
    if (fs.existsSync(credsPath)) {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      const oauth = creds?.claudeAiOauth;
      if (oauth && oauth.accessToken) {
        authenticated = true;
        subscriptionType = oauth.subscriptionType || null;
        rateLimitTier = oauth.rateLimitTier || null;
        if (oauth.expiresAt) {
          const expDate = new Date(oauth.expiresAt);
          if (!Number.isNaN(expDate.getTime())) {
            tokenExpiresAt = expDate.toISOString();
          }
        }

        const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
          headers: {
            Authorization: 'Bearer ' + oauth.accessToken,
            'anthropic-beta': 'oauth-2025-04-20',
          },
          signal: AbortSignal.timeout(4000),
        }).catch(() => null);

        if (res && res.ok) {
          const data = await res.json();
          const limits = Array.isArray(data?.limits) ? data.limits : [];
          const sessionLim = limits.find((l) => l.kind === 'session');
          const weeklyLim = limits.find((l) => l.kind === 'weekly_all');

          if (data?.five_hour) {
            fiveHour = {
              utilizationPercent: Math.min(100, Math.max(0, Number(data.five_hour.utilization) || 0)),
              resetsAt: data.five_hour.resets_at || null,
              severity: sessionLim?.severity || 'normal',
            };
          }
          if (data?.seven_day) {
            sevenDay = {
              utilizationPercent: Math.min(100, Math.max(0, Number(data.seven_day.utilization) || 0)),
              resetsAt: data.seven_day.resets_at || null,
              severity: weeklyLim?.severity || 'normal',
            };
          }
          if (data?.extra_usage && typeof data.extra_usage === 'object') {
            const eu = data.extra_usage;
            extraUsage = {
              enabled: Boolean(eu.is_enabled),
              usedUsd: (Number(eu.used_credits) || 0) / 100,
              limitUsd: (Number(eu.monthly_limit) || 0) / 100,
              utilizationPercent: Math.min(100, Math.max(0, Number(eu.utilization) || 0)),
              disabledReason: eu.disabled_reason || null,
            };
          }
        }
      }
    }
  } catch {}

  const result = {
    available: true,
    authenticated,
    subscriptionType,
    rateLimitTier,
    tokenExpiresAt,
    fiveHour,
    sevenDay,
    extraUsage,
    hourlyTokens: hourly,
    dailyTokens: daily,
    weeklyTokens: weekly,
    providerQuotas: { antigravity: await getAntigravityQuota(forceRefresh) },
    updatedAt: new Date(nowMs).toISOString(),
  };

  cachedClaudeUsage = result;
  cachedClaudeUsageAt = nowMs;
  return result;
}

try { fs.rmSync(SOCKET_PATH, { force: true }); } catch {}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET' && u.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: DAEMON_VERSION }));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/claude-usage') {
      const forceRefresh = u.searchParams.get('refresh') === '1';
      const usage = await getClaudeUsage(forceRefresh);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(usage));
      return;
    }
    if (req.method === 'POST' && u.pathname === '/shutdown') {
      stopPlaytestLoop();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => {
        server.close(() => process.exit(0));
      }, 50);
      return;
    }
    if (req.method === 'GET' && u.pathname === '/state') {
      const defaultUrl = u.searchParams.get('defaultUrl') || undefined;
      const snap = await captureState(defaultUrl);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snap));
      return;
    }
    if (req.method === 'POST' && u.pathname === '/action') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const defaultUrl = u.searchParams.get('defaultUrl') || undefined;
      const snap = await handleAction(body, defaultUrl);
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
  try { fs.chmodSync(SOCKET_PATH, 0o660); } catch {}
  void ensureChromium();
});
`;

function socketRequest<T>(
  socketPath: string,
  method: 'GET' | 'POST',
  urlPath: string,
  body?: unknown,
  timeoutMs = 8_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : undefined;
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': String(payload.length),
            }
          : undefined,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(`Browser daemon HTTP ${res.statusCode}: ${raw}`));
              return;
            }
            resolve(JSON.parse(raw) as T);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('Browser daemon request timed out'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let ensuringPromise: Promise<string | null> | null = null;

/**
 * Ensures `/run/emberline/browser-daemon.mjs` and `/run/emberline/playwright-hook.cjs`
 * are written and running inside the `runner` container.
 */
export async function ensureRunnerBrowserDaemon(
  ptyd: PtydBridge,
  socketDir: string,
): Promise<string | null> {
  const browserSock = path.join(socketDir, 'browser.sock');
  const scriptPath = path.join(socketDir, 'browser-daemon.mjs');
  const hookPath = path.join(socketDir, 'playwright-hook.cjs');

  try {
    // S15: the hook is preloaded into every agent's node processes; a copy edited by one agent is
    // put back before the next launch. (The runner is one trust domain: agents and ptyd share a uid.)
    if (!existsSync(hookPath) || readFileSync(hookPath, 'utf8') !== PLAYWRIGHT_HOOK_SCRIPT) {
      await mkdir(socketDir, { recursive: true });
      await writeFile(hookPath, PLAYWRIGHT_HOOK_SCRIPT, { encoding: 'utf8', mode: 0o644 });
    }
    if (existsSync(browserSock)) {
      const health = await socketRequest<{ ok?: boolean; version?: string }>(
        browserSock,
        'GET',
        '/health',
        undefined,
        1_200,
      );
      if (health.ok && health.version === BROWSER_DAEMON_VERSION) {
        return browserSock;
      }
      await socketRequest(browserSock, 'POST', '/shutdown', {}, 1_000).catch(() => undefined);
    }
  } catch {
    // Not listening yet; spawn below.
  }

  if (ensuringPromise) return ensuringPromise;

  ensuringPromise = (async () => {
    try {
      await mkdir(socketDir, { recursive: true });
      await writeFile(hookPath, PLAYWRIGHT_HOOK_SCRIPT, { encoding: 'utf8', mode: 0o644 });
      await writeFile(scriptPath, BROWSER_DAEMON_SCRIPT, { encoding: 'utf8', mode: 0o755 });

      if (ptyd.status !== 'connected') return null;

      const launcher = await ptyd.get().spawn({
        file: 'node',
        args: [
          '-e',
          `const { spawn } = require('node:child_process'); const p = spawn('node', [${JSON.stringify(scriptPath)}], { detached: true, stdio: 'ignore', env: { ...process.env, EMBERLINE_BROWSER_SOCKET: ${JSON.stringify(browserSock)} } }); p.unref(); process.exit(0);`,
        ],
        cwd: '/workspaces',
      });

      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 140));
        try {
          const health = await socketRequest<{ ok?: boolean }>(
            browserSock,
            'GET',
            '/health',
            undefined,
            1_000,
          );
          if (health.ok) {
            await ptyd
              .get()
              .remove(launcher.id)
              .catch(() => undefined);
            return browserSock;
          }
        } catch {
          // Keep polling
        }
      }

      await ptyd
        .get()
        .remove(launcher.id)
        .catch(() => undefined);
      return existsSync(browserSock) ? browserSock : null;
    } catch {
      return null;
    } finally {
      ensuringPromise = null;
    }
  })();

  return ensuringPromise;
}

function mergeActions(
  daemonList: BrowserAgentAction[] | undefined,
  runList: BrowserAgentAction[] | undefined,
): BrowserAgentAction[] {
  const combined = [...(daemonList ?? []), ...(runList ?? [])];
  combined.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return combined.slice(0, 30);
}

export async function getRunnerBrowserState(params: {
  ptyd: PtydBridge;
  socketDir: string;
  defaultUrl: string | null;
  agentActions?: BrowserAgentAction[];
  agentActive?: boolean;
}): Promise<BrowserViewportSnapshot | null> {
  const sock = await ensureRunnerBrowserDaemon(params.ptyd, params.socketDir);
  if (!sock) return null;
  try {
    const query = params.defaultUrl
      ? `?defaultUrl=${encodeURIComponent(params.defaultUrl)}`
      : '';
    const snap = await socketRequest<BrowserViewportSnapshot>(sock, 'GET', `/state${query}`);
    return {
      ...snap,
      agentActions: mergeActions(snap.agentActions, params.agentActions),
      agentActive: Boolean(snap.agentActive || params.agentActive),
    };
  } catch {
    return null;
  }
}

export async function performRunnerBrowserAction(params: {
  ptyd: PtydBridge;
  socketDir: string;
  defaultUrl: string | null;
  actionBody: BrowserActionBody;
  agentActions?: BrowserAgentAction[];
  agentActive?: boolean;
}): Promise<BrowserViewportSnapshot | null> {
  const sock = await ensureRunnerBrowserDaemon(params.ptyd, params.socketDir);
  if (!sock) return null;
  const query = params.defaultUrl
    ? `?defaultUrl=${encodeURIComponent(params.defaultUrl)}`
    : '';
  const snap = await socketRequest<BrowserViewportSnapshot>(
    sock,
    'POST',
    `/action${query}`,
    params.actionBody,
  );
  return {
    ...snap,
    agentActions: mergeActions(snap.agentActions, params.agentActions),
    agentActive: Boolean(snap.agentActive || params.agentActive),
  };
}

let lastKnownClaudeUtilizationPercent = 0;

export function getLastKnownClaudeUtilizationPercent(): number {
  return lastKnownClaudeUtilizationPercent;
}

function createEmptyBucket(): ClaudeTokenBucket {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    turnCount: 0,
  };
}

function scanAntigravityTranscriptTokens(nowMs = Date.now()): ProviderTokenTelemetry {
  const hourly = createEmptyBucket();
  const daily = createEmptyBucket();
  const weekly = createEmptyBucket();
  const brainRoot = '/home/node/.gemini/antigravity-cli/brain';
  const cutoff7d = nowMs - 7 * 86_400_000;
  const cutoff24h = nowMs - 86_400_000;
  const cutoff1h = nowMs - 3_600_000;

  try {
    if (!existsSync(brainRoot)) {
      return { hourlyTokens: hourly, dailyTokens: daily, weeklyTokens: weekly };
    }
    const dirs = readdirSync(brainRoot, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const transcriptPath = path.join(brainRoot, d.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (!existsSync(transcriptPath)) continue;
      let st;
      try {
        st = statSync(transcriptPath);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff7d) continue;
      let raw = '';
      try {
        raw = readFileSync(transcriptPath, 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (!line || !line.includes('"PLANNER_RESPONSE"')) continue;
        try {
          const obj = JSON.parse(line) as {
            type?: string;
            created_at?: string;
            input_tokens?: number;
            output_tokens?: number;
            cache_read_tokens?: number;
          };
          if (obj.type !== 'PLANNER_RESPONSE') continue;
          const ts = obj.created_at ? Date.parse(obj.created_at) : st.mtimeMs;
          if (!Number.isFinite(ts) || ts < cutoff7d) continue;
          const inp = Number(obj.input_tokens) || 0;
          const out = Number(obj.output_tokens) || 0;
          const cr = Number(obj.cache_read_tokens) || 0;
          const tot = inp + out + cr;
          if (tot <= 0) continue;

          const add = (b: ClaudeTokenBucket) => {
            b.inputTokens += inp;
            b.outputTokens += out;
            b.cacheReadTokens += cr;
            b.totalTokens += tot;
            b.turnCount += 1;
          };
          add(weekly);
          if (ts >= cutoff24h) add(daily);
          if (ts >= cutoff1h) add(hourly);
        } catch {
          // ignore malformed line
        }
      }
    }
  } catch {
    // ignore read errors
  }

  return { hourlyTokens: hourly, dailyTokens: daily, weeklyTokens: weekly };
}

export async function getRunnerClaudeUsage(params: {
  ptyd: PtydBridge;
  socketDir: string;
  forceRefresh?: boolean;
}): Promise<ClaudeUsageTelemetry> {
  const empty = createEmptyBucket();
  const agyTokens = scanAntigravityTranscriptTokens();
  const fallback: ClaudeUsageTelemetry = {
    available: false,
    authenticated: false,
    subscriptionType: null,
    rateLimitTier: null,
    tokenExpiresAt: null,
    fiveHour: null,
    sevenDay: null,
    extraUsage: null,
    hourlyTokens: empty,
    dailyTokens: empty,
    weeklyTokens: empty,
    providerTokens: {
      claude: { hourlyTokens: empty, dailyTokens: empty, weeklyTokens: empty },
      antigravity: agyTokens,
      gemini: agyTokens,
    },
    updatedAt: new Date().toISOString(),
  };

  const sock = await ensureRunnerBrowserDaemon(params.ptyd, params.socketDir);
  if (!sock) return fallback;
  try {
    const query = params.forceRefresh ? '?refresh=1' : '';
    const res = await socketRequest<ClaudeUsageTelemetry>(sock, 'GET', `/claude-usage${query}`, undefined, 6_000);
    const fivePct = res.fiveHour?.utilizationPercent ?? 0;
    const sevenPct = res.sevenDay?.utilizationPercent ?? 0;
    lastKnownClaudeUtilizationPercent = Math.max(fivePct, sevenPct);
    return {
      ...res,
      providerTokens: {
        claude: {
          hourlyTokens: res.hourlyTokens,
          dailyTokens: res.dailyTokens,
          weeklyTokens: res.weeklyTokens,
        },
        antigravity: agyTokens,
        gemini: agyTokens,
      },
    };
  } catch {
    return fallback;
  }
}


