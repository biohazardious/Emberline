/** Integration of run worktrees into the main workspace (git merge under a per-workspace lock). */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { type SyncWorktreeResponse } from '@emberline/protocol';
import { HttpError } from '../errors.js';
import { execGitFile, runGit } from '../git-exec.js';
import { KeyedMutex } from '../keyed-mutex.js';

/**
 * Command-line config beats repo config, and `author.*` / `committer.*` beat `user.*`: setting all
 * of them keeps a repo's own config from forging who made Emberline's commits.
 */
export const FACTORY_GIT_IDENTITY = (['user', 'author', 'committer'] as const).flatMap((who) => [
  '-c',
  `${who}.name=Emberline AI Factory`,
  '-c',
  `${who}.email=factory@emberline.local`,
]);

/**
 * Emberline's scratch files under `.emberline/`: agents write them for core to read (tickets,
 * brainstorm and roadmap output, critic reports, attachments). Everything else there, above all
 * `.emberline/worktree.yml`, is project content and is committed like any other file, so an
 * agent's edit reaches main and shows up for review.
 */
export const EMBERLINE_SCRATCH_PATHS = [
  '.emberline/new-tickets.json',
  '.emberline/tickets.json',
  '.emberline/brainstorm-suggestions.json',
  '.emberline/roadmap*.json',
  '.emberline/cross-critic-*.json',
  '.emberline/attachments/**',
] as const;

const SCRATCH_EXCLUDES = EMBERLINE_SCRATCH_PATHS.map((p) => `:(exclude,glob)**/${p}`);

/** Never committed from a run's worktree even when the project forgot to ignore them. */
const RUN_OUTPUT_EXCLUDES = [':(exclude,glob)**/node_modules/**', ...SCRATCH_EXCLUDES];

/** The scratch files at any depth, as pathspecs. */
const SCRATCH_PATHSPECS = EMBERLINE_SCRATCH_PATHS.map((p) => `:(glob)**/${p}`);

/**
 * Takes Emberline's scratch files out of the index right before an Emberline commit. A pathspec
 * exclude on `git add` is not enough: a file the agent staged itself stays in the index, and
 * `git commit` takes the whole index. Scratch files that are already tracked are removed from the
 * index too, so the commit deletes them from the repository; the files on disk are left alone.
 */
export async function unstageScratchFiles(cwd: string): Promise<void> {
  // -f: the staged content may differ from both HEAD and the file on disk; only the index changes.
  await execGitFile(['rm', '-r', '-q', '-f', '--cached', '--ignore-unmatch', '--', ...SCRATCH_PATHSPECS], { cwd });
}

/**
 * Puts the scratch files' index entries back to HEAD (a staged new one leaves the index, a staged
 * change to a tracked one is undone); the files on disk are left alone. For the main workspace,
 * where a tracked scratch file is removed by the run's merge rather than by a snapshot commit.
 */
async function resetScratchFilesToHead(cwd: string): Promise<void> {
  await execGitFile(['reset', '-q', 'HEAD', '--', ...SCRATCH_PATHSPECS], { cwd });
}

/** One merge into a main workspace at a time (parallel runs finish independently). */
const mainWorkspaceLock = new KeyedMutex();

/** Runs `fn` while no merge (or other locked change) touches this main workspace. */
export function withMainWorkspaceLock<T>(mainWorkspacePath: string, fn: () => Promise<T>): Promise<T> {
  return mainWorkspaceLock.run(path.resolve(mainWorkspacePath), fn);
}

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

/** The commit the main workspace is at; null when unknown (no commits, not a repository). */
export async function mainHead(mainWorkspacePath: string): Promise<string | null> {
  const head = (await runGit(mainWorkspacePath, ['rev-parse', 'HEAD']).catch(() => '')).trim();
  return head || null;
}

/** The one follow-up a run gets when its branch no longer merges into `branch` cleanly. */
export function conflictResolutionPrompt(branch: string, conflicts: string[]): string {
  return `${branch} has moved on while you worked and your branch no longer merges cleanly (conflicts in: ${conflicts.join(', ')}). Merge ${branch} into your branch (git merge ${branch}), resolve every conflict keeping the intent of both changes, run the project's checks, commit, and finish.`;
}

/**
 * Whether a run left anything to merge: uncommitted changes in its worktree outside Emberline's
 * scratch files, or a branch tip that is not on the main workspace's first-parent history. A branch
 * that was never committed to still points at a commit of main's own line; one with commits of its
 * own is reached by main only through a merge's second parent (merges are `--no-ff`), or not at all.
 * So no base commit has to be stored, and older runs are judged the same way. True whenever it
 * cannot tell: a worktree that is gone, or git failing.
 */
export async function runProducedChanges(worktreePath: string, mainWorkspacePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return true;
  try {
    const inWorktree = { cwd: worktreePath };
    const status = await execGitFile(['status', '--porcelain', '--untracked-files=all', '--', '.', ...RUN_OUTPUT_EXCLUDES], inWorktree);
    if (status.stdout.trim()) return true;
    const tip = (await execGitFile(['rev-parse', 'HEAD'], inWorktree)).stdout.trim();
    // Main's first-parent line down to where the branch started: the walk stops at the tip's parents.
    const mainLine = await execGitFile(['rev-list', '--first-parent', 'HEAD', '--not', `${tip}^@`], { cwd: mainWorkspacePath });
    return !gitLines(mainLine.stdout).includes(tip);
  } catch {
    return true;
  }
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
  /** The run's branch: with the worktree gone, whether its tip is in main decides. */
  branch?: string | null;
  /** Called once there is something to merge (not for work already in main); may throw to refuse. */
  beforeMerge?: () => void;
}): Promise<SyncWorktreeResponse> {
  const { worktreePath, mainWorkspacePath, ticketKey, runId, branch, beforeMerge } = params;
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
  if (!existsSync(worktreePath)) {
    // A pruned worktree: its branch may still be in main (merged earlier), then there is nothing to do.
    const inMain =
      Boolean(branch) &&
      existsSync(path.join(mainWorkspacePath, '.git')) &&
      (await execGitFile(['merge-base', '--is-ancestor', `refs/heads/${branch}`, 'HEAD'], { cwd: mainWorkspacePath }).then(
        () => true,
        () => false,
      ));
    if (!inMain) throw new HttpError(409, 'worktree_missing', "the run's worktree is gone and its work isn't in main");
    const head = (await execGitFile(['rev-parse', '--short', 'HEAD'], { cwd: mainWorkspacePath })).stdout.trim() || null;
    return result(true, `${label} is already merged into the main workspace (its worktree is gone).`, { commitSha: head, alreadyMerged: true });
  }
  if (!existsSync(path.join(worktreePath, '.git')) || !existsSync(path.join(mainWorkspacePath, '.git'))) {
    return result(false, `Cannot merge ${label}: the project is not a git repository.`);
  }

  return mainWorkspaceLock.run(path.resolve(mainWorkspacePath), async () => {
    const inWorktree = { cwd: worktreePath };
    const inMain = { cwd: mainWorkspacePath };

    // 1. Commit the run's output on its own branch; .gitignore keeps secrets and build output out.
    await execGitFile(['add', '-A', '--', '.', ...RUN_OUTPUT_EXCLUDES], inWorktree);
    await unstageScratchFiles(worktreePath);
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
    //    the merge can never overwrite them. Untracked files stay untracked. Scratch files are put
    //    back to HEAD in the index and never snapshotted: one main still tracks leaves with the
    //    run's merge (which also deletes it from disk) instead of staying behind untracked.
    await resetScratchFilesToHead(mainWorkspacePath);
    const editedTracked = await execGitFile(['diff', 'HEAD', '--name-only'], inMain);
    if (editedTracked.stdout.trim()) {
      await execGitFile(['add', '-u', '--', '.', ...SCRATCH_EXCLUDES], inMain);
      const snapshot = await execGitFile(['diff', '--cached', '--name-only'], inMain);
      if (snapshot.stdout.trim()) {
        await execGitFile(
          [...FACTORY_GIT_IDENTITY, 'commit', '-q', '-m', `chore: snapshot workspace edits before merging ${label}`],
          inMain,
        );
      }
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
