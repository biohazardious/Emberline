import {
  CreateBranchBody,
  type GitBranch,
  type GitCommitDetail,
  type GitCommitsPage,
  type GitCompare,
  type GitFileDiff,
  type GitSync,
  SetWorkingBranchBody,
  UpdateGitSettingsBody,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { readRepositorySettings, workingBranchOf, writeRepositorySettings } from '../db/project-settings.js';
import { projects } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { buildWorkspaceDemo } from '../factory/demo.js';
import type { ForgeService } from '../forge/service.js';
import type { RepositoryService } from '../repository/service.js';
import type { RunService } from '../runs/service.js';
import type { TicketService } from '../tickets/service.js';
import {
  createBranch,
  type DeleteBranchResult,
  deleteBranch,
  listBranches,
  setWorkingBranch,
} from './branches.js';
import { commitDetail, commitFileDiff, compareFileDiff, compareRefs, listCommits } from './history.js';
import { fetchOrigin, matchOrigin, pull, pullTicketText, type SyncDeps } from './sync.js';

/** What the Git page needs from the rest of core; later actions add to this. */
export interface GitPageDeps {
  runs: RunService;
  forge: ForgeService;
  tickets: TicketService;
  /** Where core keeps worktrees; a pull's heal gets its own there. */
  workspacesDir: string;
  /** Runs the checks on a healed pull merge (tests inject it); default: buildWorkspaceDemo. */
  buildWorkspaceDemo?: typeof buildWorkspaceDemo;
}

/**
 * The Git page's server side. History, compare and the branch list read the main workspace's git
 * objects only; branch changes run under the main-workspace lock, and a remote delete in
 * RepositoryService's remote-ops order.
 */
export class GitPageService {
  constructor(
    private readonly db: Db,
    readonly repository: RepositoryService,
    readonly deps: GitPageDeps,
  ) {}

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
      dockerEnvForMain: (projectId) => this.deps.runs.dockerEnvForMain(projectId),
      workspacesDir: this.deps.workspacesDir,
      ...(this.deps.buildWorkspaceDemo ? { buildWorkspaceDemo: this.deps.buildWorkspaceDemo } : {}),
    };
  }

  /** A person's Pull (`auto: false`), or auto-pull's. */
  pull(projectId: string, opts: { auto: boolean }): Promise<GitSync> {
    this.project(projectId);
    return pull(this.syncDeps(), projectId, opts);
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
