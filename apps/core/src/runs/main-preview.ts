/**
 * The container preview of a project's main workspace: the approved worktree.yml's compose preview
 * service, started from main in its own compose project (`emberline-main-<p8>-preview`, apart from
 * Build & Verify's `emberline-main-<p8>`). Its state lives in project settings `mainPreview`; the
 * engine is the truth for whether it runs, so a core restart reads what the engine has. RunService
 * owns it and shares its preview port allocator, so run and main previews never take the same port.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isComposeService, type MainPreviewStatus, type WorktreeComposeService } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { cancelCommand } from '../command-exec.js';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { readProjectSettings, writeProjectSettings } from '../db/project-settings.js';
import { projects, projectSettings } from '../db/schema.js';
import { engineHostName } from '../docker/compose.js';
import {
  CLEANUP_DOWN,
  type ComposePreviewTiming,
  composeDown,
  composeServiceStatus,
  runComposePreview,
  settlesWithin,
} from '../docker/compose-preview.js';
import {
  DOCKER_ENGINE_OFF_TEXT,
  DOCKER_ENGINE_UNREACHABLE_HINT,
  type DockerEngine,
  mainPreviewComposeProjectName,
  withHint,
} from '../docker/engine.js';
import { conflict, HttpError, notFound } from '../errors.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { approvedPreviewService } from '../worktree-config/load.js';
import { previewUrl } from './preview-url.js';

/** The project settings key of the main preview's state. */
export const MAIN_PREVIEW_KEY = 'mainPreview';

const MainPreviewState = z.object({
  /** `starting` and `running` hold the port; `failed` and `stopped` do not. */
  status: z.enum(['starting', 'running', 'failed', 'stopped']),
  port: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  error: z.string().optional(),
  /** The end of the build or container output of a failed start or refresh (untrusted). */
  logs: z.string().nullable().optional(),
  /** What it was started with (the approval may change later). */
  file: z.string().optional(),
  service: z.string().optional(),
  containerPort: z.number().int().optional(),
  refreshedAt: z.string().optional(),
});
type MainPreviewState = z.infer<typeof MainPreviewState>;

/** A start core did not see end (it restarted meanwhile) whose service never came up. */
const RESTARTED = 'Emberline restarted before the preview was ready; start it again';

/** Why main has no container preview service; the start's 409 says the same. */
const NO_COMPOSE_SERVICE = 'the approved worktree.yml has no compose preview service, so main has no container preview';

/** The 409 of a compose preview without the engine (run previews say the same). */
export function composeEngineOffMessage(serviceName: string, engineError: string | undefined): string {
  const base = `the preview service "${serviceName}" runs in Docker`;
  return engineError
    ? withHint(`${base}, but the Docker engine is not reachable: ${engineError}`, DOCKER_ENGINE_UNREACHABLE_HINT)
    : `${base}. ${DOCKER_ENGINE_OFF_TEXT}`;
}

/** How a compose preview shows where the command box is: what Emberline runs for it. */
export function composePreviewLabel(service: WorktreeComposeService): string {
  return `docker compose up ${service.compose.service} (${service.compose.file}, port ${service.compose.port})`;
}

function missingComposeFile(file: string): string {
  return `${file} is not in main yet: merge the work that adds it, then start the preview`;
}

export interface MainPreviewDeps {
  db: Db;
  config: Pick<CoreConfig, 'dockerHost'>;
  docker: DockerEngine;
  /** The engine's variables for main (RunService.dockerEnvForMain). */
  envForMain: (projectId: string) => Promise<Record<string, string>>;
  /** Runs `fn` under the preview port lock (allocation and its record happen together). */
  withPorts: <T>(fn: () => Promise<T>) => Promise<T>;
  /** A free port of the docker range for this project's main preview, never one in `exclude`. Under {@link withPorts}. */
  allocatePort: (projectId: string, exclude: ReadonlySet<number>) => Promise<number>;
  timing: () => ComposePreviewTiming;
  log?: () => { warn: (obj: object, msg: string) => void } | undefined;
}

/** A start or refresh running `up` and the readiness checks in the background. */
interface Job {
  execId: string;
  cancelled: boolean;
  /** A stop stopped waiting for it: when it settles, its project is taken down once more. */
  abandoned: boolean;
  generation: number;
  done: Promise<void>;
}

type DownResult = Awaited<ReturnType<typeof composeDown>>;

export class MainPreviews {
  /** One start, stop or refresh per project at a time. */
  private readonly lock = new KeyedMutex();
  private readonly jobs = new Map<string, Job>();
  private readonly generations = new Map<string, number>();
  /** Projects being deleted: a start abandoned meanwhile is taken down with its volumes when it settles. */
  private readonly deleting = new Set<string>();

  constructor(private readonly deps: MainPreviewDeps) {}

  /**
   * The status as the engine reports it. A start that core did not see end (it restarted) is
   * reconciled first, under the project's lock; nothing else changes the stored state.
   */
  async status(projectId: string, requestHost?: string): Promise<MainPreviewStatus> {
    const project = this.project(projectId);
    if (this.interrupted(projectId)) await this.lock.run(projectId, () => this.reconcileHeld(projectId));
    const service = this.composeService(projectId);
    const label = service ? composePreviewLabel(service) : null;
    const unavailable = await this.unavailableReason(project.path, service);
    const idle: MainPreviewStatus = {
      runId: null,
      targetId: 'main',
      status: 'stopped',
      kind: 'compose',
      terminalId: null,
      command: null,
      port: null,
      url: null,
      detectedCommand: label,
      error: null,
      logs: null,
      ...(unavailable ? { unavailable } : {}),
    };
    const state = this.read(projectId);
    if (!state || state.status === 'stopped') return idle;
    const port = state.port;
    const base: MainPreviewStatus = {
      ...idle,
      command: state.service && state.file && state.containerPort ? labelOf(state) : label,
      port,
      url: port ? previewUrl(port, requestHost) : null,
    };
    if (state.status === 'failed') return { ...base, status: 'failed', error: state.error ?? 'the preview failed', logs: state.logs ?? null };
    if (state.status === 'starting' && this.jobs.has(projectId)) return { ...base, status: 'starting' };
    await this.deps.docker.ready();
    if (!this.deps.docker.status.available) return { ...base, status: 'exited', error: 'the Docker engine is not reachable' };
    const engine = await composeServiceStatus({
      project: mainPreviewComposeProjectName(projectId),
      service: state.service ?? service?.compose.service ?? '',
      env: this.deps.docker.cliEnv(),
    });
    if (engineRuns(engine)) return { ...base, status: 'running' };
    // `starting` without a job here: a restart left it and the engine could not be asked yet.
    if (state.status === 'starting') return { ...base, status: 'failed', error: RESTARTED };
    const name = state.service ?? service?.compose.service;
    return { ...base, status: 'exited', error: name ? `the "${name}" container is not running` : 'the preview container is not running' };
  }

  /**
   * At boot: reconciles every project's start that core did not see end. Each runs under its
   * project's lock and is idempotent, like the lazy one in {@link status} and {@link refresh}.
   */
  async reconcileInterrupted(): Promise<void> {
    for (const row of this.deps.db.select({ projectId: projectSettings.projectId }).from(projectSettings).all()) {
      if (!this.interrupted(row.projectId)) continue;
      await this.lock.run(row.projectId, () => this.reconcileHeld(row.projectId)).catch(() => undefined);
    }
  }

  /**
   * Starts main's preview: 409 without a compose preview service, without the engine or without the
   * compose file in main. A start while one is starting cancels the first. Returns `starting`.
   */
  async start(projectId: string, requestHost?: string): Promise<MainPreviewStatus> {
    const project = this.project(projectId);
    const { service, port } = await this.lock.run(projectId, async () => {
      const service = this.composeService(projectId);
      if (!service) {
        throw new HttpError(409, 'no_compose_preview', NO_COMPOSE_SERVICE, {
          hint: 'add a service with `compose:` and `preview: true` to .emberline/worktree.yml and approve it',
        });
      }
      await this.deps.docker.ready();
      if (!this.deps.docker.status.available || !this.deps.config.dockerHost) {
        throw conflict(composeEngineOffMessage(service.name, this.deps.docker.status.error));
      }
      if (!existsSync(path.join(project.path, service.compose.file))) {
        throw conflict(missingComposeFile(service.compose.file), 'compose_file_missing');
      }
      const generation = this.nextGeneration(projectId);
      await this.stopHeld(projectId);
      const env = await this.deps.envForMain(projectId);
      const port = await this.deps.withPorts(async () => {
        const port = await this.deps.allocatePort(projectId, new Set());
        this.write(projectId, {
          status: 'starting',
          port,
          startedAt: new Date().toISOString(),
          file: service.compose.file,
          service: service.compose.service,
          containerPort: service.compose.port,
        });
        return port;
      });
      this.launch(projectId, project.path, service, port, env, generation, false);
      return { service, port };
    });
    const label = composePreviewLabel(service);
    return {
      runId: null,
      targetId: 'main',
      status: 'starting',
      kind: 'compose',
      terminalId: null,
      command: label,
      port,
      url: previewUrl(port, requestHost),
      detectedCommand: label,
      error: null,
      logs: null,
    };
  }

  /** A person's Stop: ends a start still going, takes the project down (volumes kept), frees the port. */
  async stop(projectId: string, requestHost?: string): Promise<MainPreviewStatus> {
    this.project(projectId);
    await this.lock.run(projectId, () => this.stopHeld(projectId));
    return this.status(projectId, requestHost);
  }

  /**
   * After a merge into main: a running preview is rebuilt (`up -d --build`, a fresh override) on the
   * same port. A failure is recorded as `failed` with the logs tail. Resolves when it ended; never throws.
   */
  async refresh(projectId: string): Promise<void> {
    const job = await this.lock
      .run(projectId, async () => {
        await this.reconcileHeld(projectId);
        const state = this.read(projectId);
        if (state?.status !== 'running' || !state.port || this.jobs.has(projectId)) return null;
        if ((await this.status(projectId)).status !== 'running') return null;
        const project = this.project(projectId);
        const service = this.composeService(projectId);
        if (!service || !existsSync(path.join(project.path, service.compose.file))) {
          await this.stopHeld(projectId);
          this.write(projectId, {
            ...state,
            status: 'failed',
            error: `the refresh after a merge failed: ${service ? missingComposeFile(service.compose.file) : NO_COMPOSE_SERVICE}`,
            logs: null,
          });
          return null;
        }
        const env = await this.deps.envForMain(projectId);
        this.write(projectId, { ...state, file: service.compose.file, service: service.compose.service, containerPort: service.compose.port });
        return this.launch(projectId, project.path, service, state.port, env, this.nextGeneration(projectId), true);
      })
      .catch(() => null);
    await job?.done;
  }

  /**
   * A Docker page Stop or Remove of `name` (the main preview project): through the main preview stop
   * when it is started (state stopped, port free), then the project's `down` if that did not run it.
   */
  takeDown(projectId: string, name: string, env: Record<string, string>, action: 'stop' | 'remove'): Promise<DownResult> {
    const opts = action === 'remove' ? CLEANUP_DOWN : {};
    return this.lock.run(projectId, async () => {
      const state = this.read(projectId);
      if ((state && state.status !== 'stopped') || this.jobs.has(projectId)) {
        let taken: DownResult | undefined;
        await this.stopHeld(projectId, {
          volumes: action === 'remove',
          onDown: (project, down) => {
            if (project === name) taken = down;
          },
        });
        if (taken) return taken;
      }
      return composeDown(name, env, opts);
    });
  }

  /** Before a project is deleted: ends a start still going and takes the preview down with its volumes and images. */
  async removeForProject(projectId: string): Promise<void> {
    // Kept for good once the project is gone (ids are never reused), or until a failed delete calls
    // cancelRemove: a start abandoned by the stop below is taken down with CLEANUP_DOWN when it
    // settles, even while the project row still exists.
    this.deleting.add(projectId);
    await this.lock.run(projectId, async () => {
      this.nextGeneration(projectId);
      await this.stopHeld(projectId, { volumes: true });
    });
  }

  /** The project delete failed after {@link removeForProject}: the project stays, so its previews are ordinary again. */
  cancelRemove(projectId: string): void {
    this.deleting.delete(projectId);
  }

  /** Ports main previews hold (`starting` or `running`), except `exceptProjectId`'s. */
  reservedPorts(exceptProjectId?: string): Set<number> {
    const ports = new Set<number>();
    for (const row of this.deps.db.select().from(projectSettings).all()) {
      if (row.projectId === exceptProjectId) continue;
      const parsed = MainPreviewState.safeParse((row.settings as Record<string, unknown> | null)?.[MAIN_PREVIEW_KEY]);
      if (!parsed.success || parsed.data.port === null) continue;
      if (parsed.data.status === 'starting' || parsed.data.status === 'running') ports.add(parsed.data.port);
    }
    return ports;
  }

  /**
   * `up` and the readiness checks in the background. Its outcome is recorded only while it is the
   * project's current job: a stop or a newer start cancels it.
   */
  private launch(
    projectId: string,
    mainPath: string,
    service: WorktreeComposeService,
    hostPort: number,
    env: Record<string, string>,
    generation: number,
    refresh: boolean,
  ): Job {
    const project = mainPreviewComposeProjectName(projectId);
    const job: Job = { execId: `main-preview-${projectId}-${randomUUID()}`, cancelled: false, abandoned: false, generation, done: Promise.resolve() };
    const target = {
      worktreePath: mainPath,
      project,
      file: service.compose.file,
      service: service.compose.service,
      containerPort: service.compose.port,
      hostPort,
      engineHost: engineHostName(this.deps.config.dockerHost ?? ''),
      env,
    };
    const current = () => !job.cancelled && this.jobs.get(projectId) === job && this.hasProject(projectId);
    const patch = (fields: Partial<MainPreviewState>) => {
      const state = this.read(projectId);
      if (state) this.write(projectId, { ...state, ...fields });
    };
    const reallocate = (taken: ReadonlySet<number>) =>
      this.deps.withPorts(async () => {
        if (!current()) throw new Error('the preview was stopped');
        const port = await this.deps.allocatePort(projectId, taken);
        patch({ port });
        return port;
      });
    job.done = runComposePreview(target, this.deps.timing(), { execId: job.execId, cancelled: () => job.cancelled, reallocate })
      .then(async (outcome) => {
        if (!current()) return;
        if (outcome.ok) {
          const { error: _error, logs: _logs, ...rest } = this.read(projectId) ?? { status: 'running', port: null, startedAt: null };
          this.write(projectId, { ...rest, status: 'running', port: target.hostPort, ...(refresh ? { refreshedAt: new Date().toISOString() } : {}) });
          return;
        }
        if (outcome.cancelled) return;
        // Take down what it left (a container that exited, a half-built project) and free its port.
        await composeDown(project, env);
        if (!current()) return;
        patch({ status: 'failed', error: refresh ? `the refresh after a merge failed: ${outcome.error}` : outcome.error, logs: outcome.logs });
        this.deps.log?.()?.warn({ projectId, project, error: outcome.error }, refresh ? 'main preview refresh failed' : 'main preview failed');
      })
      .catch(() => undefined)
      .finally(() => {
        // A cancelled job's entry is the stop's to remove, once its down ran.
        if (this.jobs.get(projectId) === job && !job.cancelled) this.jobs.delete(projectId);
      });
    this.jobs.set(projectId, job);
    // A start a stop gave up waiting for may still have created containers: take them down when it
    // settles, unless the project started another preview meanwhile (under its lock).
    void job.done
      .then(async () => {
        if (!job.abandoned) return;
        await this.lock.run(projectId, async () => {
          const gone = !this.hasProject(projectId) || this.deleting.has(projectId);
          if (!gone && this.generations.get(projectId) !== job.generation) return;
          await composeDown(project, env, gone ? CLEANUP_DOWN : {});
        });
      })
      .catch(() => undefined);
    return job;
  }

  /**
   * Ends what the last start began: cancels a job still going (bounded, cancelled once more after a
   * short delay) and takes the project down (`volumes`: with its volumes and images, whether or not
   * it runs), then records it stopped with no port. Callers hold the project's lock.
   */
  private async stopHeld(
    projectId: string,
    { volumes = false, onDown }: { volumes?: boolean; onDown?: (project: string, down: DownResult) => void } = {},
  ): Promise<void> {
    const state = this.read(projectId);
    const job = this.jobs.get(projectId);
    if (job) {
      job.cancelled = true;
      const { stopSettleMs, cancelRetryMs } = this.deps.timing();
      await cancelCommand(job.execId);
      let settled = await settlesWithin(job.done, cancelRetryMs);
      if (!settled) {
        await cancelCommand(job.execId);
        settled = await settlesWithin(job.done, Math.max(0, stopSettleMs - cancelRetryMs));
      }
      if (!settled) job.abandoned = true;
    }
    const started = Boolean(state && state.status !== 'stopped');
    if (started || volumes) {
      const env = this.deps.docker.cliEnv();
      if (env.DOCKER_HOST) {
        const project = mainPreviewComposeProjectName(projectId);
        const down = await composeDown(project, env, volumes ? CLEANUP_DOWN : {});
        onDown?.(project, down);
        if (!down.ok) this.deps.log?.()?.warn({ projectId, output: down.output.slice(-500) }, 'main preview: down failed');
      }
    }
    if (job && this.jobs.get(projectId) === job) this.jobs.delete(projectId);
    if (started && state) this.write(projectId, { status: 'stopped', port: null, startedAt: null });
  }

  /** A stored `starting` with no job in this process: core restarted before that start ended. */
  private interrupted(projectId: string): boolean {
    return this.read(projectId)?.status === 'starting' && !this.jobs.has(projectId);
  }

  /**
   * Settles an interrupted start (callers hold the project's lock; a no-op otherwise): `running`
   * when the engine runs the service (or says starting, or cannot tell), else its project is taken
   * down and it is `failed` with the restart hint, which frees the port. While the engine does not
   * answer it stays as it is, to be settled on a later touch.
   */
  private async reconcileHeld(projectId: string): Promise<void> {
    if (!this.interrupted(projectId)) return;
    const state = this.read(projectId)!;
    const project = mainPreviewComposeProjectName(projectId);
    if (!this.deps.docker.host) {
      // No engine at all now: nothing of it can run.
      this.write(projectId, { ...state, status: 'failed', error: RESTARTED, logs: null });
      return;
    }
    await this.deps.docker.ready();
    const env = this.deps.docker.cliEnv();
    if (!env.DOCKER_HOST) return;
    const engine = await composeServiceStatus({
      project,
      service: state.service ?? this.composeService(projectId)?.compose.service ?? '',
      env,
    });
    if (engineRuns(engine)) {
      this.write(projectId, { ...state, status: 'running' });
      return;
    }
    const down = await composeDown(project, env);
    if (!down.ok) this.deps.log?.()?.warn({ projectId, output: down.output.slice(-500) }, 'main preview: down after a restart failed');
    this.write(projectId, { ...state, status: 'failed', error: RESTARTED, logs: null });
  }

  private async unavailableReason(mainPath: string, service: WorktreeComposeService | null): Promise<string | null> {
    if (!service) return NO_COMPOSE_SERVICE;
    if (this.deps.config.dockerHost) await this.deps.docker.ready();
    if (!this.deps.docker.status.available || !this.deps.config.dockerHost) {
      return composeEngineOffMessage(service.name, this.deps.docker.status.error);
    }
    if (!existsSync(path.join(mainPath, service.compose.file))) return missingComposeFile(service.compose.file);
    return null;
  }

  private composeService(projectId: string): WorktreeComposeService | null {
    const service = approvedPreviewService(this.deps.db, projectId);
    return service && isComposeService(service) ? service : null;
  }

  private nextGeneration(projectId: string): number {
    const generation = (this.generations.get(projectId) ?? 0) + 1;
    this.generations.set(projectId, generation);
    return generation;
  }

  private project(projectId: string): { id: string; path: string } {
    const row = this.deps.db.select({ id: projects.id, path: projects.path }).from(projects).where(eq(projects.id, projectId)).get();
    if (!row) throw notFound('no such project');
    return row;
  }

  private hasProject(projectId: string): boolean {
    return Boolean(this.deps.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get());
  }

  private read(projectId: string): MainPreviewState | null {
    const parsed = MainPreviewState.safeParse(readProjectSettings(this.deps.db, projectId)[MAIN_PREVIEW_KEY]);
    return parsed.success ? parsed.data : null;
  }

  /** Replaces the state; a project deleted meanwhile has none to keep. */
  private write(projectId: string, state: MainPreviewState): void {
    if (!this.hasProject(projectId)) return;
    writeProjectSettings(this.deps.db, projectId, { [MAIN_PREVIEW_KEY]: state });
  }
}

/** What `compose ps` says counts as running: running, starting, or it could not tell. */
function engineRuns(state: Awaited<ReturnType<typeof composeServiceStatus>>): boolean {
  return state === 'running' || state === 'starting' || state === 'unknown';
}

function labelOf(state: MainPreviewState): string {
  return `docker compose up ${state.service} (${state.file}, port ${state.containerPort})`;
}
