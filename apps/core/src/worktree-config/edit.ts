/**
 * Editing `.emberline/worktree.yml` from Project settings: the content is validated, committed to
 * the main workspace's branch (only that path) and approved in one step, under the main-workspace
 * lock. Pattern: `executeAdopt` (factory/project-import.ts).
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  ADOPT_FILE_PATHS,
  type SaveWorktreeConfigBody,
  WORKTREE_CONFIG_CODES,
  type WorktreeConfigStatusResponse,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { projectWorktreeConfig } from '../db/schema.js';
import { conflict, HttpError } from '../errors.js';
import { readHeadWorktreeYml } from '../factory/detect.js';
import { FACTORY_GIT_IDENTITY, mainWorkspaceBranch, withMainWorkspaceLock } from '../factory/merge.js';
import { execGitFile } from '../git-exec.js';
import { shortGitError } from '../repository/git.js';
import { createExclusiveFile, isMissing, realDirUnder, UnsafePathError } from '../outputs/safe-fs.js';
import { parseWorktreeYml } from './load.js';
import { storeApproval, worktreeConfigStatus } from './trust.js';

const COMMIT_MESSAGE = 'chore: edit .emberline/worktree.yml from project settings';

const codeOf = (error: unknown) => (error as { code?: string }).code;

export interface SaveWorktreeConfigOptions {
  /** The commit message (default `chore: edit .emberline/worktree.yml from project settings`). */
  message?: string;
  /** Checked under the lock: the approval the content was built from (null = none); 409 changed otherwise. */
  approvedSha256?: string | null;
  /** The 409 text when HEAD's file moved since the base (default names the editor). */
  changedText?: string;
}

/** Why `content` cannot be used as worktree.yml (the banner's wording); empty when it can. */
export function worktreeYmlErrors(content: string): string[] {
  const parsed = parseWorktreeYml(content);
  return parsed.ok ? [] : parsed.errors;
}

/**
 * Puts `content` at `.emberline/worktree.yml` in the main workspace: written to a temp file in the
 * verified real `.emberline` directory and renamed over the old entry, so a link there is replaced
 * and never followed; a linked `.emberline` is refused. The old entry is kept aside until `keep`
 * (dropped) or `undo` (put back, and a `.emberline` created here removed).
 */
async function replaceWorktreeYml(
  projectPath: string,
  content: string,
): Promise<{ undo: () => Promise<void>; keep: () => Promise<void> }> {
  const rel = ADOPT_FILE_PATHS.worktreeYml;
  const dir = path.join(projectPath, path.dirname(rel));
  let createdDir = false;
  let temp: string | null = null;
  try {
    await mkdir(dir).then(
      () => (createdDir = true),
      (error: unknown) => {
        if (codeOf(error) !== 'EEXIST') throw error;
      },
    );
    const realDir = await realDirUnder(projectPath, dir);
    if (!realDir) throw new Error(`${path.dirname(rel)} disappeared`);
    const id = randomUUID();
    const tempPath = path.join(realDir, `.worktree.yml.${id}.tmp`);
    const handle = await createExclusiveFile(realDir, path.basename(tempPath));
    temp = tempPath;
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    const target = path.join(realDir, path.basename(rel));
    // rename never follows a link at either end: the old entry (file or link) is set aside as it is.
    const aside = path.join(realDir, `.worktree.yml.${id}.old`);
    const hadEntry = await rename(target, aside).then(
      () => true,
      (error: unknown) => {
        if (isMissing(error)) return false;
        throw error;
      },
    );
    try {
      await rename(tempPath, target);
    } catch (error) {
      if (hadEntry) await rename(aside, target).catch(() => undefined);
      throw error;
    }
    temp = null;
    return {
      keep: async () => {
        if (hadEntry) await unlink(aside).catch(() => undefined);
      },
      undo: async () => {
        if (hadEntry) await rename(aside, target).catch(() => undefined);
        else await unlink(target).catch(() => undefined);
        if (createdDir) await rmdir(dir).catch(() => undefined);
      },
    };
  } catch (error) {
    if (temp) await unlink(temp).catch(() => undefined);
    if (createdDir) await rmdir(dir).catch(() => undefined);
    if (error instanceof UnsafePathError)
      throw conflict(`cannot write into the repository safely: ${error.message}`);
    if (codeOf(error) === 'ENOTDIR')
      throw conflict('.emberline exists in the repository and is not a folder');
    throw error;
  }
}

/**
 * Commits `body.content` as `.emberline/worktree.yml` on the main workspace's branch (only that
 * path, Emberline's identity, no hooks) and approves exactly that content. 400 when it does not
 * parse; 409 when the workspace is detached, HEAD's file is not the one the editor opened, or the
 * file has uncommitted changes. Content equal to HEAD's commits nothing and only approves. A failed
 * commit puts the previous file back and stores no approval. `opts.approvedSha256`, when given, must
 * still be the stored approval's sha256 under the lock (409 changed otherwise).
 */
export async function saveWorktreeConfig(
  db: Db,
  project: { id: string; path: string },
  body: SaveWorktreeConfigBody,
  opts: SaveWorktreeConfigOptions = {},
): Promise<WorktreeConfigStatusResponse> {
  const rel = ADOPT_FILE_PATHS.worktreeYml;
  const errors = worktreeYmlErrors(body.content);
  if (errors.length > 0) {
    throw new HttpError(400, WORKTREE_CONFIG_CODES.invalid, '.emberline/worktree.yml is not valid', {
      errors,
    });
  }
  return withMainWorkspaceLock(project.path, async () => {
    if (
      !(await lstat(path.join(project.path, '.git')).then(
        () => true,
        () => false,
      ))
    ) {
      throw conflict(
        'The project folder is not a git repository, so the file cannot be committed. Run git init in the folder, then save again.',
        WORKTREE_CONFIG_CODES.notGitRepo,
      );
    }
    if (!(await mainWorkspaceBranch(project.path))) {
      throw conflict(
        'The main workspace is not on a branch, so the file cannot be committed. Check out a branch, then save again.',
        WORKTREE_CONFIG_CODES.detached,
      );
    }
    if (opts.approvedSha256 !== undefined) {
      const approved = db
        .select()
        .from(projectWorktreeConfig)
        .where(eq(projectWorktreeConfig.projectId, project.id))
        .get();
      if ((approved?.sha256 ?? null) !== opts.approvedSha256) {
        throw conflict(
          'The approved .emberline/worktree.yml changed since the preview was shown. Reload to see the current version.',
          WORKTREE_CONFIG_CODES.changed,
        );
      }
    }
    const head = await readHeadWorktreeYml(project.path);
    if (head.kind === 'unknown')
      throw conflict(`cannot read .emberline/worktree.yml from HEAD: ${head.error}`);
    const headSha = head.kind === 'present' ? head.yml.sha256 : null;
    const headContent = head.kind === 'present' ? head.yml.content : null;
    if (headSha !== body.baseSha256) {
      throw conflict(
        opts.changedText ??
          '.emberline/worktree.yml changed on main since the editor opened. Reload to edit the current version.',
        WORKTREE_CONFIG_CODES.changed,
      );
    }
    const inRepo = { cwd: project.path };
    // --ignored: an untracked file in an ignored .emberline/ is uncommitted work too; --untracked-files=all:
    // the repository's status.showUntrackedFiles must not hide one.
    const dirty = (
      await execGitFile(['status', '--porcelain', '--ignored', '--untracked-files=all', '--', rel], inRepo)
    ).stdout.trim();
    if (dirty) {
      throw conflict(
        'The main workspace has uncommitted changes to .emberline/worktree.yml. Commit or discard them, then save again.',
        WORKTREE_CONFIG_CODES.dirty,
      );
    }
    if (headContent !== body.content) {
      const written = await replaceWorktreeYml(project.path, body.content);
      try {
        // -f: a repository that ignores .emberline/ still gets the file committed.
        await execGitFile(['add', '-f', '--', rel], inRepo);
        // A commit with paths takes only those paths, whatever else is staged.
        await execGitFile(
          [
            ...FACTORY_GIT_IDENTITY,
            'commit',
            '-q',
            '--no-verify',
            '-m',
            opts.message ?? COMMIT_MESSAGE,
            '--',
            rel,
          ],
          inRepo,
        );
      } catch (error) {
        await execGitFile(['reset', '-q', '--', rel], inRepo).catch(() => undefined);
        await written.undo();
        throw new HttpError(
          500,
          WORKTREE_CONFIG_CODES.commitFailed,
          `Git could not commit .emberline/worktree.yml: ${shortGitError(error).trim().replace(/\.$/, '')}. The file on main is unchanged and nothing was approved.`,
        );
      }
      await written.keep();
    }
    storeApproval(db, project.id, body.content, 'person');
    return worktreeConfigStatus(db, project);
  });
}
