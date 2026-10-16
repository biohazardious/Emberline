import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
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
import { execGitFile } from '../git-exec.js';


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

  const [numstatOut, nameStatusOut] = await Promise.all([
    gitRaw(worktreePath, [...diffArgs, '--numstat']),
    gitRaw(worktreePath, [...diffArgs, '--name-status']),
  ]);

  const statusByPath = new Map<string, { status: DiffFileStatus; oldPath: string | null }>();
  for (const line of nameStatusOut.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0] ?? 'M';
    if (code.startsWith('R') && parts[1] && parts[2]) {
      statusByPath.set(parts[2], { status: 'renamed', oldPath: parts[1] });
    } else if (parts[1]) {
      statusByPath.set(parts[1], { status: statusFromCode(code), oldPath: null });
    }
  }

  const filesByPath = new Map<string, DiffFile>();
  for (const line of numstatOut.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const addRaw = parts[0] ?? '0';
    const delRaw = parts[1] ?? '0';
    const pathPart = parts.slice(2).join('\t');
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
          const abs = path.join(worktreePath, filePath);
          const info = await stat(abs);
          if (info.isFile() && info.size <= MAX_TEXT_BYTES) {
            const buf = await readFile(abs);
            if (!isBinaryBuffer(buf)) additions = countLines(buf.toString('utf8'));
          }
        } catch {
          // Ignore unreadable untracked file
        }
        filesByPath.set(filePath, {
          path: filePath,
          oldPath: null,
          status: 'untracked',
          additions,
          deletions: 0,
          staged: false,
          unstaged: true,
        });
      }
    }
  }

  const files = [...filesByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
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

async function readGitBlob(worktreePath: string, spec: string): Promise<{ text: string; binary: boolean } | null> {
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
    origBlob = (await readGitBlob(worktreePath, `:${rel}`)) ?? (await readGitBlob(worktreePath, `HEAD:${rel}`));
    modBlob = await readWorktreeFile(abs);
    patch = await gitRaw(worktreePath, ['diff', '--', rel]).catch(() => '');
  } else {
    origBlob = await readGitBlob(worktreePath, `${baseRef}:${rel}`);
    modBlob = await readWorktreeFile(abs);
    patch = await gitRaw(worktreePath, ['diff', baseRef, '--', rel]).catch(() => '');
  }

  const binary = Boolean(origBlob?.binary || modBlob?.binary);
  const status: DiffFileStatus = !origBlob && modBlob ? 'added' : origBlob && !modBlob ? 'deleted' : 'modified';

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

export async function pushWorktreeBranch(
  worktreePath: string,
  branch: string | null,
  defaultBranch: string,
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

  const remoteUrl = await git(worktreePath, ['remote', 'get-url', 'origin']).catch(() => '');
  if (!remoteUrl) {
    throw conflict('no "origin" remote is configured for this repository');
  }

  try {
    const { stdout, stderr } = await execGitFile(
      ['-C', worktreePath, 'push', '--porcelain', '-u', 'origin', `refs/heads/${branchToPush}:refs/heads/${branchToPush}`],
      {
        timeout: 60_000,
      },
    );
    return {
      branch: branchToPush,
      remote: 'origin',
      output: `${stdout}\n${stderr}`.trim() || `Pushed ${branchToPush} to origin`,
    };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw conflict(`git push failed${stderr ? `: ${stderr}` : ''}`);
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
export async function listWorktreeArtifacts(worktreePath: string, baseBranch: string): Promise<RunArtifact[]> {
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
  return artifacts.sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || Date.parse(b.mtime) - Date.parse(a.mtime));
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
  '.apk', '.aab', '.ipa', '.appimage', '.deb', '.rpm', '.snap', '.flatpak', '.exe', '.msi', '.dmg', '.pkg',
  '.elf', '.hex', '.uf2',
]);
/** `.bin` is too generic on its own; it counts inside build output directories (firmware images). */
const FIRMWARE_BIN_DIR = /(^|\/)(\.pio\/build|build|firmware|out|dist)\//;
/** Dependency, cache and intermediate directories: never deliverables, and often huge. */
const BUILD_OUTPUT_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.pnpm-store', '.gradle', 'intermediates', 'tmp', 'generated', 'kotlin',
  '.dart_tool', '.pub-cache', 'Pods', '.venv', 'venv', '__pycache__', '.next', '.turbo', '.cache',
  'libdeps', 'deps', 'incremental', '.fingerprint',
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
    const listed = await git(worktreePath, ['ls-files', '-z', '--', ...outputs.map((o) => o.rel)]).catch(() => '');
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
  const contentType = MIME_BY_EXT[ext] ?? (isBinaryBuffer(buffer) ? 'application/octet-stream' : 'text/plain; charset=utf-8');
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
export async function worktreeHasUnmergedCommits(worktreePath: string, defaultBranch: string): Promise<boolean> {
  if (!existsSync(path.join(worktreePath, '.git'))) return false;
  try {
    await git(worktreePath, ['rev-parse', '--verify', '--quiet', `refs/heads/${defaultBranch}`]);
    const count = await git(worktreePath, ['rev-list', '--count', `refs/heads/${defaultBranch}..HEAD`]);
    return !/^\d+$/.test(count) || Number(count) > 0;
  } catch {
    return true;
  }
}

/**
 * The commit a linked worktree has checked out, read from git's files without spawning git (cheap
 * enough for a check every minute). Null when it cannot be read.
 */
export async function worktreeHeadSha(worktreePath: string): Promise<string | null> {
  try {
    const dotGit = await readFile(path.join(worktreePath, '.git'), 'utf8');
    const gitDir = /^gitdir: (.+)$/m.exec(dotGit)?.[1]?.trim();
    if (!gitDir) return null;
    const dir = path.resolve(worktreePath, gitDir);
    const head = (await readFile(path.join(dir, 'HEAD'), 'utf8')).trim();
    if (!head.startsWith('ref: ')) return head || null;
    const ref = head.slice('ref: '.length);
    const common = path.resolve(
      dir,
      (await readFile(path.join(dir, 'commondir'), 'utf8').catch(() => '.')).trim(),
    );
    const loose = await readFile(path.join(common, ref), 'utf8').catch(() => null);
    if (loose !== null) return loose.trim() || null;
    const packed = await readFile(path.join(common, 'packed-refs'), 'utf8').catch(() => '');
    const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
    return line?.split(' ')[0] ?? null;
  } catch {
    return null;
  }
}

export async function pruneWorktree(projectPath: string, worktreePath: string): Promise<boolean> {
  const resolvedProject = path.resolve(projectPath);
  const resolvedWorktree = path.resolve(worktreePath);
  if (resolvedWorktree === resolvedProject || !resolvedWorktree.includes(`${path.sep}.worktrees${path.sep}`)) {
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

