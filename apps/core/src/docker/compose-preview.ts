/**
 * Starting and watching a compose preview: every step runs the Docker CLI (or curl) in the runner
 * through command-exec, with the engine's client variables. RunService records the outcome.
 */
import { execCommand, type ExecResult } from '../command-exec.js';
import {
  answeredHttp,
  COMPOSE_OVERRIDE_ENV,
  composeDownArgs,
  composeLogsArgs,
  composeLsArgs,
  composeOutputTail,
  composeOverrideYaml,
  composePsArgs,
  composeServiceState,
  composeServicesArgs,
  composeShell,
  composeUpArgs,
  builderPruneArgs,
  imagePruneArgs,
  isPortConflict,
  parseComposeLs,
  parseComposePs,
  parseComposeServices,
  reclaimArgs,
} from './compose.js';

export interface ComposePreviewTiming {
  /** `up -d --build`: builds can take minutes. */
  upTimeoutMs: number;
  /** After `up`: how long the service has to run and answer HTTP. */
  readyTimeoutMs: number;
  pollMs: number;
  /** A stop waits this long for a cancelled start to settle before its `down`. */
  stopSettleMs: number;
  /** ...and cancels once more after this long (a cancel can miss a command that was just starting). */
  cancelRetryMs: number;
}

export const DEFAULT_COMPOSE_PREVIEW_TIMING: ComposePreviewTiming = {
  upTimeoutMs: 15 * 60_000,
  readyTimeoutMs: 120_000,
  pollMs: 2_000,
  stopSettleMs: 10_000,
  cancelRetryMs: 1_000,
};

/** `up` attempts when the host port turns out to be taken in the engine (each on another port). */
export const COMPOSE_UP_ATTEMPTS = 3;

const SHORT_TIMEOUT_MS = 60_000;
export const COMPOSE_DOWN_TIMEOUT_MS = 2 * 60_000;
/** Status, logs and down go by project name; `/` has no compose file to pick up by accident. */
const NEUTRAL_CWD = '/';

export interface ComposePreviewTarget {
  worktreePath: string;
  /** `-p`: always from the run (composeProjectName), never from the file or the agent's env. */
  project: string;
  file: string;
  service: string;
  containerPort: number;
  /** Changes when a taken port is retried on another one. */
  hostPort: number;
  /** The engine's name on the compose network, where the published port answers. */
  engineHost: string;
  /** The engine's client variables (DOCKER_HOST, TLS). */
  env: Record<string, string>;
}

export type ComposePreviewOutcome =
  | { ok: true }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; error: string; logs: string | null };

/**
 * `config --services`, then `up -d --build` with the port override on stdin, then polls `ps` and an
 * HTTP request to the published port until the service answers or `readyTimeoutMs` passed.
 */
export async function runComposePreview(
  target: ComposePreviewTarget,
  timing: ComposePreviewTiming,
  control: {
    execId: string;
    cancelled: () => boolean;
    /** Another free port for the preview (never `taken`), recorded as the preview's port. */
    reallocate: (taken: ReadonlySet<number>) => Promise<number>;
  },
): Promise<ComposePreviewOutcome> {
  const { project, file, service } = target;
  const listed = await run(composeServicesArgs(project, file), target.worktreePath, target.env, SHORT_TIMEOUT_MS);
  if (control.cancelled()) return { ok: false, cancelled: true };
  if (!listed.ok) return { ok: false, error: `docker compose config failed (${listed.how})`, logs: listed.output };
  const services = parseComposeServices(listed.result!.stdout);
  if (!services.includes(service)) return { ok: false, error: `"${service}" is not a service in ${file}`, logs: null };

  const shell = composeShell(composeUpArgs(project, file, service));
  const tried = new Set<number>();
  for (let attempt = 1; ; attempt++) {
    const override = composeOverrideYaml({ service, port: target.containerPort, hostPort: target.hostPort, services });
    const up = await run(shell.args, target.worktreePath, { ...target.env, [COMPOSE_OVERRIDE_ENV]: override }, timing.upTimeoutMs, {
      file: shell.file,
      execId: control.execId,
    });
    if (control.cancelled() || up.result?.cancelled) return { ok: false, cancelled: true };
    if (up.ok) break;
    // Something else in the engine (an agent's container) holds the port: take the next free one.
    if (attempt < COMPOSE_UP_ATTEMPTS && isPortConflict(up.output)) {
      tried.add(target.hostPort);
      try {
        target.hostPort = await control.reallocate(tried);
      } catch {
        return { ok: false, error: `docker compose up failed (${up.how}) and no other preview port is free`, logs: up.output };
      }
      if (control.cancelled()) return { ok: false, cancelled: true };
      continue;
    }
    return { ok: false, error: `docker compose up failed (${up.how})`, logs: up.output };
  }

  const deadline = Date.now() + timing.readyTimeoutMs;
  for (;;) {
    if (control.cancelled()) return { ok: false, cancelled: true };
    const state = await composeServiceStatus(target);
    if (state === 'stopped') {
      return { ok: false, error: `the "${service}" container stopped`, logs: await composeLogsTail(target) };
    }
    if (state === 'running' && (await answersHttp(target))) return { ok: true };
    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: `"${service}" did not answer HTTP on port ${target.containerPort} within ${Math.round(timing.readyTimeoutMs / 1000)} s`,
        logs: await composeLogsTail(target),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, timing.pollMs));
  }
}

/** The preview service's state from `ps`; `unknown` when compose could not answer. */
export async function composeServiceStatus(
  target: Pick<ComposePreviewTarget, 'project' | 'service' | 'env'>,
): Promise<ReturnType<typeof composeServiceState> | 'unknown'> {
  const ps = await run(composePsArgs(target.project), NEUTRAL_CWD, target.env, SHORT_TIMEOUT_MS);
  if (!ps.ok) return 'unknown';
  return composeServiceState(parseComposePs(ps.result!.stdout), target.service);
}

/**
 * `down --remove-orphans` (stop: volumes and images stay), or with `-v` and `--rmi local` (cleanup).
 * Never throws; `exitCode` is null when compose did not exit by itself (timeout, could not run).
 */
export async function composeDown(
  project: string,
  env: Record<string, string>,
  opts: { volumes?: boolean; images?: boolean } = {},
): Promise<{ ok: boolean; output: string; exitCode: number | null }> {
  const down = await run(composeDownArgs(project, opts), NEUTRAL_CWD, env, COMPOSE_DOWN_TIMEOUT_MS);
  return { ok: down.ok, output: down.output, exitCode: down.result && !down.result.timedOut ? down.result.exitCode : null };
}

/** Every compose project in the engine (`compose ls -a`); null when compose could not answer. */
export async function composeProjects(env: Record<string, string>): Promise<string[] | null> {
  const ls = await run(composeLsArgs(), NEUTRAL_CWD, env, SHORT_TIMEOUT_MS);
  return ls.ok ? parseComposeLs(ls.result!.stdout) : null;
}

/** `image prune` and `builder prune`, each `-f --filter until=72h`. Never throws. */
export async function pruneImages(env: Record<string, string>): Promise<{ ok: boolean; output: string }> {
  const images = await run(imagePruneArgs(), NEUTRAL_CWD, env, COMPOSE_DOWN_TIMEOUT_MS);
  const cache = await run(builderPruneArgs(), NEUTRAL_CWD, env, COMPOSE_DOWN_TIMEOUT_MS);
  return { ok: images.ok && cache.ok, output: [images.output, cache.output].filter(Boolean).join('\n') };
}

/**
 * A short read-only `docker <args>` in the runner (the Docker page's listings and logs): stdout in
 * `result`, the sanitised tail of the output in `output`. Never throws.
 */
export function dockerQuery(args: string[], env: Record<string, string>): Promise<Ran> {
  return run(args, NEUTRAL_CWD, env, SHORT_TIMEOUT_MS);
}

/**
 * Gives the files under `dir` back to the runner user through a throwaway container in the engine
 * (see {@link reclaimArgs}). Never throws.
 */
export async function reclaimFiles(dir: string, env: Record<string, string>): Promise<{ ok: boolean; output: string }> {
  let args: string[];
  try {
    args = reclaimArgs(dir);
  } catch (error) {
    return { ok: false, output: (error as Error).message };
  }
  const reclaim = await run(args, NEUTRAL_CWD, env, COMPOSE_DOWN_TIMEOUT_MS);
  return { ok: reclaim.ok, output: reclaim.output };
}

async function composeLogsTail(target: ComposePreviewTarget): Promise<string | null> {
  const logs = await run(composeLogsArgs(target.project, target.service), NEUTRAL_CWD, target.env, SHORT_TIMEOUT_MS);
  return logs.output || null;
}

/** Any HTTP answer on the published port, asked from the runner on the compose network. */
async function answersHttp(target: ComposePreviewTarget): Promise<boolean> {
  const url = `http://${target.engineHost}:${target.hostPort}/`;
  try {
    const result = await execCommand({
      file: 'curl',
      // A proxy in the runner's environment would answer for the engine.
      args: ['-s', '--noproxy', '*', '-o', '/dev/null', '-m', '5', '-w', '%{http_code}', url],
      cwd: NEUTRAL_CWD,
      timeoutMs: 10_000,
    });
    return answeredHttp(result.stdout);
  } catch {
    return false;
  }
}

export interface Ran {
  ok: boolean;
  result?: ExecResult;
  /** exit code, timeout or error, for messages. */
  how: string;
  /** Sanitised tail of stdout + stderr (untrusted). */
  output: string;
}

async function run(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  opts: { file?: string; execId?: string } = {},
): Promise<Ran> {
  try {
    const result = await execCommand({
      file: opts.file ?? 'docker',
      args,
      cwd,
      env,
      timeoutMs,
      ...(opts.execId ? { execId: opts.execId } : {}),
    });
    const output = composeOutputTail(`${result.stdout}${result.stderr}`);
    const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled;
    const how = result.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `exit ${result.exitCode}`;
    return { ok, result, how, output };
  } catch (error) {
    return { ok: false, how: 'could not run', output: composeOutputTail((error as Error).message) };
  }
}
