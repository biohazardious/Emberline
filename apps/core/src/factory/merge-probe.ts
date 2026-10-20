import { execGitFile } from '../git-exec.js';

export interface ConflictFile {
  /** Repository-relative path. */
  path: string;
  /** 'add/add' | 'content' | 'modify/delete' | … (git's own wording). */
  kind: string;
}

export interface MergeProbe {
  ok: true;
  mainHead: string;
  branchHead: string;
  conflicts: ConflictFile[];
}

export type MergeProbeResult = MergeProbe | { ok: false; error: string };

const CACHE_LIMIT = 200;
const cache = new Map<string, MergeProbe>();

function remember(key: string, probe: MergeProbe): void {
  cache.set(key, probe);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

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
    // Other kinds start with the path: "d deleted in br and modified in main. …".
    const owner = paths.filter((p) => rest.startsWith(`${p} `)).sort((a, b) => b.length - a.length)[0];
    if (owner && !kinds.has(owner)) kinds.set(owner, kind);
  }
  return paths.map((p) => ({ path: p, kind: kinds.get(p) ?? 'content' }));
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
        await execGitFile(
          ['-C', mainWorkspacePath, 'merge-tree', '--write-tree', '--name-only', '--messages', mainHead, branchHead],
        )
      ).stdout;
    } catch (err) {
      // Exit code 1 means conflicts; the result is on stdout.
      const e = err as { code?: number | null; stdout?: string };
      if (e.code !== 1 || typeof e.stdout !== 'string') throw err;
      stdout = e.stdout;
    }
    const probe: MergeProbe = { ok: true, mainHead, branchHead, conflicts: parseMergeTree(stdout) };
    remember(key, probe);
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
 */
export async function findSuperseding(
  mainWorkspacePath: string,
  mainBranch: string,
  conflicts: ConflictFile[],
  ownKey: string | null,
): Promise<{ key: string; files: number } | null> {
  const counts = new Map<string, number>();
  for (const file of conflicts) {
    if (file.kind !== 'add/add') continue;
    let out: string;
    try {
      out = (
        await execGitFile(['-C', mainWorkspacePath, 'log', '--diff-filter=A', '--format=%s', mainBranch, '--', file.path])
      ).stdout;
    } catch {
      continue;
    }
    const keys = new Set<string>();
    for (const subject of out.split('\n')) {
      const key = ticketKeyFromSubject(subject.trim());
      if (key && key !== ownKey) keys.add(key);
    }
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: { key: string; files: number } | null = null;
  for (const [key, files] of counts) if (!best || files > best.files) best = { key, files };
  return best;
}
