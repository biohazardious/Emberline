/**
 * Promote and release from Emberline: the working branch goes into main as a merge commit, the
 * project's approved checks run on main, CHANGELOG.md gets the notes, main is pushed, then the tag
 * and the forge release; the working branch is brought up to main last.
 *
 * Main moves here, so every step is careful about it:
 * - Only what the person approved goes out: the promote merges the approved head (`job.head`), and
 *   each later step works on the commit the step before it made, never on whatever main names by then.
 * - Nothing is forced. Main is pushed as a fast-forward before any tag exists, so a main push origin
 *   rejects leaves no tag behind; a tag is pushed only when origin has none of that name.
 * - Nothing is lost. Main moves only from the commit Emberline expects there (a compare-and-set, or a
 *   fast-forward of the checked-out branch that git refuses over an edit). A rejected main push and
 *   Undo promote take back only Emberline's own unpushed commits.
 * Network calls run in RepositoryService's remote-ops order, outside the main-workspace lock; each
 * change to the main workspace or its refs runs under the lock. The checks run in core's own
 * detached worktree under a compose project of their own, never the main preview's.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  RELEASE_VERSION,
  type ReleaseJob,
  type ReleaseStep,
  ReleaseStepName,
  StartReleaseBody,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import { CommandFailedError, isRunnerUnavailable } from '../command-exec.js';
import type { Db } from '../db/index.js';
import { readRepositorySettings, workingBranchOf, writeRepositorySettings } from '../db/project-settings.js';
import { projects, runs } from '../db/schema.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { commitIdentityFor, gitIdentityArgs } from '../factory/commit-identity.js';
import { writeResolved } from '../factory/conflict-heal.js';
import { buildWorkspaceDemo } from '../factory/demo.js';
import { runsMergingInto, withMainWorkspaceLock } from '../factory/merge.js';
import { parseForgeRemote, type ForgeService } from '../forge/service.js';
import { redactGitText } from '../git-gateway/gateway.js';
import { execGitFile } from '../git-exec.js';
import {
  isAncestorCommit,
  mainBranchState,
  originUrls,
  pushBranch,
  pushRef,
  realGit,
  remoteRefHead,
  unlessRunnerUnavailable,
} from '../repository/git.js';
import type { RepositoryService } from '../repository/service.js';
import { pruneWorktree } from '../runs/git.js';
import type { RunService } from '../runs/service.js';
import { approvedChecks, approvedSetup } from '../worktree-config/load.js';
import { checkedOutBranches, classify, gitMessage, localTip, refTip, WORKSPACE_DIRTY } from './branches.js';
import { type GitNotify, within, workspaceDirty } from './sync.js';

/** How long stop() waits for a running release step to end. */
export const RELEASE_STOP_TIMEOUT_MS = 5_000;
/** The last part of a failed check's output that is kept. */
const CHECK_OUTPUT_KEPT = 2_400;
/** Core's own worktree for a release's checks: `<workspacesDir>/.worktrees/<slug>/release-<id8>`. */
const RELEASE_DIR = /^release-[0-9a-f]{8}$/;
/** The checks' compose project (`emberline-release-<id8>`), apart from every run's and the main preview's. */
const composeProjectOf = (dir: string) => `emberline-${path.basename(dir)}`;

const NO_CHECKS = 'No approved checks in .emberline/worktree.yml';
const ORIGIN_MAIN_MOVED = "origin's main moved during the release: Pull, then Retry";
/**
 * With no working branch of its own, main is where the factory merges and Keep main pushed publishes:
 * commits origin got meanwhile may be ones the person never saw, so the release is not redone on top
 * of them. After the Pull, a new release shows them.
 */
const ORIGIN_MAIN_MOVED_START_AGAIN =
  "origin's main moved during the release: Pull, then start the release again";
const PROMOTE_CONFLICT = 'main has commits the working branch lacks; Pull first';
const INTERRUPTED =
  'Emberline stopped during this step. Retry checks what it got done and goes on from there.';

/** What a release needs from the rest of core. */
export interface ReleaseDeps {
  /** Pages a person when a job ends done or failed; a failure inside it never reaches the job. */
  notify?: GitNotify;
  repository: Pick<RepositoryService, 'remoteAction' | 'readOrigin' | 'recordPush'>;
  forge: Pick<ForgeService, 'createRelease' | 'findRelease'>;
  /** Docker for the checks' own worktree (RunService's job helpers). */
  runs: Pick<RunService, 'dockerEnvForJob' | 'teardownJobWorktree'>;
  /** Where core keeps worktrees; the checks get their own there. */
  workspacesDir: string;
  /** Runs the checks (tests inject it); default: buildWorkspaceDemo. */
  buildWorkspaceDemo?: typeof buildWorkspaceDemo;
}

interface ReleaseProject {
  id: string;
  path: string;
  slug: string;
  defaultBranch: string;
}

/** One run of a job: what it works on, and the worktree it made. */
interface JobContext {
  project: ReleaseProject;
  main: string;
  job: ReleaseJob;
  /** Run by Retry: the working branch may have moved on past the approved head. */
  resumed: boolean;
  worktree: string | null;
}

type Outcome = { status: 'done' | 'skipped' | 'failed'; detail: string | null };
const done = (detail: string | null = null): Outcome => ({ status: 'done', detail });
const skipped = (detail: string): Outcome => ({ status: 'skipped', detail });
const failed = (detail: string): Outcome => ({ status: 'failed', detail });

const stepOf = (job: ReleaseJob, name: ReleaseStepName): ReleaseStep =>
  job.steps.find((s) => s.name === name) as ReleaseStep;
const finished = (job: ReleaseJob, name: ReleaseStepName) => stepOf(job, name).status === 'done';
const short = (oid: string | null) => (oid ? oid.slice(0, 8) : 'nothing');

/** The commit main should name now: the last one this release made, else main as the release found it. */
function expectedMain(job: ReleaseJob): string | null {
  if (finished(job, 'changelog') && job.releaseCommit) return job.releaseCommit;
  if (finished(job, 'promote') && job.promoteOid) return job.promoteOid;
  return job.previousMain;
}

/**
 * Whether main moved from `previous` to `tip` only by commits origin's main has (as last read, after a
 * Pull): those are published already, and may join a release whose working branch is not main.
 */
async function onlyFromOrigin(mainPath: string, main: string, previous: string | null, tip: string) {
  const originMain = await refTip(mainPath, `refs/remotes/origin/${main}`);
  return (
    previous !== null &&
    originMain !== null &&
    (await isAncestorCommit(mainPath, previous, tip)) &&
    (await isAncestorCommit(mainPath, tip, originMain))
  );
}

const ORIGIN_MOVED_AFTER_CHECKS = "Origin's main moved after the checks; Retry checks it again.";

const mainMoved = (main: string) =>
  `${main} moved during the release (something else changed it here), so Emberline stopped. Start the release again once ${main} is where you want it.`;

/**
 * A step's failure as a sentence for the page, and for the page sent to ntfy or a webhook: never with
 * an address's credentials or a capability in it (the forge masks its own token in its errors).
 */
function failureText(error: unknown): string {
  if (isRunnerUnavailable(error)) return 'The runner did not answer; Retry once it is back.';
  if (error instanceof HttpError) return redactGitText(error.message);
  return redactGitText(gitMessage(error)) || 'The step failed.';
}

/**
 * The approved notes as a new section of CHANGELOG.md, above the first released version: after the
 * `## [Unreleased]` section (whose items stay under it, unpublished) when there is one, else above
 * the first `## ` heading, else at the end. Only linear scans: the file may be anyone's.
 */
export function withReleaseSection(text: string, version: string, date: string, notes: string): string {
  const body = notes.replace(/\r\n/g, '\n').trim();
  const section = `## [${version.replace(/^v/, '')}] - ${date}\n\n${body ? `${body}\n` : ''}`;
  const unreleased = /^## \[unreleased\][^\n]*$/im.exec(text);
  const from = unreleased ? unreleased.index + unreleased[0].length : 0;
  const next = /^## /m.exec(text.slice(from));
  const at = next ? from + next.index : text.length;
  const before = text.slice(0, at).trimEnd();
  const after = text.slice(at);
  return `${before ? `${before}\n\n` : ''}${section}${after ? `\n${after}` : ''}`;
}

/** The tree merging `theirs` into `ours` gives, or the paths that would conflict; nothing is written. */
async function mergeTree(
  mainPath: string,
  ours: string,
  theirs: string,
): Promise<{ tree: string } | { conflicts: string[] }> {
  try {
    const out = await realGit(
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ours, theirs],
      mainPath,
    );
    return { tree: out.stdout.split('\0')[0]!.trim() };
  } catch (error) {
    // Exit 1 is "conflicts": the tree, then each conflicted path. Anything else is a real failure.
    if (!(error instanceof CommandFailedError) || error.code !== 1) throw error;
    return { conflicts: [...new Set(error.stdout.split('\0').slice(1).filter(Boolean))].sort() };
  }
}

/** What a version tag looks like to describe: `v1.2.3` or `1.2.3` (RELEASE_VERSION allows both). */
export const VERSION_TAG_MATCH = ['--match', 'v[0-9]*', '--match', '[0-9]*.[0-9]*.[0-9]*'];

/** The most recent version tag in `ref`'s history, else null. */
export async function latestVersionTag(mainPath: string, ref: string): Promise<string | null> {
  return realGit(['describe', '--tags', '--abbrev=0', ...VERSION_TAG_MATCH, ref], mainPath).then(
    (r) => r.stdout.trim() || null,
    unlessRunnerUnavailable(null),
  );
}

const PULL_FIRST: Partial<Record<string, (b: string) => string>> = {
  behind: (b) => `origin's ${b} has commits ${b} here does not have yet; Pull first.`,
  diverged: (b) => `${b} and origin's ${b} both have commits the other lacks; Pull first.`,
  rewritten: (b) =>
    `origin's ${b} no longer shares history with ${b} here (it was rewritten); use Match origin on the Git page first.`,
};

/** The background release jobs, at most one per project. */
export class ReleaseJobs {
  private readonly running = new Map<string, Promise<void>>();
  /** A start, Retry or Undo between its first check and its job: a second one is refused. */
  private readonly busy = new Set<string>();
  private stopping = false;

  constructor(
    private readonly db: Db,
    private readonly deps: ReleaseDeps,
  ) {}

  private project(projectId: string): ReleaseProject {
    const row = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!row) throw notFound('no such project');
    return row;
  }

  /**
   * The stored job. One stored as running that no job here owns (core stopped during it) reads as
   * failed at the step it was on, so Retry goes on from there.
   */
  current(projectId: string): ReleaseJob | null {
    const job = readRepositorySettings(this.db, projectId).releaseJob;
    if (!job || job.state !== 'running' || this.running.has(projectId)) return job;
    return {
      ...job,
      state: 'failed',
      error: INTERRUPTED,
      steps: job.steps.map((s) =>
        s.status === 'running' ? { ...s, status: 'failed', detail: INTERRUPTED } : s,
      ),
    };
  }

  /** Resolves once no release job runs. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()]);
  }

  /**
   * Core is stopping: a running job ends at its next step (failed, for Retry), and none starts. A
   * step that is running is waited for at most `timeoutMs`; if core is gone before it ends, the job
   * reads as failed at that step.
   */
  async stop(timeoutMs = RELEASE_STOP_TIMEOUT_MS): Promise<void> {
    this.stopping = true;
    await within(this.idle(), timeoutMs);
  }

  /** The first refusal a release would meet that is decidable here, with no network; null: none. */
  async refusal(projectId: string): Promise<string | null> {
    const refused = await this.localRefusal(this.project(projectId), null);
    return refused?.message ?? null;
  }

  /** Approve and publish, or Promote only: checked now, then run in the background. */
  async start(projectId: string, raw: unknown): Promise<ReleaseJob> {
    const parsed = StartReleaseBody.safeParse(raw ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    const body = parsed.data;
    const project = this.project(projectId);
    return this.exclusive(projectId, async () => {
      const refused = await this.localRefusal(project, body);
      if (refused) throw refused;
      const checked = await this.remotePreflight(project, body);
      const main = project.defaultBranch;
      const working = workingBranchOf(readRepositorySettings(this.db, projectId), main);
      // With no working branch of its own, main is what the factory merges into: the release is
      // exactly the approved head, and a merge landing since stops it (the steps check main is there).
      const mainTip = working === main ? body.head : checked;
      const workingInMain =
        working !== main && mainTip !== null && (await isAncestorCommit(project.path, body.head, mainTip));
      const job: ReleaseJob = {
        id: randomUUID(),
        mode: body.mode,
        version: body.mode === 'publish' ? (body.version ?? null) : null,
        notes: body.mode === 'publish' ? (body.notes ?? '') : null,
        head: body.head,
        working,
        state: 'running',
        steps: ReleaseStepName.options.map((name) => ({ name, status: 'pending', detail: null })),
        startedAt: new Date().toISOString(),
        finishedAt: null,
        previousMain: mainTip,
        checked: null,
        promoteOid: null,
        releaseCommit: null,
        releaseUrl: null,
        error: null,
      };
      const skip = (name: ReleaseStepName, detail: string) =>
        Object.assign(stepOf(job, name), { status: 'skipped', detail });
      if (working === main) {
        skip('promote', `The working branch is ${main} itself: there is nothing to promote.`);
        skip('sync_working', `The working branch is ${main} itself.`);
      } else if (workingInMain) {
        skip('promote', `${main} already has everything on ${working}.`);
      }
      if (body.mode === 'promote_only') {
        for (const name of ['changelog', 'tag', 'push_tag', 'forge_release'] as const)
          skip(name, 'Promote only makes no tag and no release.');
      }
      this.write(projectId, job);
      this.launch(project, job, false);
      return job;
    });
  }

  /** Goes on from the first step that is not done, with the version and notes stored. */
  async retry(projectId: string): Promise<ReleaseJob> {
    const project = this.project(projectId);
    return this.exclusive(projectId, async () => {
      const stopped = this.current(projectId);
      if (stopped?.state !== 'failed')
        throw conflict('There is no stopped release to retry.', 'nothing_to_retry');
      if (stepOf(stopped, 'push_main').detail === ORIGIN_MAIN_MOVED_START_AGAIN)
        throw conflict(ORIGIN_MAIN_MOVED_START_AGAIN, 'restart_needed');
      const job: ReleaseJob = {
        ...stopped,
        state: 'running',
        error: null,
        finishedAt: null,
        steps: stopped.steps.map((s) =>
          s.status === 'failed' ? { ...s, status: 'pending', detail: null } : s,
        ),
      };
      // Checks that ran on another commit than main names now say nothing about it: they run again,
      // but only while nothing after them took effect. A step after them that is done, or that core
      // stopped during (a push may have landed), fixes what the release is: Retry finishes it on the
      // commits recorded, whatever main took in since.
      const after = stopped.steps.slice(stopped.steps.findIndex((s) => s.name === 'checks') + 1);
      const untouched = after.every(
        (s) =>
          s.status === 'pending' ||
          s.status === 'skipped' ||
          (s.status === 'failed' && s.detail !== INTERRUPTED),
      );
      const checks = stepOf(job, 'checks');
      if (
        untouched &&
        (checks.status === 'done' || checks.status === 'skipped') &&
        (await localTip(project.path, project.defaultBranch)) !== job.checked
      )
        Object.assign(checks, { status: 'pending', detail: null });
      this.write(projectId, job);
      this.launch(project, job, true);
      return job;
    });
  }

  /**
   * Puts main back where the stopped release found it, while nothing of it is pushed. Only
   * Emberline's own commits are taken back: a main that moved since is left as it is.
   */
  async undoPromote(projectId: string): Promise<ReleaseJob> {
    const project = this.project(projectId);
    const main = project.defaultBranch;
    return this.exclusive(projectId, async () => {
      const stopped = this.current(projectId);
      if (stopped?.state !== 'failed')
        throw conflict('There is no stopped release whose promote can be undone.', 'nothing_to_undo');
      if (finished(stopped, 'push_main'))
        throw conflict(`${main} is pushed to origin already, so its promote stays.`, 'already_pushed');
      const previous = stopped.previousMain;
      const ours = [stopped.releaseCommit, stopped.promoteOid].filter((oid): oid is string => oid !== null);
      const ctx: JobContext = { project, main, job: stopped, resumed: true, worktree: null };
      const nothingToUndo = () =>
        conflict(`${main} is where it was before the release; there is nothing to undo.`, 'nothing_to_undo');
      const moved = () =>
        conflict(`${main} moved since the release stopped, so Emberline left it as it is.`, 'main_moved');
      const local = await localTip(project.path, main);
      if (!previous || local === previous) throw nothingToUndo();
      if (!local || !ours.includes(local)) throw moved();
      // origin as it is now, not as last read: a push that went through though nothing recorded it
      // (the tracking ref may be older) means the promote is published, and it stays.
      await this.deps.repository.remoteAction(project.id, async (ws) => {
        const read = await this.deps.repository.readOrigin(project.id, ws);
        if (read.stale || read.error)
          throw conflict(
            `Couldn't read origin${read.error ? ` (${read.error})` : ''}, so Emberline cannot tell whether ${main} is published there; ${main} stays as it is. Try again once origin answers.`,
            'remote_unreachable',
          );
        await withMainWorkspaceLock(ws.path, async () => {
          const tip = await localTip(ws.path, main);
          if (tip === previous) throw nothingToUndo();
          if (!tip || !ours.includes(tip)) throw moved();
          if (read.main && (await isAncestorCommit(ws.path, tip, read.main)))
            throw conflict(`${main} is on origin already, so its promote stays.`, 'already_pushed');
          await this.moveMain(ctx, tip, previous, 'emberline: undo promote');
        });
      });
      const job: ReleaseJob = { ...stopped, state: 'undone', finishedAt: new Date().toISOString() };
      this.write(projectId, job);
      return job;
    });
  }

  /** `fn` while no other start, Retry or Undo of this project runs, and no job. */
  private async exclusive<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    if (this.stopping)
      throw new HttpError(503, 'stopping', 'Emberline is stopping; try again once it is back.');
    if (this.running.has(projectId) || this.busy.has(projectId))
      throw conflict('A release is running already; wait for it to finish.', 'job_running');
    this.busy.add(projectId);
    try {
      return await fn();
    } finally {
      this.busy.delete(projectId);
    }
  }

  /**
   * The refusals decidable here, with no network and no lock: in the order a person fixes them.
   * `body` null: the Release tab's question (can a release start now?).
   */
  private async localRefusal(
    project: ReleaseProject,
    body: StartReleaseBody | null,
  ): Promise<HttpError | null> {
    const { path: mainPath, defaultBranch: main } = project;
    const settings = readRepositorySettings(this.db, project.id);
    const working = workingBranchOf(settings, main);
    if (this.running.has(project.id) || (body === null && this.busy.has(project.id)))
      return conflict('A release is running already; wait for it to finish.', 'job_running');
    if (body?.mode === 'publish') {
      const version = body.version ?? '';
      const valid =
        RELEASE_VERSION.test(version) &&
        (await execGitFile(['check-ref-format', `refs/tags/${version}`], { cwd: mainPath }).then(
          () => true,
          unlessRunnerUnavailable(false),
        ));
      if (!valid)
        return conflict(
          'Type the version as v1.2.3: an optional v, three numbers, and an optional pre-release such as -rc.1.',
          'version_invalid',
        );
    }
    const workingTip = await localTip(mainPath, working);
    if (!workingTip) return conflict(`${working} has no commits here.`, 'no_commits');
    if (body && body.head !== workingTip)
      return conflict(
        `${working} moved since you looked (it is at ${short(workingTip)} now); look at the release again.`,
        'head_moved',
      );
    const mainTip = await localTip(mainPath, main);
    if (!mainTip) return conflict(`${main} has no commits yet.`, 'no_commits');
    if (!(await originUrls(mainPath)).fetch)
      return conflict(
        'This project has no origin. Connect a repository in Project settings → Repository first.',
        'no_remote',
      );
    if (working !== main) {
      const { branch: checkedOut } = await mainBranchState(mainPath);
      if (checkedOut !== working)
        return conflict(
          `The main workspace ${checkedOut ? `is on ${checkedOut}` : 'is not on a branch'}, but the working branch is ${working}. Switch back on the Git page (or check out ${working}) first.`,
          'working_mismatch',
        );
    }
    const last = this.current(project.id);
    if (
      last?.state === 'failed' &&
      !finished(last, 'push_main') &&
      [last.promoteOid, last.releaseCommit].includes(mainTip)
    )
      return conflict(
        `The last release stopped with ${main} changed here and not pushed. Retry it, or Undo promote, first.`,
        'release_unfinished',
      );
    const merging = runsMergingInto(mainPath);
    if (merging.length > 0) {
      const runs = merging.map((id) => ({ id, title: this.runTitle(id) }));
      const names = runs.map((r) => r.title ?? r.id).join(', ');
      return new HttpError(
        409,
        'runs_live',
        `A run is merging into ${working} right now (${names}); release once it has finished.`,
        { runs },
      );
    }
    const latest = await latestVersionTag(mainPath, `refs/heads/${main}`);
    const atLatest = latest !== null && (await refTip(mainPath, `refs/tags/${latest}`)) === mainTip;
    const workingInMain = working !== main && (await isAncestorCommit(mainPath, workingTip, mainTip));
    if (workingInMain && body?.mode === 'promote_only')
      return conflict(
        `${main} already has everything on ${working}; there is nothing to promote.`,
        'nothing_to_release',
      );
    if ((working === main || workingInMain) && atLatest)
      return conflict(
        `${main} is at ${latest} already and has nothing new to release.`,
        'nothing_to_release',
      );
    if (body?.mode === 'publish' && (await refExists(mainPath, `refs/tags/${body.version}`)))
      return conflict(`The tag ${body.version} exists here already; choose another version.`, 'tag_exists');
    // As origin was last read; a start reads it again.
    return this.originRefusal(
      mainPath,
      main,
      working,
      await refTip(mainPath, `refs/remotes/origin/${main}`),
      working !== main ? await refTip(mainPath, `refs/remotes/origin/${working}`) : null,
    );
  }

  /** Main and the working branch against origin's: a release needs both caught up first. */
  private async originRefusal(
    mainPath: string,
    main: string,
    working: string,
    remoteMain: string | null,
    remoteWorking: string | null,
  ): Promise<HttpError | null> {
    const branches: [string, string | null][] = [[main, remoteMain]];
    if (working !== main) branches.push([working, remoteWorking]);
    for (const [branch, remote] of branches) {
      if (!remote) continue;
      const state = await classify(mainPath, await localTip(mainPath, branch), remote);
      const text = PULL_FIRST[state];
      if (text) return conflict(text(branch), 'pull_first');
      // Commits on main that are not this release's would go out with it, unseen.
      if (state === 'ahead' && branch === main && working !== main)
        return conflict(
          `${main} has commits origin's ${main} does not have, and they are not part of this release. Push or remove them first.`,
          'main_unpushed',
        );
    }
    return null;
  }

  /**
   * In origin's queue: origin read now, then the tag looked up there. Returns main's commit as it
   * was checked against origin's: the one the release starts from.
   */
  private async remotePreflight(project: ReleaseProject, body: StartReleaseBody): Promise<string | null> {
    return this.deps.repository.remoteAction(project.id, async (ws) => {
      const read = await this.deps.repository.readOrigin(project.id, ws);
      if (read.stale)
        throw conflict(
          "This project's origin changed while Emberline read it, so nothing was started. Try again.",
          'origin_changed',
        );
      if (read.error) throw conflict(`Couldn't read origin: ${read.error}`, 'remote_unreachable');
      const refused = await this.originRefusal(
        ws.path,
        ws.defaultBranch,
        read.workingBranch,
        read.main,
        read.workingBranch !== ws.defaultBranch ? read.working : null,
      );
      if (refused) throw refused;
      if (
        body.mode === 'publish' &&
        (await remoteRefHead(ws.path, ws.access, `refs/tags/${body.version}`)) !== null
      )
        throw conflict(`origin has a tag ${body.version} already; choose another version.`, 'tag_exists');
      return localTip(ws.path, ws.defaultBranch);
    });
  }

  private runTitle(runId: string): string | null {
    return this.db.select({ title: runs.title }).from(runs).where(eq(runs.id, runId)).get()?.title ?? null;
  }

  private write(projectId: string, job: ReleaseJob): void {
    try {
      writeRepositorySettings(this.db, projectId, { releaseJob: job });
    } catch {
      // the project was deleted meanwhile
    }
  }

  private launch(project: ReleaseProject, job: ReleaseJob, resumed: boolean): void {
    const ctx: JobContext = { project, main: project.defaultBranch, job, resumed, worktree: null };
    const running = this.run(ctx)
      .catch(() => undefined)
      .finally(() => this.running.delete(project.id));
    this.running.set(project.id, running);
  }

  /** The steps in order, from the first that is not done; the job is written after each one. */
  private async run(ctx: JobContext): Promise<void> {
    const { job, project } = ctx;
    const end = (state: ReleaseJob['state'], error: string | null) => {
      Object.assign(job, { state, error, finishedAt: new Date().toISOString() });
      this.write(project.id, job);
      if (!this.stopping) this.page(ctx);
    };
    try {
      for (const name of ReleaseStepName.options) {
        const step = stepOf(job, name);
        if (step.status === 'done' || step.status === 'skipped') continue;
        if (this.stopping)
          return end('failed', `Emberline stopped before this step: ${name}. Retry goes on from there.`);
        Object.assign(step, { status: 'running', detail: null });
        this.write(project.id, job);
        const outcome = await this.step(ctx, name).catch((error: unknown) => failed(failureText(error)));
        Object.assign(step, outcome);
        this.write(project.id, job);
        if (outcome.status === 'failed') return end('failed', outcome.detail);
      }
      end('done', null);
    } finally {
      await this.removeWorktree(ctx);
    }
  }

  /**
   * One page each time the job ends: done, or failed at its first failed step. Core stopping pages
   * nothing.
   */
  private page({ job, project, main }: JobContext): void {
    if (!this.deps.notify || (job.state !== 'done' && job.state !== 'failed')) return;
    const label = job.version ?? job.working;
    const at = job.steps.find((s) => s.status === 'failed')?.name ?? 'the start';
    try {
      // Each end of the job is its own page: a Retry that stops again is paged again.
      this.deps.notify(project.id, `${project.id}:release:${job.id}:${job.state}:${job.finishedAt ?? ''}`, {
        event: 'release_finished',
        title:
          job.state === 'done'
            ? job.version
              ? `Released ${job.version}`
              : `Promoted ${job.working} into ${main}`
            : `Release ${label} stopped at ${at}`,
        body:
          job.state === 'done'
            ? (job.releaseUrl ?? `${label} is released.`)
            : (job.error ?? 'Open the Git page to see what stopped it.'),
        priority: job.state === 'done' ? 'default' : 'high',
        tags: [job.state === 'done' ? 'rocket' : 'x', 'emberline'],
      });
    } catch {
      // a page that cannot be sent never changes how the job ends
    }
  }

  private step(ctx: JobContext, name: ReleaseStepName): Promise<Outcome> {
    switch (name) {
      case 'promote':
        return this.promote(ctx);
      case 'checks':
        return this.checks(ctx);
      case 'changelog':
        return this.changelog(ctx);
      case 'push_main':
        return this.pushMain(ctx);
      case 'tag':
        return this.tag(ctx);
      case 'push_tag':
        return this.pushTag(ctx);
      case 'forge_release':
        return this.forgeRelease(ctx);
      case 'sync_working':
        return this.syncWorking(ctx);
    }
  }

  /**
   * The approved head merged into main as a commit with parents [main, head], made with the project's
   * identity and no trailers, and main moved to it from the commit read under the lock.
   */
  private promote(ctx: JobContext): Promise<Outcome> {
    const { project, main, job } = ctx;
    const mainPath = project.path;
    const working = job.working;
    return withMainWorkspaceLock(mainPath, async () => {
      const now = workingBranchOf(readRepositorySettings(this.db, project.id), main);
      if (now !== working)
        return failed(`The working branch changed to ${now} during the release; start the release again.`);
      const workingTip = await localTip(mainPath, working);
      if (!ctx.resumed && workingTip !== job.head)
        return failed(
          `${working} moved since you approved the release (a merge landed); look at the release again and start it again.`,
        );
      if (!workingTip || !(await isAncestorCommit(mainPath, job.head, workingTip)))
        return failed(
          `${working} no longer has ${short(job.head)}, the commit this release was approved at; start the release again.`,
        );
      const mainTip = await localTip(mainPath, main);
      // A promote that went through just before core stopped.
      if (job.promoteOid && mainTip === job.promoteOid) return done();
      job.promoteOid = null;
      if (!mainTip) return failed(`${main} has no commits here.`);
      if (mainTip !== job.previousMain) {
        if (!(await onlyFromOrigin(mainPath, main, job.previousMain, mainTip)))
          return failed(mainMoved(main));
        job.previousMain = mainTip;
      }
      if ((await checkedOutBranches(mainPath)).has(main))
        return failed(
          `${main} is checked out in a worktree, so Emberline did not move it. Check out another branch there, then Retry.`,
        );
      const merged = await mergeTree(mainPath, mainTip, job.head);
      if ('conflicts' in merged) return failed(PROMOTE_CONFLICT);
      const identity = gitIdentityArgs(commitIdentityFor(this.db, project.id));
      const commit = (
        await execGitFile(
          [
            ...identity,
            'commit-tree',
            merged.tree,
            '-p',
            mainTip,
            '-p',
            job.head,
            '-m',
            `Merge ${working} into ${main}`,
          ],
          { cwd: mainPath },
        )
      ).stdout.trim();
      // Recorded first: a core that stops right after the move still knows the commit is its own.
      job.promoteOid = commit;
      this.write(project.id, job);
      try {
        await this.moveMain(ctx, mainTip, commit, `emberline: promote ${working}`);
      } catch (error) {
        job.promoteOid = null;
        throw error;
      }
      return done();
    });
  }

  /**
   * For the checks: the commit main must name, the one this release left. Before the release made
   * any commit (a skipped promote, or one taken back after a rejected push), main may have taken in
   * origin's commits by a Pull, when the working branch is not main; the release goes on from there,
   * checked. Every later step needs exactly the commit the checks ran on (`job.checked`).
   */
  private async pinnedMain(ctx: JobContext, mainTip: string | null): Promise<string | null> {
    const { project, main, job } = ctx;
    const expected = expectedMain(job);
    if (!expected || !mainTip) return null;
    if (mainTip === expected) return expected;
    const made = finished(job, 'promote') || finished(job, 'changelog');
    if (made || job.working === main || !(await onlyFromOrigin(project.path, main, expected, mainTip)))
      return null;
    job.previousMain = mainTip;
    return mainTip;
  }

  /** The approved worktree.yml checks on main as this release left it, in core's own worktree. */
  private async checks(ctx: JobContext): Promise<Outcome> {
    const { project, main } = ctx;
    const expected = await this.pinnedMain(ctx, await localTip(project.path, main));
    if (!expected) return failed(mainMoved(main));
    const checks = approvedChecks(this.db, project.id);
    if (!checks) {
      ctx.job.checked = expected;
      return skipped(NO_CHECKS);
    }
    const dir = await this.worktreeAt(ctx, expected);
    const result = await (this.deps.buildWorkspaceDemo ?? buildWorkspaceDemo)({
      db: this.db,
      projectId: project.id,
      targetId: 'release',
      workspacePath: dir,
      checks,
      setup: approvedSetup(this.db, project.id),
      env: await this.deps.runs.dockerEnvForJob(composeProjectOf(dir)),
    });
    if (!result.ok) {
      await this.removeWorktree(ctx);
      return failed(result.output.slice(-CHECK_OUTPUT_KEPT).trim() || 'The checks failed.');
    }
    ctx.job.checked = expected;
    return done();
  }

  /**
   * Main as the checks saw it, for the steps after them; else the failure. Main moved on only by
   * origin's commits (a Pull during the checks): the checks are to run again on it, by Retry.
   */
  private async checkedMain(ctx: JobContext, mainTip: string | null): Promise<string | Outcome> {
    const { project, main, job } = ctx;
    const expected = expectedMain(job);
    if (expected && mainTip === expected && expected === job.checked) return expected;
    const made = finished(job, 'promote') || finished(job, 'changelog');
    if (
      expected &&
      mainTip &&
      !made &&
      job.working !== main &&
      (await onlyFromOrigin(project.path, main, expected, mainTip))
    ) {
      Object.assign(stepOf(job, 'checks'), { status: 'pending', detail: null });
      return failed(ORIGIN_MOVED_AFTER_CHECKS);
    }
    if (expected && mainTip === expected)
      return failed('The checks did not run on this commit of main; Retry runs them.');
    return failed(mainMoved(main));
  }

  /** The notes as a new section of main's CHANGELOG.md, in a commit that changes only that file. */
  private async changelog(ctx: JobContext): Promise<Outcome> {
    const { project, main, job } = ctx;
    const mainPath = project.path;
    const mainTip = await localTip(mainPath, main);
    // A release commit made just before core stopped.
    if (job.releaseCommit && mainTip && (await isAncestorCommit(mainPath, job.releaseCommit, mainTip)))
      return done();
    job.releaseCommit = null;
    const expected = await this.checkedMain(ctx, mainTip);
    if (typeof expected !== 'string') return expected;
    const entry = (await realGit(['ls-tree', '-z', expected, '--', 'CHANGELOG.md'], mainPath)).stdout.split(
      '\0',
    )[0];
    if (!entry) return skipped(`${main} has no CHANGELOG.md.`);
    const [meta = '', file] = entry.split('\t');
    const [mode, type, blob] = meta.split(' ');
    if (file !== 'CHANGELOG.md' || type !== 'blob' || (mode !== '100644' && mode !== '100755') || !blob)
      return skipped(`CHANGELOG.md on ${main} is not a regular file, so it was left as it is.`);
    const version = job.version ?? '';
    const text = (await realGit(['cat-file', 'blob', blob], mainPath)).stdout;
    // Read as UTF-8 text, bytes that are not UTF-8 would come back as U+FFFD and be written so:
    // such a file is left as it is rather than changed past what the notes add.
    const size = Number((await realGit(['cat-file', '-s', blob], mainPath)).stdout.trim());
    if (Buffer.byteLength(text, 'utf8') !== size)
      return skipped('CHANGELOG.md is not UTF-8 text; the notes were not added.');
    const next = withReleaseSection(text, version, new Date().toISOString().slice(0, 10), job.notes ?? '');
    const dir = await this.worktreeAt(ctx, expected);
    await writeResolved(dir, 'CHANGELOG.md', next);
    await execGitFile(['add', '--', 'CHANGELOG.md'], { cwd: dir });
    const tree = (await execGitFile(['write-tree'], { cwd: dir })).stdout.trim();
    const changed = (await realGit(['diff-tree', '-r', '--name-only', expected, tree, '--'], dir)).stdout
      .split('\n')
      .filter(Boolean);
    if (changed.length !== 1 || changed[0] !== 'CHANGELOG.md')
      return failed('The release commit would have changed more than CHANGELOG.md, so it was not made.');
    const identity = gitIdentityArgs(commitIdentityFor(this.db, project.id));
    const commit = (
      await execGitFile(
        [...identity, 'commit-tree', tree, '-p', expected, '-m', `chore(release): ${version}`],
        {
          cwd: mainPath,
        },
      )
    ).stdout.trim();
    job.releaseCommit = commit;
    this.write(project.id, job);
    try {
      await withMainWorkspaceLock(mainPath, () =>
        this.moveMain(ctx, expected, commit, `emberline: release ${version}`),
      );
    } catch (error) {
      job.releaseCommit = null;
      throw error;
    }
    return done();
  }

  /**
   * Main's commit as this release left it pushed to origin's main, as a fast-forward. origin's main
   * moving meanwhile rejects it; then main here goes back to where the release found it (nothing of
   * the release is pushed), so a Pull can bring origin's in and Retry promotes again on top.
   */
  private async pushMain(ctx: JobContext): Promise<Outcome> {
    const { project, main, job } = ctx;
    const expected = expectedMain(job);
    if (!expected) return failed(`${main} has no commits here.`);
    // Only what the checks ran on goes out: that commit, or the release commit made right on it.
    if (expected !== job.checked && !(finished(job, 'changelog') && expected === job.releaseCommit))
      return failed('The checks did not run on this commit of main; Retry runs them.');
    const result = await this.deps.repository.remoteAction(project.id, async (ws) => {
      const has = await withMainWorkspaceLock(ws.path, async () => {
        const tip = await localTip(ws.path, main);
        return tip !== null && (await isAncestorCommit(ws.path, expected, tip));
      });
      if (!has) return 'gone' as const;
      const pushed = await pushBranch(ws.path, ws.access, main, expected);
      if (pushed === 'pushed') {
        // The push landed: origin has main now, whatever recording it here comes to. A failure of
        // that record never makes the step failed (Undo would then take back a published promote).
        await this.deps.repository.recordPush(project.id, ws, main, expected).catch(() => undefined);
        return pushed;
      }
      // Rejected: origin's main moved. If it has the release's commit already (Keep main pushed, or a
      // push recorded nowhere), there is nothing to push; the read also sets the tracking ref.
      const read = await this.deps.repository.readOrigin(project.id, ws);
      const contained =
        !read.stale &&
        !read.error &&
        read.main !== null &&
        (await isAncestorCommit(ws.path, expected, read.main));
      if (!contained) return pushed;
      await this.deps.repository.recordPush(project.id, ws, main, read.main!);
      return 'contained' as const;
    });
    if (result === 'gone')
      return failed(
        `${main} here no longer has the release's commit ${short(expected)}, so it was not pushed.`,
      );
    if (result === 'contained') return done(`origin's ${main} has this release's commit already.`);
    if (result === 'rejected') {
      const kept = await this.takeBack(ctx);
      if (kept)
        return failed(
          `origin's ${main} moved during the release, and ${main} here could not be put back where the release found it (${kept}), so a Pull cannot bring origin's in yet. Undo promote once that is fixed, then Pull and start the release again.`,
        );
      return failed(job.working === main ? ORIGIN_MAIN_MOVED_START_AGAIN : ORIGIN_MAIN_MOVED);
    }
    return done();
  }

  /**
   * After a rejected main push: main back at the commit the release found, if it still names this
   * release's last commit, and the steps that made those commits to do again on Retry. Returns why
   * main could not be put back, or null (put back, or nothing of the release's to take back).
   */
  private async takeBack(ctx: JobContext): Promise<string | null> {
    const { project, main, job } = ctx;
    const previous = job.previousMain;
    const expected = expectedMain(job);
    if (!previous || !expected || expected === previous) return null;
    const why = await withMainWorkspaceLock(project.path, async () => {
      if ((await localTip(project.path, main)) !== expected)
        return `${main} moved here since the release changed it`;
      await this.moveMain(ctx, expected, previous, 'emberline: release not pushed');
      return null;
    }).catch((error: unknown) => failureText(error));
    if (why) return why;
    for (const name of ['promote', 'checks', 'changelog'] as const) {
      const step = stepOf(job, name);
      if (step.status === 'done') Object.assign(step, { status: 'pending', detail: null });
    }
    job.promoteOid = null;
    job.releaseCommit = null;
    return null;
  }

  /** The annotated tag `<version>` on the release commit, with the project's identity. */
  private tag(ctx: JobContext): Promise<Outcome> {
    const { project, job } = ctx;
    const target = expectedMain(job);
    const version = job.version ?? '';
    const ref = `refs/tags/${version}`;
    return withMainWorkspaceLock(project.path, async () => {
      if (!target) return failed('There is no release commit to tag.');
      if (await refExists(project.path, ref)) {
        // A tag made just before core stopped.
        const type = await objectType(project.path, ref);
        if (type === 'tag' && (await refTip(project.path, ref)) === target) return done();
        return failed(`A tag ${version} exists here already, on another commit; it was left as it is.`);
      }
      await execGitFile(
        [
          ...gitIdentityArgs(commitIdentityFor(this.db, project.id)),
          '-c',
          'tag.forceSignAnnotated=false',
          'tag',
          '-a',
          '-m',
          version,
          version,
          target,
        ],
        { cwd: project.path },
      );
      return done();
    });
  }

  /** The tag pushed to origin only when origin has none of that name; ours there already is done. */
  private async pushTag(ctx: JobContext): Promise<Outcome> {
    const { project, job } = ctx;
    const version = job.version ?? '';
    const ref = `refs/tags/${version}`;
    const result = await this.deps.repository.remoteAction(project.id, async (ws) => {
      const local = await realGit(
        ['rev-parse', '--verify', '--quiet', '--end-of-options', ref],
        ws.path,
      ).then((r) => r.stdout.trim() || null, unlessRunnerUnavailable(null));
      if (!local) return 'missing' as const;
      const remote = await remoteRefHead(ws.path, ws.access, ref);
      if (remote === local) return 'pushed' as const;
      if (remote !== null) return 'rejected' as const;
      return pushRef(ws.path, ws.access, { ref, newOid: local, expectOld: null });
    });
    if (result === 'missing') {
      Object.assign(stepOf(job, 'tag'), { status: 'pending', detail: null });
      return failed(`The tag ${version} is gone here; Retry makes it again.`);
    }
    if (result === 'rejected')
      return failed(
        `origin already has a tag ${version} that names another object, so Emberline did not push its own. Remove one of them, then Retry.`,
      );
    return done();
  }

  /** The release page on the forge; with no account for origin, the tag alone is the release. */
  private async forgeRelease(ctx: JobContext): Promise<Outcome> {
    const { project, job } = ctx;
    const tag = job.version ?? '';
    try {
      const { url } = await this.deps.forge.createRelease(project.id, {
        tag,
        name: tag,
        notes: job.notes ?? '',
      });
      job.releaseUrl = url;
      return done();
    } catch (error) {
      // "Already exists" (GitHub 422, GitLab and Gitea 409): one made before, whose answer was lost.
      if (
        error instanceof HttpError &&
        error.code === 'forge_error' &&
        [409, 422].includes(error.statusCode)
      ) {
        const found = await this.deps.forge.findRelease(project.id, tag);
        if (!found) throw error;
        job.releaseUrl = found.url;
        return done(`The forge had this release already.`);
      }
      if (!(error instanceof HttpError) || error.code !== 'forge_account_missing') throw error;
      const origin = (await originUrls(project.path)).fetch;
      const host = (origin && parseForgeRemote(origin)?.host) || 'origin';
      return skipped(`No forge account for ${host}: the tag is pushed, the release page is not`);
    }
  }

  /**
   * The checked-out working branch brought up to main: a fast-forward, which git refuses over an
   * edit; when the factory merged into it meanwhile, main is merged in as a pull does, only cleanly.
   */
  private syncWorking(ctx: JobContext): Promise<Outcome> {
    const { project, main, job } = ctx;
    const mainPath = project.path;
    const working = job.working;
    return withMainWorkspaceLock(mainPath, async () => {
      const now = workingBranchOf(readRepositorySettings(this.db, project.id), main);
      if (now !== working)
        return failed(
          `The working branch changed to ${now} during the release, so ${working} was not brought up to ${main}.`,
        );
      const { branch: checkedOut } = await mainBranchState(mainPath);
      if (checkedOut !== working)
        return failed(
          `The main workspace ${checkedOut ? `is on ${checkedOut}` : 'is not on a branch'}, not ${working}, so ${working} was not brought up to ${main}. Check out ${working}, then Retry.`,
        );
      const mainTip = await localTip(mainPath, main);
      const workingTip = await localTip(mainPath, working);
      if (!mainTip || !workingTip) return failed(`${main} or ${working} has no commits here.`);
      if (await isAncestorCommit(mainPath, mainTip, workingTip)) return done();
      const dirty = (why: string) =>
        failed(
          `The main workspace has changes that bringing ${working} up to ${main} would overwrite, so ${working} stayed as it was. Commit or discard them, then Retry. (${why})`,
        );
      const inMain = { cwd: mainPath, timeout: 120_000 };
      if (await isAncestorCommit(mainPath, workingTip, mainTip)) {
        try {
          await execGitFile(['merge', '--ff-only', '--no-stat', mainTip], inMain);
        } catch (error) {
          if (isRunnerUnavailable(error)) throw error;
          const why = gitMessage(error);
          if (WORKSPACE_DIRTY.test(why)) return dirty(why);
          return failed(`Could not fast-forward ${working} to ${main}: ${why}`);
        }
        return done();
      }
      if (await workspaceDirty(mainPath)) return dirty('uncommitted changes');
      const merged = await mergeTree(mainPath, workingTip, mainTip);
      if ('conflicts' in merged) {
        const shown = merged.conflicts.slice(0, 10).join(', ') + (merged.conflicts.length > 10 ? ', …' : '');
        return failed(
          `${working} got commits during the release that change the same lines as ${main} in ${shown}, so ${main} was not merged into it. Merge ${main} into ${working} (by hand or with a ticket), then Retry.`,
        );
      }
      try {
        await execGitFile(
          [
            ...gitIdentityArgs(commitIdentityFor(this.db, project.id)),
            'merge',
            '--no-ff',
            '--no-edit',
            '--no-log',
            '--no-signoff',
            '-m',
            `Merge ${main} into ${working}`,
            mainTip,
          ],
          inMain,
        );
      } catch (error) {
        if (isRunnerUnavailable(error)) throw error;
        // Only a merge that started is aborted; the tree was clean, so that puts it back exactly.
        if ((await refTip(mainPath, 'MERGE_HEAD')) !== null)
          await execGitFile(['merge', '--abort'], { cwd: mainPath }).catch(
            unlessRunnerUnavailable(undefined),
          );
        return failed(`Could not merge ${main} into ${working}: ${gitMessage(error)}`);
      }
      return done();
    });
  }

  /**
   * Under the lock: main from `from` to `to`, and only from `from`. Checked out in the main workspace,
   * it moves with its files (a fast-forward, or `reset --keep` back), which git refuses over an edit;
   * otherwise its ref is set by compare-and-set.
   */
  private async moveMain(ctx: JobContext, from: string, to: string, reason: string): Promise<void> {
    const { project, main } = ctx;
    const mainPath = project.path;
    const { branch: checkedOut } = await mainBranchState(mainPath);
    if (checkedOut === main) {
      if ((await refTip(mainPath, 'HEAD')) !== from) throw conflict(mainMoved(main), 'main_moved');
      const forward = await isAncestorCommit(mainPath, from, to);
      try {
        await execGitFile(forward ? ['merge', '--ff-only', '--no-stat', to] : ['reset', '--keep', to], {
          cwd: mainPath,
          timeout: 120_000,
        });
      } catch (error) {
        if (isRunnerUnavailable(error)) throw error;
        const why = gitMessage(error);
        throw conflict(
          WORKSPACE_DIRTY.test(why) || /local changes|not uptodate/i.test(why)
            ? `The main workspace has changes to files this would overwrite, so ${main} stayed as it was. Commit or discard them, then try again. (${why})`
            : `Could not move ${main}: ${why}`,
          'workspace_dirty',
        );
      }
      if ((await localTip(mainPath, main)) !== to) throw conflict(mainMoved(main), 'main_moved');
      return;
    }
    if ((await checkedOutBranches(mainPath)).has(main))
      throw conflict(
        `${main} is checked out in another worktree, so Emberline did not move it. Check out another branch there, then try again.`,
        'branch_checked_out',
      );
    await execGitFile(['update-ref', '-m', reason, `refs/heads/${main}`, to, from], { cwd: mainPath });
  }

  /** Core's own detached worktree at `commit`, made once per job run and put back there each time. */
  private async worktreeAt(ctx: JobContext, commit: string): Promise<string> {
    const { project } = ctx;
    if (ctx.worktree) {
      await execGitFile(['reset', '-q', '--hard', commit], { cwd: ctx.worktree, timeout: 120_000 });
      return ctx.worktree;
    }
    const parent = path.join(this.deps.workspacesDir, '.worktrees', project.slug);
    // Only one release of a project runs at a time: any release worktree found is left over.
    for (const name of (await readdir(parent).catch(() => [] as string[])).filter((n) => RELEASE_DIR.test(n)))
      await this.removeDir(project, path.join(parent, name));
    await mkdir(parent, { recursive: true });
    const dir = path.join(parent, `release-${ctx.job.id.replace(/-/g, '').slice(0, 8)}`);
    await withMainWorkspaceLock(project.path, () =>
      execGitFile(['worktree', 'add', '--detach', dir, commit], { cwd: project.path, timeout: 120_000 }),
    );
    ctx.worktree = dir;
    return dir;
  }

  private async removeWorktree(ctx: JobContext): Promise<void> {
    if (!ctx.worktree) return;
    const dir = ctx.worktree;
    ctx.worktree = null;
    await this.removeDir(ctx.project, dir);
  }

  /** As a run's worktree goes: worktree.yml teardown and compose down, then the removal and a prune. */
  private async removeDir(project: ReleaseProject, dir: string): Promise<void> {
    await this.deps.runs.teardownJobWorktree(project.id, dir, composeProjectOf(dir)).catch(() => undefined);
    await withMainWorkspaceLock(project.path, () => pruneWorktree(project.path, dir)).catch(() => undefined);
  }
}

const refExists = (mainPath: string, ref: string) =>
  realGit(['show-ref', '--verify', '--quiet', ref], mainPath).then(
    () => true,
    unlessRunnerUnavailable(false),
  );

const objectType = (mainPath: string, ref: string) =>
  realGit(['cat-file', '-t', ref], mainPath).then((r) => r.stdout.trim(), unlessRunnerUnavailable(''));
