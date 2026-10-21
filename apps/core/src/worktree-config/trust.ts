/**
 * Trust for `.emberline/worktree.yml`: its commands run in the runner and agents can edit and merge
 * the file, so runs use only the content a person approved (project_worktree_config). A change at
 * the main workspace's HEAD applies once a person approved exactly that content.
 */
import { createHash } from 'node:crypto';
import { ADOPT_FILE_PATHS, MAX_WORKTREE_YML_BYTES, type WorktreeConfigStatusResponse } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { projectWorktreeConfig } from '../db/schema.js';
import { badRequest, conflict } from '../errors.js';
import { readHeadWorktreeYml } from '../factory/detect.js';
import { isMissing, UnsafePathError } from '../outputs/safe-fs.js';
import { readWorktreeBytes } from '../runs/git.js';
import { unifiedDiff } from './diff.js';
import { parseWorktreeYml } from './load.js';

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

/**
 * Why a run worktree's `.emberline/worktree.yml` could not be used once merged, or null when it may
 * land: the run removed it (or never had one), left main's committed content as it is (a main whose
 * file is already unusable does not block runs that do not touch it), or changed it into a valid
 * file. Read from the working tree, which is what the merge commits, and never through a link.
 */
export async function runWorktreeYmlProblems(worktreePath: string, mainWorkspacePath: string): Promise<string[] | null> {
  const rel = ADOPT_FILE_PATHS.worktreeYml;
  let content: string | null = null;
  let unreadable: string | null = null;
  try {
    const bytes = await readWorktreeBytes(worktreePath, rel, MAX_WORKTREE_YML_BYTES);
    if (bytes) content = bytes.toString('utf8');
    else unreadable = `${rel} is larger than ${MAX_WORKTREE_YML_BYTES / 1024} KB`;
  } catch (error) {
    if (isMissing(error) && !(error instanceof UnsafePathError)) return null;
    unreadable =
      error instanceof UnsafePathError ? `${rel} is not a regular file (a symbolic link or a linked directory)` : `${rel} cannot be read`;
  }
  const main = await readHeadWorktreeYml(mainWorkspacePath);
  const mainContent = main.kind === 'present' ? main.yml.content : undefined;
  // Main's own file cannot be used either (a link, too large): the run did not make it worse.
  if (unreadable !== null) return main.kind === 'present' && mainContent === null ? null : [unreadable];
  if (content === null || content === mainContent) return null;
  const parsed = parseWorktreeYml(content);
  return parsed.ok ? null : parsed.errors;
}
