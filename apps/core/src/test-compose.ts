/**
 * Test helpers for compose previews: an in-memory Docker engine behind the command executor, and
 * what `docker compose -p <project> … config --format json` prints for a plain stack.
 */
import { type ExecRequest, type ExecResult, localCommandExecutor, RUNNER_BIN } from './command-exec.js';
import { COMPOSE_OVERRIDE_ENV } from './docker/compose.js';

/** A resolved config with `services` and compose's derived names (`<project>_<key>`); `extra` is merged over it. */
export function composeConfigJson(
  args: readonly string[],
  services: readonly string[],
  extra: Record<string, unknown> = {},
): string {
  const project = args[args.indexOf('-p') + 1] ?? '';
  return JSON.stringify({
    name: project,
    services: Object.fromEntries(services.map((name) => [name, { image: `${name}:test` }])),
    networks: { default: { name: `${project}_default` } },
    ...extra,
  });
}

export const ok = (stdout = ''): ExecResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  truncated: false,
});
export const failed = (stdout: string, exitCode = 1): ExecResult => ({
  exitCode,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  truncated: false,
});

export interface DockerCall {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** What the command got on stdin (the override), when it was run through the `sh` wrapper. */
  stdin?: string;
  file: string;
  inheritEnv?: boolean;
}

/** An engine in memory: `compose up/ps/logs/down/config` per project, plus `curl` against published ports. */
export class FakeEngine {
  calls: DockerCall[] = [];
  curls: string[] = [];
  /** URLs of the framing probes (`curl -D -`), kept apart from the readiness `curls`. */
  probes: string[] = [];
  /** published port → what the probe's curl prints (default: a plain 200). */
  frameHeaders = new Map<number, string>();
  available = true;
  services = ['web', 'db'];
  /** Merged over the resolved config `config --format json` prints (fixed names, say). */
  configExtra: Record<string, unknown> = {};
  /** project → service → state */
  projects = new Map<string, Map<string, string>>();
  /** published host port → project */
  published = new Map<number, string>();
  upResult: ExecResult = ok(' Container web-1 Started\n');
  stateAfterUp = 'running';
  answersHttp = true;
  /** Host ports something else in the engine already holds (`up` fails with compose's message). */
  busyPorts = new Set<number>();
  /** While set, `up` waits for it (or for a cancel that the canceller honours). */
  upGate: Promise<void> | null = null;
  /** Pending `up` calls by execId: resolving one with `cancelled` is what a working cancel does. */
  pendingUps = new Map<string, (result: ExecResult) => void>();
  /** Each `cancelCommand` execId, in order; `honourCancels` says how many to honour (Infinity = all). */
  cancels: string[] = [];
  ignoreCancels = 0;
  curlArgs: string[][] = [];
  /** While set, `down` waits for it; `heldDowns` counts the ones waiting. */
  downGate: Promise<void> | null = null;
  heldDowns = 0;
  /** With a gate set: hold only the `down` of this compose project (null = every project). */
  downGateFor: string | null = null;

  readonly cancel = async (execId: string): Promise<boolean> => {
    this.cancels.push(execId);
    if (this.ignoreCancels > 0) {
      this.ignoreCancels -= 1;
      return false;
    }
    const pending = this.pendingUps.get(execId);
    if (!pending) return false;
    pending({ ...failed('', 137), exitCode: null, cancelled: true });
    return true;
  };

  readonly exec = async (request: ExecRequest): Promise<ExecResult> => {
    if (request.file === RUNNER_BIN.curl && request.args.includes('-D')) {
      const url = request.args.at(-1) ?? '';
      this.probes.push(url);
      return ok(this.frameHeaders.get(Number(new URL(url).port)) ?? 'HTTP/1.1 200 OK\r\n\r\n');
    }
    if (request.file === RUNNER_BIN.curl) {
      const url = request.args.at(-1) ?? '';
      this.curls.push(url);
      this.curlArgs.push(request.args);
      const port = Number(new URL(url).port);
      return ok(this.answersHttp && this.published.has(port) ? '200' : '000');
    }
    let args: string[];
    let stdin: string | undefined;
    if (request.file === RUNNER_BIN.docker) {
      args = request.args;
    } else if (request.file === RUNNER_BIN.sh && request.args[1]?.includes(RUNNER_BIN.docker)) {
      args = request.args.slice(3);
      stdin = request.env?.[COMPOSE_OVERRIDE_ENV];
    } else {
      return localCommandExecutor(request);
    }
    if (args[0] === 'version')
      return this.available ? ok('"29.8.2"\n') : failed('Cannot connect to the Docker daemon');
    this.calls.push({
      args,
      cwd: request.cwd,
      env: request.env ?? {},
      ...(stdin !== undefined ? { stdin } : {}),
      file: request.file,
      inheritEnv: request.inheritEnv,
    });
    const project = args[2] ?? '';
    const verb = args.find((a) => ['config', 'up', 'ps', 'logs', 'down'].includes(a));
    if (verb === 'config') return ok(composeConfigJson(args, this.services, this.configExtra));
    if (verb === 'up') {
      if (this.upGate) {
        const gate = this.upGate;
        const cancelled = await new Promise<ExecResult | null>((resolve) => {
          if (request.execId) this.pendingUps.set(request.execId, resolve);
          void gate.then(() => resolve(null));
        });
        if (request.execId) this.pendingUps.delete(request.execId);
        if (cancelled) return cancelled;
      }
      if (this.upResult.exitCode !== 0) return this.upResult;
      const service = args.at(-1)!;
      const port = Number(/"(\d+):\d+"/.exec(stdin ?? '')?.[1]);
      if (this.busyPorts.has(port)) {
        return failed(
          `Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:${port} failed: port is already allocated\n`,
        );
      }
      const states = this.projects.get(project) ?? new Map<string, string>();
      states.set(service, this.stateAfterUp);
      this.projects.set(project, states);
      if (port) this.published.set(port, project);
      return this.upResult;
    }
    if (verb === 'ps') {
      const states = this.projects.get(project) ?? new Map();
      return ok(
        [...states]
          .map(([service, state]) =>
            JSON.stringify({ Service: service, State: state, Health: '', ExitCode: 0 }),
          )
          .join('\n'),
      );
    }
    if (verb === 'logs') return ok('web-1  | \u001b[31mnginx: [emerg] bind failed\u001b[0m\n');
    if (verb === 'down') {
      if (this.downGate && (this.downGateFor === null || this.downGateFor === project)) {
        this.heldDowns += 1;
        await this.downGate;
      }
      this.projects.delete(project);
      for (const [port, owner] of this.published) if (owner === project) this.published.delete(port);
      return ok();
    }
    return failed(`unexpected docker ${args.join(' ')}`);
  };

  composeCalls(verb: string): DockerCall[] {
    return this.calls.filter((c) => c.args.includes(verb));
  }
}
