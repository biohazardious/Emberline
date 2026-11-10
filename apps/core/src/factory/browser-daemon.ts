import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type {
  BrowserActionBody,
  BrowserAgentAction,
  BrowserTabInfo,
  BrowserViewportSnapshot,
} from '@emberline/protocol';
import { execCommand, RUNNER_BIN, runnerSystemCommand } from '../command-exec.js';
import type { PtydBridge } from '../ptyd-bridge.js';
import { BROWSER_DAEMON_SCRIPT_PATH } from './browser-daemon-script.js';

export {
  AGENT_BROWSER_EVENTS_FILE,
  BROWSER_DAEMON_SCRIPT,
  BROWSER_DAEMON_SCRIPT_PATH,
  BROWSER_DAEMON_VERSION,
  PLAYWRIGHT_HOOK_PATH,
  PLAYWRIGHT_HOOK_SCRIPT,
  RUNNER_BROWSER_DIR,
} from './browser-daemon-script.js';

/**
 * S17: the same rule the daemon applies before navigating (`normalizeNavigateUrl`), checked in core
 * so a refused URL comes back as a 400 the UI can show instead of a silent no-op.
 */
export function isBrowsableUrl(raw: string): boolean {
  const u = raw.trim();
  return !u || u === 'about:blank' || browsableHref(u) !== null;
}

/**
 * A web page address as the browser shows it (a bare host or `host:port/path` gets `http://`, a bare
 * origin its `/`); null when it is not an http(s) URL. The daemon's `normalizeNavigateUrl` rule.
 */
export function browsableHref(raw: string): string | null {
  const u = raw.trim();
  const candidate = !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u) || /^[^:/]+:[0-9]/.test(u) ? `http://${u}` : u;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

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

/** Whether this daemon start's bridge error was logged already. */
let bridgeErrorLogged = false;

/** A new daemon was started: its bridge error, if any, is logged again. */
export function resetBridgeErrorLog(): void {
  bridgeErrorLogged = false;
}

/** Logs the daemon's localhost:7420 bridge error (from `/health`) once per daemon start. */
export function logBridgeErrorOnce(
  bridgeError: string | null | undefined,
  log: (message: string) => void = (message) => console.warn(message),
): void {
  if (!bridgeError || bridgeErrorLogged) return;
  bridgeErrorLogged = true;
  log(
    `Live Browser: the runner's localhost:7420 bridge is not listening (${bridgeError}). Pages that open http://localhost:7420 in the runner's browser will not load.`,
  );
}

/**
 * Makes sure the browser daemon listens on `browser.sock` in `socketDir` ({@link RUNNER_BROWSER_DIR}
 * in production), starting it when it does not: the runner image's script, run by the image's node
 * as the runner's `browser` user through ptyd `exec` (a launcher that starts it detached and exits).
 * Core writes nothing for it. A daemon that answers is used whatever its version: it is the one of
 * the runner's image, and only a new runner image (whose entrypoint clears the directory) changes it.
 */
export async function ensureRunnerBrowserDaemon(ptyd: PtydBridge, socketDir: string): Promise<string | null> {
  const browserSock = path.join(socketDir, 'browser.sock');
  const health = () =>
    socketRequest<{ ok?: boolean; bridgeError?: string | null }>(
      browserSock,
      'GET',
      '/health',
      undefined,
      1_200,
    );

  if (existsSync(browserSock)) {
    try {
      const answer = await health();
      if (answer.ok) {
        logBridgeErrorOnce(answer.bridgeError);
        return browserSock;
      }
    } catch {
      // Not listening (any more); started below.
    }
  }

  if (ensuringPromise) return ensuringPromise;

  ensuringPromise = (async () => {
    try {
      if (ptyd.status !== 'connected') return null;

      resetBridgeErrorLog();
      // The image's node by its path, which starts the daemon with itself (process.execPath). The
      // daemon keeps nothing of the launcher: its own session, no stdio, so the exec ends at once.
      const launched = await execCommand(
        runnerSystemCommand({
          file: RUNNER_BIN.node,
          args: [
            '-e',
            `const { spawn } = require('node:child_process'); const p = spawn(process.execPath, [${JSON.stringify(BROWSER_DAEMON_SCRIPT_PATH)}], { detached: true, stdio: 'ignore', env: process.env }); p.unref(); process.exit(0);`,
          ],
          cwd: '/',
          // HOME: Chromium's own files (its profile is set apart) go to the daemon's directory.
          env: { EMBERLINE_BROWSER_SOCKET: browserSock, HOME: socketDir },
          runAs: 'browser',
          timeoutMs: 15_000,
        }),
      );
      if (launched.exitCode !== 0) return null;

      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 140));
        try {
          if ((await health()).ok) return browserSock;
        } catch {
          // Keep polling
        }
      }
      return existsSync(browserSock) ? browserSock : null;
    } catch {
      return null;
    } finally {
      ensuringPromise = null;
    }
  })();

  return ensuringPromise;
}

export interface RunnerBrowserQuery {
  projectId: string;
  tabId: string | null;
  follow: boolean;
  defaultUrl: string | null;
  /** The URL the project's agent navigated to last; sent only while following. */
  agentUrl?: string | null;
}
export type RunnerBrowserTab = BrowserTabInfo & { projectId: string | null };
export type RunnerBrowserSnapshot = Omit<BrowserViewportSnapshot, 'tabs'> & {
  tabs?: RunnerBrowserTab[];
  tabMissing?: boolean;
};
export type RunnerBrowserActionBody =
  BrowserActionBody | { action: 'open_tab'; url?: string } | { action: 'close_project_tabs' };
export interface RunnerBrowserDaemon {
  state(q: RunnerBrowserQuery): Promise<RunnerBrowserSnapshot>;
  action(body: RunnerBrowserActionBody, q: RunnerBrowserQuery): Promise<RunnerBrowserSnapshot>;
}

function browserQueryString(q: RunnerBrowserQuery): string {
  const params = new URLSearchParams({ projectId: q.projectId });
  if (q.tabId) params.set('tabId', q.tabId);
  if (q.follow) params.set('follow', '1');
  if (q.defaultUrl) params.set('defaultUrl', q.defaultUrl);
  if (q.follow && q.agentUrl) params.set('agentUrl', q.agentUrl);
  return `?${params.toString()}`;
}

/**
 * The daemon, started (or restarted after a version change) when needed; null while the runner is
 * away. With `start: false`, null unless it already listens.
 */
export async function runnerBrowserDaemon(
  ptyd: PtydBridge,
  socketDir: string,
  opts: { start?: boolean } = {},
): Promise<RunnerBrowserDaemon | null> {
  if (opts.start === false && !existsSync(path.join(socketDir, 'browser.sock'))) return null;
  const sock = await ensureRunnerBrowserDaemon(ptyd, socketDir);
  if (!sock) return null;
  return {
    state: (q) => socketRequest<RunnerBrowserSnapshot>(sock, 'GET', `/state${browserQueryString(q)}`),
    action: (body, q) =>
      socketRequest<RunnerBrowserSnapshot>(sock, 'POST', `/action${browserQueryString(q)}`, body),
  };
}

/** Adds the project's run activity (hook events) to a snapshot (what `mergeActions` did). */
export function withRunActivity(
  snap: BrowserViewportSnapshot,
  runActions: BrowserAgentAction[],
  runActive: boolean,
): BrowserViewportSnapshot {
  const combined = [...(snap.agentActions ?? []), ...runActions];
  combined.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return {
    ...snap,
    agentActions: combined.slice(0, 30),
    agentActive: Boolean(snap.agentActive || runActive),
  };
}
