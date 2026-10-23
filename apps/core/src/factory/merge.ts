/** Integration of run worktrees into the main workspace (git merge under a per-workspace lock). */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { type SyncWorktreeResponse } from '@emberline/protocol';
import { execFileChecked, isRunnerUnavailable } from '../command-exec.js';
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
export async function unstageScratchFiles(cwd: string, env?: Record<string, string>): Promise<void> {
  // -f: the staged content may differ from both HEAD and the file on disk; only the index changes.
  await execGitFile(['rm', '-r', '-q', '-f', '--cached', '--ignore-unmatch', '--', ...SCRATCH_PATHSPECS], {
    cwd,
    env,
  });
}

/** Stages a run's output: everything but what a run never commits (RUN_OUTPUT_EXCLUDES, scratch files). */
async function stageRunOutput(worktreePath: string, env?: Record<string, string>): Promise<void> {
  await execGitFile(['add', '-A', '--', '.', ...RUN_OUTPUT_EXCLUDES], { cwd: worktreePath, env });
  await unstageScratchFiles(worktreePath, env);
}

/**
 * A file of the worktree's git directory, read in the runner: its text, or null when it does not
 * exist (any other failure is thrown).
 */
async function readGitDirFile(worktreePath: string, name: string): Promise<string | null> {
  const file = (
    await execGitFile(['rev-parse', '--path-format=absolute', '--git-path', name], { cwd: worktreePath })
  ).stdout.trim();
  // A leading `.` tells an empty file from a missing one.
  const { stdout } = await execFileChecked({
    file: 'sh',
    args: ['-c', 'test ! -e "$1" || { printf .; cat -- "$1"; }', 'sh', file],
    cwd: worktreePath,
  });
  return stdout.startsWith('.') ? stdout.slice(1) : null;
}

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * What the agent left unconcluded in its worktree, as `git commit` would conclude it with the run's
 * output: a merge (MERGE_HEAD's commits become the output commit's other parents), a cherry-pick
 * (the output commit keeps the picked commit's author) or a revert.
 */
interface PendingOperation {
  mergeHeads: string[];
  cherryPick: string | null;
  revert: boolean;
}

async function pendingOperation(worktreePath: string): Promise<PendingOperation> {
  const verify = (rev: string) =>
    execGitFile(['rev-parse', '-q', '--verify', `${rev}^{commit}`], { cwd: worktreePath }).then(
      (res) => res.stdout.trim() || null,
      () => null,
    );
  const mergeHeads: string[] = [];
  for (const line of gitLines((await readGitDirFile(worktreePath, 'MERGE_HEAD')) ?? '')) {
    // `git commit` refuses a MERGE_HEAD it cannot read, and so does the merge.
    const oid = OBJECT_ID.test(line) ? await verify(line) : null;
    if (!oid)
      throw new Error(`MERGE_HEAD names no commit (${line.slice(0, 80)}); conclude or abort the merge`);
    mergeHeads.push(oid);
  }
  return {
    mergeHeads,
    cherryPick: await verify('CHERRY_PICK_HEAD'),
    revert: (await verify('REVERT_HEAD')) !== null,
  };
}

/** Ends what the output commit concluded, as `git commit` does once it records it. */
async function endPendingOperation(worktreePath: string, pending: PendingOperation): Promise<void> {
  const inWorktree = { cwd: worktreePath };
  // `--quit`: MERGE_HEAD, MERGE_MSG, MERGE_MODE and AUTO_MERGE go; index and files stay.
  if (pending.mergeHeads.length > 0) await execGitFile(['merge', '--quit'], inWorktree);
  if (pending.cherryPick) await execGitFile(['update-ref', '-d', 'CHERRY_PICK_HEAD'], inWorktree);
  if (pending.revert) await execGitFile(['update-ref', '-d', 'REVERT_HEAD'], inWorktree);
}

/**
 * The commit of a run's output on top of `head`, or null when there is nothing to commit: what
 * `git add -A` (but RUN_OUTPUT_EXCLUDES and scratch files) and `git commit` would record, with an
 * unconcluded merge's other parents. It is built in a copy of the worktree's index and not put on
 * any branch, so the worktree, its index and its branch stay exactly as they were (the caller moves
 * the branch once the merge is allowed). The copy (`<git dir>/index.emberline-output`) is made and
 * removed in the runner, so it belongs to the user the runner's git runs as. git reads it only
 * through GIT_INDEX_FILE, here; a copy an interrupted merge left behind is removed first, never
 * reused.
 */
async function buildRunOutputCommit(
  worktreePath: string,
  head: string,
  label: string,
  pending: PendingOperation,
): Promise<string | null> {
  const inWorktree = { cwd: worktreePath };
  const index = (
    await execGitFile(['rev-parse', '--path-format=absolute', '--git-path', 'index'], inWorktree)
  ).stdout.trim();
  const scratchIndex = `${index}.emberline-output`;
  const env = { GIT_INDEX_FILE: scratchIndex };
  const inRunner = (file: string, args: string[]) => execFileChecked({ file, args, cwd: worktreePath });
  try {
    await inRunner('rm', ['-f', '--', scratchIndex]);
    // What the agent staged by hand (a file its .gitignore ignores, say) is part of the output too.
    // Only a worktree without an index starts from HEAD; a copy that fails fails the merge.
    const hasIndex = (await inRunner('sh', ['-c', 'test ! -e "$1" || printf y', 'sh', index])).stdout === 'y';
    if (hasIndex) await inRunner('cp', ['--', index, scratchIndex]);
    else await execGitFile(['read-tree', head], { ...inWorktree, env });
    await stageRunOutput(worktreePath, env);
    const tree = (await execGitFile(['write-tree'], { ...inWorktree, env })).stdout.trim();
    const headTree = (await execGitFile(['rev-parse', `${head}^{tree}`], inWorktree)).stdout.trim();
    if (tree === headTree) return null;
    // `git commit` during a cherry-pick keeps the picked commit's author.
    const author = pending.cherryPick
      ? (
          await execGitFile(
            ['show', '-s', '--format=%an%n%ae%n%ad', '--date=raw', pending.cherryPick],
            inWorktree,
          )
        ).stdout.split('\n')
      : null;
    const parents = [head, ...pending.mergeHeads].flatMap((p) => ['-p', p]);
    return (
      await execGitFile(
        [
          ...FACTORY_GIT_IDENTITY,
          'commit-tree',
          tree,
          ...parents,
          '-m',
          `feat(${label}): factory run output`,
        ],
        {
          ...inWorktree,
          env: author
            ? {
                GIT_AUTHOR_NAME: author[0] ?? '',
                GIT_AUTHOR_EMAIL: author[1] ?? '',
                GIT_AUTHOR_DATE: author[2] ?? '',
              }
            : undefined,
        },
      )
    ).stdout.trim();
  } finally {
    await inRunner('rm', ['-f', '--', scratchIndex]).catch(() => undefined);
  }
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

/** Newest last: the merge commits Emberline made in each main workspace since core started. */
const mergeCommits = new Map<string, string[]>();
const MERGE_COMMITS_KEPT = 200;

function recordMergeCommit(mainWorkspacePath: string, oid: string): void {
  const key = path.resolve(mainWorkspacePath);
  const list = [...(mergeCommits.get(key) ?? []), oid].slice(-MERGE_COMMITS_KEPT);
  mergeCommits.set(key, list);
}

/** Whether `oid` (a full id) is a merge commit Emberline made in this main workspace (recorded under its lock). */
export function isEmberlineMergeCommit(mainWorkspacePath: string, oid: string): boolean {
  return mergeCommits.get(path.resolve(mainWorkspacePath))?.includes(oid) ?? false;
}

/**
 * A merge's outcome inside core: the response plus the merge commit's full id (merge notes carry
 * it), set only when that commit is verifiably the merge Emberline made; `commitUnverified`: the
 * merge succeeded but main's commit could not be verified (another process moved main meanwhile);
 * `mainHead`: for a merge that failed, the commit main was at when it tried (read under the merge
 * lock, so a change queued behind it is not mistaken for it), else null.
 */
export type SyncWorktreeResult = SyncWorktreeResponse & {
  commitOid: string | null;
  commitUnverified: boolean;
  mainHead: string | null;
};

/**
 * The commit main names now, if it is exactly the merge Emberline just made: parents `[before, tip]`
 * and the tree git computes for merging them. Agents share `.git` and can move `refs/heads/<b>` at
 * any moment, so the ref alone proves nothing. Read without replace refs, grafts or the
 * commit-graph (all three are agent-writable); any failure is "not verified" (null).
 */
async function verifiedMergeCommit(cwd: string, before: string, tip: string): Promise<string | null> {
  const real = async (args: string[]) =>
    (
      await execGitFile(['-c', 'core.commitGraph=false', '-c', 'core.useReplaceRefs=false', ...args], {
        cwd,
        env: { GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' },
      })
    ).stdout.trim();
  try {
    const head = await real(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const [, ...parents] = (await real(['rev-list', '--parents', '-n', '1', head])).split(' ');
    if (parents.length !== 2 || parents[0] !== before || parents[1] !== tip) return null;
    const tree = await real(['rev-parse', '--verify', '--quiet', `${head}^{tree}`]);
    const expected = (await real(['merge-tree', '--write-tree', before, tip])).split('\n')[0]?.trim();
    return tree && tree === expected ? head : null;
  } catch {
    return null;
  }
}

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

/**
 * The branch checked out in the main workspace; null when detached or git cannot tell. A runner that
 * could not run git is thrown (isRunnerUnavailable), never read as "not on a branch".
 */
export async function mainWorkspaceBranchStrict(mainWorkspacePath: string): Promise<string | null> {
  const res = await execGitFile(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: mainWorkspacePath }).catch(
    (error: unknown) => {
      if (isRunnerUnavailable(error)) throw error;
      return { stdout: '' };
    },
  );
  const branch = res.stdout.trim();
  return branch && branch !== 'HEAD' ? branch : null;
}

/** The branch checked out in the main workspace (what runs are merged into); null when detached or unknown. */
export async function mainWorkspaceBranch(mainWorkspacePath: string): Promise<string | null> {
  return mainWorkspaceBranchStrict(mainWorkspacePath).catch(() => null);
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
    const status = await execGitFile(
      ['status', '--porcelain', '--untracked-files=all', '--', '.', ...RUN_OUTPUT_EXCLUDES],
      inWorktree,
    );
    if (status.stdout.trim()) return true;
    const tip = (await execGitFile(['rev-parse', 'HEAD'], inWorktree)).stdout.trim();
    // Main's first-parent line down to where the branch started: the walk stops at the tip's parents.
    const mainLine = await execGitFile(['rev-list', '--first-parent', 'HEAD', '--not', `${tip}^@`], {
      cwd: mainWorkspacePath,
    });
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
  /**
   * Called once there is something to merge (not for work already in main), with the commit to merge
   * built but the run's branch, worktree and index untouched; may throw to refuse, which leaves them so.
   */
  beforeMerge?: () => void;
}): Promise<SyncWorktreeResult> {
  const { worktreePath, mainWorkspacePath, ticketKey, runId, branch, beforeMerge } = params;
  const label = ticketKey ?? runId.slice(0, 8);
  const result = (
    ok: boolean,
    summary: string,
    extra: Partial<SyncWorktreeResult> = {},
  ): SyncWorktreeResult => ({
    ok,
    runId,
    filesSynced: 0,
    commitSha: null,
    commitOid: null,
    commitUnverified: false,
    mainHead: null,
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
      (await execGitFile(['merge-base', '--is-ancestor', `refs/heads/${branch}`, 'HEAD'], {
        cwd: mainWorkspacePath,
      }).then(
        () => true,
        () => false,
      ));
    if (!inMain)
      throw new HttpError(409, 'worktree_missing', "the run's worktree is gone and its work isn't in main");
    const head =
      (await execGitFile(['rev-parse', '--short', 'HEAD'], { cwd: mainWorkspacePath })).stdout.trim() || null;
    return result(true, `${label} is already merged into the main workspace (its worktree is gone).`, {
      commitSha: head,
      alreadyMerged: true,
    });
  }
  if (!existsSync(path.join(worktreePath, '.git')) || !existsSync(path.join(mainWorkspacePath, '.git'))) {
    return result(false, `Cannot merge ${label}: the project is not a git repository.`);
  }

  return mainWorkspaceLock.run(path.resolve(mainWorkspacePath), async () => {
    const inWorktree = { cwd: worktreePath };
    const inMain = { cwd: mainWorkspacePath };

    // 1. The run's output as a commit on its own branch; .gitignore keeps secrets and build output
    //    out. It goes on the branch only once the merge is allowed.
    const head = (await execGitFile(['rev-parse', 'HEAD'], inWorktree)).stdout.trim();
    const pending = await pendingOperation(worktreePath);
    const output = await buildRunOutputCommit(worktreePath, head, label, pending);
    const tip = output ?? head;
    const branch = (await execGitFile(['rev-parse', '--abbrev-ref', 'HEAD'], inWorktree)).stdout.trim();
    const shortHead = async () =>
      (await execGitFile(['rev-parse', '--short', 'HEAD'], inMain)).stdout.trim() || null;

    const alreadyMerged = await execGitFile(['merge-base', '--is-ancestor', tip, 'HEAD'], inMain).then(
      () => true,
      () => false,
    );
    if (alreadyMerged) {
      return result(true, `${label} is already merged into the main workspace.`, {
        commitSha: await shortHead(),
        alreadyMerged: true,
      });
    }

    beforeMerge?.();
    if (output) {
      // The worktree's index takes the output first (as `git add -A`), then the branch moves: a
      // failure, or an agent's git command, in between finds the index ahead of HEAD, never behind.
      await stageRunOutput(worktreePath);
      // Only if the branch is still where the commit was built on (an agent may commit meanwhile).
      const moved = await execGitFile(
        [
          'update-ref',
          '-m',
          `commit${pending.mergeHeads.length > 0 ? ' (merge)' : ''}: feat(${label}): factory run output`,
          'HEAD',
          output,
          head,
        ],
        inWorktree,
      ).then(
        () => false,
        () => true,
      );
      if (moved) {
        beforeMerge?.();
        return result(
          false,
          `Could not merge ${label}: its branch moved while it was being merged. Merge it again.`,
        );
      }
      await endPendingOperation(worktreePath, pending);
    }

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
          [
            ...FACTORY_GIT_IDENTITY,
            'commit',
            '-q',
            '-m',
            `chore: snapshot workspace edits before merging ${label}`,
          ],
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
        (await execGitFile(['diff', '--name-only', '--diff-filter=U'], inMain).catch(() => ({ stdout: '' })))
          .stdout,
      );
      await execGitFile(['merge', '--abort'], inMain).catch(() => undefined);
      const detail =
        conflicts.length > 0
          ? `conflicts in ${conflicts.slice(0, 10).join(', ')}${conflicts.length > 10 ? ', …' : ''}`
          : (gitLines(String((error as { stderr?: string }).stderr ?? (error as Error).message))[0] ??
            'git merge failed');
      return result(
        false,
        `Could not merge ${label} into the main workspace (${detail}); it was left unchanged.`,
        {
          conflicts,
          commitSha: await shortHead(),
          mainHead: before,
        },
      );
    }

    const changed = gitLines((await execGitFile(['diff', '--name-only', before, 'HEAD'], inMain)).stdout);
    const commitSha = await shortHead();
    // Verified, then recorded before the lock is released (a push queued behind a later merge knows
    // its commit); an unverified one is never recorded, so Keep main pushed never publishes it.
    const commitOid = await verifiedMergeCommit(mainWorkspacePath, before, tip);
    if (commitOid) recordMergeCommit(mainWorkspacePath, commitOid);
    return result(
      true,
      `Merged ${changed.length} changed files from ${label} (${branch}) into the main workspace${commitSha ? ` (commit ${commitSha})` : ''}.`,
      {
        filesSynced: changed.length,
        commitSha,
        commitOid,
        commitUnverified: !commitOid,
      },
    );
  });
}
