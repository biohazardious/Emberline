import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type {
  BrowserActionBody,
  BrowserAgentAction,
  BrowserViewportSnapshot,
} from '@emberline/protocol';
import type { PtydBridge } from '../ptyd-bridge.js';

export const BROWSER_DAEMON_VERSION = '1.0.0';

/**
 * Self-contained Node 22 ESM script executed inside the `runner` container.
 *
 * Responsibilities:
 * 1. Bridges `127.0.0.1:7420 -> core:7420` inside `runner` so `http://localhost:7420/...`
 *    works seamlessly inside Chromium and Playwright MCP.
 * 2. Launches and supervises a shared Chromium instance on `127.0.0.1:9222` (`1280x720`).
 *    Playwright MCP (`--cdp-endpoint http://127.0.0.1:9222`) connects to this exact browser!
 * 3. Exposes `/health`, `/state`, `/action`, and `/shutdown` over `/run/emberline/browser.sock`
 *    so `core` can stream live viewports, console logs, open tabs, and interactive clicks/keys.
 */
const BROWSER_DAEMON_SCRIPT = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const DAEMON_VERSION = '${BROWSER_DAEMON_VERSION}';
const SOCKET_PATH = process.env.EMBERLINE_BROWSER_SOCKET || '/run/emberline/browser.sock';
const CDP_PORT = 9222;
const CDP_BASE = 'http://127.0.0.1:' + CDP_PORT;
const PROFILE_DIR = '/tmp/emberline-chrome-profile';

let selectedTabId = null;
let knownTabIds = new Set();
const consoleLogs = [];
const attachedTabs = new Set();
let launchingBrowser = null;

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

async function isCdpAlive() {
  try {
    const res = await fetch(CDP_BASE + '/json/version', { signal: AbortSignal.timeout(1200) });
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
  if (!u) return 'about:blank';
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) {
    u = 'http://' + u;
  }
  return u;
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

  // If a newly created non-blank tab appeared (e.g. opened by Playwright MCP), auto-select it
  for (const p of pages) {
    if (!knownTabIds.has(p.id) && p.url && p.url !== 'about:blank') {
      selectedTabId = p.id;
    }
  }
  knownTabIds = new Set(pages.map((p) => p.id));

  let active = pages.find((p) => p.id === selectedTabId);
  // If selected tab is about:blank and another tab has a real URL (agent navigated it), prefer the real tab
  if ((!active || active.url === 'about:blank') && pages.some((p) => p.url && p.url !== 'about:blank')) {
    active = pages.find((p) => p.url && p.url !== 'about:blank') || pages[0];
  }
  if (!active) active = pages[0];
  if (active) selectedTabId = active.id;

  return { pages, active };
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

  let { pages, active } = await listPageTargets();
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

  return {
    available: Boolean(imageDataUrl),
    source: 'cdp_live',
    targetUrl: liveUrl || active.url || defaultUrl || null,
    pageTitle: liveTitle || active.title || null,
    activeTabId: active.id,
    tabs,
    consoleLogs: consoleLogs.slice(-30),
    imageDataUrl,
    capturedAt: nowIso,
    message: imageDataUrl
      ? 'Live Chromium CDP stream (1280×720) · Shared with Playwright MCP'
      : 'Waiting for browser frame…',
  };
}

async function handleAction(body, defaultUrl) {
  await ensureChromium();
  const { pages, active } = await listPageTargets();
  const action = body?.action;

  if (action === 'select_tab' && body.tabId) {
    selectedTabId = body.tabId;
    await fetch(CDP_BASE + '/json/activate/' + encodeURIComponent(body.tabId)).catch(() => {});
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
      await fetch(CDP_BASE + '/json/close/' + encodeURIComponent(body.tabId)).catch(() => {});
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
      await new Promise((r) => setTimeout(r, 220));
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
      await new Promise((r) => setTimeout(r, 220));
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
      await new Promise((r) => setTimeout(r, 180));
    }
  }).catch(() => {});

  return captureState(defaultUrl);
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
    if (req.method === 'POST' && u.pathname === '/shutdown') {
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
 * Ensures `/run/emberline/browser-daemon.mjs` is written and running inside the `runner`
 * container (speaking on `/run/emberline/browser.sock` and hosting Chromium CDP on `:9222`).
 */
export async function ensureRunnerBrowserDaemon(
  ptyd: PtydBridge,
  socketDir: string,
): Promise<string | null> {
  const browserSock = path.join(socketDir, 'browser.sock');
  const scriptPath = path.join(socketDir, 'browser-daemon.mjs');

  try {
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
      // Outdated daemon version: request clean shutdown before respawning
      await socketRequest(browserSock, 'POST', '/shutdown', {}, 1_000).catch(() => undefined);
    }
  } catch {
    // Not listening yet; spawn below.
  }

  if (ensuringPromise) return ensuringPromise;

  ensuringPromise = (async () => {
    try {
      await mkdir(socketDir, { recursive: true });
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

      // Wait up to 3.5s for the Unix socket to start accepting connections
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
      agentActions: params.agentActions ?? [],
      agentActive: params.agentActive ?? false,
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
    agentActions: params.agentActions ?? [],
    agentActive: params.agentActive ?? false,
  };
}
