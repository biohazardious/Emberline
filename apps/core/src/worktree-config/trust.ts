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
  const yml = read.kind === 'present' ? read.yml : null;
  const head = yml?.content != null && yml.sha256 ? { content: yml.content, sha256: yml.sha256 } : null;
  const errors = yml?.errors ?? [];
  // HEAD was read and has no entry at all (not one that cannot be used, not a git failure): deleted.
  const removed = read.kind === 'absent' && approved !== null;
  // HEAD has a file, but a link, an oversized or an invalid one: the review shows why it cannot be approved.
  const unusable = read.kind === 'present' && (head === null || errors.length > 0);
  const changed = removed || (head !== null && head.sha256 !== approved?.sha256) || (unusable && approved !== null);
  return {
    approved,
    head,
    headError: read.kind === 'unknown' ? read.error : null,
    changed,
    removed,
    // Without HEAD content there is nothing to compare: the errors say what is wrong.
    diff: changed && (head !== null || removed) ? unifiedDiff(approved?.content ?? '', head?.content ?? '') : '',
    errors,
    unusable,
  };
}

/** Accepts that HEAD removed the file: the approval goes, and runs get no worktree lifecycle. */
export async function approveWorktreeConfigRemoval(db: Db, project: { id: string; path: string }): Promise<WorktreeConfigStatusResponse> {
  const current = await worktreeConfigStatus(db, project);
  if (!current.removed) {
    throw conflict(
      current.headError
        ? `cannot tell whether HEAD removed .emberline/worktree.yml: ${current.headError}`
        : current.approved
          ? 'HEAD still has .emberline/worktree.yml (or one that cannot be read); there is no removal to approve'
          : 'nothing is approved',
    );
  }
  db.delete(projectWorktreeConfig).where(eq(projectWorktreeConfig.projectId, project.id)).run();
  return worktreeConfigStatus(db, project);
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
    throw conflict(current.errors[0] ?? current.headError ?? 'the main workspace has no committed .emberline/worktree.yml');
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
