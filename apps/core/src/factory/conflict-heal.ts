/**
 * Layer 2 of conflict handling (PROJECT.md M5): when a run's branch no longer merges into main,
 * core merges main into the branch in the run's worktree and resolves the conflicts that are
 * purely additive (both sides only added lines at the same spot, the diff3 base is empty) as ours
 * then theirs. Anything else (an edit/edit hunk, a lockfile, a binary, a modify/delete, a rename or
 * a file/directory conflict, a failing gate, or no gate that could check the result) undoes the heal:
 * worktree, index and branch tip are as they were, and the caller escalates.
 *
 * Every git and file step runs through ops like the merge itself. The conflicted text comes from
 * the blobs (`git merge-file --object-id`), never from the agent-writable worktree; the resolved
 * text is written with `dd oflag=nofollow`, so a link planted at the path is refused, not written through.
 */
import path from 'node:path';
import { CommandFailedError, execFileChecked, RUNNER_BIN, systemCommand } from '../command-exec.js';
import { execGitFile } from '../git-exec.js';
import { isLockfile } from '../lockfiles.js';
import { FACTORY_GIT_IDENTITY, NOT_REGULAR, readGitDirFile } from './merge.js';

/** The marker size of the heal's own merge-file output: long enough that a file's text never looks like one. */
const HEAL_MARKER_SIZE = 32;
/** Larger resolved files are left for the agent (the text goes to `dd` as arguments). */
const MAX_RESOLVED_CHARS = 512_000;
const ARG_CHUNK_CHARS = 30_000;

export type AdditiveResolution = { resolved: string } | { unresolved: true };

const LINE = /[^\n]*\n|[^\n]+$/g;

function isMarker(line: string, char: string, size: number): boolean {
  if (!line.startsWith(char.repeat(size))) return false;
  const next = line[size];
  return next === undefined || next === ' ' || next === '\n' || next === '\r';
}

/**
 * Resolves a diff3-marked text whose every conflict hunk has an empty base section: each becomes
 * ours followed by theirs (one copy when both sides are identical). Any hunk with a base (a real
 * edit/edit conflict), a two-way hunk without a base section, malformed markers, or a text with no
 * hunk at all is `unresolved`.
 */
export function resolveAdditiveHunks(text: string, markerSize = 7): AdditiveResolution {
  const unresolved = { unresolved: true } as const;
  let state: 'outside' | 'ours' | 'base' | 'theirs' = 'outside';
  let ours: string[] = [];
  let base: string[] = [];
  let theirs: string[] = [];
  let hunks = 0;
  const out: string[] = [];
  for (const line of text.match(LINE) ?? []) {
    const start = isMarker(line, '<', markerSize);
    if (state === 'outside') {
      if (start) {
        state = 'ours';
        ours = [];
        base = [];
        theirs = [];
      } else if (isMarker(line, '|', markerSize) || isMarker(line, '>', markerSize)) {
        return unresolved;
      } else {
        out.push(line);
      }
      continue;
    }
    if (start) return unresolved;
    if (state === 'ours') {
      if (isMarker(line, '|', markerSize)) state = 'base';
      else if (isMarker(line, '=', markerSize) || isMarker(line, '>', markerSize)) return unresolved;
      else ours.push(line);
    } else if (state === 'base') {
      if (isMarker(line, '=', markerSize)) state = 'theirs';
      else if (isMarker(line, '|', markerSize) || isMarker(line, '>', markerSize)) return unresolved;
      else base.push(line);
    } else if (isMarker(line, '>', markerSize)) {
      if (base.length > 0) return unresolved;
      const oursText = ours.join('');
      const theirsText = theirs.join('');
      out.push(oursText, oursText === theirsText ? '' : theirsText);
      hunks += 1;
      state = 'outside';
    } else if (isMarker(line, '|', markerSize) || isMarker(line, '=', markerSize)) {
      return unresolved;
    } else {
      theirs.push(line);
    }
  }
  if (state !== 'outside' || hunks === 0) return unresolved;
  return { resolved: out.join('') };
}

/**
 * Why a heal did not land; `turn_moved`: the agent worked again, nothing was changed; `unverified`:
 * no check could run on the healed tree, so it was undone.
 */
export type HealFailureReason =
  'turn_moved' | 'worktree_busy' | 'unresolved' | 'gate_failed' | 'unverified' | 'git_error';

/**
 * The worktree gate's verdict on the healed tree. `unverified`: no check ran (the build gate is off,
 * or the tree has nothing to verify); a union-merged tree nobody checked never lands, so the heal is
 * undone and the conflict takes the ladder like any other.
 */
export type HealGate = { ok: true } | { ok: false; output: string } | { ok: 'unverified'; reason: string };

export type HealResult =
  | { healed: true; files: string[]; commitSha: string; commitOid: string }
  | {
      healed: false;
      reason: HealFailureReason;
      /** Every path the merge of main into the branch left conflicted. */
      conflicts: string[];
      /** The paths that could not be resolved (a subset of `conflicts`). */
      unresolved: string[];
      message: string;
      gateFailure?: string;
    };

export type HealFailure = Extract<HealResult, { healed: false }>;

export interface HealParams {
  worktreePath: string;
  mainWorkspacePath: string;
  /** The branch the main workspace has checked out (the commit message names it). */
  mainBranch: string;
  /** The ticket key or run label, for the messages. */
  label: string;
  /** Main's commit to catch up with (the failed merge read it under its lock); default: `mainBranch`'s tip. */
  mainTip?: string | null;
  /** The agent worked again since the pass began: the heal changes nothing. */
  stale: () => boolean;
  /** The worktree gate (build/lint/test) on the healed tree. */
  verify: () => Promise<HealGate>;
}

interface Stage {
  mode: string;
  oid: string;
}

/** Unmerged index entries by path (`git ls-files -u -z`). */
async function unmergedEntries(worktreePath: string): Promise<Map<string, Map<number, Stage>>> {
  const { stdout } = await execGitFile(['ls-files', '-u', '-z'], { cwd: worktreePath });
  const byPath = new Map<string, Map<number, Stage>>();
  for (const record of stdout.split('\0')) {
    const match = /^(\d{6}) ([0-9a-f]+) ([123])\t(.+)$/s.exec(record);
    if (!match) continue;
    const [, mode, oid, stage, file] = match;
    if (!mode || !oid || !stage || !file) continue;
    const stages = byPath.get(file) ?? new Map<number, Stage>();
    stages.set(Number(stage), { mode, oid });
    byPath.set(file, stages);
  }
  return byPath;
}

/** The additive resolution of one conflicted path, or null when it is not one this layer resolves. */
async function resolvePath(
  mainWorkspacePath: string,
  file: string,
  stages: Map<number, Stage>,
): Promise<string | null> {
  // Both sides' additions to a lockfile are no valid lockfile: the ladder's agent re-runs its manager.
  if (isLockfile(file)) return null;
  const base = stages.get(1);
  const ours = stages.get(2);
  const theirs = stages.get(3);
  // A missing stage is a modify/delete, add/add, rename or file/directory conflict.
  if (!base || !ours || !theirs) return null;
  const regular = (s: Stage) => s.mode === '100644' || s.mode === '100755';
  if (![base, ours, theirs].every(regular) || ours.mode !== theirs.mode) return null;
  const args = [
    'merge-file',
    '-p',
    '--diff3',
    `--marker-size=${HEAL_MARKER_SIZE}`,
    '-L',
    'ours',
    '-L',
    'base',
    '-L',
    'theirs',
    '--object-id',
    ours.oid,
    base.oid,
    theirs.oid,
  ];
  // In the main workspace, which has the same objects: git 2.53's `merge-file --object-id` aborts
  // in a linked worktree ("cannot reinitialize an already-initialized object directory").
  // Exit status is the number of conflicts (capped at 127); a binary or other failure is above it.
  const text = await execGitFile(args, { cwd: mainWorkspacePath }).then(
    (res) => res.stdout,
    (error: unknown) => {
      const code = error instanceof CommandFailedError ? error.code : null;
      return error instanceof CommandFailedError && code !== null && code > 0 && code < 128
        ? error.stdout
        : null;
    },
  );
  if (text === null || text.includes('\0')) return null;
  const result = resolveAdditiveHunks(text, HEAL_MARKER_SIZE);
  if ('unresolved' in result || result.resolved.length > MAX_RESOLVED_CHARS) return null;
  return result.resolved;
}

/** Writes `text` to the regular file `$1` in ops; a link or anything else there is refused. */
const WRITE_FILE = [
  `if [ -L "$1" ]; then ${NOT_REGULAR}; fi`,
  `[ -f "$1" ] || { ${NOT_REGULAR}; }`,
  'f=$1',
  'shift 2',
  `printf '%s' "$@" | ${RUNNER_BIN.dd} of="$f" oflag=nofollow status=none`,
].join('\n');

async function writeResolved(worktreePath: string, file: string, text: string): Promise<void> {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += ARG_CHUNK_CHARS) chunks.push(text.slice(i, i + ARG_CHUNK_CHARS));
  await execFileChecked(
    systemCommand({
      file: RUNNER_BIN.sh,
      args: ['-c', WRITE_FILE, 'sh', path.join(worktreePath, file), file, ...chunks],
      cwd: worktreePath,
    }),
  );
}

const head = async (worktreePath: string) =>
  (await execGitFile(['rev-parse', 'HEAD'], { cwd: worktreePath })).stdout.trim();

/** Whether the worktree has no change to tracked files and no unconcluded operation. */
async function worktreeSettled(worktreePath: string): Promise<boolean> {
  const status = await execGitFile(['status', '--porcelain', '--untracked-files=no'], { cwd: worktreePath });
  if (status.stdout.trim()) return false;
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD']) {
    if ((await readGitDirFile(worktreePath, name)) !== null) return false;
  }
  return true;
}

/**
 * Puts the worktree back at `previous`: an unconcluded merge is aborted, the heal's own commit
 * (`healCommit`) is taken off the branch. A branch the agent moved past it is left alone.
 */
async function restore(worktreePath: string, previous: string, healCommit: string | null): Promise<void> {
  const inWorktree = { cwd: worktreePath };
  if ((await readGitDirFile(worktreePath, 'MERGE_HEAD')) !== null) {
    await execGitFile(['merge', '--abort'], inWorktree).catch(() => undefined);
  }
  const now = await head(worktreePath);
  if (healCommit !== null && now === healCommit) {
    await execGitFile(
      ['update-ref', '-m', 'emberline: undo conflict heal', 'HEAD', previous, now],
      inWorktree,
    );
  } else if (now !== previous) {
    return;
  }
  await execGitFile(['reset', '--hard', '-q', previous], inWorktree);
}

/** After its commit, a heal whose agent worked again is undone only if the agent left the tree untouched. */
async function untouchedSince(worktreePath: string, healCommit: string): Promise<boolean> {
  const status = await execGitFile(['status', '--porcelain', '--untracked-files=no'], { cwd: worktreePath });
  return !status.stdout.trim() && (await head(worktreePath)) === healCommit;
}

/**
 * Catches the run's branch up with main in its worktree and resolves additive conflicts (see the
 * module comment). On success the branch has the merge commit, its gate passed, and merging the
 * branch into main is a clean 3-way merge; on failure everything is as before.
 */
export async function healConflicts(params: HealParams): Promise<HealResult> {
  const { worktreePath, mainBranch, label, stale, verify } = params;
  const inWorktree = { cwd: worktreePath };
  let conflicts: string[] = [];
  const failed = (
    reason: HealFailureReason,
    message: string,
    extra: { unresolved?: string[]; gateFailure?: string } = {},
  ): HealFailure => ({
    healed: false,
    reason,
    conflicts,
    unresolved: extra.unresolved ?? [],
    message,
    ...(extra.gateFailure !== undefined ? { gateFailure: extra.gateFailure } : {}),
  });
  if (stale()) return failed('turn_moved', `${label} worked again; the heal was not started.`);

  let previous: string;
  let mainTip: string;
  let branch: string;
  try {
    if (!(await worktreeSettled(worktreePath))) {
      return failed(
        'worktree_busy',
        `${label}'s worktree has uncommitted changes or an unfinished git operation.`,
      );
    }
    previous = await head(worktreePath);
    branch = (await execGitFile(['symbolic-ref', '--short', 'HEAD'], inWorktree)).stdout.trim();
    const tipRev = params.mainTip ?? `refs/heads/${mainBranch}`;
    mainTip = (
      await execGitFile(['rev-parse', '--verify', '--quiet', `${tipRev}^{commit}`], inWorktree)
    ).stdout.trim();
  } catch (error) {
    return failed('git_error', `Could not start the heal of ${label}: ${(error as Error).message}`);
  }

  let healCommit: string | null = null;
  const undo = async (result: HealResult): Promise<HealResult> => {
    await restore(worktreePath, previous, healCommit);
    return result;
  };
  try {
    const merge = await execGitFile(
      [
        ...FACTORY_GIT_IDENTITY,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'merge.conflictStyle=diff3',
        'merge',
        '--no-ff',
        '--no-commit',
        mainTip,
      ],
      { ...inWorktree, timeout: 120_000 },
    ).then(
      () => null,
      (error: unknown) => error as Error,
    );
    const entries = await unmergedEntries(worktreePath);
    conflicts = [...entries.keys()].sort();
    if (merge && conflicts.length === 0) {
      return await undo(
        failed('git_error', `Could not merge ${mainBranch} into ${branch}: ${merge.message}`),
      );
    }

    const resolved = new Map<string, string>();
    const unresolved: string[] = [];
    for (const [file, stages] of entries) {
      const text = await resolvePath(params.mainWorkspacePath, file, stages);
      if (text === null) unresolved.push(file);
      else resolved.set(file, text);
    }
    if (unresolved.length > 0) {
      return await undo(
        failed('unresolved', `Not additive: ${unresolved.sort().join(', ')}.`, { unresolved }),
      );
    }
    if (stale()) return await undo(failed('turn_moved', `${label} worked again during the heal.`));

    for (const [file, text] of resolved) await writeResolved(worktreePath, file, text);
    if (resolved.size > 0) await execGitFile(['add', '--', ...resolved.keys()], inWorktree);
    if ((await unmergedEntries(worktreePath)).size > 0) {
      return await undo(failed('git_error', 'Conflicts remained in the index after resolving them.'));
    }
    const tree = (await execGitFile(['write-tree'], inWorktree)).stdout.trim();
    const message = `Merge ${mainBranch} into ${branch}${conflicts.length > 0 ? ` (auto-resolved: ${conflicts.join(', ')})` : ''}`;
    const commit = (
      await execGitFile(
        [...FACTORY_GIT_IDENTITY, 'commit-tree', tree, '-p', previous, '-p', mainTip, '-m', message],
        inWorktree,
      )
    ).stdout.trim();
    if (stale()) return await undo(failed('turn_moved', `${label} worked again during the heal.`));
    // Only if the branch is still where the heal began (an agent may commit meanwhile).
    await execGitFile(
      ['update-ref', '-m', `commit (merge): ${message}`, 'HEAD', commit, previous],
      inWorktree,
    );
    healCommit = commit;
    await execGitFile(['merge', '--quit'], inWorktree);

    const gate = await verify().catch((error: unknown): HealGate => ({
      ok: false,
      output: (error as Error).message ?? String(error),
    }));
    if (stale()) {
      const result = failed('turn_moved', `${label} worked again during the heal's checks.`);
      return (await untouchedSince(worktreePath, commit)) ? await undo(result) : result;
    }
    if (gate.ok === 'unverified') {
      return await undo(
        failed(
          'unverified',
          `Nothing checked ${branch} merged with ${mainBranch} (${gate.reason}); the heal was undone.`,
        ),
      );
    }
    if (!gate.ok) {
      return await undo(
        failed('gate_failed', `The checks failed on ${branch} merged with ${mainBranch}.`, {
          gateFailure: gate.output.slice(-2_400),
        }),
      );
    }
    const commitSha = (await execGitFile(['rev-parse', '--short', commit], inWorktree)).stdout.trim();
    return { healed: true, files: conflicts, commitSha, commitOid: commit };
  } catch (error) {
    const result = failed('git_error', `The heal of ${label} failed: ${(error as Error).message}`);
    return restore(worktreePath, previous, healCommit).then(
      () => result,
      (restoreError: unknown) => ({
        ...result,
        message: `${result.message} (restoring the worktree failed too: ${(restoreError as Error).message})`,
      }),
    );
  }
}
