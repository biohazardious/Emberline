/**
 * Trust for `.emberline/worktree.yml`: its commands run in the runner and agents can edit and merge
 * the file, so runs use only the content a person approved (project_worktree_config). A change at
 * the main workspace's HEAD applies once a person approved exactly that content.
 */
import { createHash } from 'node:crypto';
import type { WorktreeConfigStatusResponse } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { projectWorktreeConfig } from '../db/schema.js';
import { badRequest, conflict } from '../errors.js';
import { readHeadWorktreeYml } from '../factory/detect.js';
import { unifiedDiff } from './diff.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The approved content next to HEAD's committed file, with the diff between them. */
export async function worktreeConfigStatus(db: Db, project: { id: string; path: string }): Promise<WorktreeConfigStatusResponse> {
  const row = db.select().from(projectWorktreeConfig).where(eq(projectWorktreeConfig.projectId, project.id)).get();
  const approved = row
    ? { content: row.content, sha256: row.sha256, approvedAt: row.approvedAt.toISOString(), approvedBy: row.approvedBy }
    : null;
  const read = await readHeadWorktreeYml(project.path);
  const head = read?.content != null && read.sha256 ? { content: read.content, sha256: read.sha256 } : null;
  const changed = head !== null && head.sha256 !== approved?.sha256;
  return {
    approved,
    head,
    changed,
    diff: changed ? unifiedDiff(approved?.content ?? '', head.content) : '',
    errors: read?.errors ?? [],
  };
}

/**
 * Approves HEAD's file, only when `sha` is its content's sha256 (what the person reviewed is what
 * HEAD has now: 409 otherwise) and it is valid schema v1 (400 otherwise).
 */
export async function approveWorktreeConfig(
  db: Db,
  project: { id: string; path: string },
  sha: string,
): Promise<WorktreeConfigStatusResponse> {
  const current = await worktreeConfigStatus(db, project);
  if (!current.head) {
    throw conflict(current.errors[0] ?? 'the main workspace has no committed .emberline/worktree.yml');
  }
  if (current.head.sha256 !== sha) {
    throw conflict('.emberline/worktree.yml changed in HEAD since it was reviewed; review it again');
  }
  if (current.errors.length > 0) throw badRequest(`.emberline/worktree.yml is invalid: ${current.errors.join('; ')}`);
  const approval = { content: current.head.content, sha256: sha256(current.head.content), approvedAt: new Date(), approvedBy: 'person' };
  db.insert(projectWorktreeConfig)
    .values({ projectId: project.id, ...approval })
    .onConflictDoUpdate({ target: projectWorktreeConfig.projectId, set: approval })
    .run();
  return worktreeConfigStatus(db, project);
}
