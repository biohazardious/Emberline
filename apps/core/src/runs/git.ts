import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  ArtifactKind,
  DiffFile,
  DiffFileStatus,
  DiffScope,
  GitCommitBody,
  GitCommitResponse,
  GitPushResponse,
  GitStageBody,
  RunArtifact,
  RunBuildOutput,
  RunDiffSummary,
  RunFileDiff,
} from '@emberline/protocol';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { unstageScratchFiles } from '../factory/merge.js';
import { execGitFile, NO_SUBMODULES } from '../git-exec.js';
import { describeGitError, type KnownSecrets, redactGitText } from '../git-gateway/gateway.js';
import { type AccountRemote, accountPushBranch } from '../git-gateway/remote-git.js';
import { isMissing, type OpenedFile, openVerifiedFile, UnsafePathError } from '../outputs/safe-fs.js';

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_ARTIFACTS = 200;
const ARTIFACT_DIRS = ['artifacts', 'screenshots', 'test-results', 'playwright-report'];
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.pnpm-store', '.turbo', '.next']);

/** Runs git without ever prompting (no TTY in core) and returns trimmed stdout. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execGitFile(['-C', cwd, ...args], {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Like {@link git}, but preserves leading/trailing whitespace and NUL delimiters. */
async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execGitFile(['-C', cwd, ...args], {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
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
export async function prepareWorkspace(
  projectPath: string,
  worktreePath: string,
  branch: string,
): Promise<Workspace> {
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

/**
 * Validates a relative path inside `worktreePath` so callers cannot traverse outside the
 * worktree, read `.git` internals, or inject git flags starting with `-`.
 */
export function resolveSafeWorktreePath(worktreePath: string, relPath: string): { abs: string; rel: string } {
  const normalized = relPath.replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('/') || normalized.startsWith('-')) {
    throw badRequest('invalid file path');
  }
  const root = path.resolve(worktreePath);
  const abs = path.resolve(root, normalized);
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel === '.git' || rel.startsWith('.git/')) {
    throw badRequest('path outside worktree is not allowed');
  }
  return { abs, rel };
}

async function resolveBaseRef(worktreePath: string, baseBranch: string): Promise<string> {
  for (const candidate of [baseBranch, `origin/${baseBranch}`, 'HEAD']) {
    try {
      const mb = await git(worktreePath, ['merge-base', 'HEAD', candidate]);
      if (mb) return mb;
    } catch {
      // Try next candidate
    }
  }
  return 'HEAD';
}

function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function isBinaryBuffer(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8_000));
  return sample.includes(0);
}

interface PorcelainEntry {
  indexStatus: string;
  worktreeStatus: string;
  oldPath: string | null;
}

async function readPorcelainStatus(worktreePath: string): Promise<Map<string, PorcelainEntry>> {
  const raw = await gitRaw(worktreePath, ['status', '--porcelain=v1', '-z', '-uall']);
  const tokens = raw.split('\0');
  const map = new Map<string, PorcelainEntry>();
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0] ?? ' ';
    const y = entry[1] ?? ' ';
    const filePath = entry.slice(3);
    let oldPath: string | null = null;
    if (x === 'R' || x === 'C') {
      oldPath = tokens[++i] ?? null;
    }
    map.set(filePath, { indexStatus: x, worktreeStatus: y, oldPath });
  }
  return map;
}

function statusFromCode(code: string): DiffFileStatus {
  if (code.startsWith('A')) return 'added';
  if (code.startsWith('D')) return 'deleted';
  if (code.startsWith('R')) return 'renamed';
  if (code === '??') return 'untracked';
  return 'modified';
}

/** Files larger than this are not hashed (they get the `unhashed:` fallback). */
const MAX_HASH_BYTES = 64 * 1024 * 1024;

/** Old blob ids of deleted files from `git diff --raw --no-abbrev` output. */
function deletedBlobs(rawOut: string): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const line of rawOut.split('\n')) {
    // :<old mode> <new mode> <old blob> <new blob> <status>\t<path>
    const m = /^:\d+ \d+ ([0-9a-f]+) [0-9a-f]+ D\t(.+)$/.exec(line);
    if (m) blobs.set(m[2]!, m[1]!);
  }
  return blobs;
}

/** True when `abs`'s parent directory really lives inside the worktree (no symlinked directory escapes). */
async function parentInside(root: string, abs: string): Promise<boolean> {
  try {
    const [realRoot, realParent] = await Promise.all([realpath(root), realpath(path.dirname(abs))]);
    return realParent === realRoot || realParent.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

/**
 * Opens `rel` inside the worktree for reading through one verified descriptor: O_NOFOLLOW on the
 * last component, the descriptor's real path must be `realpath(worktree)/rel` (no symlinked parent)
 * and it must be a regular file. So an agent swapping a link, FIFO or device in after a check cannot
 * make core read it. Throws UnsafePathError for those, the plain error when missing.
 */
async function openWorktreeFile(worktreePath: string, rel: string): Promise<OpenedFile> {
  const real = path.join(await realpath(worktreePath), rel);
  return openVerifiedFile(real, real);
}

/** Reads exactly `size` bytes of an open file, chunk by chunk, into `onChunk`. */
async function readOpened({ handle, size }: OpenedFile, onChunk: (chunk: Buffer) => void): Promise<void> {
  const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(size, 1024 * 1024)));
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (bytesRead === 0) throw new Error('the file shrank while it was read');
    onChunk(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

/** The whole content of a regular worktree file of at most `max` bytes (null when larger). */
export async function readWorktreeBytes(
  worktreePath: string,
  rel: string,
  max: number,
): Promise<Buffer | null> {
  const opened = await openWorktreeFile(worktreePath, rel);
  try {
    if (opened.size > max) return null;
    const parts: Buffer[] = [];
    await readOpened(opened, (chunk) => parts.push(Buffer.from(chunk)));
    return Buffer.concat(parts);
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/**
 * The git blob id of a regular worktree file, computed in Node as sha1(`blob <size>\0` + content)
 * (what `git hash-object --no-filters` reports), read through {@link openWorktreeFile}. Null over
 * the 64 MB cap; throws UnsafePathError for a link, a symlinked parent or anything not a regular file.
 */
export async function blobHashNoFollow(worktreePath: string, rel: string): Promise<string | null> {
  const opened = await openWorktreeFile(worktreePath, rel);
  try {
    if (opened.size > MAX_HASH_BYTES) return null;
    const hash = createHash('sha1').update(`blob ${opened.size}\0`);
    await readOpened(opened, (chunk) => hash.update(chunk));
    return hash.digest('hex');
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/**
 * Content hashes for paths present in the worktree. Regular files are hashed in Node through a
 * verified, non-following descriptor ({@link blobHashNoFollow}); symlinks are hashed by their link
 * text (`link:<sha1>`), never followed. Anything else (FIFO, device, directory, a link out of the
 * worktree, over the size cap) maps to null.
 */
async function contentHashes(worktreePath: string, relPaths: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const root = path.resolve(worktreePath);
  for (const rel of relPaths) {
    result.set(rel, null);
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) continue;
    try {
      result.set(rel, await blobHashNoFollow(root, path.relative(root, abs)));
    } catch (error) {
      if (!(error instanceof UnsafePathError)) continue;
      // Not a regular file reached directly: a link inside the worktree is hashed by its text.
      try {
        if ((await lstat(abs)).isSymbolicLink() && (await parentInside(root, abs))) {
          result.set(
            rel,
            `link:${createHash('sha1')
              .update(await readlink(abs))
              .digest('hex')}`,
          );
        }
      } catch {
        // swapped again or gone: stays null
      }
    }
  }
  return result;
}

/**
 * Fills `DiffFile.hash`: content hash for files in the worktree, `link:<sha1>` for symlinks,
 * `deleted:<old blob>` for deleted files, and a varying `unhashed:<status>:<adds>:<dels>` otherwise.
 */
export async function assignHashes(worktreePath: string, files: DiffFile[], rawOut: string): Promise<void> {
  const blobs = deletedBlobs(rawOut);
  const present: DiffFile[] = [];
  for (const f of files) {
    const blob = f.status === 'deleted' ? blobs.get(f.path) : undefined;
    if (blob) f.hash = `deleted:${blob}`;
    else if (f.status !== 'deleted') present.push(f);
  }
  const hashes = await contentHashes(
    worktreePath,
    present.map((f) => f.path),
  );
  for (const f of files) {
    if (f.hash) continue;
    f.hash = hashes.get(f.path) ?? `unhashed:${f.status}:${f.additions}:${f.deletions}`;
  }
}

/**
 * Hash of a single file as `inspectDiff` would report it (null when unhashable), without listing the
 * whole diff. A file missing from the worktree reports `deleted:<blob at the base>`.
 */
export async function hashWorktreeFile(
  worktreePath: string,
  baseBranch: string,
  relPath: string,
): Promise<string | null> {
  const { rel } = resolveSafeWorktreePath(worktreePath, relPath);
  const present = (await contentHashes(worktreePath, [rel])).get(rel) ?? null;
  if (present) return present;
  if (
    await lstat(path.join(worktreePath, rel)).then(
      () => true,
      () => false,
    )
  )
    return null;
  const baseRef = await resolveBaseRef(worktreePath, baseBranch);
  const blob = (
    await gitRaw(worktreePath, ['rev-parse', '--verify', '-q', `${baseRef}:${rel}`]).catch(() => '')
  ).trim();
  return blob ? `deleted:${blob}` : null;
}

/**
 * The branch-diff hashes of `relPaths` (as `inspectDiff` reports them) for the paths that are in the
 * diff; a path that is not is absent. Lists only names (diff `--name-only`, untracked files) and
 * hashes only the given files, instead of the whole hashed diff. Null when the worktree is gone.
 * An unhashable file maps to `unhashed:` (never equal to a stored hash).
 */
export async function reviewFileHashes(
  worktreePath: string,
  baseBranch: string,
  relPaths: readonly string[],
): Promise<Map<string, string> | null> {
  if (!existsSync(worktreePath) || !existsSync(path.join(worktreePath, '.git'))) return null;
  const result = new Map<string, string>();
  if (relPaths.length === 0) return result;
  const baseRef = await resolveBaseRef(worktreePath, baseBranch);
  const [changed, untracked] = await Promise.all([
    gitRaw(worktreePath, ['diff', baseRef, '--name-only', '-z']),
    gitRaw(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const inDiff = new Set([...changed.split('\0'), ...untracked.split('\0')].filter(Boolean));
  for (const rel of new Set(relPaths)) {
    if (!inDiff.has(rel)) continue;
    const hash = await hashWorktreeFile(worktreePath, baseBranch, rel).catch(() => null);
    result.set(rel, hash ?? 'unhashed:');
  }
  return result;
}

/** Largest file side read when re-anchoring review comments. */
export const MAX_ANCHOR_BYTES = 2 * 1024 * 1024;

/**
 * Text of one side of a file for re-anchoring (`modified` = worktree, `original` = base branch).
 * Returns null when the side does not exist; throws when it is unreadable or over the 2 MB cap.
 */
export async function readReviewSide(
  worktreePath: string,
  baseBranch: string,
  relPath: string,
  side: 'modified' | 'original',
): Promise<string | null> {
  const { abs, rel } = resolveSafeWorktreePath(worktreePath, relPath);
  if (side === 'modified') {
    let buf: Buffer | null;
    try {
      // The text ends up in agent prompts: read through a verified descriptor, never a link.
      buf = await readWorktreeBytes(worktreePath, rel, MAX_ANCHOR_BYTES);
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof UnsafePathError) {
        const info = await lstat(abs).catch(() => null);
        if (
          info &&
          !info.isSymbolicLink() &&
          !info.isFile() &&
          (await parentInside(path.resolve(worktreePath), abs))
        )
          return null;
        throw new Error(`${rel} is a symlink, lies behind one or is not a regular file`);
      }
      throw error;
    }
    if (buf === null) throw new Error(`${rel} is larger than ${MAX_ANCHOR_BYTES} bytes`);
    if (isBinaryBuffer(buf)) throw new Error(`${rel} is binary`);
    return buf.toString('utf8');
  }
  const baseRef = await resolveBaseRef(worktreePath, baseBranch);
  let basePath = rel;
  const exists = (p: string) =>
    gitRaw(worktreePath, ['cat-file', '-e', `${baseRef}:${p}`]).then(
      () => true,
      () => false,
    );
  if (!(await exists(rel))) {
    // A renamed file's original lives under its old path.
    const tokens = (
      await gitRaw(worktreePath, ['diff', baseRef, '--name-status', '-z', '-M']).catch(() => '')
    ).split('\0');
    let old: string | null = null;
    for (let i = 0; i < tokens.length; i++) {
      const code = tokens[i];
      if (!code) continue;
      if (code.startsWith('R') || code.startsWith('C')) {
        if (tokens[i + 2] === rel) old = tokens[i + 1] ?? null;
        i += 2;
      } else i += 1;
    }
    if (!old || !(await exists(old))) return null;
    basePath = old;
  }
  const { stdout } = await execGitFile(['-C', worktreePath, 'show', `${baseRef}:${basePath}`], {
    timeout: 15_000,
    maxBuffer: MAX_ANCHOR_BYTES + 1024,
    encoding: 'buffer',
  });
  if (stdout.length > MAX_ANCHOR_BYTES) throw new Error(`${rel} is larger than ${MAX_ANCHOR_BYTES} bytes`);
  if (isBinaryBuffer(stdout)) throw new Error(`${rel} is binary`);
  return stdout.toString('utf8');
}

/**
 * Returns the per-file diff summary for a run's worktree (`branch`, `unstaged`, or `staged`).
 */
export async function inspectDiff(
  worktreePath: string,
  baseBranch: string,
  scope: DiffScope,
  runId: string,
  branch: string | null,
): Promise<RunDiffSummary> {
  if (!existsSync(worktreePath) || !existsSync(path.join(worktreePath, '.git'))) {
    return {
      runId,
      isGitRepo: false,
      branch,
      baseBranch,
      headSha: null,
      aheadCount: 0,
      clean: true,
      hasRemote: false,
      scope,
      totalAdditions: 0,
      totalDeletions: 0,
      files: [],
    };
  }

  const headSha = await git(worktreePath, ['rev-parse', '--short', 'HEAD']).catch(() => null);
  const baseRef = await resolveBaseRef(worktreePath, baseBranch);
  const aheadRaw = await git(worktreePath, ['rev-list', '--count', `${baseRef}..HEAD`]).catch(() => '0');
  const aheadCount = Number.parseInt(aheadRaw, 10) || 0;
  const remotes = await git(worktreePath, ['remote']).catch(() => '');
  const hasRemote = remotes.split('\n').some((r) => r.trim() === 'origin');

  const statusMap = await readPorcelainStatus(worktreePath);
  const clean = statusMap.size === 0;

  const diffArgs =
    scope === 'staged' ? ['diff', '--cached'] : scope === 'unstaged' ? ['diff'] : ['diff', baseRef];

  const [numstatOut, nameStatusOut, rawOut] = await Promise.all([
    gitRaw(worktreePath, [...diffArgs, '--numstat', '-z']),
    gitRaw(worktreePath, [...diffArgs, '--name-status', '-z']),
    gitRaw(worktreePath, [...diffArgs, '--raw', '--no-abbrev']).catch(() => ''),
  ]);

  // NUL-delimited output: renames come as `R<score> \0 old \0 new` and paths are never quoted.
  const statusByPath = new Map<string, { status: DiffFileStatus; oldPath: string | null }>();
  const nameTokens = nameStatusOut.split('\0');
  for (let i = 0; i < nameTokens.length; i++) {
    const code = nameTokens[i];
    if (!code) continue;
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldP = nameTokens[++i];
      const newP = nameTokens[++i];
      if (oldP && newP)
        statusByPath.set(newP, { status: code.startsWith('R') ? 'renamed' : 'added', oldPath: oldP });
    } else {
      const p = nameTokens[++i];
      if (p) statusByPath.set(p, { status: statusFromCode(code), oldPath: null });
    }
  }

  const filesByPath = new Map<string, DiffFile>();
  const numTokens = numstatOut.split('\0');
  for (let i = 0; i < numTokens.length; i++) {
    const head = numTokens[i];
    if (!head) continue;
    const parts = head.replace(/^\n/, '').split('\t');
    const addRaw = parts[0] ?? '0';
    const delRaw = parts[1] ?? '0';
    let pathPart = parts.slice(2).join('\t');
    if (!pathPart) {
      // rename/copy: the next two tokens are the old and the new path
      i++;
      pathPart = numTokens[++i] ?? '';
    }
    if (!pathPart) continue;
    const additions = addRaw === '-' ? 0 : Number.parseInt(addRaw, 10) || 0;
    const deletions = delRaw === '-' ? 0 : Number.parseInt(delRaw, 10) || 0;
    const ns = statusByPath.get(pathPart);
    const porc = statusMap.get(pathPart);
    filesByPath.set(pathPart, {
      path: pathPart,
      oldPath: ns?.oldPath ?? porc?.oldPath ?? null,
      status: ns?.status ?? 'modified',
      additions,
      deletions,
      hash: '',
      staged: porc ? porc.indexStatus !== ' ' && porc.indexStatus !== '?' : false,
      unstaged: porc ? porc.worktreeStatus !== ' ' : false,
    });
  }

  // Include untracked files in `branch` and `unstaged` scopes so newly created files are visible.
  if (scope === 'branch' || scope === 'unstaged') {
    for (const [filePath, porc] of statusMap.entries()) {
      if (porc.indexStatus === '?' && porc.worktreeStatus === '?' && !filesByPath.has(filePath)) {
        let additions = 0;
        try {
          // Never through a link: an agent's symlink must not make core read outside the worktree.
          const buf = await readWorktreeBytes(worktreePath, filePath, MAX_TEXT_BYTES);
          if (buf && !isBinaryBuffer(buf)) additions = countLines(buf.toString('utf8'));
        } catch {
          // Ignore unreadable untracked file
        }
        filesByPath.set(filePath, {
          path: filePath,
          oldPath: null,
          status: 'untracked',
          additions,
          deletions: 0,
          hash: '',
          staged: false,
          unstaged: true,
        });
      }
    }
  }

  const files = [...filesByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  await assignHashes(worktreePath, files, rawOut);
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const f of files) {
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
  }

  return {
    runId,
    isGitRepo: true,
    branch,
    baseBranch,
    headSha,
    aheadCount,
    clean,
    hasRemote,
    scope,
    totalAdditions,
    totalDeletions,
    files,
  };
}

async function readGitBlob(
  worktreePath: string,
  spec: string,
): Promise<{ text: string; binary: boolean } | null> {
  try {
    const { stdout } = await execGitFile(['-C', worktreePath, 'show', spec], {
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'buffer',
    });
    if (isBinaryBuffer(stdout)) return { text: '', binary: true };
    const slice = stdout.length > MAX_TEXT_BYTES ? stdout.subarray(0, MAX_TEXT_BYTES) : stdout;
    return { text: slice.toString('utf8'), binary: false };
  } catch {
    return null;
  }
}

async function readWorktreeFile(absPath: string): Promise<{ text: string; binary: boolean } | null> {
  try {
    const info = await stat(absPath);
    if (!info.isFile()) return null;
    const buf = await readFile(absPath);
    if (isBinaryBuffer(buf)) return { text: '', binary: true };
    const slice = buf.length > MAX_TEXT_BYTES ? buf.subarray(0, MAX_TEXT_BYTES) : buf;
    return { text: slice.toString('utf8'), binary: false };
  } catch {
    return null;
  }
}

/**
 * Returns `original`, `modified`, and `patch` for a single file so Monaco DiffEditor can
 * render side-by-side or inline diffs and accept line annotations.
 */
export async function inspectFileDiff(
  worktreePath: string,
  baseBranch: string,
  scope: DiffScope,
  relPath: string,
): Promise<RunFileDiff> {
  const { abs, rel } = resolveSafeWorktreePath(worktreePath, relPath);
  const baseRef = await resolveBaseRef(worktreePath, baseBranch);

  let origBlob: { text: string; binary: boolean } | null = null;
  let modBlob: { text: string; binary: boolean } | null = null;
  let patch = '';

  if (scope === 'staged') {
    origBlob = await readGitBlob(worktreePath, `HEAD:${rel}`);
    modBlob = await readGitBlob(worktreePath, `:${rel}`);
    patch = await gitRaw(worktreePath, ['diff', '--cached', '--', rel]).catch(() => '');
  } else if (scope === 'unstaged') {
    origBlob =
      (await readGitBlob(worktreePath, `:${rel}`)) ?? (await readGitBlob(worktreePath, `HEAD:${rel}`));
    modBlob = await readWorktreeFile(abs);
    patch = await gitRaw(worktreePath, ['diff', '--', rel]).catch(() => '');
  } else {
    origBlob = await readGitBlob(worktreePath, `${baseRef}:${rel}`);
    modBlob = await readWorktreeFile(abs);
    patch = await gitRaw(worktreePath, ['diff', baseRef, '--', rel]).catch(() => '');
  }

  const binary = Boolean(origBlob?.binary || modBlob?.binary);
  const status: DiffFileStatus =
    !origBlob && modBlob ? 'added' : origBlob && !modBlob ? 'deleted' : 'modified';

  return {
    path: rel,
    scope,
    status,
    binary,
    original: binary ? '' : (origBlob?.text ?? ''),
    modified: binary ? '' : (modBlob?.text ?? ''),
    patch: patch.slice(0, MAX_TEXT_BYTES),
  };
}

export async function stageWorktreeFiles(worktreePath: string, body: GitStageBody): Promise<void> {
  if (!existsSync(path.join(worktreePath, '.git'))) throw conflict('project is not a git repository');
  const safePaths = (body.paths ?? []).map((p) => resolveSafeWorktreePath(worktreePath, p).rel);
  if (!body.all && safePaths.length === 0) throw badRequest('specify paths or all: true');

  if (body.unstage) {
    if (body.all) {
      await git(worktreePath, ['reset', '-q', 'HEAD', '--', '.']).catch(() => undefined);
    } else {
      await git(worktreePath, ['reset', '-q', 'HEAD', '--', ...safePaths]).catch(() => undefined);
    }
  } else if (body.all) {
    await git(worktreePath, ['add', '-A']);
  } else {
    await git(worktreePath, ['add', '--', ...safePaths]);
  }
}

export async function commitWorktree(
  worktreePath: string,
  branch: string | null,
  body: GitCommitBody,
): Promise<GitCommitResponse> {
  if (!existsSync(path.join(worktreePath, '.git'))) throw conflict('project is not a git repository');
  if (body.stageAll) {
    await git(worktreePath, ['add', '-A']);
  }
  try {
    await unstageScratchFiles(worktreePath);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw conflict(`could not unstage Emberline scratch files${stderr ? `: ${stderr}` : ''}`);
  }
  const staged = await git(worktreePath, ['diff', '--cached', '--name-only']);
  if (!staged) throw conflict('no changes staged to commit');

  const hasName = await git(worktreePath, ['config', 'user.name']).catch(() => '');
  const hasEmail = await git(worktreePath, ['config', 'user.email']).catch(() => '');
  const identityArgs: string[] = [];
  if (!hasName) identityArgs.push('-c', 'user.name=Emberline');
  if (!hasEmail) identityArgs.push('-c', 'user.email=emberline@local');

  try {
    const summary = await git(worktreePath, [...identityArgs, 'commit', '-m', body.message]);
    const sha = await git(worktreePath, ['rev-parse', '--short', 'HEAD']);
    return { sha, branch, summary };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw conflict(`git commit failed${stderr ? `: ${stderr}` : ''}`);
  }
}

/** The most of a push's output the run's page gets. */
const MAX_PUSH_OUTPUT = 4096;

export async function pushWorktreeBranch(
  worktreePath: string,
  branch: string | null,
  defaultBranch: string,
  account?: AccountRemote | null,
): Promise<GitPushResponse> {
  if (!existsSync(path.join(worktreePath, '.git'))) throw conflict('project is not a git repository');
  const currentBranch = (await git(worktreePath, ['branch', '--show-current']).catch(() => '')).trim();
  const targetBranch = currentBranch || branch;
  if (!targetBranch) throw conflict('run does not have a dedicated git branch');
  const protectedBranches = new Set([defaultBranch, 'main', 'master']);
  if (protectedBranches.has(targetBranch) || (branch && protectedBranches.has(branch))) {
    throw conflict(`refusing to push to protected/default branch "${targetBranch}"`);
  }
  const branchToPush = targetBranch;

  if (account) {
    // The account pushes the run's own branch only: an agent may have switched its worktree.
    if (!branch)
      throw conflict(
        'this run has no branch of its own; Emberline pushes only a run branch with the forge account',
      );
    if (currentBranch && currentBranch !== branch) {
      throw conflict(
        `refusing to push: the run's worktree is on "${currentBranch}", not on its branch "${branch}"`,
      );
    }
    let result: 'pushed' | 'rejected';
    try {
      result = await accountPushBranch(account, worktreePath, branch);
    } catch (error) {
      throw conflict(`git push failed: ${describeGitError(error, { credential: account.credential })}`);
    }
    if (result === 'rejected')
      throw conflict(`git push failed: the remote ${branch} has commits this run doesn't have`);
    // What `push -u` wrote before: the runner's git, no network.
    await git(worktreePath, ['config', `branch.${branch}.remote`, 'origin']).catch(() => undefined);
    await git(worktreePath, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`]).catch(
      () => undefined,
    );
    return { branch, remote: 'origin', output: `Pushed ${branch} to ${account.url}` };
  }

  const remoteUrl = await git(worktreePath, ['remote', 'get-url', 'origin']).catch(() => '');
  if (!remoteUrl) {
    throw conflict('no "origin" remote is configured for this repository');
  }
  // origin as configured (its push URL too): a token typed into it is masked wherever git quotes it.
  const pushUrl = await git(worktreePath, ['remote', 'get-url', '--push', 'origin']).catch(() => '');
  const known: KnownSecrets = { addresses: [remoteUrl, pushUrl] };

  try {
    const { stdout, stderr } = await execGitFile(
      [
        '-C',
        worktreePath,
        ...NO_SUBMODULES,
        'push',
        '--porcelain',
        '--no-recurse-submodules',
        '-u',
        'origin',
        `refs/heads/${branchToPush}:refs/heads/${branchToPush}`,
      ],
      { timeout: 60_000 },
    );
    // `remote:` lines are the server's: as bounded and redacted as a failure's.
    const output = redactGitText(`${stdout}\n${stderr}`.trim(), known).slice(0, MAX_PUSH_OUTPUT);
    return { branch: branchToPush, remote: 'origin', output: output || `Pushed ${branchToPush} to origin` };
  } catch (error) {
    // A refused repository config has no stderr: its message says what to remove.
    throw conflict(`git push failed: ${describeGitError(error, known)}`);
  }
}

function classifyArtifact(relPath: string): ArtifactKind {
  const ext = path.extname(relPath).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
  if (['.zip', '.har', '.trace'].includes(ext)) return 'trace';
  if (ext === '.log' || relPath.endsWith('-log.txt')) return 'log';
  if (['.md', '.html', '.pdf', '.txt', '.json'].includes(ext)) return 'document';
  return 'file';
}

async function walkRelativeFiles(root: string, subDir: string, out: Set<string>, depth = 0): Promise<void> {
  if (depth > 4 || out.size >= MAX_ARTIFACTS) return;
  const absDir = path.join(root, subDir);
  if (!existsSync(absDir)) return;
  const entries = await readdir(absDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.size >= MAX_ARTIFACTS) break;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const rel = path.posix.join(subDir, entry.name);
    if (entry.isDirectory()) {
      await walkRelativeFiles(root, rel, out, depth + 1);
    } else if (entry.isFile()) {
      out.add(rel);
    }
  }
}

/**
 * Lists artifacts (screenshots, traces, reports, and files created/modified during the run)
 * inside the run's worktree.
 */
export async function listWorktreeArtifacts(
  worktreePath: string,
  baseBranch: string,
): Promise<RunArtifact[]> {
  if (!existsSync(worktreePath)) return [];
  const candidates = new Set<string>();

  for (const dir of ARTIFACT_DIRS) {
    await walkRelativeFiles(worktreePath, dir, candidates);
  }

  if (existsSync(path.join(worktreePath, '.git'))) {
    const baseRef = await resolveBaseRef(worktreePath, baseBranch);
    const diffNames = await git(worktreePath, ['diff', '--name-only', baseRef]).catch(() => '');
    for (const line of diffNames.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) candidates.add(trimmed);
    }
    const statusMap = await readPorcelainStatus(worktreePath).catch(() => new Map<string, PorcelainEntry>());
    for (const filePath of statusMap.keys()) {
      candidates.add(filePath);
    }
  } else {
    await walkRelativeFiles(worktreePath, '', candidates, 2);
  }

  const artifacts: RunArtifact[] = [];
  for (const rel of candidates) {
    if (artifacts.length >= MAX_ARTIFACTS) break;
    try {
      const { abs, rel: safeRel } = resolveSafeWorktreePath(worktreePath, rel);
      const info = await stat(abs);
      if (!info.isFile()) continue;
      artifacts.push({
        path: safeRel,
        name: path.basename(safeRel),
        kind: classifyArtifact(safeRel),
        sizeBytes: info.size,
        mtime: info.mtime.toISOString(),
      });
    } catch {
      // Skip deleted or inaccessible paths
    }
  }

  const kindRank: Record<ArtifactKind, number> = { image: 0, trace: 1, log: 2, document: 3, file: 4 };
  return artifacts.sort(
    (a, b) => kindRank[a.kind] - kindRank[b.kind] || Date.parse(b.mtime) - Date.parse(a.mtime),
  );
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
};

/** Deliverables people install or flash, by extension (lowercase). */
const BUILD_OUTPUT_EXTENSIONS = new Set([
  '.apk',
  '.aab',
  '.ipa',
  '.appimage',
  '.deb',
  '.rpm',
  '.snap',
  '.flatpak',
  '.exe',
  '.msi',
  '.dmg',
  '.pkg',
  '.elf',
  '.hex',
  '.uf2',
]);
/** `.bin` is too generic on its own; it counts inside build output directories (firmware images). */
const FIRMWARE_BIN_DIR = /(^|\/)(\.pio\/build|build|firmware|out|dist)\//;
/** Dependency, cache and intermediate directories: never deliverables, and often huge. */
const BUILD_OUTPUT_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  '.gradle',
  'intermediates',
  'tmp',
  'generated',
  'kotlin',
  '.dart_tool',
  '.pub-cache',
  'Pods',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.turbo',
  '.cache',
  'libdeps',
  'deps',
  'incremental',
  '.fingerprint',
]);
const MAX_BUILD_OUTPUTS = 50;
const MAX_BUILD_OUTPUT_DIRS = 5000;

function isBuildOutput(rel: string): boolean {
  const ext = path.extname(rel).toLowerCase();
  if (BUILD_OUTPUT_EXTENSIONS.has(ext)) return true;
  return ext === '.bin' && FIRMWARE_BIN_DIR.test(rel);
}

/**
 * Deliverables a run produced (APKs, installers, firmware images) anywhere in its worktree, newest
 * first, including the ones in git-ignored build directories that a merge never carries to the main
 * workspace. Read-only: it only walks the worktree, and asks git which of them are tracked.
 */
export async function listBuildOutputs(worktreePath: string): Promise<RunBuildOutput[]> {
  if (!existsSync(worktreePath)) return [];
  const found: { rel: string; size: number; mtime: Date }[] = [];
  const queue: string[] = [''];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_BUILD_OUTPUT_DIRS) {
    const relDir = queue.shift() as string;
    visited += 1;
    const entries = await readdir(path.join(worktreePath, relDir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!BUILD_OUTPUT_SKIP_DIRS.has(entry.name)) queue.push(rel);
      } else if (entry.isFile() && isBuildOutput(rel)) {
        const info = await stat(path.join(worktreePath, rel)).catch(() => null);
        if (info) found.push({ rel, size: info.size, mtime: info.mtime });
      }
    }
  }
  found.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const outputs = found.slice(0, MAX_BUILD_OUTPUTS);
  let tracked = new Set<string>();
  if (outputs.length > 0 && existsSync(path.join(worktreePath, '.git'))) {
    const listed = await git(worktreePath, ['ls-files', '-z', '--', ...outputs.map((o) => o.rel)]).catch(
      () => '',
    );
    tracked = new Set(listed.split('\0').filter(Boolean));
  }
  return outputs.map((o) => ({
    path: o.rel,
    name: path.basename(o.rel),
    sizeBytes: o.size,
    mtime: o.mtime.toISOString(),
    tracked: tracked.has(o.rel),
  }));
}

export async function readWorktreeArtifact(
  worktreePath: string,
  relPath: string,
): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
  const { abs, rel } = resolveSafeWorktreePath(worktreePath, relPath);
  const info = await stat(abs).catch(() => null);
  if (!info?.isFile()) throw notFound('artifact not found');
  if (info.size > 25 * 1024 * 1024) throw conflict('artifact exceeds 25 MB preview limit');
  const buffer = await readFile(abs);
  const ext = path.extname(rel).toLowerCase();
  const contentType =
    MIME_BY_EXT[ext] ?? (isBinaryBuffer(buffer) ? 'application/octet-stream' : 'text/plain; charset=utf-8');
  return { buffer, contentType, fileName: path.basename(rel) };
}

/**
 * Safely removes a linked git worktree created for a run (`/workspaces/.worktrees/...`),
 * leaving the branch intact in the parent repository. Never touches the main project path.
 */
/** True when removing the worktree would lose uncommitted or untracked (non-ignored) changes. */
export async function worktreeHasUncommittedWork(worktreePath: string): Promise<boolean> {
  if (!existsSync(path.join(worktreePath, '.git'))) return false;
  const status = await git(worktreePath, ['status', '--porcelain']).catch(() => null);
  // Unreadable status: keep the worktree rather than guess.
  return status === null || status.trim().length > 0;
}

/**
 * True when the worktree's HEAD has commits that are not in the project's default branch, so
 * removing it would strand them on a branch nobody merged. Fail-closed: any git error (missing
 * default branch, unreadable repo) counts as unmerged.
 */
export async function worktreeHasUnmergedCommits(
  worktreePath: string,
  defaultBranch: string,
): Promise<boolean> {
  if (!existsSync(path.join(worktreePath, '.git'))) return false;
  try {
    await git(worktreePath, ['rev-parse', '--verify', '--quiet', `refs/heads/${defaultBranch}`]);
    const count = await git(worktreePath, ['rev-list', '--count', `refs/heads/${defaultBranch}..HEAD`]);
    return !/^\d+$/.test(count) || Number(count) > 0;
  } catch {
    return true;
  }
}

/** Caps for git's own files read from an agent-writable repository. */
const GIT_SMALL_FILE_MAX = 4 * 1024;
const PACKED_REFS_MAX = 1024 * 1024;
const GIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const GIT_REF = /^refs\/[A-Za-z0-9._/-]+$/;

/**
 * A file of git's under `dir`, read through one verified descriptor (no link, FIFO or device, no
 * symlinked parent; see {@link readWorktreeBytes}). Undefined when missing; null when refused,
 * over `max` bytes or unreadable.
 */
async function readGitFile(dir: string, rel: string, max: number): Promise<string | null | undefined> {
  try {
    const buf = await readWorktreeBytes(dir, rel, max);
    return buf ? buf.toString('utf8') : null;
  } catch (error) {
    return isMissing(error) && !(error instanceof UnsafePathError) ? undefined : null;
  }
}

/** The commit HEAD in `gitDir` names, refs read from `commonDir`; null for anything unexpected. */
async function headShaIn(gitDir: string, commonDir: string): Promise<string | null> {
  const head = (await readGitFile(gitDir, 'HEAD', GIT_SMALL_FILE_MAX))?.trim();
  if (!head) return null;
  if (!head.startsWith('ref: ')) return GIT_SHA.test(head) ? head : null;
  const ref = head.slice('ref: '.length).trim();
  if (!GIT_REF.test(ref) || ref.split('/').includes('..')) return null;
  const loose = await readGitFile(commonDir, ref, GIT_SMALL_FILE_MAX);
  if (loose === null) return null;
  if (loose !== undefined) {
    const sha = loose.trim();
    return GIT_SHA.test(sha) ? sha : null;
  }
  const packed = await readGitFile(commonDir, 'packed-refs', PACKED_REFS_MAX);
  if (!packed) return null;
  const sha = packed
    .split('\n')
    .find((l) => l.endsWith(` ${ref}`))
    ?.split(' ')[0];
  return sha && GIT_SHA.test(sha) ? sha : null;
}

/**
 * The commit a workspace has checked out, read from git's files without spawning git: the
 * project's main checkout (its `.git` directory) or, unless `linkedOnly`, also a linked worktree
 * whose gitdir lies under `<project>/.git/worktrees/`. The repository is agent-writable, so every
 * file goes through a verified, capped read and any other layout (a gitdir or commondir elsewhere,
 * odd ref names or shas, links, FIFOs) gives null.
 */
async function checkedOutSha(
  workspacePath: string,
  projectPath: string,
  linkedOnly: boolean,
): Promise<string | null> {
  try {
    const projectGit = path.join(await realpath(projectPath), '.git');
    if ((await realpath(projectGit)) !== projectGit) return null;
    const workspace = await realpath(workspacePath);
    const dotGit = await lstat(path.join(workspace, '.git'));
    if (dotGit.isDirectory()) {
      if (linkedOnly || path.join(workspace, '.git') !== projectGit) return null;
      return await headShaIn(projectGit, projectGit);
    }
    if (!dotGit.isFile()) return null;
    const pointer = await readGitFile(workspace, '.git', GIT_SMALL_FILE_MAX);
    const gitDirRel = pointer ? /^gitdir: (.+)$/m.exec(pointer)?.[1]?.trim() : undefined;
    if (!gitDirRel) return null;
    const gitDir = await realpath(path.resolve(workspace, gitDirRel));
    if (!gitDir.startsWith(path.join(projectGit, 'worktrees') + path.sep)) return null;
    const commonRel = (await readGitFile(gitDir, 'commondir', GIT_SMALL_FILE_MAX))?.trim();
    if (!commonRel) return null;
    if ((await realpath(path.resolve(gitDir, commonRel))) !== projectGit) return null;
    return await headShaIn(gitDir, projectGit);
  } catch {
    return null;
  }
}

/**
 * The commit a linked worktree of the project has checked out, read from git's files without
 * spawning git (cheap enough for a check every minute). Null when it cannot be read safely.
 */
export async function worktreeHeadSha(worktreePath: string, projectPath: string): Promise<string | null> {
  return checkedOutSha(worktreePath, projectPath, true);
}

/**
 * Like {@link worktreeHeadSha}, for the project's main checkout as well as a linked worktree:
 * cheap enough for every status poll. Null outside a git repository or when unsafe to read.
 */
export async function workspaceHeadSha(workspacePath: string, projectPath: string): Promise<string | null> {
  return checkedOutSha(workspacePath, projectPath, false);
}

export async function pruneWorktree(projectPath: string, worktreePath: string): Promise<boolean> {
  const resolvedProject = path.resolve(projectPath);
  const resolvedWorktree = path.resolve(worktreePath);
  if (
    resolvedWorktree === resolvedProject ||
    !resolvedWorktree.includes(`${path.sep}.worktrees${path.sep}`)
  ) {
    throw conflict('cannot prune the main project directory; only linked run worktrees can be pruned');
  }
  if (!existsSync(resolvedWorktree)) {
    await git(resolvedProject, ['worktree', 'prune']).catch(() => undefined);
    return false;
  }
  try {
    await git(resolvedProject, ['worktree', 'remove', '--force', resolvedWorktree]);
  } catch {
    await rm(resolvedWorktree, { recursive: true, force: true });
    await git(resolvedProject, ['worktree', 'prune']).catch(() => undefined);
  }
  return true;
}
