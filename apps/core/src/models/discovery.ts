/**
 * Model discovery: one job per provider reads the models its CLI offers (a listing command, or the
 * `/model` picker read from a background terminal) and folds them into the catalog, with an Inbox
 * notice for new models and for a list that could not be read.
 *
 * Jobs run in the runner, one at a time, each with a hard timeout, in a fixed scratch folder under
 * the runner home. Discovery never sends a prompt, never takes a scheduler slot, and no run waits
 * for it. It runs once after the runner first connects, every 24 hours, right after Emberline
 * installs or updates a CLI, and on request; only for providers that are installed and enabled.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentId } from '@emberline/protocol';
import type { PtydClient } from '@emberline/ptyd/client';
import type { Db } from '../db/index.js';
import { getFactorySettings } from '../factory/service.js';
import { getProviderEnvFromSettings } from '../factory/settings.js';
import type { NoticeService } from '../notices/service.js';
import type { ToolchainService } from '../toolchain/service.js';
import {
  type DiscoveryResult,
  type ProviderRead,
  mergeDiscovery,
  publishCatalog,
  readCatalog,
  recordReadFailure,
} from './catalog.js';
import { listCommandsFor, parseAgyModels, parseAiderModels } from './list-command.js';
import { CLAUDE_PICKER, parseClaudePicker, type PickerModel } from './parsers/claude.js';
import { PickerError, type PickerScript, readPicker } from './picker.js';

/**
 * The `kind` a probe's terminal carries. The terminals list leaves it out: a probe is not a person's
 * terminal, and anything typed into it would land in the CLI the reader is driving.
 */
export const MODEL_PROBE_KIND = 'model_probe';

/** The scratch folder, fixed so a CLI that records the folders it ran in records only this one. */
export const PROBE_DIR_NAME = '.emberline-model-probe';

const HARD_TIMEOUT_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** readPicker ends its own steps this long before the hard timeout, so its error names the step. */
const READER_MARGIN_MS = 5_000;
/** After a timeout, how long a job that was told to stop may take to wind down before the next one. */
const STOP_GRACE_MS = 10_000;
const REASON_CHARS = 300;

/** First-run questions each CLI asks, answered for the probe the way runs answer them. */
const PROBE_ENV: Partial<Record<AgentId, Record<string, string>>> = {
  claude: { CLAUDE_CODE_SANDBOXED: '1' },
  gemini: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
};
/** CLIs whose first-run questions `emberline-cli-seed` pre-answers in their config files. */
const SEEDED = new Set<AgentId>(['antigravity', 'copilot', 'gemini']);

/** Key env var → the litellm prefix aider lists that vendor's models under. */
const AIDER_PREFIXES: Record<string, string> = {
  ANTHROPIC_API_KEY: 'anthropic/',
  OPENAI_API_KEY: 'openai/',
  GEMINI_API_KEY: 'gemini/',
};

/**
 * Runs the CLI from the scratch folder (created if missing), after the seed for CLIs that have one,
 * with the runner-tools volume on PATH. Every value is a positional argument, never shell text.
 */
const PROBE_SCRIPT = [
  'mkdir -p "$1" && cd "$1" || exit 1',
  'export PATH="$2:$PATH"',
  'if [ -n "$3" ]; then emberline-cli-seed.mjs "$3" >/dev/null 2>&1 || true; fi',
  'shift 3',
  'exec "$@"',
].join('\n');

export type ProbeClient = Pick<
  PtydClient,
  'spawn' | 'write' | 'snapshot' | 'kill' | 'remove' | 'exec' | 'execCancel' | 'list'
>;

/** What a job is handed. */
export interface JobContext {
  agent: AgentId;
  client: ProbeClient;
  /** Wraps a command so it runs in the scratch folder with the seed and PATH (see PROBE_SCRIPT). */
  probeCommand(file: string, args: string[]): { file: string; args: string[] };
  /** Where the probe starts (it then moves to the scratch folder): the runner home. */
  cwd: string;
  /** The credential env and the first-run answers for this CLI. */
  env: Record<string, string>;
  aiderPrefixes: string[];
  /** Time the job may use; the hard timeout comes a little after it. */
  deadlineMs: number;
  /** Registers how to stop the job when its hard timeout fires (kill its terminal, cancel its command). */
  onStop(stop: () => Promise<void>): void;
  /** Names the terminal the job opened, so a sweep of leftover probes spares it. */
  onSession(id: string): void;
}

/** A provider's read: the models found, or null when there is nothing to read (aider without a key). */
export type DiscoveryJob = (
  ctx: JobContext,
) => Promise<{ models: DiscoveryResult['models']; source: DiscoveryResult['source'] } | null>;

/** A job that runs the provider's listing commands and parses what they print. */
export function listingJob(
  parse: (stdout: string, ctx: JobContext) => DiscoveryResult['models'],
): DiscoveryJob {
  return async (ctx) => {
    const commands = listCommandsFor(ctx.agent, { aiderPrefixes: ctx.aiderPrefixes });
    if (commands.length === 0) return null;
    let running: string | undefined;
    let stopped = false;
    ctx.onStop(async () => {
      stopped = true;
      if (running) await ctx.client.execCancel(running).catch(() => undefined);
    });
    const end = Date.now() + ctx.deadlineMs;
    let stdout = '';
    for (const command of commands) {
      if (stopped) throw new Error('stopped');
      running = `model-probe-${randomUUID()}`;
      const result = await ctx.client.exec({
        ...ctx.probeCommand(command.file, command.args),
        cwd: ctx.cwd,
        env: ctx.env,
        timeoutMs: Math.max(1_000, end - Date.now()),
        execId: running,
      });
      running = undefined;
      if (result.timedOut) throw new Error(`\`${command.file}\` did not finish in time`);
      if (result.exitCode !== 0) {
        const said = lastLines(result.stderr || result.stdout);
        throw new Error(
          `\`${command.file}\` exited with ${result.exitCode ?? result.signal ?? 'an error'}${said ? `: ${said}` : ''}`,
        );
      }
      stdout += `${result.stdout}\n`;
    }
    const models = parse(stdout, ctx);
    if (models.length === 0) throw new Error(`\`${commands[0]!.file}\` listed no models it could read`);
    return { models, source: 'cli' };
  };
}

/** A job that reads the CLI's `/model` picker with `script` and parses the screens. */
export function pickerJob(script: PickerScript, parse: (screens: string[]) => PickerModel[]): DiscoveryJob {
  return async (ctx) => {
    let session: string | undefined;
    let stopped = false;
    const end = async (id: string) => {
      await ctx.client.kill(id).catch(() => undefined);
      await ctx.client.remove(id).catch(() => undefined);
    };
    ctx.onStop(async () => {
      stopped = true;
      if (session) await end(session);
    });
    // The reader's terminal is marked as a probe (left out of the terminals list), and its id kept
    // so the hard timeout can end it.
    const client: Parameters<typeof readPicker>[0] = {
      spawn: async (params) => {
        const info = await ctx.client.spawn({
          ...params,
          meta: { ...params.meta, kind: MODEL_PROBE_KIND, title: `Model discovery · ${ctx.agent}` },
        });
        session = info.id;
        ctx.onSession(info.id);
        if (stopped) {
          await end(info.id);
          throw new Error('stopped');
        }
        return info;
      },
      write: (id, data) => ctx.client.write(id, data),
      snapshot: (id, scrollback) => ctx.client.snapshot(id, scrollback),
      kill: (id, signal) => ctx.client.kill(id, signal),
      remove: (id) => ctx.client.remove(id),
    };
    const { file, args, env } = script.command;
    const { screens } = await readPicker(
      client,
      { ...script, command: { ...ctx.probeCommand(file, args), env: { ...ctx.env, ...env } } },
      { cwd: ctx.cwd, deadlineMs: ctx.deadlineMs },
    );
    return { models: parse(screens), source: 'picker' };
  };
}

/**
 * The providers discovery can read. Gemini CLI, Copilot and Codex get a `pickerJob` line each once
 * their picker parsers exist; until then their models are added by hand.
 */
export const DISCOVERY_JOBS: Partial<Record<AgentId, DiscoveryJob>> = {
  claude: pickerJob(CLAUDE_PICKER, parseClaudePicker),
  antigravity: listingJob((stdout) => parseAgyModels(stdout)),
  aider: listingJob((stdout, ctx) => parseAiderModels(stdout, ctx.aiderPrefixes)),
};

interface StatusEvents {
  on(event: 'status', listener: (status: string) => void): unknown;
  off(event: 'status', listener: (status: string) => void): unknown;
}

interface DiscoveryPtyd extends StatusEvents {
  readonly status: string;
  /** False while nothing may start in the runner (outdated, not secured, the ops service missing). */
  readonly available?: boolean;
  get(): ProbeClient;
}

export interface ModelDiscoveryDeps {
  db: Db;
  /** The runner's ptyd. */
  ptyd: DiscoveryPtyd;
  /** The ops ptyd, when there is one: the runner starts nothing until it answers too. */
  ops?: StatusEvents;
  toolchain: Pick<ToolchainService, 'getToolStatus' | 'onCliInstalled'>;
  notices: Pick<NoticeService, 'newModels' | 'readFailed' | 'readRecovered'>;
  log: (message: string, err?: unknown) => void;
  now?: () => Date;
  intervalMs?: number;
  /** The hard timeout of one job. */
  timeoutMs?: number;
  /** The runner's home as the runner sees it (core mounts it at the same path). */
  runnerHome?: string;
  /** The runner-tools volume, put on the probe's PATH. */
  toolsDir?: string;
  jobs?: Partial<Record<AgentId, DiscoveryJob>>;
}

/** The end of a command's output or a screen, on one line. */
function lastLines(text: string, count = 3): string {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-count)
    .join(' / ');
}

/** What the failure notice says went wrong, in at most REASON_CHARS characters. */
export function failureReason(error: unknown): string {
  let reason: string;
  if (error instanceof PickerError) {
    const screen = lastLines(error.screenTail);
    reason = screen ? `${error.message} (the screen ended with: ${screen})` : error.message;
  } else {
    reason = error instanceof Error ? error.message : String(error);
  }
  // The notice adds its own full stop after the reason.
  reason = reason
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');
  return reason.length > REASON_CHARS ? `${reason.slice(0, REASON_CHARS - 1)}…` : reason;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

export class ModelDiscovery {
  private readonly jobs: Partial<Record<AgentId, DiscoveryJob>>;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly runnerHome: string;
  private readonly toolsDir: string;
  /** Every job waits for the one before it. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Jobs queued and not started yet, per provider: asking again joins the queued one. */
  private readonly queued = new Map<AgentId, Promise<ProviderRead | null>>();
  /** Stops the job running now (shutdown). */
  private stopCurrent: (() => void) | null = null;
  /** The running job: when it started (ISO, as ptyd stamps sessions) and the terminal it opened. */
  private current: { startedAt: string; session: string | null } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private ranOnConnect = false;
  private readonly unsubscribeInstalls: () => void;

  constructor(private readonly deps: ModelDiscoveryDeps) {
    this.jobs = deps.jobs ?? DISCOVERY_JOBS;
    this.now = deps.now ?? (() => new Date());
    this.intervalMs = deps.intervalMs ?? DAY_MS;
    this.timeoutMs = deps.timeoutMs ?? HARD_TIMEOUT_MS;
    this.runnerHome = deps.runnerHome ?? process.env.EMBERLINE_RUNNER_HOME ?? '/home/node';
    this.toolsDir = deps.toolsDir ?? process.env.EMBERLINE_TOOLS_DIR ?? '/opt/ai-tools';
    // A freshly installed or updated CLI may list other models; the install's answer does not wait.
    this.unsubscribeInstalls = deps.toolchain.onCliInstalled((agent) => {
      void this.refresh(agent).catch((err: unknown) => deps.log(`model discovery for ${agent} failed`, err));
    });
  }

  /** Once when the runner first connects (now, if it already is), then every interval. */
  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => this.refreshInBackground(), this.intervalMs);
    this.timer.unref?.();
    this.deps.ptyd.on('status', this.onStatus);
    this.deps.ops?.on('status', this.onStatus);
    this.onStatus();
  }

  /**
   * Ends probe terminals no job of this process is driving: ptyd keeps a session when core's
   * connection drops, so a probe outlives a core that was killed or lost the runner mid-job, and the
   * terminals list hides it. The running job's terminal, and any opened since it started (its spawn
   * may still be on the way back), are spared.
   */
  async sweep(): Promise<void> {
    if (this.deps.ptyd.status !== 'connected') return;
    try {
      const client = this.deps.ptyd.get();
      const { sessions } = await client.list();
      const current = this.current;
      for (const s of sessions) {
        if (s.meta.kind !== MODEL_PROBE_KIND) continue;
        if (current && (s.id === current.session || s.createdAt >= current.startedAt)) continue;
        if (s.status === 'running') await client.kill(s.id).catch(() => undefined);
        await client.remove(s.id);
      }
    } catch (err) {
      this.deps.log('removing leftover model-discovery terminals failed', err);
    }
  }

  /** No new job starts; the running one is stopped and waited for. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribeInstalls();
    this.deps.ptyd.off('status', this.onStatus);
    this.deps.ops?.off('status', this.onStatus);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopCurrent?.();
    await this.chain;
  }

  /**
   * Reads `agent`'s models, or every readable provider's, one job at a time. Resolves with the read
   * of each provider that was read (skipped: not installed or enabled, no job, runner away).
   */
  async refresh(agent?: AgentId): Promise<Partial<Record<AgentId, ProviderRead>>> {
    const agents = agent ? [agent] : (Object.keys(this.jobs) as AgentId[]);
    const reads = await Promise.all(agents.map((a) => this.enqueue(a)));
    return Object.fromEntries(agents.flatMap((a, i) => (reads[i] ? [[a, reads[i]]] : [])));
  }

  /** The runner is connected and may start something. */
  private runnerReady(): boolean {
    return this.deps.ptyd.status === 'connected' && this.deps.ptyd.available !== false;
  }

  /**
   * Each time the runner connects, leftover probes go; the first time it is ready (either bridge's
   * status can make it so), every provider is read, after that sweep.
   */
  private readonly onStatus = () => {
    if (this.stopped || this.deps.ptyd.status !== 'connected') return;
    const firstRead = !this.ranOnConnect && this.runnerReady();
    if (firstRead) this.ranOnConnect = true;
    void this.sweep().then(() => {
      if (firstRead) this.refreshInBackground();
    });
  };

  private refreshInBackground(): void {
    void this.refresh().catch((err: unknown) => this.deps.log('model discovery failed', err));
  }

  private enqueue(agent: AgentId): Promise<ProviderRead | null> {
    const waiting = this.queued.get(agent);
    if (waiting) return waiting;
    const job = this.chain.then(() => {
      this.queued.delete(agent);
      return this.runOne(agent);
    });
    this.queued.set(agent, job);
    this.chain = job.catch(() => undefined);
    return job;
  }

  private async runOne(agent: AgentId): Promise<ProviderRead | null> {
    const job = this.jobs[agent];
    // A runner that is away or refuses to start anything is not a failed read.
    if (!job || this.stopped || !this.runnerReady()) return null;
    if (!getFactorySettings(this.deps.db).enabledProviders.includes(agent)) return null;
    const tool = await this.deps.toolchain.getToolStatus(agent);
    // An install in progress triggers its own read when it is done.
    if (!tool.installed || tool.installing) return null;
    // `installed` is what the toolchain says when it cannot tell the version without running the CLI.
    const cliVersion = tool.version && tool.version !== 'installed' ? tool.version : null;

    if (this.stopped) return null;

    const outcome = await this.runWithTimeout(agent, job);
    if (outcome === 'shutdown' || (outcome.ok && outcome.value === null)) return null;
    const now = this.now();
    if (outcome.ok) {
      const { added } = mergeDiscovery(this.deps.db, agent, { ...outcome.value!, cliVersion }, now);
      if (added.length > 0) this.deps.notices.newModels(agent, added);
      this.deps.notices.readRecovered(agent);
    } else {
      const reason = failureReason(outcome.error);
      const { firstFailure } = recordReadFailure(this.deps.db, agent, cliVersion, reason, now);
      if (firstFailure) this.deps.notices.readFailed(agent, cliVersion, reason);
      this.deps.log(`could not read ${agent}'s models: ${reason}`);
    }
    publishCatalog(this.deps.db);
    return readCatalog(this.deps.db)[agent].read;
  }

  /**
   * Runs one job under the hard timeout. On expiry (or shutdown) the job is told to stop, which
   * kills its terminal or cancels its command, and is given a moment to wind down; the next job
   * starts only after that.
   */
  private async runWithTimeout(
    agent: AgentId,
    job: DiscoveryJob,
  ): Promise<Settled<Awaited<ReturnType<DiscoveryJob>>> | 'shutdown'> {
    let stopJob: (() => Promise<void>) | undefined;
    let interrupt: (why: 'timeout' | 'shutdown') => void = () => undefined;
    const interrupted = new Promise<'timeout' | 'shutdown'>((resolve) => (interrupt = resolve));
    const timer = setTimeout(() => interrupt('timeout'), this.timeoutMs);
    timer.unref?.();
    this.stopCurrent = () => interrupt('shutdown');
    const current = { startedAt: new Date().toISOString(), session: null as string | null };
    this.current = current;
    try {
      const running = settle(
        Promise.resolve().then(() =>
          job({
            agent,
            client: this.deps.ptyd.get(),
            probeCommand: (file, args) => this.probeCommand(agent, file, args),
            cwd: this.runnerHome,
            env: this.envFor(agent),
            aiderPrefixes: this.aiderPrefixes(),
            deadlineMs: Math.max(1_000, this.timeoutMs - READER_MARGIN_MS),
            onStop: (stop) => {
              stopJob = stop;
            },
            onSession: (id) => {
              current.session = id;
            },
          }),
        ),
      );
      const first = await Promise.race([running, interrupted]);
      if (typeof first !== 'string') return first;
      await stopJob?.().catch(() => undefined);
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<'late'>((resolve) => {
        graceTimer = setTimeout(() => resolve('late'), STOP_GRACE_MS);
        graceTimer.unref?.();
      });
      const late = (await Promise.race([running, grace])) === 'late';
      clearTimeout(graceTimer);
      if (late) this.deps.log(`model discovery for ${agent} did not wind down after it was stopped`);
      if (first === 'shutdown') return 'shutdown';
      return {
        ok: false,
        error: new Error(`it did not finish within ${Math.round(this.timeoutMs / 1000)} s and was stopped`),
      };
    } finally {
      clearTimeout(timer);
      this.stopCurrent = null;
      this.current = null;
    }
  }

  private probeCommand(agent: AgentId, file: string, args: string[]): { file: string; args: string[] } {
    const pathPrefix = `${path.join(this.toolsDir, 'bin')}:${path.join(this.toolsDir, 'npm', 'bin')}`;
    return {
      file: 'bash',
      args: [
        '-c',
        PROBE_SCRIPT,
        'emberline-model-probe',
        path.join(this.runnerHome, PROBE_DIR_NAME),
        pathPrefix,
        SEEDED.has(agent) ? agent : '',
        file,
        ...args,
      ],
    };
  }

  /**
   * The CLI's own login when it has one; otherwise the stored key's env (none stored: empty, and the
   * CLI says it is signed out, which reads as a failure).
   */
  private envFor(agent: AgentId): Record<string, string> {
    const auth = getFactorySettings(this.deps.db).providerAuth?.[agent];
    const credential = auth?.method === 'oauth_cli' ? {} : getProviderEnvFromSettings(this.deps.db, agent);
    return { ...credential, ...PROBE_ENV[agent] };
  }

  /** The vendors aider has a stored key for. */
  private aiderPrefixes(): string[] {
    const env = getProviderEnvFromSettings(this.deps.db, 'aider');
    return Object.keys(AIDER_PREFIXES)
      .filter((key) => env[key])
      .map((key) => AIDER_PREFIXES[key]!);
  }
}
