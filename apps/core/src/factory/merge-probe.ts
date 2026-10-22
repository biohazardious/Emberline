import { execGitFile } from '../git-exec.js';

export interface ConflictFile {
  /** Repository-relative path. */
  path: string;
  /** 'add/add' | 'content' | 'modify/delete' | 'file/directory' | … (git's own wording), or 'unknown' when no message names the path. */
  kind: string;
}

export interface MergeProbe {
  ok: true;
  mainHead: string;
  branchHead: string;
  conflicts: readonly ConflictFile[];
}

export type MergeProbeResult = MergeProbe | { ok: false; error: string };

const CACHE_LIMIT = 200;
const cache = new Map<string, MergeProbe>();

export interface Superseding {
  key: string;
  files: number;
}
/** findSuperseding results by main head, own key and add/add paths: main's history at a head never changes. */
const supersedingCache = new Map<string, Superseding | null>();

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  while (map.size > CACHE_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** The path as a whole word of a message: after the start or a space, before a space or punctuation. */
const at = (p: string) => new RegExp(`(?:^|\\s)${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s.,;:~]|$)`);

/**
 * Parses `git merge-tree --write-tree --name-only --messages` output: the tree id, the conflicted
 * paths (one per line), an empty line, then the informational messages. Clean merges print the
 * tree id only. The kind of each path comes from its `CONFLICT (kind): …` message.
 */
export function parseMergeTree(stdout: string): ConflictFile[] {
  const lines = stdout.split('\n');
  const paths: string[] = [];
  let i = 1; // line 0 is the tree id
  for (; i < lines.length && lines[i] !== ''; i++) paths.push(lines[i]!);

  const kinds = new Map<string, string>();
  for (const line of lines.slice(i + 1)) {
    const m = /^CONFLICT \(([^)]+)\): (.*)$/.exec(line);
    if (!m) continue;
    const kind = m[1]!;
    const rest = m[2]!;
    const inFile = /^Merge conflict in (.+)$/.exec(rest);
    if (inFile) {
      kinds.set(inFile[1]!, kind);
      continue;
    }
    // Other kinds name their paths inside the text: "d deleted in br and modified in main. …",
    // "directory in the way of d from main; …". Longest paths first, so `a.ts` is not read as `a`.
    let left = rest;
    for (const p of [...paths].sort((a, b) => b.length - a.length)) {
      const hit = at(p).exec(left);
      if (!hit) continue;
      if (!kinds.has(p)) kinds.set(p, kind);
      left = left.slice(0, hit.index) + ' '.repeat(hit[0].length) + left.slice(hit.index + hit[0].length);
    }
  }
  return paths.map((p) => ({ path: p, kind: kinds.get(p) ?? 'unknown' }));
}

async function revParse(cwd: string, ref: string): Promise<string> {
  return (await execGitFile(['-C', cwd, 'rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim();
}

/** Dry-runs merging `runBranch` into `mainBranch` without touching any working tree. */
export async function probeMerge(
  mainWorkspacePath: string,
  mainBranch: string,
  runBranch: string,
): Promise<MergeProbeResult> {
  try {
    const mainHead = await revParse(mainWorkspacePath, mainBranch);
    const branchHead = await revParse(mainWorkspacePath, runBranch);
    const key = `${mainHead}:${branchHead}`;
    const hit = cache.get(key);
    if (hit) return hit;

    let stdout: string;
    try {
      stdout = (
        await execGitFile([
          '-C',
          mainWorkspacePath,
          '-c',
          'core.quotePath=false',
          'merge-tree',
          '--write-tree',
          '--name-only',
          '--messages',
          mainHead,
          branchHead,
        ])
      ).stdout;
    } catch (err) {
      // Exit code 1 means conflicts; the result is on stdout.
      const e = err as { code?: number | null; stdout?: string };
      if (e.code !== 1 || typeof e.stdout !== 'string') throw err;
      stdout = e.stdout;
    }
    // Frozen: the cached object is handed to every caller, and none may change what the next one reads.
    const probe: MergeProbe = Object.freeze({
      ok: true as const,
      mainHead,
      branchHead,
      conflicts: Object.freeze(parseMergeTree(stdout).map((c) => Object.freeze(c))),
    });
    remember(cache, key, probe);
    return probe;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 'feat(EL-10): …' or 'Merge EL-10 (…)' → 'EL-10'. */
export function ticketKeyFromSubject(subject: string): string | null {
  const m = /^feat\(([^)\s]+)\):/.exec(subject) ?? /^Merge ([^\s(]+) \(/.exec(subject);
  return m ? m[1]! : null;
}

/**
 * Which other ticket added the files that now conflict add/add? Returns the key that added the
 * most of them (and how many), or null. Whether that ticket is done is the caller's check.
 * The adding commit is read along main's first parents, so a ticket merged as `Merge KEY (…)` is
 * credited even when the agent's own commit names no key. `complete` is false when a lookup failed.
 */
async function readSuperseding(
  mainWorkspacePath: string,
  mainBranch: string,
  conflicts: readonly ConflictFile[],
  ownKey: string | null,
): Promise<{ found: Superseding | null; complete: boolean }> {
  const counts = new Map<string, number>();
  let complete = true;
  for (const file of conflicts) {
    if (file.kind !== 'add/add') continue;
    let out: string;
    try {
      out = (
        await execGitFile([
          '-C',
          mainWorkspacePath,
          '-c',
          'core.quotePath=false',
          'log',
          '--first-parent',
          '--diff-merges=first-parent',
          '--diff-filter=A',
          '--no-patch',
          '--format=%s',
          mainBranch,
          '--',
          file.path,
        ])
      ).stdout;
    } catch {
      complete = false;
      continue;
    }
    const keys = new Set<string>();
    for (const subject of out.split('\n')) {
      const key = ticketKeyFromSubject(subject.trim());
      if (key && key !== ownKey) keys.add(key);
    }
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: Superseding | null = null;
  for (const [key, files] of counts) if (!best || files > best.files) best = { key, files };
  return { found: best, complete };
}

/** {@link readSuperseding} without the completeness flag. */
export async function findSuperseding(
  mainWorkspacePath: string,
  mainBranch: string,
  conflicts: readonly ConflictFile[],
  ownKey: string | null,
): Promise<Superseding | null> {
  return (await readSuperseding(mainWorkspacePath, mainBranch, conflicts, ownKey)).found;
}

/**
 * {@link findSuperseding} for a probe's conflicts, read at the probe's main head and cached, so
 * repeated reads of the same heads run no `git log` (a read with a failed lookup is not cached).
 */
export async function supersedingFor(
  mainWorkspacePath: string,
  probe: MergeProbe,
  ownKey: string | null,
): Promise<Superseding | null> {
  const added = probe.conflicts
    .filter((c) => c.kind === 'add/add')
    .map((c) => c.path)
    .sort();
  if (added.length === 0) return null;
  const key = JSON.stringify([mainWorkspacePath, probe.mainHead, ownKey, added]);
  if (supersedingCache.has(key)) return supersedingCache.get(key) ?? null;
  const { found, complete } = await readSuperseding(
    mainWorkspacePath,
    probe.mainHead,
    probe.conflicts,
    ownKey,
  );
  // A failed lookup is transient: cache only a complete answer.
  if (complete) remember(supersedingCache, key, found);
  return found;
}

/** main's first-parent history by path, newest first, keyed by main head, branch head, own key and paths. */
const moversCache = new Map<string, string[]>();

/**
 * Which tickets moved main under a branch? The keys of the commits on main since the branch's head
 * that touched the probe's conflicted paths, newest first, without duplicates and without `ownKey`.
 * Cached by the probe's heads and paths (history at two heads never changes); a failed read is
 * not cached and answers nothing.
 */
export async function mainMoversFor(
  mainWorkspacePath: string,
  probe: MergeProbe,
  ownKey: string | null,
): Promise<string[]> {
  const paths = probe.conflicts.map((c) => c.path).sort();
  if (paths.length === 0) return [];
  const key = JSON.stringify([mainWorkspacePath, probe.mainHead, probe.branchHead, ownKey, paths]);
  const hit = moversCache.get(key);
  if (hit) return hit;
  let out: string;
  try {
    out = (
      await execGitFile([
        '-C',
        mainWorkspacePath,
        '-c',
        'core.quotePath=false',
        'log',
        '--first-parent',
        '--no-patch',
        '--format=%s',
        `${probe.branchHead}..${probe.mainHead}`,
        '--',
        ...paths,
      ])
    ).stdout;
  } catch {
    return [];
  }
  const keys = new Set<string>();
  for (const subject of out.split('\n')) {
    const found = ticketKeyFromSubject(subject.trim());
    if (found && found !== ownKey) keys.add(found);
  }
  const movers = [...keys];
  remember(moversCache, key, movers);
  return movers;
}
