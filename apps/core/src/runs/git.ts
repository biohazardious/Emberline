import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { conflict, HttpError } from '../errors.js';

const execFileAsync = promisify(execFile);

/** Runs git without ever prompting (no TTY in core) and returns trimmed stdout. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

export interface Workspace {
  /** Directory the agent runs in. */
  path: string;
  /** Branch created for the run; null when the project is not a git repository. */
  branch: string | null;
}

/**
 * Gives a run an isolated git worktree on a fresh branch (PROJECT.md §5.6).
 * Projects that are plain directories (no `.git`) run in place.
 */
export async function prepareWorkspace(projectPath: string, worktreePath: string, branch: string): Promise<Workspace> {
  if (!existsSync(projectPath)) {
    throw conflict('project directory does not exist (is the clone still running, or did it fail?)');
  }
  if (!existsSync(path.join(projectPath, '.git'))) return { path: projectPath, branch: null };

  try {
    await git(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  } catch {
    throw conflict('repository has no commits yet, or the clone is still running');
  }

  await mkdir(path.dirname(worktreePath), { recursive: true });
  const unique = await uniqueBranch(projectPath, branch);
  try {
    await git(projectPath, ['worktree', 'add', '-b', unique, worktreePath, 'HEAD']);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new HttpError(500, 'worktree_failed', `git worktree add failed${stderr ? `: ${stderr}` : ''}`);
  }
  return { path: worktreePath, branch: unique };
}

/** `branch`, or `branch-2`, `branch-3`, ... if it already exists. */
async function uniqueBranch(repo: string, branch: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? branch : `${branch}-${n}`;
    try {
      await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`]);
    } catch {
      return candidate; // ref does not exist
    }
  }
  throw conflict(`too many branches named ${branch}-*`);
}
