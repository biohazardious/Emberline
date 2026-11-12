import { existsSync } from 'node:fs';
import path from 'node:path';
import type { GarbageCollectRunsResponse, Run } from '@emberline/protocol';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runs, tickets } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { type HealFailure, type HealGate, healConflicts } from '../factory/conflict-heal.js';
import { mainWorkspaceBranch, type SyncWorktreeResult } from '../factory/merge.js';
import { syncWorktreeToMainWorkspace } from '../factory/service.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { copyIntoWorktree, type CopyOutcome, notIgnoredPaths } from '../worktree-config/lifecycle.js';
import { type ApprovedConfig, loadApprovedWorktreeConfig } from '../worktree-config/load.js';
import {
  prepareWorkspace,
  pruneWorktree,
  type Workspace,
  worktreeHasUncommittedWork,
  worktreeHasUnmergedCommits,
  worktreeHeadSha,
} from './git.js';

type RunRow = typeof runs.$inferSelect;

/** The project fields the worktree operations need. */
export interface WorktreeProject {
  id: string;
  path: string;
  defaultBranch: string;
}

/** How a pre-prune archive pass went (BuildOutputArchive.archiveBeforePrune). */
export type ArchiveOutcome = 'archived' | 'timeout' | 'failed';

/** Why garbage collection keeps a run's worktree. */
export type KeptWorktreeReason = GarbageCollectRunsResponse['keptWorktrees'][number]['reason'];

/** Work a prune would delete: changes not committed, or commits the merge target does not contain. */
export type WorktreeWork = { reason: Exclude<KeptWorktreeReason, 'in_review'>; branch: string };

/** Auto-GC re-runs git on a kept worktree whose HEAD has not moved at most this often. */
const KEPT_WORKTREE_RECHECK_MS = 10 * 60_000;

/** A run that may still work in its worktree: not ended, or waiting out its quota to resume there. */
export const runStillActive = () =>
  or(isNull(runs.endedAt), and(eq(runs.state, 'rate_limited'), isNull(runs.cancelledAt)));

/** Another run in the same worktree (a handoff's predecessor or successor); `stillRunning`: an active one only. */
export function worktreeSharedWith(
  db: Db,
  row: Pick<RunRow, 'id' | 'worktreePath'>,
  opts: { stillRunning?: boolean } = {},
): RunRow | undefined {
  const sharing = and(eq(runs.worktreePath, row.worktreePath), ne(runs.id, row.id));
  return db
    .select()
    .from(runs)
    .where(opts.stillRunning ? and(sharing, runStillActive()) : sharing)
    .get();
}

/** A new run's workspace, with what the approved worktree.yml's `copy` put into it. */
export interface PreparedRunWorkspace {
  workspace: Workspace;
  /** The approved worktree.yml, for a fresh worktree only (not in place, not a shared one). */
  lifecycle: ApprovedConfig | null;
  copied: CopyOutcome[] | null;
  /** Copied files git would not ignore: the agent could commit them (a copied `.env`, say). */
  notIgnored: string[] | null;
}

/**
 * Creates a run's worktree and branch (or takes the one it shares) and applies the approved
 * worktree.yml's `copy`; its `setup` runs at launch. Before the run exists for the scheduler.
 */
export async function prepareRunWorkspace(params: {
  db: Db;
  workspacesDir: string;
  project: { id: string; path: string; slug: string };
  runShort: string;
  branch?: string;
  shared?: Workspace;
}): Promise<PreparedRunWorkspace> {
  const { db, workspacesDir, project, runShort } = params;
  const workspace =
    params.shared ??
    (await prepareWorkspace(
      project.path,
      path.join(workspacesDir, '.worktrees', project.slug, runShort),
      params.branch ?? `emberline/run-${runShort}`,
    ));
  const lifecycle =
    !params.shared && workspace.path !== project.path ? loadApprovedWorktreeConfig(db, project.id) : null;
  const copied =
    lifecycle && lifecycle.config.copy.length > 0
      ? await copyIntoWorktree(
          { trustedBase: workspacesDir, mainPath: project.path, worktreePath: workspace.path },
          lifecycle.config.copy,
        ).catch((error: unknown): CopyOutcome[] =>
          lifecycle.config.copy.map((entry) => ({
            path: entry.path,
            mode: entry.mode,
            status: 'skipped' as const,
            reason: `copy failed: ${(error as Error).message.slice(0, 200)}`,
          })),
        )
      : null;
  const notIgnored = copied
    ? await notIgnoredPaths(
        workspace.path,
        copied.filter((c) => c.status !== 'skipped').flatMap((c) => [c.path, ...(c.secrets ?? [])]),
      ).catch(() => null)
    : null;
  return { workspace, lifecycle, copied, notIgnored };
}

/** The branch runs merge into: the main workspace's current branch, else the project's `defaultBranch`. */
export async function mergeTarget(project: Pick<WorktreeProject, 'path' | 'defaultBranch'>): Promise<string> {
  return (await mainWorkspaceBranch(project.path)) ?? project.defaultBranch;
}

/** {@link mergeTarget}, asked of git on the first call only (one GC pass over one project). */
export function lazyMergeTarget(
  project: Pick<WorktreeProject, 'path' | 'defaultBranch'>,
): () => Promise<string> {
  let branch: Promise<string> | undefined;
  return () => (branch ??= mergeTarget(project));
}

/**
 * Runs merge into the main workspace's current branch (the project's `defaultBranch` column is
 * only the fallback), so that is what "merged" is measured against. `branch` names it.
 */
export async function worktreeWork(
  worktreePath: string,
  project: Pick<WorktreeProject, 'path' | 'defaultBranch'>,
  knownBranch?: string,
): Promise<WorktreeWork | null> {
  const branch = knownBranch ?? (await mergeTarget(project));
  if (await worktreeHasUncommittedWork(worktreePath)) return { reason: 'uncommitted_changes', branch };
  if (await worktreeHasUnmergedCommits(worktreePath, branch)) return { reason: 'unmerged_commits', branch };
  return null;
}

/** 409 `worktree_has_work` when pruning the worktree would delete work (see {@link worktreeWork}). */
export async function assertNothingToLose(
  worktreePath: string,
  project: Pick<WorktreeProject, 'path' | 'defaultBranch'>,
): Promise<void> {
  const found = await worktreeWork(worktreePath, project);
  if (!found) return;
  throw new HttpError(
    409,
    'worktree_has_work',
    found.reason === 'uncommitted_changes'
      ? 'This worktree has uncommitted changes that pruning would delete.'
      : `This worktree has commits that are not in ${found.branch} yet. Merge the branch first, or prune anyway.`,
  );
}

/** Refuses a merge once the agent worked again (a newer turn's pass decides). */
class TurnMoved extends Error {}

/** What merging a run's branch into main did; a merge that threw is a failure with its message. */
export type RunMerge = Pick<
  SyncWorktreeResult,
  | 'ok'
  | 'summary'
  | 'conflicts'
  | 'commitSha'
  | 'commitOid'
  | 'commitUnverified'
  | 'alreadyMerged'
  | 'mainHead'
  | 'resolution'
  | 'autoResolved'
> & {
  /** A conflict heal that was tried and did not land (for the agent's prompt: what failed). */
  healFailure?: HealFailure;
};

/** Layer 2 of the conflict ladder (factory/conflict-heal.ts), when the factory setting is on. */
export interface MergeHeal {
  /** The worktree gate (build/lint/test) on the healed tree. */
  verify: () => Promise<HealGate>;
  note: (type: 'conflict_auto_resolved' | 'conflict_heal_failed', payload: Record<string, unknown>) => void;
}

/**
 * Merges the run's branch into the main workspace (through ops). `stale` is checked once the run's
 * output commit is built and its tip read, right before that tip (not a later one) is merged: an
 * agent that worked again since leaves it, and its branch, worktree and index as they were, and
 * the result is null. With `heal`, a conflicting merge first tries the deterministic heal of
 * additive conflicts in the run's worktree and merges again once it landed.
 */
export async function mergeRunBranch(params: {
  run: Pick<Run, 'id' | 'worktreePath' | 'branch'>;
  mainWorkspacePath: string;
  ticketKey: string | null;
  stale: () => boolean;
  heal?: MergeHeal;
}): Promise<RunMerge | null> {
  const { run, stale, heal, mainWorkspacePath, ticketKey } = params;
  const mergeOnce = () =>
    syncWorktreeToMainWorkspace({
      worktreePath: run.worktreePath,
      mainWorkspacePath,
      ticketKey,
      runId: run.id,
      branch: run.branch,
      beforeMerge: () => {
        if (stale()) throw new TurnMoved();
      },
    }).catch((error: unknown): RunMerge | null => {
      if (error instanceof TurnMoved) return null;
      return {
        ok: false,
        summary: (error as Error).message,
        conflicts: [],
        commitSha: null,
        commitOid: null,
        commitUnverified: false,
        alreadyMerged: false,
        mainHead: null,
        resolution: null,
        autoResolved: [],
      };
    });
  const first = await mergeOnce();
  if (!heal || !first || first.ok || first.conflicts.length === 0) return first;
  return healThenMerge({ run, mainWorkspacePath, ticketKey, stale, heal, first, merge: mergeOnce });
}

/**
 * Layer 2 after a conflicting `first` merge: heals the additive conflicts in the run's worktree and,
 * once that landed, merges again with `merge`. A heal that did not land returns `first` with its
 * `healFailure`; null when the agent worked again meanwhile.
 */
export async function healThenMerge<M extends RunMerge>(params: {
  run: Pick<Run, 'id' | 'worktreePath'>;
  mainWorkspacePath: string;
  ticketKey: string | null;
  stale: () => boolean;
  heal: MergeHeal;
  first: M;
  merge: () => Promise<M | null>;
}): Promise<M | null> {
  const { run, mainWorkspacePath, ticketKey, stale, heal, first } = params;
  const healed = await healConflicts({
    worktreePath: run.worktreePath,
    mainWorkspacePath,
    mainBranch: (await mainWorkspaceBranch(mainWorkspacePath)) ?? 'main',
    label: ticketKey ?? run.id.slice(0, 8),
    mainTip: first.mainHead,
    stale,
    verify: heal.verify,
  });
  if (!healed.healed) {
    if (healed.reason === 'turn_moved') return null;
    heal.note('conflict_heal_failed', {
      reason: healed.reason,
      files: healed.conflicts.length > 0 ? healed.conflicts : first.conflicts,
      unresolved: healed.unresolved,
      message: healed.message,
      ...(healed.gateFailure !== undefined ? { gateFailure: healed.gateFailure } : {}),
    });
    return { ...first, healFailure: healed };
  }
  heal.note('conflict_auto_resolved', { files: healed.files, commitSha: healed.commitSha });
  const retry = await params.merge();
  if (!retry?.ok) return retry;
  return { ...retry, resolution: 'auto_resolved', autoResolved: healed.files };
}

/**
 * Removes a run worktree. When the removal fails on files the engine's containers wrote (rootless
 * Docker: a sub-uid the runner user cannot delete), `reclaim` hands them back and it runs once more.
 */
export async function pruneWithReclaim(
  projectPath: string,
  worktreePath: string,
  reclaim: (dir: string) => Promise<boolean>,
): Promise<boolean> {
  try {
    return await pruneWorktree(projectPath, worktreePath);
  } catch (error) {
    const inWorktrees = path.resolve(worktreePath).includes(`${path.sep}.worktrees${path.sep}`);
    if (!inWorktrees || path.resolve(worktreePath) === path.resolve(projectPath)) throw error;
    if (!(await reclaim(worktreePath))) throw error;
    return pruneWorktree(projectPath, worktreePath);
  }
}

/**
 * Garbage collection's "keep it" verdicts. GC never deletes work a human still has to look at: runs
 * of tickets that are not `done` yet (e.g. in Review after a refused merge), worktrees with
 * uncommitted changes, and worktrees whose branch has commits the merge target does not contain.
 * Auto-GC (every minute) may reuse the last verdict on a kept worktree whose HEAD has not moved.
 */
export class KeptWorktrees {
  /** The last verdict on each kept worktree, by run id: the HEAD it saw and when. */
  readonly checks = new Map<string, { head: string | null; reason: KeptWorktreeReason; checkedAt: number }>();

  constructor(private readonly db: Db) {}

  /**
   * Why `row` must be kept, or null. `branch`: the merge target, resolved at most once per pass and
   * only when a check needs it. `cached`: reuse a verdict for up to KEPT_WORKTREE_RECHECK_MS.
   */
  async reason(
    row: RunRow,
    project: Pick<WorktreeProject, 'path' | 'defaultBranch'> | undefined,
    opts: { branch?: () => Promise<string>; cached?: boolean } = {},
  ): Promise<KeptWorktreeReason | null> {
    if (row.ticketId) {
      const ticket = this.db
        .select({ status: tickets.status })
        .from(tickets)
        .where(eq(tickets.id, row.ticketId))
        .get();
      if (ticket && ticket.status !== 'done') return 'in_review';
    }
    if (!row.worktreePath || row.worktreePath === project?.path) return null;
    // Without a project the target branch is unknown, so nothing can be proven merged.
    if (!project) return 'unmerged_commits';
    if (!opts.cached) {
      return (await worktreeWork(row.worktreePath, project, await opts.branch?.()))?.reason ?? null;
    }
    const head = await worktreeHeadSha(row.worktreePath, project.path);
    const last = this.checks.get(row.id);
    if (last && last.head === head && Date.now() - last.checkedAt < KEPT_WORKTREE_RECHECK_MS) {
      return last.reason;
    }
    const reason = (await worktreeWork(row.worktreePath, project, await opts.branch?.()))?.reason ?? null;
    if (reason) this.checks.set(row.id, { head, reason, checkedAt: Date.now() });
    else this.checks.delete(row.id);
    return reason;
  }

  /** Forgets the verdicts of runs a GC pass no longer saw. */
  retainOnly(seen: ReadonlySet<string>): void {
    for (const id of this.checks.keys()) {
      if (!seen.has(id)) this.checks.delete(id);
    }
  }
}

/** The steps of one teardown-then-prune job, in order; each is best effort. */
export interface TeardownSteps {
  /** The approved worktree.yml's `teardown` commands. */
  teardown(row: RunRow, project: Pick<WorktreeProject, 'id' | 'path'>): Promise<void>;
  /** The worktree's compose projects, with their volumes. */
  downComposeProjects(row: RunRow): Promise<void>;
  prune(projectPath: string, worktreePath: string): Promise<boolean>;
}

/** The run a teardown job was started for, and how archiving the worktree's outputs went first. */
export interface TeardownOwner {
  runId: string;
  archive?: ArchiveOutcome;
}

/**
 * Background teardown-then-prune jobs, one per worktree, and the prune lock that orders a prune's
 * archive and the start of its teardown. `tearingDown` holds the runs whose worktree is being torn
 * down (a job, or a project delete), so no other path starts it again.
 */
export class WorktreeTeardowns {
  readonly tearingDown = new Set<string>();
  /** A prune's archive and the start of its teardown, one per worktree at a time (GC skips a locked one). */
  readonly pruneLock = new KeyedMutex();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly owners = new Map<string, TeardownOwner>();

  constructor(private readonly steps: TeardownSteps) {}

  /** The job tearing this worktree down, if one runs. */
  jobFor(worktreePath: string): Promise<void> | undefined {
    return this.jobs.get(worktreePath);
  }

  ownerOf(worktreePath: string): TeardownOwner | undefined {
    return this.owners.get(worktreePath);
  }

  /** Whether the run's worktree is being removed: its own teardown, or another run's job for it. */
  removing(runId: string, worktreePath: string): boolean {
    return this.tearingDown.has(runId) || this.jobs.has(worktreePath);
  }

  /**
   * `fn` under the worktree's prune lock for garbage collection: null at once, without waiting, while
   * a manual prune (or another clean-up) holds it, so the worktree is left for the next pass.
   */
  unlessPruning<T>(worktreePath: string, fn: () => Promise<T>): Promise<T | null> {
    if (this.pruneLock.isLocked(worktreePath)) return Promise.resolve(null);
    return this.pruneLock.run(worktreePath, fn);
  }

  /** `fn` with the run marked as tearing down; for a teardown outside a job (a project delete). */
  async marked<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    this.tearingDown.add(runId);
    try {
      return await fn();
    } finally {
      this.tearingDown.delete(runId);
    }
  }

  /**
   * Teardown, then the worktree's compose projects, then prune, then `after`, as one background
   * job. Never rejects. While another run's job for the same worktree (a handoff) runs, this run
   * follows it and gets `after` once it ended; a second request for the same run gets its job back.
   */
  teardownThenPrune(
    row: RunRow,
    project: Pick<WorktreeProject, 'id' | 'path'>,
    after: (removed: boolean) => unknown,
    archive?: ArchiveOutcome,
  ): Promise<void> {
    const running = this.jobs.get(row.worktreePath);
    if (running) {
      if (this.tearingDown.has(row.id)) return running;
      this.tearingDown.add(row.id);
      return running
        .then(async () => {
          await after(!existsSync(row.worktreePath));
        })
        .catch(() => undefined)
        .finally(() => this.tearingDown.delete(row.id));
    }
    this.tearingDown.add(row.id);
    const job: Promise<void> = this.steps
      .teardown(row, project)
      // Best effort: a teardown that throws must not leave the worktree behind.
      .catch(() => undefined)
      .then(() => this.steps.downComposeProjects(row))
      .catch(() => undefined)
      .then(() => this.steps.prune(project.path, row.worktreePath))
      .catch(() => false)
      .then(async (removed) => {
        await after(removed);
      })
      .catch(() => undefined)
      .finally(() => {
        this.tearingDown.delete(row.id);
        if (this.jobs.get(row.worktreePath) === job) {
          this.jobs.delete(row.worktreePath);
          this.owners.delete(row.worktreePath);
        }
      });
    this.jobs.set(row.worktreePath, job);
    this.owners.set(row.worktreePath, { runId: row.id, archive });
    return job;
  }
}
