/** Integration of run worktrees into the main workspace (git merge under a per-workspace lock). */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { type SyncWorktreeResponse } from '@emberline/protocol';
import { execGitFile } from '../git-exec.js';
import { KeyedMutex } from '../keyed-mutex.js';

const FACTORY_GIT_IDENTITY = ['-c', 'user.name=Emberline AI Factory', '-c', 'user.email=factory@emberline.local'];

/** Never committed from a run's worktree even when the project forgot to ignore them. */
const RUN_OUTPUT_EXCLUDES = [':(exclude,glob)**/node_modules/**', ':(exclude,glob)**/.emberline/**'];

/** One merge into a main workspace at a time (parallel runs finish independently). */
const mainWorkspaceLock = new KeyedMutex();

function gitLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The branch checked out in the main workspace (what runs are merged into); null when detached or unknown. */
export async function mainWorkspaceBranch(mainWorkspacePath: string): Promise<string | null> {
  const res = await execGitFile(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: mainWorkspacePath }).catch(() => ({ stdout: '' }));
  const branch = res.stdout.trim();
  return branch && branch !== 'HEAD' ? branch : null;
}

/** The one follow-up a run gets when its branch no longer merges into `branch` cleanly. */
export function conflictResolutionPrompt(branch: string, conflicts: string[]): string {
  return `${branch} has moved on while you worked and your branch no longer merges cleanly (conflicts in: ${conflicts.join(', ')}). Merge ${branch} into your branch (git merge ${branch}), resolve every conflict keeping the intent of both changes, run the project's checks, commit, and finish.`;
}

/**
 * Integrates a run's worktree into the project's main workspace with git: the run's output is
 * committed on its own branch and merged (`--no-ff`) into the main checkout. Untracked and ignored
 * files in the main workspace (`.env`, virtualenvs, build output) are never touched, and work merged
 * by a parallel run is kept. A conflicting merge is aborted and reported with `ok: false`, leaving
 * the main workspace as it was.
 */
export async function syncWorktreeToMainWorkspace(params: {
  worktreePath: string;
  mainWorkspacePath: string;
  ticketKey: string | null;
  runId: string;
  /** Called once there is something to merge (not for work already in main); may throw to refuse. */
  beforeMerge?: () => void;
}): Promise<SyncWorktreeResponse> {
  const { worktreePath, mainWorkspacePath, ticketKey, runId, beforeMerge } = params;
  if (!existsSync(worktreePath)) {
    throw new Error(`Worktree path does not exist: ${worktreePath}`);
  }
  const label = ticketKey ?? runId.slice(0, 8);
  const result = (ok: boolean, summary: string, extra: Partial<SyncWorktreeResponse> = {}): SyncWorktreeResponse => ({
    ok,
    runId,
    filesSynced: 0,
    commitSha: null,
    conflicts: [],
    alreadyMerged: false,
    summary,
    ...extra,
  });
  if (!existsSync(path.join(worktreePath, '.git')) || !existsSync(path.join(mainWorkspacePath, '.git'))) {
    return result(false, `Cannot merge ${label}: the project is not a git repository.`);
  }

  return mainWorkspaceLock.run(path.resolve(mainWorkspacePath), async () => {
    const inWorktree = { cwd: worktreePath };
    const inMain = { cwd: mainWorkspacePath };

    // 1. Commit the run's output on its own branch; .gitignore keeps secrets and build output out.
    await execGitFile(['add', '-A', '--', '.', ...RUN_OUTPUT_EXCLUDES], inWorktree);
    const staged = await execGitFile(['diff', '--cached', '--name-only'], inWorktree);
    if (staged.stdout.trim()) {
      await execGitFile([...FACTORY_GIT_IDENTITY, 'commit', '-q', '-m', `feat(${label}): factory run output`], inWorktree);
    }
    const tip = (await execGitFile(['rev-parse', 'HEAD'], inWorktree)).stdout.trim();
    const branch = (await execGitFile(['rev-parse', '--abbrev-ref', 'HEAD'], inWorktree)).stdout.trim();
    const shortHead = async () => (await execGitFile(['rev-parse', '--short', 'HEAD'], inMain)).stdout.trim() || null;

    const alreadyMerged = await execGitFile(['merge-base', '--is-ancestor', tip, 'HEAD'], inMain).then(
      () => true,
      () => false,
    );
    if (alreadyMerged) {
      return result(true, `${label} is already merged into the main workspace.`, { commitSha: await shortHead(), alreadyMerged: true });
    }

    beforeMerge?.();

    // 2. Edits made directly in the main workspace (file explorer, blueprint) are committed first so
    //    the merge can never overwrite them. Untracked files stay untracked.
    const editedTracked = await execGitFile(['diff', 'HEAD', '--name-only'], inMain);
    if (editedTracked.stdout.trim()) {
      await execGitFile(['add', '-u'], inMain);
      await execGitFile(
        [...FACTORY_GIT_IDENTITY, 'commit', '-q', '-m', `chore: snapshot workspace edits before merging ${label}`],
        inMain,
      );
    }
    const before = (await execGitFile(['rev-parse', 'HEAD'], inMain)).stdout.trim();

    // 3. Merge. On any failure (conflict, untracked file in the way) restore the previous state.
    try {
      await execGitFile(
        [...FACTORY_GIT_IDENTITY, 'merge', '--no-ff', '--no-edit', '-m', `Merge ${label} (${branch})`, tip],
        { ...inMain, timeout: 120_000 },
      );
    } catch (error) {
      const conflicts = gitLines(
        (await execGitFile(['diff', '--name-only', '--diff-filter=U'], inMain).catch(() => ({ stdout: '' }))).stdout,
      );
      await execGitFile(['merge', '--abort'], inMain).catch(() => undefined);
      const detail =
        conflicts.length > 0
          ? `conflicts in ${conflicts.slice(0, 10).join(', ')}${conflicts.length > 10 ? ', …' : ''}`
          : (gitLines(String((error as { stderr?: string }).stderr ?? (error as Error).message))[0] ?? 'git merge failed');
      return result(false, `Could not merge ${label} into the main workspace (${detail}); it was left unchanged.`, {
        conflicts,
        commitSha: await shortHead(),
      });
    }

    const changed = gitLines((await execGitFile(['diff', '--name-only', before, 'HEAD'], inMain)).stdout);
    const commitSha = await shortHead();
    return result(true, `Merged ${changed.length} changed files from ${label} (${branch}) into the main workspace${commitSha ? ` (commit ${commitSha})` : ''}.`, {
      filesSynced: changed.length,
      commitSha,
    });
  });
}
