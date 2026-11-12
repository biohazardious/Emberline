import type { GitCommitDetail, GitCommitsPage, GitCompare, GitFileDiff } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { readRepositorySettings, workingBranchOf } from '../db/project-settings.js';
import { projects } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import type { ForgeService } from '../forge/service.js';
import type { RepositoryService } from '../repository/service.js';
import type { RunService } from '../runs/service.js';
import type { TicketService } from '../tickets/service.js';
import { commitDetail, commitFileDiff, compareFileDiff, compareRefs, listCommits } from './history.js';

/** What the Git page needs from the rest of core; later actions add to this. */
export interface GitPageDeps {
  runs: RunService;
  forge: ForgeService;
  tickets: TicketService;
}

/** The Git page's server side. History and compare read the main workspace's git objects only. */
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
}
