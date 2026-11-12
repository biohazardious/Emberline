/** Which paths a repository's ignore rules match (git check-ignore), tracked or not. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isRunnerUnavailable } from '../command-exec.js';
import { execGitFile } from '../git-exec.js';

/**
 * The repo-relative `paths` the repository at `repoPath` ignores. `--no-index`: a file Emberline
 * force-added earlier is tracked, and still counts as ignored. Exit 1 (none ignored), a folder that
 * is not a repository or a git error all read as "none"; a runner that could not run git is thrown.
 */
export async function gitIgnoredPaths(repoPath: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0 || !existsSync(path.join(repoPath, '.git'))) return new Set();
  try {
    const { stdout } = await execGitFile(['check-ignore', '--no-index', '--', ...paths], { cwd: repoPath });
    return new Set(
      stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => paths.includes(line)),
    );
  } catch (error) {
    if (isRunnerUnavailable(error)) throw error;
    return new Set();
  }
}
