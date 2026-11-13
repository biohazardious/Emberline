/**
 * A read of all of origin: every branch's commit, kept as `refs/remotes/origin/<branch>`, and the
 * tags this project lacks, created as origin has them. The network part (one ls-remote, then one
 * fetch of the objects that are missing) runs outside the main-workspace lock; the ref writes run
 * under it, compare-and-set, and only for what changed. A local tag is never moved or deleted.
 */
import { createHash } from 'node:crypto';
import { isRunnerUnavailable } from '../command-exec.js';
import { HttpError } from '../errors.js';
import { execGitFile } from '../git-exec.js';
import {
  fetchBranchObjects,
  fetchRefObjects,
  hasRealCommit,
  type OriginRefs,
  realGit,
  type RemoteAccess,
  unlessRunnerUnavailable,
} from './git.js';

/**
 * Branches and tags fetched in one read beyond the ones the read needs (main and the working
 * branch). The writes run under the main-workspace lock, one git call each, so a first read of a
 * repository with hundreds of them takes them over a few reads instead of holding the lock long.
 */
export const MAX_NEW_REFS_PER_READ = 100;
/** Refspecs per fetch: a long list stays well within a command line. */
const FETCH_CHUNK = 100;
/** The tags that differ from origin's kept for the Git page, at most. */
const DIFFERING_KEPT = 100;

/**
 * How long origin's other branches and tags are left alone after their fetch failed, unless the
 * refs to fetch change first: a fetch that keeps failing would otherwise run on every read (every
 * 2 minutes) while it holds the project's remote-ops queue.
 */
export const UNREAD_BACKOFF_MS = 30 * 60_000;

/** The last fetch of origin's other branches and tags that failed: when, and what it fetched. */
export interface UnreadRefs {
  at: string;
  /** A digest of the refs and commits it asked for: other refs to fetch mean a new try. */
  key: string;
}

/** What one read brought in, ready to be written under the lock. */
export interface OriginObjects {
  /** origin's branches whose commits are here now, by name. */
  branches: Map<string, string>;
  /** origin's tags this project lacked, whose objects are here now. */
  newTags: Map<string, string>;
  /** Set while some of origin's branches or tags (not main or the working branch) could not be fetched. */
  unread: UnreadRefs | null;
}

/** The refs under `prefix` (`refs/remotes/origin/`, `refs/tags/`) with what each names, by the rest of the name. */
async function refsUnder(mainPath: string, prefix: string): Promise<Map<string, string>> {
  const out = (await realGit(['for-each-ref', '--format=%(refname)%00%(objectname)', prefix], mainPath))
    .stdout;
  const refs = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [ref, oid] = line.split('\0');
    if (!ref?.startsWith(prefix) || !oid) continue;
    const name = ref.slice(prefix.length);
    // origin's HEAD (a clone's symbolic ref) is no branch of origin's.
    if (name && !(prefix === 'refs/remotes/origin/' && name === 'HEAD')) refs.set(name, oid);
  }
  return refs;
}

/**
 * The commit each local tag names (an annotated tag's peeled one level, `%(*objectname)`, as
 * origin's `^{}` line peels it), by name.
 */
async function tagCommitsHere(mainPath: string): Promise<Map<string, string>> {
  const out = (
    await realGit(
      ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)', 'refs/tags/'],
      mainPath,
    )
  ).stdout;
  const commits = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [ref, oid, peeled] = line.split('\0');
    if (ref?.startsWith('refs/tags/') && oid) commits.set(ref.slice('refs/tags/'.length), peeled || oid);
  }
  return commits;
}

const hasRealObject = (mainPath: string, oid: string) =>
  realGit(['cat-file', '-e', oid], mainPath).then(() => true, unlessRunnerUnavailable(false));

/**
 * A tag named like a branch here or on origin is never created: beside a branch of the same name,
 * git's short names turn ambiguous (`main` reads as `heads/main`), which every reader of a branch
 * name would trip over.
 */
const namedLikeBranch = (name: string, refs: OriginRefs, localBranches: Map<string, string>) =>
  refs.branches.has(name) || localBranches.has(name);

/** Version-like names newest first (v0.10.0 before v0.9.0), so a capped read takes the latest tags. */
const newestFirst = (a: string, b: string) => b.localeCompare(a, 'en', { numeric: true });

/**
 * Outside the lock: the objects of origin's branches and new tags that are not here yet, in one
 * fetch (no ref written). `needed` (main and the working branch) always come; others up to
 * {@link MAX_NEW_REFS_PER_READ}, the rest in the next reads. A branch or tag that origin moved or
 * dropped since it was listed is left out of this read; one that `needed` names is the read's
 * failure (`remote_moved`), as before.
 */
export async function bringOriginObjects(
  mainPath: string,
  access: RemoteAccess,
  refs: OriginRefs,
  needed: readonly string[],
  /** The last failed fetch of the other refs: within {@link UNREAD_BACKOFF_MS}, the same refs are not tried again. */
  lastUnread: UnreadRefs | null = null,
  now = Date.now(),
): Promise<OriginObjects> {
  const [tracked, localTags, localBranches] = await Promise.all([
    refsUnder(mainPath, 'refs/remotes/origin/'),
    refsUnder(mainPath, 'refs/tags/'),
    refsUnder(mainPath, 'refs/heads/'),
  ]);
  const branches = new Map<string, string>();
  const newTags = new Map<string, string>();
  const missing: { ref: string; name: string; oid: string; tag: boolean }[] = [];
  let budget = MAX_NEW_REFS_PER_READ;
  const order = [
    ...needed.filter((name) => refs.branches.has(name)),
    ...[...refs.branches.keys()].filter((name) => !needed.includes(name)),
  ];
  for (const name of order) {
    const oid = refs.branches.get(name)!;
    // Unchanged since the last read: its commit is here already.
    if (tracked.get(name) === oid) {
      branches.set(name, oid);
      continue;
    }
    if (!needed.includes(name) && budget-- <= 0) continue;
    if (await hasRealCommit(mainPath, oid)) branches.set(name, oid);
    else missing.push({ ref: `refs/heads/${name}`, name, oid, tag: false });
  }
  for (const name of [...refs.tags.keys()].sort(newestFirst)) {
    if (localTags.has(name) || namedLikeBranch(name, refs, localBranches) || budget-- <= 0) continue;
    const oid = refs.tags.get(name)!;
    if (await hasRealObject(mainPath, oid)) newTags.set(name, oid);
    else missing.push({ ref: `refs/tags/${name}`, name, oid, tag: true });
  }
  if (missing.length === 0) return { branches, newTags, unread: null };

  const isNeeded = (m: (typeof missing)[number]) => !m.tag && needed.includes(m.name);
  const optional = missing.filter((m) => !isNeeded(m));
  const key = createHash('sha256')
    .update(
      optional
        .map((m) => `${m.ref} ${m.oid}`)
        .sort()
        .join('\n'),
    )
    .digest('hex')
    .slice(0, 32);
  // The same refs failed a short while ago: only what the read needs is fetched this time.
  const waiting =
    optional.length > 0 &&
    lastUnread !== null &&
    lastUnread.key === key &&
    now - Date.parse(lastUnread.at) < UNREAD_BACKOFF_MS;
  const toFetch = waiting ? missing.filter(isNeeded) : missing;
  let unread: UnreadRefs | null = waiting ? lastUnread : null;
  try {
    for (let i = 0; i < toFetch.length; i += FETCH_CHUNK)
      await fetchRefObjects(
        mainPath,
        access,
        toFetch.slice(i, i + FETCH_CHUNK).map((m) => m.ref),
      );
  } catch (error) {
    if (isRunnerUnavailable(error)) throw error;
    // A ref origin dropped since the listing, or one the forge will not send, fails the whole fetch:
    // the branches the read needs are fetched alone then (their own failure is the read's), and the
    // rest are left alone for a while.
    if (optional.length > 0) unread = { at: new Date(now).toISOString(), key };
    for (const m of missing) if (isNeeded(m)) await fetchBranchObjects(mainPath, access, m.name, m.oid);
  }
  for (const m of missing) {
    const here = m.tag ? await hasRealObject(mainPath, m.oid) : await hasRealCommit(mainPath, m.oid);
    if (here) (m.tag ? newTags : branches).set(m.name, m.oid);
    else if (!m.tag && needed.includes(m.name))
      throw new HttpError(
        409,
        'remote_moved',
        `origin's ${m.name} changed while Emberline read it. Press Refresh again.`,
      );
  }
  return { branches, newTags, unread };
}

/**
 * Under the main-workspace lock: the tracking refs of branches origin no longer has removed, each
 * `refs/remotes/origin/<branch>` that changed set to what origin named, and the new tags created
 * (compare-and-set: one that appeared meanwhile is left as it is). A write of `needed` that fails is
 * the read's failure; any other is skipped (a name that clashes with another ref, say). Returns the
 * tags here on another commit than origin's tag of the same name (compared by commit, so the
 * lightweight and the annotated tag of one commit match), and origin's tags that are named like a
 * branch (never created here).
 */
export async function writeOriginRefs(
  mainPath: string,
  refs: OriginRefs,
  objects: OriginObjects,
  needed: readonly string[],
): Promise<{ tagsDiffer: string[]; tagsNamedLikeBranches: string[] }> {
  const inMain = { cwd: mainPath };
  const tracked = await refsUnder(mainPath, 'refs/remotes/origin/');
  // The branches gone from origin go first: one named like a new branch's folder (`develop/x` when
  // origin now has `develop`) would block that branch's write.
  for (const [name, old] of tracked) {
    if (refs.branches.has(name)) continue;
    await execGitFile(
      ['update-ref', '-m', 'emberline: gone from origin', '-d', `refs/remotes/origin/${name}`, old],
      inMain,
    ).catch(unlessRunnerUnavailable(undefined));
  }
  for (const [name, oid] of objects.branches) {
    const old = tracked.get(name);
    if (old === oid) continue;
    try {
      await execGitFile(
        ['update-ref', '-m', 'emberline: origin read', `refs/remotes/origin/${name}`, oid, old ?? ''],
        inMain,
      );
    } catch (error) {
      if (isRunnerUnavailable(error) || needed.includes(name)) throw error;
    }
  }
  const [localTags, localBranches] = await Promise.all([
    refsUnder(mainPath, 'refs/tags/'),
    refsUnder(mainPath, 'refs/heads/'),
  ]);
  for (const [name, oid] of objects.newTags) {
    // A branch of that name made since the objects were brought in counts too.
    if (localTags.has(name) || namedLikeBranch(name, refs, localBranches)) continue;
    // The empty old value makes this a create: a tag made here meanwhile is never moved.
    const made = await execGitFile(
      ['update-ref', '-m', 'emberline: tag from origin', `refs/tags/${name}`, oid, ''],
      inMain,
    ).then(() => true, unlessRunnerUnavailable(false));
    if (made) localTags.set(name, oid);
  }
  const likeBranches = [...refs.tags.keys()]
    .filter((name) => namedLikeBranch(name, refs, localBranches))
    .sort()
    .slice(0, DIFFERING_KEPT);
  // Compared by the commit each names: a lightweight tag here and an annotated one on origin (or
  // the other way round) on the same commit are the same tag, not one that differs.
  const commitsHere = await tagCommitsHere(mainPath);
  const tagsDiffer = [...refs.tagCommits]
    .filter(
      ([name, commit]) =>
        !likeBranches.includes(name) && commitsHere.has(name) && commitsHere.get(name) !== commit,
    )
    .map(([name]) => name)
    .sort(newestFirst)
    .slice(0, DIFFERING_KEPT);
  return { tagsDiffer, tagsNamedLikeBranches: likeBranches };
}
