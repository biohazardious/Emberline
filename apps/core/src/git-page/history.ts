import type {
  GitCommitDetail,
  GitCommitsPage,
  GitCommitSummary,
  GitCompare,
  GitFileChange,
  GitFileDiff,
  GitRefLabel,
} from '@emberline/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { readRepositorySettings, workingBranchOf } from '../db/project-settings.js';
import { tickets } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import { commitIdentityFor } from '../factory/commit-identity.js';
import { isRunnerUnavailable } from '../command-exec.js';
import { realGit } from '../repository/git.js';
import { FULL_OID } from '../repository/service.js';
import { resolveSafeWorktreePath } from '../runs/git.js';

export const COMMITS_PAGE = 50;
/** Each side of a file diff is sent up to this size; a bigger side is left out and the diff says so. */
const SIDE_CAP = 1024 * 1024;
/** Git's own rule for "this is binary": a NUL byte in the first 8000 bytes. */
const BINARY_PROBE = 8000;

const CONVENTIONAL_KEY = /^\w+\(([A-Z][A-Z0-9]*-\d+)\)!?:/;
const MERGE_KEY = /^Merge ([A-Z][A-Z0-9]*-\d+) \(/;

/** The ticket key in a commit subject: `feat(EMB-4): …` or the factory's `Merge EMB-4 (…)`. */
export function ticketKeyOf(subject: string): string | null {
  return CONVENTIONAL_KEY.exec(subject)?.[1] ?? MERGE_KEY.exec(subject)?.[1] ?? null;
}

const isFactoryMerge = (subject: string) => MERGE_KEY.test(subject);

/**
 * Whether `name` is a plain ref name by git's own rules (`git check-ref-format`), so that a revision
 * expression such as `main~3`, `main^`, `main@{1}` or `a..b` is never taken for a ref.
 */
export function isPlainRefName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name) || name.includes('..') || name.includes('@{')) return false;
  if (name === '@' || name.startsWith('/') || name.endsWith('/') || name.includes('//')) return false;
  if (name.endsWith('.')) return false;
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

/**
 * A git command that exits with `codes` found nothing (no such ref, no merge base) and reads as
 * `fallback`; any other failure (the runner, an output over the cap, a crash) is thrown, never
 * shown as an empty answer.
 */
export const absentWhen =
  <T>(fallback: T, ...codes: number[]) =>
  (error: unknown): T => {
    const code = (error as { code?: unknown } | null)?.code;
    if (!isRunnerUnavailable(error) && typeof code === 'number' && codes.includes(code)) return fallback;
    throw error;
  };

/** The branches a ref may be given as, in the order they are tried. */
const REF_NAMESPACES = ['refs/heads/', 'refs/tags/', 'refs/emberline/backup/'];

/**
 * The commit a ref names: a local branch, a tag, a backup ref or a full commit id. Anything else
 * (an abbreviation, `HEAD~3`, `main^`, `main@{1}`, an option) is not a ref the Git page reads.
 */
export async function resolveRef(mainPath: string, ref: string): Promise<string> {
  if (!ref || ref.startsWith('-') || (!FULL_OID.test(ref) && !isPlainRefName(ref))) {
    throw badRequest('Choose a branch, a tag or a full commit id.');
  }
  const candidates = FULL_OID.test(ref)
    ? [ref]
    : ref.startsWith('refs/')
      ? REF_NAMESPACES.some((ns) => ref.startsWith(ns))
        ? [ref]
        : []
      : REF_NAMESPACES.map((ns) => `${ns}${ref}`);
  for (const candidate of candidates) {
    const out = await realGit(
      ['rev-parse', '--verify', '--end-of-options', `${candidate}^{commit}`],
      mainPath,
    ).then((r) => r.stdout.trim(), absentWhen('', 1, 128));
    if (out) return out;
  }
  throw notFound(`There is no branch, tag or commit "${ref}" in this repository.`);
}

/** A commit id from a URL: always the full id, because an abbreviation can be made to collide. */
export async function resolveCommitId(mainPath: string, sha: string): Promise<string> {
  if (!FULL_OID.test(sha)) throw badRequest('Use the full commit id, not an abbreviation.');
  return resolveRef(mainPath, sha);
}

/** The path inside the tree, or a 400: no `..`, no leading `-`, nothing absolute, nothing under `.git/`. */
export function safeTreePath(mainPath: string, path: string): string {
  return resolveSafeWorktreePath(mainPath, path).rel;
}

/** Every ref's labels, by commit id. One `for-each-ref`, tags peeled to the commit they point at. */
export async function refLabels(
  mainPath: string,
  working: string,
  main: string,
): Promise<Map<string, GitRefLabel[]>> {
  const out = await realGit(
    ['for-each-ref', '--format=%(objectname) %(*objectname) %(refname)'],
    mainPath,
  ).then((r) => r.stdout);
  const labels = new Map<string, GitRefLabel[]>();
  const add = (sha: string, label: GitRefLabel) => {
    const list = labels.get(sha) ?? [];
    list.push(label);
    labels.set(sha, list);
  };
  for (const line of out.split('\n')) {
    // An unpeeled ref has an empty second field, so the line holds two spaces in a row.
    const match = /^(\S+) (\S*) (.+)$/.exec(line);
    if (!match) continue;
    const [, object, peeled, ref] = match as unknown as [string, string, string, string];
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice('refs/heads/'.length);
      // Main as the working branch is one label, not the same name twice.
      if (name === working) add(object, { kind: 'working', name });
      else if (name === main) add(object, { kind: 'main', name });
      else add(object, { kind: 'branch', name });
    } else if (ref.startsWith('refs/tags/')) {
      add(peeled || object, { kind: 'tag', name: ref.slice('refs/tags/'.length) });
    } else if (ref.startsWith('refs/remotes/origin/')) {
      const name = ref.slice('refs/remotes/origin/'.length);
      if (name !== 'HEAD') add(object, { kind: 'origin', name: `origin/${name}` });
    } else if (ref.startsWith('refs/emberline/backup/')) {
      add(object, { kind: 'backup', name: ref.slice('refs/emberline/backup/'.length) });
    }
  }
  return labels;
}

export async function listCommits(
  db: Db,
  project: { id: string; path: string; defaultBranch: string },
  ref: string,
  cursor: number,
): Promise<GitCommitsPage> {
  const tip = await resolveRef(project.path, ref);
  const settings = readRepositorySettings(db, project.id);
  const working = workingBranchOf(settings, project.defaultBranch);
  const out = await realGit(
    [
      'log',
      '--no-show-signature',
      `--skip=${cursor}`,
      `-n`,
      String(COMMITS_PAGE + 1),
      '--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%s',
      tip,
      '--',
    ],
    project.path,
  ).then((r) => r.stdout);
  const rows = out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\0') as [string, string, string, string, string, string, string]);
  const keys = [...new Set(rows.map((row) => ticketKeyOf(row[6])).filter((k): k is string => k !== null))];
  const ticketIds = new Map<string, string>();
  if (keys.length > 0) {
    for (const t of db
      .select({ id: tickets.id, key: tickets.key })
      .from(tickets)
      .where(and(eq(tickets.projectId, project.id), inArray(tickets.key, keys)))
      .all()) {
      ticketIds.set(t.key, t.id);
    }
  }
  const labels = await refLabels(project.path, working, project.defaultBranch);
  const factoryEmail = commitIdentityFor(db, project.id).email;
  const pulled = new Set(settings.pulledOids);
  const commits: GitCommitSummary[] = rows
    .slice(0, COMMITS_PAGE)
    .map(([sha, shortSha, parents, authorName, authorEmail, authoredAt, subject]) => {
      const ticketKey = ticketKeyOf(subject);
      return {
        sha,
        shortSha,
        subject,
        authorName,
        authorEmail,
        authoredAt,
        parents: parents ? parents.split(' ') : [],
        byFactory: authorEmail === factoryEmail || isFactoryMerge(subject),
        ticketKey,
        ticketId: ticketKey ? (ticketIds.get(ticketKey) ?? null) : null,
        labels: labels.get(sha) ?? [],
        fromOrigin: pulled.has(sha),
      };
    });
  return {
    ref,
    commits,
    nextCursor: rows.length > COMMITS_PAGE ? cursor + COMMITS_PAGE : null,
  };
}

const STATUS = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified' } as const;

/** The files that differ between `from` (null: nothing, for a root commit) and `to`. */
async function changedFiles(mainPath: string, from: string | null, to: string): Promise<GitFileChange[]> {
  const base = from === null ? ['diff-tree', '-r', '--root', '--no-commit-id', to] : ['diff', from, to];
  const common = ['-M', '--no-ext-diff', '--no-textconv', '-z'];
  const run = (flag: string) =>
    realGit([...base.slice(0, 1), ...common, flag, ...base.slice(1), '--'], mainPath).then((r) => r.stdout);
  const [names, counts] = await Promise.all([run('--name-status'), run('--numstat')]);

  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const numstat = counts.split('\0');
  for (let i = 0; i < numstat.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(numstat[i] ?? '');
    if (!m) continue;
    const binary = m[1] === '-';
    const entry = { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary };
    if (m[3] === '') {
      // A rename: the next two fields are the old and the new path.
      stats.set(numstat[i + 2] ?? '', entry);
      i += 2;
    } else {
      stats.set(m[3] as string, entry);
    }
  }

  const files: GitFileChange[] = [];
  const fields = names.split('\0');
  for (let i = 0; i + 1 < fields.length;) {
    const code = fields[i] as string;
    const letter = code[0] as keyof typeof STATUS;
    const renamed = letter === 'R' || letter === 'C';
    const oldPath = renamed ? (fields[i + 1] as string) : null;
    const path = (renamed ? fields[i + 2] : fields[i + 1]) as string;
    i += renamed ? 3 : 2;
    const stat = stats.get(path) ?? { additions: 0, deletions: 0, binary: false };
    files.push({
      path,
      oldPath: letter === 'R' ? oldPath : null,
      status: STATUS[letter] ?? 'modified',
      ...stat,
    });
  }
  return files;
}

async function parentsOf(mainPath: string, sha: string): Promise<string[]> {
  // The commit exists (the caller resolved it), so a failure here is a real one; a root commit
  // simply has an empty parent list.
  const out = await realGit(
    ['log', '-n', '1', '--no-show-signature', '--format=%P', sha, '--'],
    mainPath,
  ).then((r) => r.stdout.trim());
  return out ? out.split(' ') : [];
}

export async function commitDetail(mainPath: string, sha: string): Promise<GitCommitDetail> {
  const oid = await resolveCommitId(mainPath, sha);
  const message = await realGit(
    ['log', '-n', '1', '--no-show-signature', '--format=%B', oid, '--'],
    mainPath,
  ).then((r) => r.stdout.replace(/\s+$/, ''));
  const parents = await parentsOf(mainPath, oid);
  return { sha: oid, message, parents, files: await changedFiles(mainPath, parents[0] ?? null, oid) };
}

/** One side of a diff, straight from the git objects: empty when the file is not there. */
async function readSide(
  mainPath: string,
  rev: string | null,
  path: string,
): Promise<{ text: string; binary: boolean; truncated: boolean }> {
  const empty = { text: '', binary: false, truncated: false };
  if (rev === null) return empty;
  // Decide "not there" explicitly: ls-tree prints nothing for a path the tree lacks and fails for
  // anything else, so a git failure below is never read as an absent file.
  const entry = await realGit(['ls-tree', '-z', rev, '--', path], mainPath).then((r) => r.stdout);
  if (!/^\d+ blob /.test(entry)) return empty;
  const size = Number((await realGit(['cat-file', '-s', `${rev}:${path}`], mainPath)).stdout.trim());
  if (size > SIDE_CAP) return { text: '', binary: false, truncated: true };
  const text = (await realGit(['cat-file', 'blob', `${rev}:${path}`], mainPath)).stdout;
  if (text.slice(0, BINARY_PROBE).includes('\0')) return { text: '', binary: true, truncated: false };
  return { text, binary: false, truncated: false };
}

async function fileDiff(
  mainPath: string,
  from: string | null,
  to: string,
  rawPath: string,
): Promise<GitFileDiff> {
  const path = safeTreePath(mainPath, rawPath);
  const change = (await changedFiles(mainPath, from, to)).find((f) => f.path === path);
  const [original, modified] = await Promise.all([
    change?.status === 'added'
      ? readSide(mainPath, null, path)
      : readSide(mainPath, from, change?.oldPath ?? path),
    change?.status === 'deleted' ? readSide(mainPath, null, path) : readSide(mainPath, to, path),
  ]);
  return {
    path,
    original: original.text,
    modified: modified.text,
    binary: original.binary || modified.binary,
    truncated: original.truncated || modified.truncated,
  };
}

export async function commitFileDiff(mainPath: string, sha: string, path: string): Promise<GitFileDiff> {
  const oid = await resolveCommitId(mainPath, sha);
  const parents = await parentsOf(mainPath, oid);
  return fileDiff(mainPath, parents[0] ?? null, oid, path);
}

/** Three-dot: what `head` has that its merge base with `base` does not. */
async function compareSides(mainPath: string, base: string, head: string) {
  const [baseOid, headOid] = [await resolveRef(mainPath, base), await resolveRef(mainPath, head)];
  const mergeBase = await realGit(['merge-base', baseOid, headOid], mainPath).then(
    (r) => r.stdout.trim() || null,
    absentWhen(null, 1),
  );
  return { baseOid, headOid, mergeBase };
}

const countRange = (mainPath: string, range: string) =>
  realGit(['rev-list', '--count', range, '--'], mainPath).then((r) => Number(r.stdout.trim()) || 0);

export async function compareRefs(mainPath: string, base: string, head: string): Promise<GitCompare> {
  const { baseOid, headOid, mergeBase } = await compareSides(mainPath, base, head);
  const [ahead, behind, files] = await Promise.all([
    countRange(mainPath, `${baseOid}..${headOid}`),
    countRange(mainPath, `${headOid}..${baseOid}`),
    changedFiles(mainPath, mergeBase ?? baseOid, headOid),
  ]);
  return { base, head, mergeBase, ahead, behind, files };
}

export async function compareFileDiff(
  mainPath: string,
  base: string,
  head: string,
  path: string,
): Promise<GitFileDiff> {
  const { baseOid, headOid, mergeBase } = await compareSides(mainPath, base, head);
  return fileDiff(mainPath, mergeBase ?? baseOid, headOid, path);
}
