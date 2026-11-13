/**
 * Picking up pushes from elsewhere: Emberline reads origin's working branch and origin's main,
 * fast-forwards or merges them in, and stops with a clear state when it cannot do so cleanly.
 *
 * Nothing a person or the factory committed is lost and nothing in the main workspace is
 * overwritten: a fast-forward goes through only when git agrees, a merge needs a clean tree and is
 * checked first with `merge-tree` (a conflicting one never touches the main workspace), the
 * additive heal and its checks run in core's own worktree, and Match origin keeps the old tip under
 * `refs/emberline/backup/`. Network calls run outside the main-workspace lock, in RepositoryService's
 * remote-ops order; every change to the main workspace or its refs runs under the lock.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  type BranchRemoteState,
  type CommitIdentity,
  type GitSync as SyncRecord,
  type GitSyncState,
  MatchOriginBody,
} from '@emberline/protocol';
import { eq, isNotNull } from 'drizzle-orm';
import { CommandFailedError, isRunnerUnavailable } from '../command-exec.js';
import type { Db } from '../db/index.js';
import { readRepositorySettings, workingBranchOf, writeRepositorySettings } from '../db/project-settings.js';
import { projects } from '../db/schema.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { commitIdentityFor, gitIdentityArgs } from '../factory/commit-identity.js';
import { healConflicts } from '../factory/conflict-heal.js';
import type { buildWorkspaceDemo } from '../factory/demo.js';
import { resetScratchFilesToHead, withMainWorkspaceLock } from '../factory/merge.js';
import { effectiveFactorySettings } from '../factory/settings.js';
import { execGitFile } from '../git-exec.js';
import {
  isAncestorCommit,
  mainBranchState,
  originUrls,
  realGit,
  RUNNER_WAITING_MESSAGE,
  unlessRunnerUnavailable,
} from '../repository/git.js';
import type { RepositoryService, Snapshot } from '../repository/service.js';
import type { ReleaseJobs } from './release.js';
import { pruneWorktree } from '../runs/git.js';
import { verifyBuildIn } from '../runs/gates.js';
import {
  checkedOutBranches,
  classify,
  gitMessage,
  liveRunsOf,
  localTip,
  type PatchesOnOrigin,
  patchesOnOrigin,
  refTip,
  WORKSPACE_DIRTY,
} from './branches.js';
import { absentWhen, isPlainRefName } from './history.js';

/** How often origin is read (and, with auto-pull on, pulled). */
export const AUTO_PULL_INTERVAL_MS = 120_000;
/** The commits kept as "from origin" for the history, newest first. */
const PULLED_KEPT = 500;
/** A pull heals at most twice (origin's working branch, then main into it), then ends. */
const MAX_HEALS = 2;
/** Core's own worktree for a pull's heal: `<workspacesDir>/.worktrees/<slug>/pull-<id8>`. */
const HEAL_DIR = /^pull-[0-9a-f]{8}$/;
/**
 * Core's own job worktrees under `<workspacesDir>/.worktrees/<slug>/`: a pull's heal (`pull-<id8>`)
 * and a release's checks (`release-<random8>`).
 */
export const JOB_WORKTREE = /^(?:pull|release)-[0-9a-f]{8}$/;
/** A job worktree's compose project, apart from every run's and the main workspace's. */
export const jobComposeProject = (dir: string) => `emberline-${path.basename(dir)}`;
const healComposeProject = jobComposeProject;
const BACKUP_PREFIX = 'refs/emberline/backup/';
const ORIGIN_CHANGED =
  "This project's origin changed while Emberline read it, so nothing was pulled. Pull again.";

/** A page about a project (not a run): what core's notifications send, narrowed to what git-page says. */
export type GitNotify = (
  projectId: string,
  occurrence: string,
  message: {
    event: 'git_pull_stopped' | 'release_finished';
    title: string;
    body: string;
    priority?: 'default' | 'high';
    tags?: string[];
  },
) => void;

/** What a pull needs from the rest of core. */
export interface SyncDeps {
  db: Db;
  /** Pages a person when an automatic pull stops; a failure inside it never reaches the pull. */
  notify?: GitNotify;
  repository: Pick<RepositoryService, 'remoteAction' | 'readOrigin' | 'originStill'>;
  /** Docker for the heal's own worktree, under a compose project of its own (RunService's job helpers). */
  docker: {
    envFor(composeProject: string): Promise<Record<string, string>>;
    teardown(projectId: string, worktreePath: string, composeProject: string): Promise<void>;
  };
  /** The heals running in the background (one per project). */
  heals: HealJobs;
  /**
   * The project's release (ReleaseJobs): while one runs or stopped with main changed, Match origin is
   * refused and auto-pull keeps out of its way.
   */
  releases?: Pick<ReleaseJobs, 'standing' | 'guard'>;
  /** Where core keeps worktrees (`<workspacesDir>/.worktrees/<slug>/…`); the heal's own goes there. */
  workspacesDir: string;
  /** Runs the checks on a healed merge (tests inject it); default: buildWorkspaceDemo. */
  buildWorkspaceDemo?: typeof buildWorkspaceDemo;
}

/** What one pull came to, before it is stored as the project's `sync`. */
interface Outcome {
  state: GitSyncState;
  branch: string | null;
  files?: string[];
  message: string | null;
  /** A stop that waits for the person (a conflict, a rewritten origin): what was being merged. */
  source?: string;
  /** That stop's commit being merged. */
  sourceTip?: string | null;
}

type Mode = 'read' | 'auto' | 'person';

const toSync = (o: Outcome): SyncRecord => ({
  state: o.state,
  at: new Date().toISOString(),
  branch: o.branch,
  files: o.files ?? [],
  message: o.message,
});

const IDLE: SyncRecord = { state: 'idle', at: null, branch: null, files: [], message: null };

function projectRow(db: Db, projectId: string) {
  const row = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!row) throw notFound('no such project');
  return row;
}

/**
 * Stores `outcome` as the project's last pull, with the commits that came in (newest first, before
 * the ones kept already). A stop that waits for the person records origin's tips then, so auto-pull
 * leaves it until origin moves; a pull that got through lifts it; anything else leaves it standing.
 */
function record(
  db: Db,
  projectId: string,
  outcome: Outcome,
  extra: { pulled?: string[]; tips?: { working: string | null; main: string | null } } = {},
): SyncRecord {
  const sync = toSync(outcome);
  try {
    const settings = readRepositorySettings(db, projectId);
    // A failure (a read of origin, the runner) never hides a stop that waits for the person: its
    // files and Resolve with a ticket stay. The failure is answered, and the read keeps its own record.
    const standing = settings.sync?.state === 'conflict' || settings.sync?.state === 'rewritten';
    const keepStop = outcome.state === 'error' && settings.syncStop !== null && standing;
    const pulledOids = extra.pulled?.length
      ? [...new Set([...extra.pulled, ...settings.pulledOids])].slice(0, PULLED_KEPT)
      : settings.pulledOids;
    const old = settings.syncStop;
    // The same stop again (origin's tips and what was merged): its ticket stays its ticket.
    const same =
      old !== null &&
      extra.tips !== undefined &&
      old.working === extra.tips.working &&
      old.main === extra.tips.main &&
      old.source === outcome.source;
    const syncStop =
      outcome.source !== undefined && extra.tips
        ? {
            ...extra.tips,
            source: outcome.source,
            sourceTip: outcome.sourceTip ?? null,
            ...(same && old.ticketId ? { ticketId: old.ticketId } : {}),
          }
        : outcome.state === 'pulled' || outcome.state === 'up_to_date'
          ? null
          : settings.syncStop;
    writeRepositorySettings(db, projectId, keepStop ? { pulledOids } : { sync, pulledOids, syncStop });
  } catch {
    // the project was deleted meanwhile
  }
  return sync;
}

/** Everything one pull works with, read in order: the snapshot, then what origin names. */
interface PullContext {
  deps: SyncDeps;
  projectId: string;
  ws: Snapshot;
  main: string;
  working: string;
  remote: { main: string | null; working: string | null };
  identity: CommitIdentity;
  /** The branch moves this pull made, to collect the commits that came in. */
  moves: { before: string | null; after: string }[];
  /** The merge commits Emberline made in this pull: they did not come from origin. */
  made: Set<string>;
  /** Who started the pull: a person sees its outcome in the reply, the timer's goes to a page. */
  mode: Mode;
}

/** A merge that conflicted: the additive heal is tried on it outside the lock. */
interface HealRequest {
  before: string;
  source: string;
  label: string;
  conflicts: string[];
  /** Said with the conflict if the heal cannot resolve it (Match origin, for origin's branch). */
  note?: string;
}

/** `quiet`: an automatic pull that keeps out of a running release's way, and records nothing. */
type Step = { outcome: Outcome } | { heal: HealRequest } | { quiet: true };

/**
 * A pull of the working branch (and main, when it is another branch) from origin. `auto`: the
 * timer's, which only reads origin while auto-pull is off or a stop waits for the person.
 */
export function pull(deps: SyncDeps, projectId: string, { auto }: { auto: boolean }): Promise<SyncRecord> {
  return syncProject(deps, projectId, auto ? 'auto' : 'person');
}

/** Reads origin (sets the tracking refs) and pulls nothing; the last pull's outcome is returned. */
export function fetchOrigin(deps: SyncDeps, projectId: string): Promise<SyncRecord> {
  return syncProject(deps, projectId, 'read');
}

async function syncProject(deps: SyncDeps, projectId: string, mode: Mode): Promise<SyncRecord> {
  const project = projectRow(deps.db, projectId);
  const finish = (outcome: Outcome) =>
    mode === 'read' ? toSync(outcome) : record(deps.db, projectId, outcome);
  // A heal of this project's pull is still checking its merge: that pull is not started twice.
  const healing = mode === 'read' ? null : deps.heals.running(projectId);
  if (healing) return healingSync(deps.db, projectId, healing);
  try {
    // No origin: nothing to read, and no network call.
    if (!(await originUrls(project.path)).fetch)
      return finish({
        state: 'no_remote',
        branch: null,
        message: 'This project has no origin. Connect a repository in Project settings → Repository first.',
      });
    return await deps.repository.remoteAction(projectId, (ws) => pullIn(deps, projectId, ws, mode));
  } catch (error) {
    // A runner that did not answer decided nothing: the next tick or Pull tries again.
    if (isRunnerUnavailable(error))
      return finish({ state: 'error', branch: null, message: RUNNER_WAITING_MESSAGE });
    const message = error instanceof HttpError ? error.message : gitMessage(error);
    return finish({ state: 'error', branch: null, message });
  }
}

/** The stored sync, answered with what the project's running heal is doing. */
const healingSync = (db: Db, projectId: string, message: string): SyncRecord => ({
  ...(readRepositorySettings(db, projectId).sync ?? IDLE),
  message,
});

/**
 * In origin's queue: the read of origin, and the pull as far as it goes without a heal. A heal is
 * reserved here, in the queue, so a Pull or Match origin queued behind this one sees it; it then
 * runs in the background, with the queue free.
 */
async function pullIn(deps: SyncDeps, projectId: string, ws: Snapshot, mode: Mode): Promise<SyncRecord> {
  const { db } = deps;
  // A pull queued behind the one that started a heal.
  const healing = mode === 'read' ? null : deps.heals.running(projectId);
  if (healing) return healingSync(db, projectId, healing);
  const read = await deps.repository.readOrigin(projectId, ws);
  const current = () => readRepositorySettings(db, projectId).sync ?? IDLE;
  const stopped = (outcome: Outcome) => (mode === 'read' ? toSync(outcome) : record(db, projectId, outcome));
  if (read.stale) return stopped({ state: 'error', branch: null, message: ORIGIN_CHANGED });
  if (read.error)
    return stopped({ state: 'error', branch: null, message: `Couldn't read origin: ${read.error}` });
  const settings = readRepositorySettings(db, projectId);
  if (mode === 'read') return current();
  if (mode === 'auto') {
    // With auto-pull off, the read alone shows the new commits; the person pulls.
    if (!settings.autoPull) return current();
    // A conflict or a rewritten origin waits for the person, until origin moves on, or until the
    // working branch has what was being merged (a "Resolve with a ticket" run merged it in).
    const stop = settings.syncStop;
    if (
      stop &&
      stop.working === read.working &&
      stop.main === read.main &&
      !(await stopResolved(ws.path, stop.sourceTip ?? null, read.workingBranch))
    )
      return current();
  }
  const ctx: PullContext = {
    deps,
    projectId,
    ws,
    main: ws.defaultBranch,
    working: read.workingBranch,
    remote: { main: read.main, working: read.working },
    identity: commitIdentityFor(db, projectId),
    moves: [],
    made: new Set(),
    mode,
  };
  const step = await withMainWorkspaceLock(ws.path, () => advance(ctx, null));
  if ('quiet' in step) return current();
  if ('outcome' in step) return finishPull(ctx, step.outcome);
  // The heal and its checks (minutes) run in the background: Refresh, pushes and the other
  // projects' pulls go on meanwhile. Its outcome is recorded when it ends.
  const { heal } = step;
  const message = `Emberline is trying to resolve the conflicts of merging ${heal.label} into ${ctx.working} (only purely additive ones) and checking the result; the pull finishes when that does.`;
  if (!deps.heals.start(projectId, message, () => healInBackground(ctx, heal)))
    return healingSync(db, projectId, deps.heals.running(projectId) ?? message);
  return record(db, projectId, { state: 'idle', branch: ctx.working, message });
}

/** Whether the working branch has the commit a stop was merging, so the stop no longer stands. */
async function stopResolved(mainPath: string, sourceTip: string | null, working: string): Promise<boolean> {
  if (!sourceTip) return false;
  const tip = await localTip(mainPath, working);
  return tip !== null && (await isAncestorCommit(mainPath, sourceTip, tip));
}

/** Records how the pull ended, with the commits it brought in. */
async function finishPull(ctx: PullContext, outcome: Outcome, background = false): Promise<SyncRecord> {
  pageStop(ctx, outcome, background);
  return record(ctx.deps.db, ctx.projectId, outcome, { pulled: await pulledCommits(ctx), tips: ctx.remote });
}

/** The stops that wait for a person: the ones worth a page. */
const PAGED_STOPS: readonly GitSyncState[] = ['conflict', 'rewritten', 'diverged', 'main_unpushed'];
const STOP_TEXT: Partial<Record<GitSyncState, string>> = {
  conflict: 'merge conflict',
  rewritten: 'origin was rewritten',
  diverged: 'branches diverged',
  main_unpushed: 'main has commits origin lacks',
};

/**
 * Pages once for a stop the timer's pull (or a heal's end, whoever started it) came to; a person who
 * pulled sees it in the reply. The occurrence names origin's tips, so the same stop is one page and
 * a stop on a new tip is another.
 */
function pageStop(ctx: PullContext, outcome: Outcome, background: boolean): void {
  if (!ctx.deps.notify || !PAGED_STOPS.includes(outcome.state) || (ctx.mode !== 'auto' && !background))
    return;
  const { remote } = ctx;
  const tip = `${remote.working ?? ''}/${remote.main ?? ''}`;
  const branch = outcome.branch ?? ctx.working;
  try {
    ctx.deps.notify(ctx.projectId, `${ctx.projectId}:pull:${outcome.state}:${tip}`, {
      event: 'git_pull_stopped',
      title: `Pull stopped on ${branch}: ${STOP_TEXT[outcome.state] ?? outcome.state}`,
      body: outcome.message ?? 'Open the Git page to see what stopped it.',
      priority: 'high',
      tags: ['warning', 'emberline'],
    });
  } catch {
    // a page that cannot be sent never changes how the pull ends
  }
}

/**
 * The rest of a pull whose merge conflicted, with no lock and outside origin's queue: the heal, then
 * (under the main-workspace lock) its result applied only while the working branch is where the heal
 * began, and the pull goes on from there. Every failure ends as a recorded outcome; once core is
 * stopping, nothing more is applied or recorded.
 */
async function healInBackground(ctx: PullContext, first: HealRequest): Promise<void> {
  const { heals } = ctx.deps;
  let outcome: Outcome = {
    state: 'error',
    branch: ctx.working,
    message: 'The pull did not finish; pull again.',
  };
  try {
    let req: HealRequest | null = first;
    for (let n = 0; req && n < MAX_HEALS; n++) {
      if (heals.stopped) return;
      const result = await healPull(ctx, req);
      req = null;
      // Core is stopping: the heal gave up, and nothing is applied or recorded. Its worktree is
      // swept before the next heal, and the next pull starts over.
      if (heals.stopped) return;
      if ('outcome' in result) {
        outcome = result.outcome;
        break;
      }
      const step = await withMainWorkspaceLock(ctx.ws.path, () =>
        heals.stopped ? Promise.resolve(null) : advance(ctx, result),
      );
      if (step === null) return;
      // A release started meanwhile: the healed merge waits for the next pull after it.
      if ('quiet' in step) outcome = { state: 'idle', branch: ctx.working, message: null };
      else if ('outcome' in step) outcome = step.outcome;
      else req = step.heal;
    }
  } catch (error) {
    if (heals.stopped) return;
    outcome = {
      state: 'error',
      branch: ctx.working,
      message: isRunnerUnavailable(error)
        ? RUNNER_WAITING_MESSAGE
        : error instanceof HttpError
          ? error.message
          : gitMessage(error),
    };
  }
  if (heals.stopped) return;
  await finishPull(ctx, outcome, true).catch(() => record(ctx.deps.db, ctx.projectId, outcome));
}

/** How long stop() waits for a heal to give up (as PostMergeJobs waits for its jobs). */
export const HEAL_STOP_TIMEOUT_MS = 5_000;

/** A pull's heals running in the background, at most one per project. */
export class HealJobs {
  private readonly jobs = new Map<string, { message: string; done: Promise<void> }>();
  /** The heals' own worktrees while they exist: a sweep of leftovers never takes one of these. */
  private readonly dirs = new Set<string>();
  private stopping = false;

  /** Whether `dir` is the worktree of a heal running now. */
  uses(dir: string): boolean {
    return this.dirs.has(path.resolve(dir));
  }

  /** Whether `name` is the compose project of a heal running now. */
  usesComposeProject(name: string): boolean {
    return [...this.dirs].some((dir) => jobComposeProject(dir) === name);
  }

  /** Marks `dir` as a running heal's worktree; the function returned ends that. */
  claim(dir: string): () => void {
    const key = path.resolve(dir);
    this.dirs.add(key);
    return () => this.dirs.delete(key);
  }

  /** Core is stopping: a running heal gives up at its next check, and none starts. */
  get stopped(): boolean {
    return this.stopping;
  }

  /** What the project's heal is doing, or null when none runs. */
  running(projectId: string): string | null {
    return this.jobs.get(projectId)?.message ?? null;
  }

  /** Starts `fn` unless a heal of this project runs already (false then). */
  start(projectId: string, message: string, fn: () => Promise<void>): boolean {
    if (this.stopping || this.jobs.has(projectId)) return false;
    const done = fn()
      .catch(() => undefined)
      .finally(() => this.jobs.delete(projectId));
    this.jobs.set(projectId, { message, done });
    return true;
  }

  /** Resolves once no heal runs. */
  async idle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.all([...this.jobs.values()].map((j) => j.done));
  }

  /**
   * Makes running heals give up and waits for them at most `timeoutMs`: a check already running in
   * the runner is not killed, but what the heal made of it is never applied.
   */
  async stop(timeoutMs = HEAL_STOP_TIMEOUT_MS): Promise<void> {
    this.stopping = true;
    await within(this.idle(), timeoutMs);
  }
}

/** Waits for `work`, at most `ms`. */
export async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, ms);
      timeout.unref();
    }),
  ]);
  clearTimeout(timeout);
}

/**
 * Under the lock: moves main and the working branch as far as they go cleanly. Returns the outcome,
 * or a conflicting merge for the heal (the next round applies a heal that landed, first).
 */
async function advance(ctx: PullContext, healed: { before: string; commit: string } | null): Promise<Step> {
  const { ws, main, working, remote, deps, projectId } = ctx;
  const stop = (outcome: Outcome): Step => ({ outcome });
  if (!(await deps.repository.originStill(projectId, ws)))
    return stop({ state: 'error', branch: null, message: ORIGIN_CHANGED });
  // A release that is running moves main between its promote and its push (local main is ahead of
  // origin's then, on purpose): the timer's pull leaves it alone, with no stop and no page.
  if (ctx.mode === 'auto' && (await deps.releases?.standing(projectId)) === 'running') return { quiet: true };
  // A switch of the working branch takes this lock too: one made since the read is not pulled into.
  const nowWorking = workingBranchOf(readRepositorySettings(deps.db, projectId), main);
  if (nowWorking !== working)
    return stop({
      state: 'error',
      branch: nowWorking,
      message: `The working branch changed to ${nowWorking} during the pull, so nothing more was pulled. Pull again.`,
    });
  const { branch: checkedOut } = await mainBranchState(ws.path);
  if (checkedOut !== working) {
    const on = checkedOut ? `is on ${checkedOut}` : 'is not on a branch';
    return stop({
      state: 'error',
      branch: working,
      message: `The main workspace ${on}, but the working branch is ${working}, so nothing was pulled. Switch back on the Git page (or check out ${working}), then pull again.`,
    });
  }
  if (healed) {
    if ((await localTip(ws.path, working)) !== healed.before)
      return stop({
        state: 'error',
        branch: working,
        message: `${working} moved while Emberline checked the merge, so the merge was not applied. The next pull tries again.`,
      });
    if (await workspaceDirty(ws.path)) return stop(dirtyOutcome(working, 'the healed merge'));
    const failed = await fastForward(ctx, healed.commit, healed.before);
    if (failed) return stop(failed);
    ctx.made.add(healed.commit);
  }

  // origin's main (a PR merged on the forge) fast-forwards local main; main is never merged into here.
  if (main !== working && remote.main) {
    const local = await localTip(ws.path, main);
    const state = await classify(ws.path, local, remote.main);
    if (state === 'behind') {
      if ((await checkedOutBranches(ws.path)).has(main))
        return stop({
          state: 'error',
          branch: main,
          message: `${main} is checked out in another worktree, so Emberline did not move it. Check out another branch there, then pull again.`,
        });
      // Only from the commit read here: a change since makes git refuse it.
      await execGitFile(
        ['update-ref', '-m', 'emberline: pull', `refs/heads/${main}`, remote.main, local ?? ''],
        { cwd: ws.path },
      );
      ctx.moves.push({ before: local, after: remote.main });
    } else if (state === 'ahead') {
      // With a working branch of its own, main is pushed by the release alone (Push main is not offered).
      const release = await deps.releases?.standing(projectId);
      return stop({
        state: 'main_unpushed',
        branch: main,
        message:
          release === 'running'
            ? `${main} has commits of the release that is running, which pushes them itself, so nothing was pulled. Pull again once the release has finished.`
            : release === 'unfinished'
              ? `${main} has commits origin's ${main} does not have: the last release stopped before it pushed them, so nothing was pulled. Retry or Undo promote on the Release tab, then pull again.`
              : `${main} has commits origin's ${main} does not have (a promote that was not pushed yet), so nothing was pulled. Push ${main}, then pull again.`,
      });
    } else if (state === 'diverged') {
      return stop({
        state: 'diverged',
        branch: main,
        message: `${main} and origin's ${main} both have commits the other lacks, so nothing was pulled. Emberline never merges into ${main} by itself: bring origin's ${main} in from a terminal, or use Match origin to take origin's.`,
      });
    } else if (state === 'rewritten') {
      return stop(await rewrittenOutcome(ws.path, main, local, remote.main));
    }
  }

  if (remote.working) {
    const local = await localTip(ws.path, working);
    const state = await classify(ws.path, local, remote.working);
    if (state === 'behind') {
      const failed = await fastForward(ctx, remote.working, local);
      if (failed) return stop(failed);
    } else if (state === 'diverged') {
      const merged = await mergeInto(ctx, remote.working, `origin/${working}`);
      if (merged) return merged;
    } else if (state === 'rewritten') {
      return stop(await rewrittenOutcome(ws.path, working, local, remote.working));
    }
  }

  // What came into main goes on into the working branch, so the factory builds on it.
  if (main !== working) {
    const mainTip = await localTip(ws.path, main);
    const workingTip = await localTip(ws.path, working);
    if (mainTip && workingTip && !(await isAncestorCommit(ws.path, mainTip, workingTip))) {
      if (!(await hasMergeBase(ws.path, mainTip, workingTip)))
        return stop({
          state: 'rewritten',
          branch: working,
          source: main,
          sourceTip: mainTip,
          message: `${main} no longer shares history with ${working} (one of them was rewritten), so ${main} was not merged into ${working}. Match origin on ${working} takes origin's history, or merge them in a terminal.`,
        });
      // The working branch has nothing main lacks (a tick between a release's main push and its
      // sync of the working branch, say): a fast-forward, not an empty merge commit.
      if (await isAncestorCommit(ws.path, workingTip, mainTip)) {
        const failed = await fastForward(ctx, mainTip, workingTip);
        if (failed) return stop(failed);
      } else {
        const merged = await mergeInto(ctx, mainTip, main);
        if (merged) return merged;
      }
    }
  }
  return stop({
    state: ctx.moves.length > 0 ? 'pulled' : 'up_to_date',
    branch: working,
    message: null,
  });
}

/** Says that `p` of the branch's commits are on origin under new hashes, and what Match origin does then. */
const rewriteNote = (p: PatchesOnOrigin) =>
  `${p.already} of your ${p.total} ${p.total === 1 ? 'commit is' : 'commits are'} already on origin with new hashes, so origin was probably rewritten. Match origin takes origin's history and keeps yours as a backup.`;

/** More than half of the branch's own commits are on origin under new hashes: worth saying in a conflict. */
const mostlyOnOrigin = (p: PatchesOnOrigin | null): p is PatchesOnOrigin =>
  p !== null && p.already > 0 && p.already * 2 > p.total;

/**
 * origin's `branch` was rewritten: it shares no history with the branch here, or it has nearly all
 * of the branch's own commits under new hashes (classify's rule). Nothing is merged either way.
 */
async function rewrittenOutcome(
  mainPath: string,
  branch: string,
  local: string | null,
  sourceTip: string,
): Promise<Outcome> {
  const shared = local !== null && (await hasMergeBase(mainPath, local, sourceTip));
  const patches = shared ? await patchesOnOrigin(mainPath, local, sourceTip) : null;
  return {
    state: 'rewritten',
    branch,
    source: `origin/${branch}`,
    sourceTip,
    message: patches
      ? `Nothing was pulled into ${branch}: ${rewriteNote(patches)}`
      : `origin's ${branch} no longer shares history with ${branch} here (it was rewritten and force-pushed), so nothing was pulled into it. Match origin takes origin's history and keeps the old tip under a backup ref.`,
  };
}

/**
 * What a conflict merging origin's working branch adds: Match origin is a way out too, and when most
 * of the branch's commits are on origin under new hashes, that origin was probably rewritten.
 */
async function matchOriginNote(mainPath: string, ours: string, theirs: string): Promise<string> {
  const patches = await patchesOnOrigin(mainPath, ours, theirs);
  return mostlyOnOrigin(patches)
    ? rewriteNote(patches)
    : "Match origin takes origin's history instead and keeps yours as a backup.";
}

const dirtyOutcome = (working: string, what: string, why?: string): Outcome => ({
  state: 'workspace_dirty',
  branch: working,
  message: `The main workspace has uncommitted changes, so Emberline did not bring ${what} into ${working}. Commit or discard them, then pull again.${why ? ` (${why})` : ''}`,
});

const conflictOutcome = (
  working: string,
  label: string,
  sourceTip: string,
  files: string[],
  detail?: string,
): Outcome => {
  const shown = files.slice(0, 10).join(', ') + (files.length > 10 ? ', …' : '');
  return {
    state: 'conflict',
    branch: working,
    files,
    source: label,
    sourceTip,
    message: `${label} and ${working} changed the same lines in ${shown}, so ${working} was left as it was. Resolve it with a ticket, or merge ${label} in a terminal.${detail ? ` ${detail}` : ''}`,
  };
};

/** Whether the main workspace has changes to tracked files or an unfinished merge (Emberline's scratch files aside). */
export async function workspaceDirty(mainPath: string): Promise<boolean> {
  await resetScratchFilesToHead(mainPath);
  const status = await execGitFile(['status', '--porcelain', '--untracked-files=no'], { cwd: mainPath });
  if (status.stdout.trim()) return true;
  return unfinishedOperation(mainPath);
}

/** Whether a merge, cherry-pick or revert someone started in the main workspace is not concluded. */
async function unfinishedOperation(mainPath: string): Promise<boolean> {
  for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if ((await refTip(mainPath, ref)) !== null) return true;
  }
  return false;
}

/** The checked-out working branch fast-forwarded to `target`; git refuses it if it would overwrite an edit. */
async function fastForward(ctx: PullContext, target: string, before: string | null): Promise<Outcome | null> {
  const { ws, working } = ctx;
  try {
    await execGitFile(['merge', '--ff-only', '--no-stat', target], { cwd: ws.path, timeout: 120_000 });
  } catch (error) {
    if (isRunnerUnavailable(error)) throw error;
    const why = gitMessage(error);
    if (WORKSPACE_DIRTY.test(why))
      return {
        state: 'workspace_dirty',
        branch: working,
        message: `The main workspace has changes the pull would overwrite, so ${working} stayed as it was. Commit or discard them, then pull again. (${why})`,
      };
    return { state: 'error', branch: working, message: `Could not fast-forward ${working}: ${why}` };
  }
  ctx.moves.push({ before, after: target });
  return null;
}

/** The paths a merge of `theirs` into `ours` would leave conflicted; nothing is written. */
async function mergeConflicts(mainPath: string, ours: string, theirs: string): Promise<string[]> {
  const out = await realGit(
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ours, theirs],
    mainPath,
  ).then(
    () => null,
    (error: unknown) => {
      // Exit 1 is "conflicts": the tree, then each conflicted path. Anything else is a real failure.
      if (error instanceof CommandFailedError && error.code === 1) return error.stdout;
      throw error;
    },
  );
  if (out === null) return [];
  return [...new Set(out.split('\0').slice(1).filter(Boolean))].sort();
}

const hasMergeBase = (mainPath: string, a: string, b: string) =>
  realGit(['merge-base', a, b], mainPath).then(() => true, absentWhen(false, 1));

/**
 * Merges `source` into the checked-out working branch (a merge commit with the project's identity,
 * no trailers). A conflicting merge is found before the main workspace is touched and goes to the
 * heal when the factory setting allows it. Null: merged.
 */
async function mergeInto(ctx: PullContext, source: string, label: string): Promise<Step | null> {
  const { ws, working, deps, projectId } = ctx;
  if (await workspaceDirty(ws.path)) return { outcome: dirtyOutcome(working, label) };
  const before = await localTip(ws.path, working);
  if (!before)
    return { outcome: { state: 'error', branch: working, message: `${working} has no commits yet.` } };
  // Merging origin's own branch in: Match origin is the other way out of a conflict.
  const fromOrigin = label === `origin/${working}`;
  const conflicts = await mergeConflicts(ws.path, before, source);
  if (conflicts.length > 0) {
    const note = fromOrigin ? await matchOriginNote(ws.path, before, source) : undefined;
    if (effectiveFactorySettings(deps.db, projectId).autoResolveAdditiveConflicts)
      return { heal: { before, source, label, conflicts, ...(note ? { note } : {}) } };
    return { outcome: conflictOutcome(working, label, source, conflicts, note) };
  }
  const inMain = { cwd: ws.path };
  try {
    await execGitFile(
      [
        ...gitIdentityArgs(ctx.identity),
        'merge',
        '--no-ff',
        '--no-edit',
        '--no-log',
        '--no-signoff',
        '-m',
        `Merge ${label} into ${working}`,
        source,
      ],
      { ...inMain, timeout: 120_000 },
    );
  } catch (error) {
    if (isRunnerUnavailable(error)) throw error;
    const why = gitMessage(error);
    const files = (
      await execGitFile(['diff', '--name-only', '--diff-filter=U'], inMain).catch(
        unlessRunnerUnavailable({ stdout: '' }),
      )
    ).stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // Only a merge that started is aborted; the tree was clean, so that puts it back exactly.
    if ((await refTip(ws.path, 'MERGE_HEAD')) !== null)
      await execGitFile(['merge', '--abort'], inMain).catch(unlessRunnerUnavailable(undefined));
    if (files.length > 0) {
      const note = fromOrigin ? await matchOriginNote(ws.path, before, source) : undefined;
      return { outcome: conflictOutcome(working, label, source, files, note) };
    }
    if (WORKSPACE_DIRTY.test(why)) return { outcome: dirtyOutcome(working, label, why) };
    return {
      outcome: {
        state: 'error',
        branch: working,
        message: `Could not merge ${label} into ${working}: ${why}`,
      },
    };
  }
  const after = await localTip(ws.path, working);
  if (after) {
    ctx.made.add(after);
    ctx.moves.push({ before, after });
  }
  return null;
}

/**
 * The additive heal (factory/conflict-heal.ts, as the merge ladder runs it) of a conflicting pull
 * merge, outside the lock, in a detached worktree of core's own at the working branch's tip: the
 * main workspace is not touched while it merges and its checks run. The healed commit is applied
 * by the next round, as a fast-forward, only if the working branch has not moved.
 */
async function healPull(
  ctx: PullContext,
  req: HealRequest,
): Promise<{ outcome: Outcome } | { before: string; commit: string }> {
  const { deps, ws, working, projectId } = ctx;
  const project = projectRow(deps.db, projectId);
  const parent = path.join(deps.workspacesDir, '.worktrees', project.slug);
  await sweepHealWorktrees(deps, projectId, ws.path, parent);
  const dir = path.join(parent, `pull-${randomUUID().slice(0, 8)}`);
  const composeProject = healComposeProject(dir);
  // Claimed before it exists, so a sweep of leftovers that lists it never takes it.
  const unclaim = deps.heals.claim(dir);
  try {
    await mkdir(parent, { recursive: true });
    await withMainWorkspaceLock(ws.path, () =>
      execGitFile(['worktree', 'add', '--detach', dir, req.before], { cwd: ws.path }),
    );
  } catch (error) {
    unclaim();
    throw error;
  }
  try {
    const healed = await healConflicts({
      worktreePath: dir,
      mainWorkspacePath: ws.path,
      mainBranch: req.label,
      branch: working,
      label: req.label,
      mainTip: req.source,
      // Core is stopping: the heal gives up at its next check and leaves nothing applied.
      stale: () => deps.heals.stopped,
      verify: () =>
        verifyBuildIn({
          db: deps.db,
          projectId,
          targetId: 'pull',
          workspacePath: dir,
          setupDone: false,
          settings: effectiveFactorySettings(deps.db, projectId),
          dockerEnv: () => deps.docker.envFor(composeProject),
          ...(deps.buildWorkspaceDemo ? { build: deps.buildWorkspaceDemo } : {}),
        }),
      identity: ctx.identity,
    });
    if (!healed.healed) {
      const files = healed.conflicts.length > 0 ? healed.conflicts : req.conflicts;
      const detail = [healed.message, req.note].filter(Boolean).join(' ');
      return { outcome: conflictOutcome(working, req.label, req.source, files, detail) };
    }
    return { before: req.before, commit: healed.commitOid };
  } finally {
    await removeHealWorktree(deps, projectId, ws.path, dir);
    unclaim();
  }
}

/** The heal's worktree goes as a run's does: worktree.yml teardown and compose down, then the removal. */
async function removeHealWorktree(deps: SyncDeps, projectId: string, mainPath: string, dir: string) {
  await deps.docker.teardown(projectId, dir, healComposeProject(dir)).catch(() => undefined);
  await withMainWorkspaceLock(mainPath, () => pruneWorktree(mainPath, dir)).catch(() => undefined);
}

/**
 * Heal worktrees a crash left behind (only one heal of a project runs at a time, so any found is
 * left over): removed with what they started, before the next heal.
 */
async function sweepHealWorktrees(deps: SyncDeps, projectId: string, mainPath: string, parent: string) {
  const names = await readdir(parent).catch(() => [] as string[]);
  for (const name of names.filter((n) => HEAL_DIR.test(n)))
    await removeHealWorktree(deps, projectId, mainPath, path.join(parent, name));
}

/** The commits this pull brought in (not the merges Emberline made), newest first. */
async function pulledCommits(ctx: PullContext): Promise<string[]> {
  const pulled: string[] = [];
  for (const { before, after } of ctx.moves) {
    const range = before ? [`${before}..${after}`] : [after];
    const out = await realGit(['rev-list', `--max-count=${PULLED_KEPT}`, ...range, '--'], ctx.ws.path).then(
      (r) => r.stdout,
      unlessRunnerUnavailable(''),
    );
    for (const oid of out.split('\n').map((l) => l.trim())) {
      if (oid && !ctx.made.has(oid)) pulled.push(oid);
    }
  }
  return pulled;
}

/** `YYYYMMDD-HHMMSS`, UTC. */
const backupStamp = (at = new Date()) => at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Keeps `oid` as `refs/emberline/backup/<branch>-<stamp>` (never overwriting one); returns the ref. */
async function keepBackup(mainPath: string, branch: string, oid: string): Promise<string> {
  const stamp = backupStamp();
  for (let n = 1; n <= 20; n++) {
    const ref = `${BACKUP_PREFIX}${branch}-${stamp}${n > 1 ? `-${n}` : ''}`;
    // The empty old value makes this a create: an existing backup is never moved.
    const made = await execGitFile(
      ['update-ref', '-m', 'emberline: backup before Match origin', ref, oid, ''],
      { cwd: mainPath },
    ).then(() => true, unlessRunnerUnavailable(false));
    if (made) return ref;
  }
  throw conflict(`Could not keep a backup of ${branch}, so it was not changed.`, 'backup_failed');
}

/** The backups Match origin kept, by name under refs/emberline/backup/. */
export async function listBackups(mainPath: string): Promise<string[]> {
  const out = (await realGit(['for-each-ref', '--format=%(refname)', BACKUP_PREFIX], mainPath)).stdout;
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((ref) => ref.startsWith(BACKUP_PREFIX))
    .map((ref) => ref.slice(BACKUP_PREFIX.length));
}

const STATE_TEXT: Record<BranchRemoteState, string> = {
  up_to_date: "is the same as origin's",
  behind: "is only behind origin's (Pull brings it in)",
  ahead: "only has commits origin's lacks",
  diverged: "has diverged from origin's",
  rewritten: "no longer shares history with origin's",
  unpublished: 'is not on origin',
  unknown: "could not be compared with origin's",
};

const pullRunning = () =>
  conflict('A pull is checking a merge right now; match origin once it has finished.', 'pull_running');

/**
 * Match origin: the branch (the working branch or main) takes origin's history, on the person's
 * confirmation, only when its own no longer fits origin's (rewritten or diverged). Its old tip is
 * kept under a backup ref first; the checked-out branch moves with `reset --keep`, which refuses to
 * overwrite an edit. Then a normal pull lines main and the working branch up again.
 */
export async function matchOrigin(deps: SyncDeps, projectId: string, raw: unknown): Promise<SyncRecord> {
  const parsed = MatchOriginBody.safeParse(raw ?? {});
  const branch = parsed.success ? parsed.data.branch : '';
  if (!branch || branch.startsWith('-') || !isPlainRefName(branch))
    throw badRequest('Name the branch to match with origin.');
  const { db } = deps;
  if (deps.heals.running(projectId)) throw pullRunning();
  // A release's checks and its sync of the working branch build on the history as it is now.
  const releaseGuard = () => deps.releases?.guard(projectId, `${branch} was not matched with origin`);
  await releaseGuard();
  const done = await deps.repository.remoteAction(projectId, async (ws) => {
    // Queued behind the pull that started a heal.
    if (deps.heals.running(projectId)) throw pullRunning();
    const read = await deps.repository.readOrigin(projectId, ws);
    if (read.stale) throw conflict(ORIGIN_CHANGED, 'origin_changed');
    if (read.error) throw conflict(`Couldn't read origin: ${read.error}`, 'remote_unreachable');
    const main = ws.defaultBranch;
    const working = read.workingBranch;
    if (branch !== working && branch !== main)
      throw badRequest(
        `Match origin is for ${working}${working !== main ? ` or ${main}` : ''}, the branches Emberline pulls.`,
      );
    const remote = branch === working ? read.working : read.main;
    if (!remote)
      throw conflict(`origin has no branch ${branch}, so there is nothing to match.`, 'unpublished');
    return withMainWorkspaceLock(ws.path, async () => {
      if (!(await deps.repository.originStill(projectId, ws)))
        throw conflict(ORIGIN_CHANGED, 'origin_changed');
      await releaseGuard();
      const local = await localTip(ws.path, branch);
      const state = await classify(ws.path, local, remote);
      if (!local || (state !== 'rewritten' && state !== 'diverged'))
        throw conflict(
          `${branch} ${STATE_TEXT[state]}, so there is nothing to match: Match origin is only for a branch whose history no longer fits origin's.`,
          'nothing_to_match',
        );
      // Runs based on the working branch's history would merge it back in.
      if (branch === working) {
        const live = await liveRunsOf(db, projectId);
        if (live.length > 0) {
          const names = live.map((r) => r.title ?? r.id).join(', ');
          throw new HttpError(
            409,
            'runs_live',
            `${branch} stays as it is while runs are live or waiting to merge: ${names}. Their work is based on its current history; let them finish and merge, or stop them, then match origin.`,
            { runs: live },
          );
        }
      }
      const { branch: checkedOut } = await mainBranchState(ws.path);
      // A reset would end a merge someone has not concluded, and drop what it recorded.
      if (checkedOut === branch && (await unfinishedOperation(ws.path)))
        throw conflict(
          `A merge, cherry-pick or revert in the main workspace is not finished, so ${branch} stayed as it was. Conclude or abort it, then try again.`,
          'workspace_dirty',
        );
      const backup = await keepBackup(ws.path, branch, local);
      if (checkedOut === branch) {
        try {
          await execGitFile(['reset', '--keep', remote], { cwd: ws.path, timeout: 120_000 });
        } catch (error) {
          if (isRunnerUnavailable(error)) throw error;
          return { backup, refused: gitMessage(error) };
        }
      } else {
        if ((await checkedOutBranches(ws.path)).has(branch))
          throw conflict(
            `${branch} is checked out in another worktree, so Emberline did not move it (its tip is kept as ${backup}).`,
            'branch_checked_out',
          );
        await execGitFile(
          ['update-ref', '-m', 'emberline: match origin', `refs/heads/${branch}`, remote, local],
          { cwd: ws.path },
        );
      }
      const pulled = (
        await realGit(['rev-list', `--max-count=${PULLED_KEPT}`, remote, '--not', local, '--'], ws.path).then(
          (r) => r.stdout,
          unlessRunnerUnavailable(''),
        )
      )
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const settings = readRepositorySettings(db, projectId);
      writeRepositorySettings(db, projectId, {
        pulledOids: [...new Set([...pulled, ...settings.pulledOids])].slice(0, PULLED_KEPT),
        syncStop: null,
      });
      return { backup, refused: null };
    });
  });
  if (done.refused !== null)
    return record(db, projectId, {
      state: 'workspace_dirty',
      branch,
      message: `The main workspace has changes that matching origin would overwrite, so ${branch} stayed as it was (its tip is also kept as ${done.backup}). Commit or discard them, then try again. (${done.refused})`,
    });
  const after = await pull(deps, projectId, { auto: false });
  if (after.state !== 'up_to_date') return after;
  return record(db, projectId, {
    state: 'pulled',
    branch,
    message: `${branch} now matches origin. Its old tip is kept as ${done.backup}.`,
  });
}

/** The body of "Resolve with a ticket": what conflicted, and how the run resolves it. */
export function pullTicketText(
  source: string,
  branch: string,
  files: string[],
): { title: string; body: string } {
  const listed = files.slice(0, 200).map((f) => `- ${f}`);
  if (files.length > 200) listed.push(`- … and ${files.length - 200} more`);
  return {
    title: `Merge ${source} into ${branch}`.slice(0, 200),
    body: [
      `Emberline could not pull ${source} into ${branch}: both changed the same lines.`,
      '',
      'Conflicting files:',
      ...listed,
      '',
      `Run \`git merge ${source}\`, resolve every conflict keeping both changes' intent, run the project's checks, commit.`,
    ].join('\n'),
  };
}

/** What GitSync needs: one pull per project. */
export interface GitSyncTarget {
  pull(projectId: string, opts: { auto: boolean }): Promise<SyncRecord>;
  /** Makes the pulls' background heals give up, and waits for them at most `timeoutMs`. */
  stop(timeoutMs?: number): Promise<void>;
}

/**
 * Auto-pull: every AUTO_PULL_INTERVAL_MS, each project with a connected origin is pulled (or, with
 * auto-pull off or a stop that waits for the person, only read), one project at a time. A tick
 * never runs while the one before it still runs; `ready` (the runner is connected) gates each one.
 */
export class GitSync {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly intervalMs: number;
  private readonly ready: () => boolean;

  constructor(
    private readonly db: Db,
    private readonly git: GitSyncTarget,
    private readonly opts: {
      intervalMs?: number;
      log: (message: string) => void;
      ready?: () => boolean;
      /** How long stop() waits for a running tick and the heals (default HEAL_STOP_TIMEOUT_MS). */
      stopTimeoutMs?: number;
    },
  ) {
    this.intervalMs = opts.intervalMs ?? AUTO_PULL_INTERVAL_MS;
    this.ready = opts.ready ?? (() => true);
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  /**
   * Stops the timer; running heals give up (none starts), and the running tick and the heals are
   * waited for at most the stop timeout, so stopping core never waits for a heal's checks.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const ms = this.opts.stopTimeoutMs ?? HEAL_STOP_TIMEOUT_MS;
    await Promise.all([this.git.stop(ms), within(this.running ?? Promise.resolve(), ms)]);
  }

  /** One pass over the projects; while a pass runs, this is that pass. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.running) this.running = this.pass().finally(() => (this.running = null));
    return this.running;
  }

  private async pass(): Promise<void> {
    const rows = this.db.select({ id: projects.id }).from(projects).where(isNotNull(projects.repoUrl)).all();
    for (const { id } of rows) {
      if (this.stopped || !this.ready()) return;
      try {
        const sync = await this.git.pull(id, { auto: true });
        if (sync.state === 'error') this.opts.log(`auto-pull: project ${id}: ${sync.message ?? 'failed'}`);
      } catch (error) {
        this.opts.log(`auto-pull: project ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
