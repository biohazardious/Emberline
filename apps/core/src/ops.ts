import { timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { PTYD_MIN_PROTOCOL_VERSION, PTYD_PROTOCOL_VERSION } from '@emberline/protocol';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { runs, tickets } from './db/schema.js';
import {
  RUNNER_MUST_START_AS_ROOT,
  RUNNER_NOT_SECURED,
  RUNNER_SECURITY_UPDATE,
  RUNNER_STARTING,
} from './errors.js';
import type { CoreDeps } from './server.js';

/** Below this much free space a volume is reported as degraded. */
const MIN_FREE_BYTES = 512 * 1024 * 1024;

interface CheckResult {
  ok: boolean;
  detail: string;
}

export const PTRACE_SCOPE_HINT =
  'set kernel.yama.ptrace_scope=1 on the Docker host (sysctl -w kernel.yama.ptrace_scope=1, and in /etc/sysctl.d/ to keep it)';

/**
 * Whether the runner host lets a process trace another of its user ({@link isPtraceUnrestricted}):
 * agents share ptyd's user, so they could then take over ptyd and every command core runs.
 */
function ptraceCheck(connected: boolean, scope: number | null | undefined): CheckResult {
  if (!connected) return { ok: true, detail: 'not connected' };
  if (scope === undefined)
    return { ok: true, detail: 'the runner does not report it (an older runner image)' };
  if (!isPtraceUnrestricted(scope)) return { ok: true, detail: `kernel.yama.ptrace_scope is ${scope}` };
  return {
    ok: false,
    detail: `${scope === null ? 'the host kernel has no Yama' : 'kernel.yama.ptrace_scope is 0'}: agents can trace the runner's own service; ${PTRACE_SCOPE_HINT}`,
  };
}

/** 0, or no Yama at all: any process may trace another of the same user. Undefined: not known. */
export function isPtraceUnrestricted(scope: number | null | undefined): boolean {
  return scope === null || scope === 0;
}

/**
 * Operations endpoints:
 * - `GET /api/health/deep` (public): database, runner connection and protocol, whether agents could
 *   replace or trace the runner's service, writable workspaces and free disk; 503 when anything is
 *   degraded. Docker keeps using the cheap `/api/health`, so a runner outage never restarts core.
 * - `GET /metrics`: Prometheus text format, only when `EMBERLINE_METRICS_TOKEN` is set and sent as
 *   a bearer token (404 otherwise, so the endpoint does not exist by default).
 */
export function registerOpsRoutes(app: FastifyInstance, deps: CoreDeps, startedAt: number): void {
  const http = new Map<string, number>();
  let durationSum = 0;
  let durationCount = 0;
  app.addHook('onResponse', async (request, reply) => {
    const key = `method="${request.method}",status="${Math.floor(reply.statusCode / 100)}xx"`;
    http.set(key, (http.get(key) ?? 0) + 1);
    durationSum += reply.elapsedTime / 1000;
    durationCount += 1;
  });

  const dbFile = path.join(deps.config.dataDir, 'emberline.db');

  const checks = async (): Promise<Record<string, CheckResult>> => {
    const result: Record<string, CheckResult> = {};
    try {
      deps.db.get(sql`select 1`);
      result.database = { ok: true, detail: 'query ok' };
    } catch (error) {
      result.database = { ok: false, detail: (error as Error).message };
    }
    const connected = deps.ptyd.status === 'connected';
    const problem = deps.ptyd.startProblem;
    result.runner = {
      ok: connected,
      detail: problem === 'must_start_as_root' ? RUNNER_MUST_START_AS_ROOT : `ptyd ${deps.ptyd.status}`,
    };
    const version = deps.ptyd.protocolVersion;
    const current = (version ?? 0) >= PTYD_PROTOCOL_VERSION;
    result.runnerProtocol = {
      ok: connected && (version ?? 0) >= PTYD_MIN_PROTOCOL_VERSION,
      detail: `runner ${version ?? 'unknown'}, core needs ${PTYD_MIN_PROTOCOL_VERSION}${
        connected && (version ?? 0) < PTYD_MIN_PROTOCOL_VERSION
          ? `. ${RUNNER_SECURITY_UPDATE}`
          : connected && !current
            ? ` (update available: protocol ${PTYD_PROTOCOL_VERSION}; rebuild the runner with \`make up\`)`
            : ''
      }`,
    };
    // Only a runner of this version locks its socket's directory; an older one is the runner update's
    // business (runnerProtocol). Without the lock core starts nothing (PtydBridge.unsecured).
    const guarded = deps.ptyd.socketGuarded;
    const required = deps.config.requireSecuredRunner;
    result.runnerSocket = {
      ok: !connected || guarded !== false || !current || !required,
      detail: !connected
        ? 'not connected'
        : guarded
          ? "the socket's directory is root's: no agent can replace the runner's service"
          : !current
            ? "an agent can replace the runner's service: its socket's directory is not root's (rebuilding the runner with `make up` locks it)"
            : required
              ? deps.ptyd.lockState === 'starting'
                ? RUNNER_STARTING
                : RUNNER_NOT_SECURED
              : "the socket's directory is not root's, allowed by EMBERLINE_ALLOW_UNSECURED_RUNNER (the dev stack)",
    };
    result.runnerPtrace = ptraceCheck(connected, deps.ptyd.ptraceScope);
    result.workspaces = await access(deps.config.workspacesDir, fsConstants.W_OK).then(
      () => ({ ok: true, detail: 'writable' }),
      (error: Error) => ({ ok: false, detail: error.message }),
    );
    for (const [name, dir] of [
      ['diskData', deps.config.dataDir],
      ['diskWorkspaces', deps.config.workspacesDir],
    ] as const) {
      result[name] = await statfs(dir).then(
        (fs) => {
          const free = fs.bavail * fs.bsize;
          return { ok: free >= MIN_FREE_BYTES, detail: `${Math.round(free / 1024 / 1024)} MiB free` };
        },
        (error: Error) => ({ ok: false, detail: error.message }),
      );
    }
    return result;
  };

  app.get('/api/health/deep', async (_request, reply) => {
    const result = await checks();
    const ok = Object.values(result).every((check) => check.ok);
    reply.code(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', checks: result };
  });

  app.get('/metrics', async (request, reply) => {
    const token = process.env.EMBERLINE_METRICS_TOKEN?.trim();
    const sent = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (!token) return reply.code(404).send({ error: 'not_found', message: 'metrics are disabled' });
    const a = Buffer.from(sent);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'bearer token required' });
    }

    const lines: string[] = [];
    const metric = (name: string, type: 'gauge' | 'counter', help: string, samples: [string, number][]) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) lines.push(`${name}${labels ? `{${labels}}` : ''} ${value}`);
    };
    const count = (rows: { key: string; n: number }[], label: string): [string, number][] =>
      rows.map((row) => [`${label}="${row.key}"`, row.n]);

    metric('emberline_up', 'gauge', 'Core is serving requests.', [['', 1]]);
    metric('emberline_uptime_seconds', 'gauge', 'Seconds since core started.', [
      ['', Math.round((Date.now() - startedAt) / 1000)],
    ]);
    const runStates = deps.db
      .select({ key: runs.state, n: sql<number>`count(*)` })
      .from(runs)
      .groupBy(runs.state)
      .all();
    metric('emberline_runs', 'gauge', 'Runs by agent state.', count(runStates, 'state'));
    const open = deps.db.get<{ n: number }>(sql`select count(*) as n from runs where ended_at is null`);
    metric('emberline_runs_open', 'gauge', 'Runs whose agent process has not ended.', [['', open?.n ?? 0]]);
    const ticketStatuses = deps.db
      .select({ key: tickets.status, n: sql<number>`count(*)` })
      .from(tickets)
      .groupBy(tickets.status)
      .all();
    metric('emberline_tickets', 'gauge', 'Tickets by board column.', count(ticketStatuses, 'status'));
    const scheduler = deps.scheduler.state();
    metric('emberline_scheduler_slots', 'gauge', 'Maximum concurrent runs.', [
      ['', scheduler.maxConcurrentRuns],
    ]);
    metric('emberline_scheduler_busy', 'gauge', 'Runs holding a slot.', [['', scheduler.busy]]);
    metric('emberline_scheduler_queued', 'gauge', 'Runs waiting for a slot or quota.', [
      ['', scheduler.queued],
    ]);
    metric(
      'emberline_quota_paused',
      'gauge',
      'Quota lanes out of quota (agent, credential, model pool); 0 when none.',
      [['', scheduler.windows.length]],
    );
    metric('emberline_runner_connected', 'gauge', 'Core is connected to the runner (ptyd).', [
      ['', deps.ptyd.status === 'connected' ? 1 : 0],
    ]);
    metric('emberline_runner_protocol_version', 'gauge', 'ptyd protocol version of the runner.', [
      ['', deps.ptyd.protocolVersion ?? 0],
    ]);
    const dbSize = await Promise.all(
      ['', '-wal'].map((suffix) =>
        stat(`${dbFile}${suffix}`).then(
          (s) => s.size,
          () => 0,
        ),
      ),
    );
    metric('emberline_db_size_bytes', 'gauge', 'SQLite database size including the WAL.', [
      ['', dbSize.reduce((a, b) => a + b, 0)],
    ]);
    metric('emberline_http_requests_total', 'counter', 'HTTP responses by method and status class.', [
      ...http.entries(),
    ]);
    metric('emberline_http_request_duration_seconds_sum', 'counter', 'Total response time.', [
      ['', durationSum],
    ]);
    metric('emberline_http_request_duration_seconds_count', 'counter', 'Responses timed.', [
      ['', durationCount],
    ]);

    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return `${lines.join('\n')}\n`;
  });
}
