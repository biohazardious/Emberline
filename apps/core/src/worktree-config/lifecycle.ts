/**
 * The run worktree lifecycle of an approved `.emberline/worktree.yml`: `copy` entries from the main
 * workspace, `setup` commands before the agent starts and `teardown` commands before a prune.
 *
 * Copies happen in core, on data only, and never follow a link. Agents can change the workspaces
 * volume at any time, so checks by name are only the first line: every component of a source is
 * lstat-checked from the main workspace down (a link is refused, wherever it points), and each file
 * is then read through a descriptor opened with O_NOFOLLOW whose real path must be exactly
 * `realpath(main)/<entry>` (outputs/safe-fs.ts). Destinations are created exclusively in verified
 * directories of the worktree, so a link committed to the branch cannot redirect a write either.
 * Commands run in the runner (command-exec.ts) through `sh -c`, like the build gate's steps; they
 * never throw: a failure is an outcome for a run event.
 */
import { lstat, mkdir, opendir, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import type { WorktreeCopyEntry } from '@emberline/protocol';
import { execCommand } from '../command-exec.js';
import { copyBetweenHandles, createExclusiveFile, isMissing, openVerifiedFile, realDirUnder } from '../outputs/safe-fs.js';

export const SETUP_TIMEOUT_MS = 10 * 60_000;
export const TEARDOWN_TIMEOUT_MS = 2 * 60_000;
/** Output kept from a failed setup command (event and prompt prefix). */
export const SETUP_TAIL_CHARS = 2000;

export interface CopyOutcome {
  path: string;
  mode: WorktreeCopyEntry['mode'];
  status: 'copied' | 'linked' | 'skipped';
  /** Why a skipped entry was not copied. */
  reason?: string;
  /** Links, sockets and the like inside a copied directory that were left out. */
  leftOut?: number;
}

/** Path components of a relative entry, or null when it is absolute or climbs out with "..". */
function segmentsOf(rel: string): string[] | null {
  if (rel.includes('\0') || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith('~')) return null;
  const parts = rel.split(/[/\\]/).filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  return parts;
}

type Checked = { isDir: boolean } | { skip: string };

/** Checks each component of the source under the (real) main workspace: no link anywhere. */
async function checkSource(mainReal: string, parts: string[]): Promise<Checked> {
  let current = mainReal;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (isMissing(error)) return { skip: 'missing in the main workspace' };
      throw error;
    }
    if (stat.isSymbolicLink()) return { skip: `${parts.slice(0, i + 1).join('/')} is a symbolic link` };
    if (i < parts.length - 1 && !stat.isDirectory()) return { skip: 'missing in the main workspace' };
    if (i === parts.length - 1) {
      if (!stat.isFile() && !stat.isDirectory()) return { skip: 'not a file or directory' };
      return { isDir: stat.isDirectory() };
    }
  }
  return { skip: 'must stay inside the main workspace' };
}

/** Creates the destination's parents inside the worktree; refuses links and an existing destination. */
async function prepareDestination(worktreeReal: string, parts: string[]): Promise<{ skip: string } | null> {
  let current = worktreeReal;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    const last = i === parts.length - 1;
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (last) return null;
      await mkdir(current);
      continue;
    }
    if (stat.isSymbolicLink()) return { skip: `${parts.slice(0, i + 1).join('/')} is a symbolic link in the worktree` };
    if (last) return { skip: 'already exists in the worktree' };
    if (!stat.isDirectory()) return { skip: `${parts.slice(0, i + 1).join('/')} is not a directory in the worktree` };
  }
  return null;
}

/** The directory, verified to be exactly `expectedReal` (no link swapped in since it was checked). */
async function verifiedDir(dir: string, expectedReal: string): Promise<string> {
  if ((await realpath(dir)) !== expectedReal) throw new Error(`${dir} moved while it was copied`);
  return expectedReal;
}

/** Copies one regular file through verified descriptors; the destination must not exist. */
async function copyVerifiedFile(srcReal: string, destDirReal: string, name: string): Promise<void> {
  const src = await openVerifiedFile(srcReal, srcReal);
  try {
    const dst = await createExclusiveFile(await verifiedDir(destDirReal, destDirReal), name);
    try {
      await copyBetweenHandles(src.handle, dst, src.size);
      await dst.chmod((await src.handle.stat()).mode & 0o777);
    } finally {
      await dst.close();
    }
  } finally {
    await src.handle.close();
  }
}

/** Copies a directory tree: directories and regular files only; returns how many entries were left out. */
async function copyVerifiedDir(srcReal: string, destReal: string): Promise<number> {
  await mkdir(destReal);
  await verifiedDir(destReal, destReal);
  let leftOut = 0;
  const dir = await opendir(await verifiedDir(srcReal, srcReal));
  for await (const entry of dir) {
    const from = path.join(srcReal, entry.name);
    if (entry.isDirectory()) leftOut += await copyVerifiedDir(from, path.join(destReal, entry.name));
    else if (entry.isFile()) await copyVerifiedFile(from, destReal, entry.name);
    else leftOut++;
  }
  return leftOut;
}

/**
 * Copies (or links) each entry from the main workspace into a fresh run worktree. `trustedBase` is
 * the workspaces root: the main workspace must be reached from it without a link. Never throws for
 * one entry: each gets an outcome, and a skipped one says why.
 */
export async function copyIntoWorktree(
  dirs: { trustedBase: string; mainPath: string; worktreePath: string },
  entries: readonly WorktreeCopyEntry[],
): Promise<CopyOutcome[]> {
  const mainReal = await realDirUnder(dirs.trustedBase, dirs.mainPath);
  const worktreeReal = await realDirUnder(dirs.trustedBase, dirs.worktreePath);
  if (!mainReal || !worktreeReal) throw new Error('the main workspace or the worktree is missing');
  const outcomes: CopyOutcome[] = [];
  for (const entry of entries) {
    const skip = (reason: string): CopyOutcome => ({ path: entry.path, mode: entry.mode, status: 'skipped', reason });
    const parts = segmentsOf(entry.path);
    if (!parts) {
      outcomes.push(skip('must stay inside the main workspace'));
      continue;
    }
    if (parts[0] === '.git') {
      outcomes.push(skip('must not touch .git'));
      continue;
    }
    try {
      const source = await checkSource(mainReal, parts);
      if ('skip' in source) {
        outcomes.push(skip(source.skip));
        continue;
      }
      const blocked = await prepareDestination(worktreeReal, parts);
      if (blocked) {
        outcomes.push(skip(blocked.skip));
        continue;
      }
      const srcReal = path.join(mainReal, ...parts);
      const destParent = path.join(worktreeReal, ...parts.slice(0, -1));
      const name = parts[parts.length - 1]!;
      if (entry.mode === 'symlink') {
        await verifiedDir(destParent, destParent);
        await symlink(srcReal, path.join(destParent, name));
        outcomes.push({ path: entry.path, mode: entry.mode, status: 'linked' });
      } else if (source.isDir) {
        const leftOut = await copyVerifiedDir(srcReal, path.join(destParent, name));
        outcomes.push({ path: entry.path, mode: entry.mode, status: 'copied', ...(leftOut > 0 ? { leftOut } : {}) });
      } else {
        await copyVerifiedFile(srcReal, destParent, name);
        outcomes.push({ path: entry.path, mode: entry.mode, status: 'copied' });
      }
    } catch (error) {
      outcomes.push(skip(`copy failed: ${(error as Error).message.slice(0, 200)}`));
    }
  }
  return outcomes;
}

export interface CommandOutcome {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** The last {@link SETUP_TAIL_CHARS} characters of the output (stdout and stderr together). */
  tail: string;
}

/**
 * Runs one worktree.yml command in the runner (`sh -c`, cwd = the worktree). Standard error is sent
 * to standard output first, so the tail keeps both in order.
 */
export async function runWorktreeCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandOutcome> {
  try {
    const result = await execCommand({
      file: 'sh',
      args: ['-c', `exec 2>&1\n${command}`],
      cwd,
      timeoutMs,
      env: { FORCE_COLOR: '0' },
    });
    const output = `${result.stdout}${result.stderr}`.trimEnd();
    return {
      command,
      ok: result.exitCode === 0 && !result.timedOut,
      exitCode: result.timedOut ? null : result.exitCode,
      timedOut: result.timedOut,
      tail: output.slice(-SETUP_TAIL_CHARS),
    };
  } catch (error) {
    return { command, ok: false, exitCode: null, timedOut: false, tail: (error as Error).message.slice(-SETUP_TAIL_CHARS) };
  }
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

/** Put in front of the run's first prompt when a setup command failed. */
export function setupFailurePrefix(failure: Pick<CommandOutcome, 'command' | 'exitCode' | 'timedOut' | 'tail'>): string {
  const how = failure.timedOut
    ? `timed out after ${minutes(SETUP_TIMEOUT_MS)}`
    : failure.exitCode === null
      ? 'did not finish'
      : `exit ${failure.exitCode}`;
  return `Worktree setup failed: \`${failure.command}\` (${how})\n\`\`\`\n${failure.tail.slice(-SETUP_TAIL_CHARS)}\n\`\`\`\nFix it as part of this ticket.`;
}
