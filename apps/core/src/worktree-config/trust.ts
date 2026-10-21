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
import { type HeadWorktreeYml, readHeadWorktreeYml } from '../factory/detect.js';
import { execGitFile } from '../git-exec.js';
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

/** Why a worktree file could not be opened safely, from {@link UnsafePathError}'s wording. */
function unsafeReason(rel: string, error: UnsafePathError): string {
  if (error.message.endsWith('is a symbolic link')) return `${rel} is a symbolic link`;
  if (error.message.endsWith('resolves outside the expected place')) return `${rel} is inside a linked directory`;
  return `${rel} is not a regular file`;
}

/**
 * `.emberline/worktree.yml` where the run's branch started: its merge-base with main's HEAD, read
 * from the run worktree (they share the objects). Null when git cannot tell.
 */
async function branchBaseWorktreeYml(worktreePath: string, mainWorkspacePath: string): Promise<HeadWorktreeYml | null> {
  try {
    const mainHead = (await execGitFile(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: mainWorkspacePath })).stdout.trim();
    const base = (await execGitFile(['merge-base', 'HEAD', mainHead], { cwd: worktreePath })).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(base)) return null;
    const read = await readHeadWorktreeYml(worktreePath, base);
    return read.kind === 'unknown' ? null : read;
  } catch {
    return null;
  }
}

/**
 * Why a run worktree's `.emberline/worktree.yml` could not be used once merged, or null when it may
 * land: the run removed it (or never had one), left it as main has it or as it was where the branch
 * started (the merge keeps main's version then; a main whose file is unusable does not block runs
 * that do not touch it), or changed it into a valid file. Read from the working tree, which is what
 * the merge commits, and never through a link. Main's committed file is read only when the run's
 * file is invalid or unreadable; throws when git cannot read it then.
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
    unreadable = error instanceof UnsafePathError ? unsafeReason(rel, error) : `${rel} cannot be read`;
  }
  /** Committed and present, but itself unusable (a link, too large): nothing to compare. */
  const unusable = (read: HeadWorktreeYml | null) => read?.kind === 'present' && read.yml.content === null;
  if (unreadable === null && content !== null) {
    // A valid file lands as it is: main's (and git reading it) only matter for an invalid one.
    const parsed = parseWorktreeYml(content);
    if (parsed.ok) return null;
    const main = await readHeadWorktreeYml(mainWorkspacePath);
    if (main.kind === 'present' && content === main.yml.content) return null;
    const base = await branchBaseWorktreeYml(worktreePath, mainWorkspacePath);
    return base?.kind === 'present' && content === base.yml.content ? null : parsed.errors;
  }
  // The run did not make an unusable file worse than main's or its starting point's.
  const main = await readHeadWorktreeYml(mainWorkspacePath);
  if (unusable(main) || unusable(await branchBaseWorktreeYml(worktreePath, mainWorkspacePath))) return null;
  return [unreadable ?? `${rel} cannot be read`];
}

/**
 * Why the run's `.emberline/worktree.yml` has no commands, or null when it has some or is not
 * this check's business (invalid, unreadable, a link, over the cap: the worktree.yml gate's job).
 */
export async function worktreeCommandsMissing(worktreePath: string): Promise<string | null> {
  const rel = ADOPT_FILE_PATHS.worktreeYml;
  let bytes: Buffer | null;
  try {
    bytes = await readWorktreeBytes(worktreePath, rel, MAX_WORKTREE_YML_BYTES);
  } catch (error) {
    if (isMissing(error) && !(error instanceof UnsafePathError)) {
      return `${rel} is missing: this ticket asks for the setup, build, lint and test commands and the preview service.`;
    }
    return null;
  }
  if (!bytes) return null;
  const parsed = parseWorktreeYml(bytes.toString('utf8'));
  if (!parsed.ok) return null;
  const { setup, services, checks } = parsed.config;
  const hasChecks = Boolean(checks.build || checks.lint || checks.test);
  return setup.length === 0 && services.length === 0 && !hasChecks
    ? `${rel} has no setup, services or checks: this ticket asks for the setup, build, lint and test commands and the preview service.`
    : null;
}
