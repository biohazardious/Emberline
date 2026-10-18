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
  composeOutputTail,
  composeOverrideYaml,
  composePsArgs,
  composeServiceState,
  composeServicesArgs,
  composeShell,
  composeUpArgs,
  parseComposePs,
  parseComposeServices,
} from './compose.js';

export interface ComposePreviewTiming {
  /** `up -d --build`: builds can take minutes. */
  upTimeoutMs: number;
  /** After `up`: how long the service has to run and answer HTTP. */
  readyTimeoutMs: number;
  pollMs: number;
}

export const DEFAULT_COMPOSE_PREVIEW_TIMING: ComposePreviewTiming = {
  upTimeoutMs: 15 * 60_000,
  readyTimeoutMs: 120_000,
  pollMs: 2_000,
};

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
  control: { execId: string; cancelled: () => boolean },
): Promise<ComposePreviewOutcome> {
  const { project, file, service } = target;
  const listed = await run(composeServicesArgs(project, file), target.worktreePath, target.env, SHORT_TIMEOUT_MS);
  if (control.cancelled()) return { ok: false, cancelled: true };
  if (!listed.ok) return { ok: false, error: `docker compose config failed (${listed.how})`, logs: listed.output };
  const services = parseComposeServices(listed.result!.stdout);
  if (!services.includes(service)) return { ok: false, error: `"${service}" is not a service in ${file}`, logs: null };

  const override = composeOverrideYaml({ service, port: target.containerPort, hostPort: target.hostPort, services });
  const shell = composeShell(composeUpArgs(project, file, service));
  const up = await run(shell.args, target.worktreePath, { ...target.env, [COMPOSE_OVERRIDE_ENV]: override }, timing.upTimeoutMs, {
    file: shell.file,
    execId: control.execId,
  });
  if (control.cancelled() || up.result?.cancelled) return { ok: false, cancelled: true };
  if (!up.ok) return { ok: false, error: `docker compose up failed (${up.how})`, logs: up.output };

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

/** `down --remove-orphans` (stop; volumes stay) or with `-v` (teardown). Never throws. */
export async function composeDown(
  project: string,
  env: Record<string, string>,
  opts: { volumes?: boolean } = {},
): Promise<{ ok: boolean; output: string }> {
  const down = await run(composeDownArgs(project, opts), NEUTRAL_CWD, env, COMPOSE_DOWN_TIMEOUT_MS);
  return { ok: down.ok, output: down.output };
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
      args: ['-s', '-o', '/dev/null', '-m', '5', '-w', '%{http_code}', url],
      cwd: NEUTRAL_CWD,
      timeoutMs: 10_000,
    });
    return answeredHttp(result.stdout);
  } catch {
    return false;
  }
}

interface Ran {
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
