import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  type BranchRemoteState,
  CreateBranchBody,
  type GitBranch,
  type GitCommitDetail,
  type GitCommitsPage,
  type GitCompare,
  type GitFileDiff,
  type GitPageStatus,
  type GitSync,
  type ReleaseDraft,
  type ReleaseJob,
  SetWorkingBranchBody,
  UpdateGitSettingsBody,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  factoryWorkingBranch,
  readRepositorySettings,
  workingBranchOf,
  writeRepositorySettings,
} from '../db/project-settings.js';
import { projects } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { buildWorkspaceDemo } from '../factory/demo.js';
import { credentialAccountForRemote } from '../forge/account-store.js';
import { parseForgeRemote, type ForgeService } from '../forge/service.js';
import { aheadBehind, mainBranchState, originUrls, realGit, remoteUrlForDisplay } from '../repository/git.js';
import type { RepositoryService } from '../repository/service.js';
import { withMainWorkspaceLock } from '../factory/merge.js';
import { pruneWorktree } from '../runs/git.js';
import type { RunService } from '../runs/service.js';
import type { TicketService } from '../tickets/service.js';
import { approvedChecks } from '../worktree-config/load.js';
import {
  classify,
  createBranch,
  type DeleteBranchResult,
  deleteBranch,
  listBranches,
  localTip,
  refTip,
  setWorkingBranch,
} from './branches.js';
import {
  commitDetail,
  commitFileDiff,
  compareFileDiff,
  compareRefs,
  listCommits,
  ticketKeyOf,
} from './history.js';
import { currentReleaseDraft, DraftJobs, draftReleaseNotes } from './release-notes.js';
import { hasChangelog, latestVersionTag, ReleaseJobs } from './release.js';
import {
  fetchOrigin,
  type GitNotify,
  HEAL_STOP_TIMEOUT_MS,
  HealJobs,
  JOB_WORKTREE,
  jobComposeProject,
  listBackups,
  matchOrigin,
  pull,
  pullTicketText,
  type SyncDeps,
  within,
} from './sync.js';

const IDLE_SYNC: GitSync = { state: 'idle', at: null, branch: null, files: [], message: null };
const isGitRepo = (dir: string) =>
  lstat(path.join(dir, '.git')).then(
    () => true,
    () => false,
  );

/** What the Git page needs from the rest of core; later actions add to this. */
export interface GitPageDeps {
  runs: RunService;
  forge: ForgeService;
  tickets: TicketService;
  /** Where core keeps worktrees; a pull's heal gets its own there. */
  workspacesDir: string;
  /** Runs the checks on a healed pull merge (tests inject it); default: buildWorkspaceDemo. */
  buildWorkspaceDemo?: typeof buildWorkspaceDemo;
  /** Pages a person about a project (server.ts wires core's notifications in); pulls and releases made here use it. */
  notify?: GitNotify;
  /** The release jobs (server.ts makes them); made from the deps above when omitted. */
  releases?: ReleaseJobs;
}

/**
 * The Git page's server side. History, compare and the branch list read the main workspace's git
 * objects only; branch changes run under the main-workspace lock, and a remote delete in
 * RepositoryService's remote-ops order.
 */
export class GitPageService {
  /** Pull heals that run in the background, one per project. */
  private readonly heals = new HealJobs();
  /** Release-notes drafts that run in the background. */
  private readonly drafts = new DraftJobs();
  /** Promote and release jobs that run in the background. */
  private readonly releases: ReleaseJobs;
  /** The sweeps of leftovers under way: stop waits for them. */
  private readonly sweeps = new Set<Promise<void>>();

  constructor(
    private readonly db: Db,
    readonly repository: RepositoryService,
    readonly deps: GitPageDeps,
  ) {
    this.releases =
      deps.releases ??
      new ReleaseJobs(db, {
        repository,
        forge: deps.forge,
        runs: deps.runs,
        workspacesDir: deps.workspacesDir,
        ...(deps.notify ? { notify: deps.notify } : {}),
        ...(deps.buildWorkspaceDemo ? { buildWorkspaceDemo: deps.buildWorkspaceDemo } : {}),
      });
  }

  private project(projectId: string) {
    const row = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!row) throw notFound('no such project');
    return row;
  }

  commits(projectId: string, ref?: string, cursor?: string): Promise<GitCommitsPage> {
    const project = this.project(projectId);
    const start = cursor === undefined || cursor === '' ? 0 : Number(cursor);
    if (!Number.isSafeInteger(start) || start < 0) throw badRequest('The cursor must be a whole number.');
    const working = workingBranchOf(readRepositorySettings(this.db, projectId), project.defaultBranch);
    return listCommits(this.db, project, ref || working, start);
  }

  commit(projectId: string, sha: string): Promise<GitCommitDetail> {
    return commitDetail(this.project(projectId).path, sha);
  }

  commitFile(projectId: string, sha: string, path: string | undefined): Promise<GitFileDiff> {
    return commitFileDiff(this.project(projectId).path, sha, path ?? '');
  }

  compare(projectId: string, base: string | undefined, head: string | undefined): Promise<GitCompare> {
    return compareRefs(this.project(projectId).path, base ?? '', head ?? '');
  }

  compareFile(
    projectId: string,
    base: string | undefined,
    head: string | undefined,
    path: string | undefined,
  ): Promise<GitFileDiff> {
    return compareFileDiff(this.project(projectId).path, base ?? '', head ?? '', path ?? '');
  }

  branches(projectId: string): Promise<GitBranch[]> {
    return listBranches(this.db, this.project(projectId), readRepositorySettings(this.db, projectId));
  }

  async createBranch(projectId: string, raw: unknown): Promise<void> {
    const project = this.project(projectId);
    const body = CreateBranchBody.parse(raw ?? {});
    const working = workingBranchOf(readRepositorySettings(this.db, projectId), project.defaultBranch);
    await createBranch(project, body.name, body.from, working);
  }

  deleteBranch(projectId: string, name: string, remote: boolean): Promise<DeleteBranchResult> {
    return deleteBranch(this.db, this.project(projectId), name, remote, this.repository);
  }

  async setWorkingBranch(projectId: string, raw: unknown): Promise<void> {
    const body = SetWorkingBranchBody.parse(raw ?? {});
    await setWorkingBranch(this.db, this.project(projectId), body.branch, (current) =>
      this.releases.guard(projectId, `the working branch stays ${current}`),
    );
  }

  private syncDeps(): SyncDeps {
    return {
      db: this.db,
      ...(this.deps.notify ? { notify: this.deps.notify } : {}),
      repository: this.repository,
      docker: {
        envFor: (composeProject) => this.deps.runs.dockerEnvForJob(composeProject),
        teardown: (projectId, worktreePath, composeProject) =>
          this.deps.runs.teardownJobWorktree(projectId, worktreePath, composeProject),
      },
      heals: this.heals,
      releases: this.releases,
      workspacesDir: this.deps.workspacesDir,
      ...(this.deps.buildWorkspaceDemo ? { buildWorkspaceDemo: this.deps.buildWorkspaceDemo } : {}),
    };
  }

  /**
   * A person's Pull (`auto: false`), or auto-pull's. While a release runs, auto-pull only reads
   * origin: main is ahead of origin's between the promote and the push on purpose, which is no stop
   * to record or page.
   */
  async pull(projectId: string, opts: { auto: boolean }): Promise<GitSync> {
    this.project(projectId);
    if (opts.auto && (await this.releases.standing(projectId)) === 'running')
      return fetchOrigin(this.syncDeps(), projectId);
    return pull(this.syncDeps(), projectId, opts);
  }

  /**
   * What a crash or a stop during a pull's heal or a release's checks left behind: their worktrees
   * (`pull-<id8>`, `release-<id8>` under the project's `.worktrees` folder), each with its
   * worktree.yml teardown and compose project, and (for every project, at startup) their compose
   * projects left in the engine. A heal's or release's that runs now is never touched: each run of
   * one makes its worktree under a name of its own, claimed before the folder exists, so a name
   * listed here and not in use is a leftover. Best effort. Core stopping ends it before its next
   * leftover; stop waits for the one under way.
   */
  sweepLeftovers(projectId?: string): Promise<void> {
    const sweep = this.sweep(projectId).finally(() => this.sweeps.delete(sweep));
    this.sweeps.add(sweep);
    return sweep;
  }

  private async sweep(projectId?: string): Promise<void> {
    if (this.heals.stopped) return;
    const rows = projectId
      ? [this.project(projectId)]
      : this.db.select({ id: projects.id, path: projects.path, slug: projects.slug }).from(projects).all();
    const inUse = (dir: string) => this.heals.uses(dir) || this.releases.uses(dir);
    for (const row of rows) {
      const parent = path.join(this.deps.workspacesDir, '.worktrees', row.slug);
      const names = (await readdir(parent).catch(() => [] as string[])).filter((n) => JOB_WORKTREE.test(n));
      for (const name of names) {
        if (this.heals.stopped) return;
        const dir = path.join(parent, name);
        if (inUse(dir)) continue;
        await this.deps.runs.teardownJobWorktree(row.id, dir, jobComposeProject(dir)).catch(() => undefined);
        await withMainWorkspaceLock(row.path, () => pruneWorktree(row.path, dir)).catch(() => undefined);
      }
    }
    if (projectId || this.heals.stopped) return;
    // The engine's leftovers: a job project whose worktree is in use now stays (asked after the
    // engine was listed, so a job that started meanwhile keeps its own).
    await this.deps.runs.downLeftoverJobProjects(
      (name) => this.heals.usesComposeProject(name) || this.releases.usesComposeProject(name),
    );
  }

  /** Resolves once no pull's heal, release-notes draft or release job runs in the background. */
  async idle(): Promise<void> {
    await Promise.all([this.heals.idle(), this.drafts.idle(), this.releases.idle()]);
  }

  /**
   * Makes the background heals and drafts give up, a release job end at its next step and a sweep
   * of leftovers end before its next one, and waits for them at most `timeoutMs`.
   */
  async stop(timeoutMs?: number): Promise<void> {
    await Promise.all([
      this.heals.stop(timeoutMs),
      this.drafts.stop(timeoutMs),
      this.releases.stop(timeoutMs),
      within(Promise.all([...this.sweeps]), timeoutMs ?? HEAL_STOP_TIMEOUT_MS),
    ]);
  }

  /** Approve and publish, or Promote only: checked now, run in the background (the job as it starts). */
  startRelease(projectId: string, raw: unknown): Promise<ReleaseJob> {
    this.project(projectId);
    return this.releases.start(projectId, raw);
  }

  /** Goes on with a stopped release from the step it stopped at. */
  retryRelease(projectId: string): Promise<ReleaseJob> {
    this.project(projectId);
    return this.releases.retry(projectId);
  }

  /** Puts main back where a stopped release found it, while nothing of it is pushed. */
  undoPromote(projectId: string): Promise<ReleaseJob> {
    this.project(projectId);
    return this.releases.undoPromote(projectId);
  }

  /**
   * What the Git page shows, read locally (no network): the branches, main and the working branch
   * against origin as last read (`refs/remotes/origin/<b>`), the last pull, and the release.
   */
  async status(projectId: string): Promise<GitPageStatus> {
    const project = this.project(projectId);
    const settings = readRepositorySettings(this.db, projectId);
    const main = project.defaultBranch;
    const working = workingBranchOf(settings, main);
    const base: GitPageStatus = {
      isGitRepo: false,
      defaultBranch: main,
      workingBranch: working,
      checkedOut: null,
      workingMismatch: false,
      mainBehindWorking: 0,
      latestTag: null,
      hasOrigin: false,
      originUrl: null,
      working: 'unknown',
      main: 'unknown',
      workingCounts: null,
      mainCounts: null,
      checkedAt: settings.lastRemoteCheck?.at ?? null,
      autoPull: settings.autoPull,
      sync: this.currentSync(projectId, settings.sync),
      forgeRelease: false,
      release: { ok: false, reason: 'The project folder is not a git repository.' },
      releaseJob: this.releases.current(projectId),
      releaseDraft: this.releaseDraft(projectId),
      releaseSummary: { head: null, commits: 0, tickets: 0, checks: [], hasChangelog: false },
      backups: [],
    };
    const dir = project.path;
    if (!(await isGitRepo(dir))) return base;
    const { branch: checkedOut } = await mainBranchState(dir);
    const stored = factoryWorkingBranch(this.db, projectId, main);
    const { fetch: origin } = await originUrls(dir);
    const mainTip = await localTip(dir, main);
    const workingTip = await localTip(dir, working);
    const behind =
      mainTip && workingTip && mainTip !== workingTip
        ? Number(
            (await realGit(['rev-list', '--count', `${mainTip}..${workingTip}`, '--'], dir)).stdout.trim(),
          )
        : 0;
    // Against origin as last read: a branch origin lacks has no tracking ref after a read that worked.
    const check = settings.lastRemoteCheck;
    const against = async (branch: string, local: string | null): Promise<BranchRemoteState> => {
      if (!origin) return 'unknown';
      const remote = await refTip(dir, `refs/remotes/origin/${branch}`);
      if (remote) return classify(dir, local, remote);
      return check && !check.error ? 'unpublished' : 'unknown';
    };
    const counts = async (branch: string, local: string | null) => {
      if (!origin || !local || !(await refTip(dir, `refs/remotes/origin/${branch}`))) return null;
      try {
        return await aheadBehind(dir, branch);
      } catch {
        return null;
      }
    };
    const reason = await this.releases.refusal(projectId);
    return {
      ...base,
      isGitRepo: true,
      checkedOut,
      workingMismatch: stored !== null && checkedOut !== stored,
      mainBehindWorking: Number.isSafeInteger(behind) ? behind : 0,
      latestTag: await latestVersionTag(dir, `refs/heads/${main}`),
      hasOrigin: origin !== null,
      originUrl: origin ? remoteUrlForDisplay(origin).display : null,
      working: await against(working, workingTip),
      main: await against(main, mainTip),
      workingCounts: await counts(working, workingTip),
      mainCounts: await counts(main, mainTip),
      forgeRelease:
        origin !== null &&
        parseForgeRemote(origin) !== null &&
        credentialAccountForRemote(this.db, origin) !== null,
      release: { ok: reason === null, reason },
      releaseSummary: await this.releaseSummary(projectId, dir, main, working, workingTip),
      backups: await listBackups(dir),
    };
  }

  /**
   * What a release would carry: main..working, or the commits on main since the latest tag when the
   * working branch is main. Tickets are counted from the same 300 commits the release notes read.
   */
  private async releaseSummary(
    projectId: string,
    dir: string,
    main: string,
    working: string,
    workingTip: string | null,
  ): Promise<GitPageStatus['releaseSummary']> {
    const checks = Object.entries(approvedChecks(this.db, projectId) ?? {})
      .filter(([, command]) => command)
      .map(([name]) => name);
    // The release commit writes on main as the promote leaves it: main's own CHANGELOG.md, or the
    // working branch's, which the promote brings in.
    const changelog =
      (await hasChangelog(dir, `refs/heads/${main}`)) ||
      (working !== main && workingTip !== null && (await hasChangelog(dir, workingTip)));
    if (!workingTip) return { head: null, commits: 0, tickets: 0, checks, hasChangelog: changelog };
    let range = workingTip;
    if (working !== main) range = `${main}..${working}`;
    else {
      const tag = await latestVersionTag(dir, `refs/heads/${main}`);
      range = tag ? `${tag}..${main}` : main;
    }
    const count = await realGit(['rev-list', '--count', range, '--'], dir).catch(() => null);
    const subjects = await realGit(['log', '--format=%s', '-n', '300', range, '--'], dir).catch(() => null);
    const keys = new Set<string>();
    for (const subject of subjects?.stdout.split('\n') ?? []) {
      const key = ticketKeyOf(subject);
      if (key) keys.add(key);
    }
    const commits = Number(count?.stdout.trim());
    return {
      head: workingTip,
      commits: Number.isSafeInteger(commits) ? commits : 0,
      tickets: keys.size,
      checks,
      hasChangelog: changelog,
    };
  }

  /**
   * The stored pull as the page shows it: an idle one that still says a heal is checking its merge,
   * while no heal of the project runs (core stopped or restarted during it), will never finish, so
   * it reads as interrupted.
   */
  private currentSync(projectId: string, sync: GitSync | null): GitSync {
    if (!sync) return IDLE_SYNC;
    if (sync.state !== 'idle' || !sync.message || this.heals.running(projectId)) return sync;
    return {
      ...sync,
      state: 'error',
      message:
        'Emberline stopped while it was checking a merge for this pull, so the pull did not finish. Pull again.',
    };
  }

  /** The stored release draft; one whose job is gone reads as failed. */
  releaseDraft(projectId: string): ReleaseDraft | null {
    this.project(projectId);
    return currentReleaseDraft({ db: this.db, jobs: this.drafts }, projectId);
  }

  /** Has an agent draft the release notes and the version bump; the draft is stored for the release. */
  draftRelease(projectId: string): Promise<ReleaseDraft> {
    return draftReleaseNotes({ db: this.db, jobs: this.drafts }, this.project(projectId));
  }

  /** Reads origin only. */
  fetch(projectId: string): Promise<GitSync> {
    this.project(projectId);
    return fetchOrigin(this.syncDeps(), projectId);
  }

  matchOrigin(projectId: string, raw: unknown): Promise<GitSync> {
    this.project(projectId);
    return matchOrigin(this.syncDeps(), projectId, raw);
  }

  updateSettings(projectId: string, raw: unknown): { autoPull: boolean } {
    this.project(projectId);
    const body = UpdateGitSettingsBody.safeParse(raw ?? {});
    if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join('; '));
    const current = readRepositorySettings(this.db, projectId);
    const autoPull = body.data.autoPull ?? current.autoPull;
    writeRepositorySettings(this.db, projectId, { autoPull });
    return { autoPull };
  }

  /**
   * Resolve with a ticket: a ticket whose run merges what conflicted into its branch, through the
   * existing run pipeline and conflict ladder.
   */
  pullTicket(projectId: string): { ticketId: string } {
    this.project(projectId);
    const { sync, syncStop } = readRepositorySettings(this.db, projectId);
    if (sync?.state !== 'conflict' || !sync.branch || !syncStop)
      throw conflict('There is no pull conflict to resolve.', 'no_conflict');
    // One ticket per stop: while the one made for it is open, asking again answers with it.
    const made = syncStop.ticketId ? this.deps.tickets.find(syncStop.ticketId) : undefined;
    if (made && made.projectId === projectId && made.status !== 'done') return { ticketId: made.id };
    const { title, body } = pullTicketText(syncStop.source, sync.branch, sync.files);
    const ticket = this.deps.tickets.create(projectId, { title, body, status: 'ready' });
    writeRepositorySettings(this.db, projectId, { syncStop: { ...syncStop, ticketId: ticket.id } });
    return { ticketId: ticket.id };
  }
}
