import { lstat } from 'node:fs/promises';
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
import { mainBranchState, originUrls, realGit, remoteUrlForDisplay } from '../repository/git.js';
import type { RepositoryService } from '../repository/service.js';
import type { RunService } from '../runs/service.js';
import type { TicketService } from '../tickets/service.js';
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
import { commitDetail, commitFileDiff, compareFileDiff, compareRefs, listCommits } from './history.js';
import { currentReleaseDraft, DraftJobs, draftReleaseNotes } from './release-notes.js';
import { latestVersionTag, ReleaseJobs } from './release.js';
import {
  fetchOrigin,
  HealJobs,
  listBackups,
  matchOrigin,
  pull,
  pullTicketText,
  type SyncDeps,
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
    await setWorkingBranch(this.db, this.project(projectId), body.branch);
  }

  private syncDeps(): SyncDeps {
    return {
      db: this.db,
      repository: this.repository,
      docker: {
        envFor: (composeProject) => this.deps.runs.dockerEnvForJob(composeProject),
        teardown: (projectId, worktreePath, composeProject) =>
          this.deps.runs.teardownJobWorktree(projectId, worktreePath, composeProject),
      },
      heals: this.heals,
      workspacesDir: this.deps.workspacesDir,
      ...(this.deps.buildWorkspaceDemo ? { buildWorkspaceDemo: this.deps.buildWorkspaceDemo } : {}),
    };
  }

  /** A person's Pull (`auto: false`), or auto-pull's. */
  pull(projectId: string, opts: { auto: boolean }): Promise<GitSync> {
    this.project(projectId);
    return pull(this.syncDeps(), projectId, opts);
  }

  /** Resolves once no pull's heal, release-notes draft or release job runs in the background. */
  async idle(): Promise<void> {
    await Promise.all([this.heals.idle(), this.drafts.idle(), this.releases.idle()]);
  }

  /**
   * Makes the background heals and drafts give up and a release job end at its next step, and
   * waits for them at most `timeoutMs`.
   */
  async stop(timeoutMs?: number): Promise<void> {
    await Promise.all([
      this.heals.stop(timeoutMs),
      this.drafts.stop(timeoutMs),
      this.releases.stop(timeoutMs),
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
      checkedAt: settings.lastRemoteCheck?.at ?? null,
      autoPull: settings.autoPull,
      sync: settings.sync ?? IDLE_SYNC,
      forgeRelease: false,
      release: { ok: false, reason: 'The project folder is not a git repository.' },
      releaseJob: this.releases.current(projectId),
      releaseDraft: this.releaseDraft(projectId),
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
      forgeRelease:
        origin !== null &&
        parseForgeRemote(origin) !== null &&
        credentialAccountForRemote(this.db, origin) !== null,
      release: { ok: reason === null, reason },
      backups: await listBackups(dir),
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
    const { title, body } = pullTicketText(syncStop.source, sync.branch, sync.files);
    const ticket = this.deps.tickets.create(projectId, { title, body, status: 'ready' });
    return { ticketId: ticket.id };
  }
}
