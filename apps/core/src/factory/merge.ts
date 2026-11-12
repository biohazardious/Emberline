/** Integration of run worktrees into the main workspace (git merge under a per-workspace lock). */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { type CommitIdentity, type SyncWorktreeResponse } from '@emberline/protocol';
import { execFileChecked, isRunnerUnavailable, RUNNER_BIN, systemCommand } from '../command-exec.js';
import { HttpError } from '../errors.js';
import { execGitFile, runGit } from '../git-exec.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { gitIdentityArgs, runOutputSubject } from './commit-identity.js';

/** The default identity's `-c` options (gitIdentityArgs); a configured one goes through gitIdentityArgs. */
export const FACTORY_GIT_IDENTITY = gitIdentityArgs();

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
  '.emberline/*.rejected.json',
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
 * The ops container reads and copies files of a worktree's git directory, which the agent may write:
 * only a regular file is read, never what a link the agent planted names (ops may read what the agent
 * may not: its own processes' command lines, with capability URLs). `$1` is the file, `$2` its name
 * in the refusal.
 */
export const NOT_REGULAR =
  'printf "%s is not a regular file (a link, a directory, a fifo): remove it\\n" "$2" >&2; exit 3';

/**
 * Where a file of the worktree's own git directory is (`index`, `MERGE_HEAD`, `sequencer/todo`: none
 * of them is shared between worktrees). Not `--git-path` with `--path-format=absolute`: that resolves
 * a link the agent made of the file, and names its target instead.
 */
async function gitDirFile(worktreePath: string, name: string): Promise<string> {
  const gitDir = (
    await execGitFile(['rev-parse', '--absolute-git-dir'], { cwd: worktreePath })
  ).stdout.trim();
  return path.join(gitDir, name);
}

/**
 * A file of the worktree's git directory, read in the ops container: its text, or null when it does not
 * exist; one that is no regular file is refused (any other failure is thrown too). dd opens it without
 * following a link, so one that turns into a link after the check is not read either.
 */
export async function readGitDirFile(worktreePath: string, name: string): Promise<string | null> {
  const file = await gitDirFile(worktreePath, name);
  // A leading `.` tells an empty file from a missing one. The system sh and dd (systemCommand).
  const script = [
    `if [ -L "$1" ]; then ${NOT_REGULAR}; fi`,
    '[ -e "$1" ] || exit 0',
    `[ -f "$1" ] || { ${NOT_REGULAR}; }`,
    'printf .',
    `exec ${RUNNER_BIN.dd} if="$1" iflag=nofollow status=none`,
  ].join('\n');
  const { stdout } = await execFileChecked(
    systemCommand({ file: RUNNER_BIN.sh, args: ['-c', script, 'sh', file, name], cwd: worktreePath }),
  );
  return stdout.startsWith('.') ? stdout.slice(1) : null;
}

/**
 * Copies the worktree's index (`$1`) to the merge's own copy (`$2`) in the ops container and prints
 * `y`, or prints nothing when there is no index. An index that is no regular file is refused; cp -P
 * opens it without following a link, and --remove-destination creates the copy afresh (a link planted
 * where it goes is replaced, never written through). The copy must be a regular file afterwards.
 */
const COPY_INDEX = [
  `if [ -L "$1" ]; then set -- "$1" index; ${NOT_REGULAR}; fi`,
  '[ -e "$1" ] || exit 0',
  `[ -f "$1" ] || { set -- "$1" index; ${NOT_REGULAR}; }`,
  `${RUNNER_BIN.cp} -P --remove-destination -- "$1" "$2" || exit 1`,
  `if [ -L "$2" ] || [ ! -f "$2" ]; then set -- "$2" "the index copy"; ${NOT_REGULAR}; fi`,
  'printf y',
].join('\n');

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * What the agent left unconcluded in its worktree, as `git commit` would conclude it with the run's
 * output: a merge (MERGE_HEAD's commits become the output commit's other parents, reduced as git
 * reduces them), a cherry-pick (the output commit keeps the picked commit's author) or a revert.
 */
interface PendingOperation {
  mergeHeads: string[];
  /** The output commit's parents: HEAD and MERGE_HEAD's commits, without one another's ancestors. */
  parents: string[];
  /** MERGE_HEAD's commits are all in HEAD already (a conclusion that failed after the branch moved). */
  staleMerge: boolean;
  cherryPick: string | null;
  revert: boolean;
  /** A `git merge --autostash` is unconcluded: its stashed changes must go back into the worktree. */
  autostash: boolean;
}

async function pendingOperation(worktreePath: string, head: string): Promise<PendingOperation> {
  const inWorktree = { cwd: worktreePath };
  const verify = (rev: string) =>
    execGitFile(['rev-parse', '-q', '--verify', `${rev}^{commit}`], inWorktree).then(
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
  let parents = [...new Set([head, ...mergeHeads])];
  // `git commit` drops a parent that another one contains, unless the merge was asked as --no-ff.
  if (mergeHeads.length > 0 && (await readGitDirFile(worktreePath, 'MERGE_MODE')) !== 'no-ff') {
    const independent = new Set(
      gitLines((await execGitFile(['merge-base', '--independent', ...parents], inWorktree)).stdout),
    );
    parents = parents.filter((p) => independent.has(p));
  }
  // Whatever MERGE_MODE says (a --no-ff merge keeps its parents unreduced).
  let staleMerge = mergeHeads.length > 0;
  for (const mergeHead of mergeHeads)
    staleMerge &&= await execGitFile(['merge-base', '--is-ancestor', mergeHead, head], inWorktree).then(
      () => true,
      () => false,
    );
  return {
    mergeHeads,
    parents,
    staleMerge,
    cherryPick: await verify('CHERRY_PICK_HEAD'),
    revert: (await verify('REVERT_HEAD')) !== null,
    autostash: (await readGitDirFile(worktreePath, 'MERGE_AUTOSTASH')) !== null,
  };
}

/** Ends what the output commit concluded, as `git commit` does once it records it. */
async function endPendingOperation(worktreePath: string, pending: PendingOperation): Promise<void> {
  const inWorktree = { cwd: worktreePath };
  // `--quit`: MERGE_HEAD, MERGE_MSG, MERGE_MODE and AUTO_MERGE go; index and files stay. (An
  // autostash never gets here: such a merge is refused.)
  if (pending.mergeHeads.length > 0) await execGitFile(['merge', '--quit'], inWorktree);
  for (const [ref, command] of [
    [pending.cherryPick ? 'CHERRY_PICK_HEAD' : null, 'cherry-pick'],
    [pending.revert ? 'REVERT_HEAD' : null, 'revert'],
  ] as const) {
    if (!ref) continue;
    await execGitFile(['update-ref', '-d', ref], inWorktree);
    // After the last pick of a sequence (its todo names only the one just concluded), `git commit`
    // removes the sequence too; before it, the sequence stays for `--continue`.
    const todo = await readGitDirFile(worktreePath, 'sequencer/todo');
    const left = gitLines(todo ?? '').filter((line) => !line.startsWith('#')).length;
    if (todo !== null && left <= 1) await execGitFile([command, '--quit'], inWorktree);
  }
}

/**
 * The commit of a run's output on top of `head`, or null when there is nothing to commit: what
 * `git add -A` (but RUN_OUTPUT_EXCLUDES and scratch files) and `git commit` would record, with an
 * unconcluded merge's other parents. It is built in a copy of the worktree's index and not put on
 * any branch, so the worktree, its index and its branch stay exactly as they were (the caller moves
 * the branch once the merge is allowed). The copy (`<git dir>/index.emberline-output`) is made and
 * removed in the ops container, so it belongs to the user core's git runs as (node, as the agents' files). git reads it only
 * through GIT_INDEX_FILE, here; a copy an interrupted merge left behind is removed first, never
 * reused.
 */
async function buildRunOutputCommit(
  worktreePath: string,
  head: string,
  commit: { identity: string[]; subject: string },
  pending: PendingOperation,
): Promise<string | null> {
  const inWorktree = { cwd: worktreePath };
  const index = await gitDirFile(worktreePath, 'index');
  const scratchIndex = `${index}.emberline-output`;
  const env = { GIT_INDEX_FILE: scratchIndex };
  // The runner image's own rm, sh and cp (systemCommand, in the ops container): a planted one never copies the index.
  const inOps = (file: string, args: string[]) =>
    execFileChecked(systemCommand({ file, args, cwd: worktreePath }));
  try {
    await inOps(RUNNER_BIN.rm, ['-f', '--', scratchIndex]);
    // What the agent staged by hand (a file its .gitignore ignores, say) is part of the output too.
    // Only a worktree without an index starts from HEAD; a copy that fails fails the merge.
    const hasIndex =
      (await inOps(RUNNER_BIN.sh, ['-c', COPY_INDEX, 'sh', index, scratchIndex])).stdout === 'y';
    if (!hasIndex) await execGitFile(['read-tree', head], { ...inWorktree, env });
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
    const parents = pending.parents.flatMap((p) => ['-p', p]);
    return (
      await execGitFile([...commit.identity, 'commit-tree', tree, ...parents, '-m', commit.subject], {
        ...inWorktree,
        env: author
          ? {
              GIT_AUTHOR_NAME: author[0] ?? '',
              GIT_AUTHOR_EMAIL: author[1] ?? '',
              GIT_AUTHOR_DATE: author[2] ?? '',
            }
          : undefined,
      })
    ).stdout.trim();
  } finally {
    await inOps(RUNNER_BIN.rm, ['-f', '--', scratchIndex]).catch(() => undefined);
  }
}

/**
 * Puts the scratch files' index entries back to HEAD (a staged new one leaves the index, a staged
 * change to a tracked one is undone); the files on disk are left alone. For the main workspace,
 * where a tracked scratch file is removed by the run's merge rather than by a snapshot commit.
 */
export async function resetScratchFilesToHead(cwd: string): Promise<void> {
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

/** The runs whose merge into each main workspace is waiting for its lock or running, by path. */
const mergesInFlight = new Map<string, Map<string, number>>();

/**
 * The runs merging into this main workspace right now (queued for its lock or merging): a release
 * waits for them, since each one moves the working branch it is about to promote.
 */
export function runsMergingInto(mainWorkspacePath: string): string[] {
  return [...(mergesInFlight.get(path.resolve(mainWorkspacePath))?.keys() ?? [])];
}

/** Counts a run's merge as in flight; the function returned ends it. */
function mergeStarted(mainWorkspacePath: string, runId: string): () => void {
  const key = path.resolve(mainWorkspacePath);
  const runs = mergesInFlight.get(key) ?? new Map<string, number>();
  mergesInFlight.set(key, runs);
  runs.set(runId, (runs.get(runId) ?? 0) + 1);
  return () => {
    const left = (runs.get(runId) ?? 1) - 1;
    if (left > 0) runs.set(runId, left);
    else runs.delete(runId);
    if (runs.size === 0 && mergesInFlight.get(key) === runs) mergesInFlight.delete(key);
  };
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
export async function syncWorktreeToMainWorkspace(
  params: Parameters<typeof mergeRunIntoMainWorkspace>[0],
): Promise<SyncWorktreeResult> {
  // Counted while it waits for the lock too: a release does not start meanwhile (runsMergingInto).
  const ended = mergeStarted(params.mainWorkspacePath, params.runId);
  try {
    return await mergeRunIntoMainWorkspace(params);
  } finally {
    ended();
  }
}

async function mergeRunIntoMainWorkspace(params: {
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
  /** Who the output, snapshot and merge commits are made as (default: DEFAULT_COMMIT_IDENTITY). */
  identity?: CommitIdentity;
  /** The output commit's subject (default: `feat(<label>): factory run output`); see runOutputSubject. */
  subject?: string;
  /**
   * The factory's working branch when the project stores one other than its default branch, else
   * null; asked under the lock. While the main workspace has another branch checked out the merge
   * is refused, so the factory's work never lands on main (or any branch) by a checkout.
   */
  workingBranch?: () => string | null;
}): Promise<SyncWorktreeResult> {
  const { worktreePath, mainWorkspacePath, ticketKey, runId, branch, beforeMerge } = params;
  const label = ticketKey ?? runId.slice(0, 8);
  const identity = gitIdentityArgs(params.identity);
  const subject = params.subject ?? runOutputSubject({ label });
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
    resolution: null,
    resolverRunId: null,
    autoResolved: [],
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

    const working = params.workingBranch?.() ?? null;
    if (working) {
      const checkedOut = (
        await execGitFile(['symbolic-ref', '--quiet', '--short', 'HEAD'], inMain).catch((error: unknown) => {
          if (isRunnerUnavailable(error)) throw error;
          return { stdout: '' }; // detached
        })
      ).stdout.trim();
      if (checkedOut !== working) {
        beforeMerge?.();
        const on = checkedOut ? `is on ${checkedOut}` : 'is not on a branch';
        return result(
          false,
          `Could not merge ${label}: the main workspace ${on}, but the factory's working branch is ${working}. Switch back on the Git page (or check out ${working}) and merge again.`,
        );
      }
    }

    // 1. The run's output as a commit on its own branch; .gitignore keeps secrets and build output
    //    out. It goes on the branch only once the merge is allowed.
    const head = (await execGitFile(['rev-parse', 'HEAD'], inWorktree)).stdout.trim();
    // A refusal is a stale pass's to drop: asked first, so it records nothing.
    const pending = await pendingOperation(worktreePath, head).catch((error: unknown) => {
      beforeMerge?.();
      throw error;
    });
    if (pending.autostash) {
      beforeMerge?.();
      // Concluding it would put the agent's stashed changes on the stash list all worktrees share.
      return result(
        false,
        `Could not merge ${label}: a git merge --autostash in its worktree is not finished. Finish it with git commit (or end it with git merge --abort), then merge again.`,
      );
    }
    const output = await buildRunOutputCommit(worktreePath, head, { identity, subject }, pending);
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
      const failed = await execGitFile(
        [
          'update-ref',
          '-m',
          `commit${pending.parents.length > 1 ? ' (merge)' : ''}: ${subject}`,
          'HEAD',
          output,
          head,
        ],
        inWorktree,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      if (failed !== null) {
        // "Moved" only when it did; any other failure (a lock, the runner) is reported as it is.
        const now = (await execGitFile(['rev-parse', 'HEAD'], inWorktree)).stdout.trim();
        if (now === head) throw failed;
        if (now !== output) {
          beforeMerge?.();
          return result(
            false,
            `Could not merge ${label}: its branch moved while it was being merged. Merge it again.`,
          );
        }
      }
      await endPendingOperation(worktreePath, pending);
    } else if (pending.staleMerge) {
      // An earlier merge recorded MERGE_HEAD's commits but could not end the merge: end it now.
      await endPendingOperation(worktreePath, { ...pending, cherryPick: null, revert: false });
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
          [...identity, 'commit', '-q', '-m', `chore: snapshot workspace edits before merging ${label}`],
          inMain,
        );
      }
    }
    const before = (await execGitFile(['rev-parse', 'HEAD'], inMain)).stdout.trim();

    // 3. Merge. On any failure (conflict, untracked file in the way) restore the previous state.
    try {
      await execGitFile(
        [...identity, 'merge', '--no-ff', '--no-edit', '-m', `Merge ${label} (${branch})`, tip],
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
