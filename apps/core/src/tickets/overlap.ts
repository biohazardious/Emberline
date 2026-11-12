import type { TicketOverlapWait } from '@emberline/protocol';
import { execGitFile } from '../git-exec.js';

/**
 * Layer 1 of conflict handling (PROJECT.md §6 M5): a ready ticket whose claimed paths overlap the
 * footprint of a busy run waits until that run is merged or held, so parallel tickets do not edit
 * the same files. Shared hot files never make a ticket wait; the merge's self-heal handles them.
 */

/** Files many tickets touch on purpose; matched by basename at any depth. */
const HOT_BASENAMES: ReadonlySet<string> = new Set([
  'PROJECT.md',
  'CHANGELOG.md',
  'README.md',
  'CLAUDE.md',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'flake.lock',
  'pubspec.lock',
]);

/** Directories whose every file is hot. */
const HOT_DIRS: readonly string[] = ['docs/', '.emberline/'];

/** The hot shared paths as patterns, for prompts and docs. */
export const HOT_SHARED_PATHS: readonly string[] = [
  ...[...HOT_BASENAMES].map((name) => (name.endsWith('.md') ? name : `**/${name}`)),
  ...HOT_DIRS.map((dir) => `${dir}**`),
];

/** Extensionless file names a claim may name on their own (`Makefile`). */
const BARE_FILE_NAMES: ReadonlySet<string> = new Set([
  'Makefile',
  'Dockerfile',
  'Containerfile',
  'Justfile',
  'Procfile',
  'Gemfile',
  'Rakefile',
  'Vagrantfile',
  'LICENSE',
]);

const GLOB_CHARS = /[*?[{]/;
const PATH_TOKEN = /^[\w.\-*?{}[\]@+,/]+$/;
const TARGET_FILES_HEADING = /^#{2,6}\s*target\s+files\b/i;
const ANY_HEADING = /^#{1,6}\s/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/** A repo-relative path or glob from a token, or null when the token is not one. */
function normalizeClaim(raw: string, dirOfPrevious: string | null): string | null {
  let token = raw
    .trim()
    .replace(/^[("'<]+/, '')
    .replace(/[)"'>,;:.]+$/, '');
  if (token === '' || /^[a-z][a-z0-9+.-]*:/i.test(token)) return null; // URLs, `C:`, `mailto:`
  if (token.startsWith('/') || token.startsWith('~') || token.startsWith('\\')) return null;
  token = token.replace(/^(\.\/)+/, '');
  if (!PATH_TOKEN.test(token) || token.includes('//')) return null;
  const segments = token.split('/').filter((s) => s !== '');
  if (segments.length === 0 || segments.some((s) => s === '..' || s === '.')) return null;
  const base = segments[segments.length - 1] as string;
  const looksLikeFile = /\.[A-Za-z0-9]+$/.test(base) || BARE_FILE_NAMES.has(base) || GLOB_CHARS.test(base);
  // `apps/core/src/tickets` (no extension) names the directory.
  const directory = token.endsWith('/') || (!looksLikeFile && segments.length >= 2);
  if (!directory && !looksLikeFile) return null;
  // `(+ x.test.ts)` next to `a/b/x.ts` means `a/b/x.test.ts`.
  const joined =
    segments.length === 1 &&
    !directory &&
    dirOfPrevious &&
    !HOT_BASENAMES.has(base) &&
    !BARE_FILE_NAMES.has(base)
      ? `${dirOfPrevious}${base}`
      : segments.join('/');
  return directory ? `${joined}/**` : joined;
}

/** Candidate tokens of one list item: its backticked spans and bare `(+ x.ts)` mentions, else its words. */
function itemTokens(item: string): string[] {
  const marked = [...item.matchAll(/`([^`]+)`|\(\+\s*([^\s)`]+)/g)].map((m) => (m[1] ?? m[2]) as string);
  if (marked.length > 0) return marked.filter((s) => !/\s/.test(s.trim()));
  return item.split(/\s+/);
}

/**
 * Repo-relative paths (globs allowed) a ticket body claims in its `## Target Files` section: list
 * items and backticked paths, in order, without duplicates. URLs and absolute paths are ignored.
 */
export function claimedPaths(body: string): string[] {
  const claims: string[] = [];
  let inSection = false;
  for (const line of body.split(/\r?\n/)) {
    if (TARGET_FILES_HEADING.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (ANY_HEADING.test(line.trim())) break;
    const item = LIST_ITEM.exec(line)?.[1] ?? (line.includes('`') ? line : null);
    if (item === null) continue;
    let dirOfPrevious: string | null = null;
    for (const token of itemTokens(item)) {
      const claim = normalizeClaim(token, dirOfPrevious);
      if (!claim) continue;
      const slash = claim.lastIndexOf('/');
      if (slash > 0 && !GLOB_CHARS.test(claim.slice(0, slash))) dirOfPrevious = claim.slice(0, slash + 1);
      if (!claims.includes(claim)) claims.push(claim);
    }
  }
  return claims;
}

/** The part of a pattern before its first wildcard. */
const literalPrefix = (pattern: string): string => {
  const at = pattern.search(GLOB_CHARS);
  return at === -1 ? pattern : pattern.slice(0, at);
};

/** Whether a path or pattern is a shared hot file that never makes a ticket wait. */
export function isHotPath(pattern: string): boolean {
  const prefix = literalPrefix(pattern);
  if (HOT_DIRS.some((dir) => prefix.startsWith(dir))) return true;
  if (GLOB_CHARS.test(pattern)) return false;
  const base = pattern.slice(pattern.lastIndexOf('/') + 1);
  return HOT_BASENAMES.has(base);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Inside a regex character class only these are special. */
const escapeClassChar = (c: string) => (/[\\\]^[-]/.test(c) ? `\\${c}` : c);

/** Thrown inside the translator only; globToRegExp turns it into null. */
class UnparsableGlob extends Error {}

/**
 * Translates `glob` from `start` until the end or, inside braces, an unnested `,` or `}`.
 * Returns the regex source and the index it stopped at.
 */
function translateGlob(glob: string, start: number, inBraces: boolean): { source: string; end: number } {
  let out = '';
  let i = start;
  for (; i < glob.length; i++) {
    const c = glob[i] as string;
    if (inBraces && (c === ',' || c === '}')) break;
    if (c === '*' && glob[i + 1] === '*') {
      const slashAfter = glob[i + 2] === '/';
      out += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const alternatives = translateBraces(glob, i);
      if (alternatives === null) out += '\\{';
      else {
        out += alternatives.source;
        i = alternatives.end;
      }
    } else if (c === '[') {
      const cls = translateClass(glob, i);
      if (cls === null) out += '\\[';
      else {
        out += cls.source;
        i = cls.end;
      }
    } else out += escapeRegExp(c);
  }
  return { source: out, end: i };
}

/** `{a,b*}` at `open` as `(?:a|b[^/]*)`, each alternative a glob of its own; null when never closed. */
function translateBraces(glob: string, open: number): { source: string; end: number } | null {
  const alternatives: string[] = [];
  let i = open + 1;
  for (;;) {
    const part = translateGlob(glob, i, true);
    alternatives.push(part.source);
    if (part.end >= glob.length) return null;
    if (glob[part.end] === '}') return { source: `(?:${alternatives.join('|')})`, end: part.end };
    i = part.end + 1;
  }
}

/**
 * `[a-z]`, `[!x]` or `[^x]` at `open` as a regex class that never matches `/`; null when never
 * closed (the `[` is then literal). A reversed range (`[z-a]`) makes the whole glob unparsable.
 */
function translateClass(glob: string, open: number): { source: string; end: number } | null {
  let i = open + 1;
  const negated = glob[i] === '!' || glob[i] === '^';
  if (negated) i++;
  const first = i;
  let body = '';
  for (; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === ']' && i > first) break;
    const to = glob[i + 2];
    if (glob[i + 1] === '-' && to !== undefined && to !== ']') {
      if (c > to) throw new UnparsableGlob(`range ${c}-${to} is out of order`);
      body += `${escapeClassChar(c)}-${escapeClassChar(to)}`;
      i += 2;
    } else body += escapeClassChar(c);
  }
  if (i >= glob.length) return null;
  return { source: negated ? `[^/${body}]` : `(?!/)[${body}]`, end: i };
}

/**
 * A glob as an anchored regular expression: `**` spans directories, `*`/`?` stay within one, `{a,b}`
 * alternatives are globs themselves, `[...]` classes never match `/`. Null when the glob cannot be
 * read as one (a reversed class range); callers then compare it by its literal prefix. Never throws:
 * a claimed path is agent-written text, and the board must survive any of it.
 */
export function globToRegExp(glob: string): RegExp | null {
  try {
    return new RegExp(`^${translateGlob(glob, 0, false).source}$`);
  } catch {
    return null;
  }
}

/** Whether a literal path can be a file the glob names; by literal prefix when the glob is unparsable. */
function globMatches(glob: string, file: string): boolean {
  return globToRegExp(glob)?.test(file) ?? file.startsWith(literalPrefix(glob));
}

/**
 * Whether two paths or globs can name the same file. Two globs overlap when one's literal prefix
 * extends the other's (conservative: they may well match a common file).
 */
export function pathsOverlap(a: string, b: string): boolean {
  const aGlob = GLOB_CHARS.test(a);
  const bGlob = GLOB_CHARS.test(b);
  if (!aGlob && !bGlob) return a === b;
  if (aGlob && !bGlob) return globMatches(a, b);
  if (!aGlob && bGlob) return globMatches(b, a);
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** A busy run's ticket and the files it claims or its branch already changed. */
export interface BusyFootprint {
  ticketId: string;
  key: string;
  paths: readonly string[];
}

/** The busy run's ticket claims ∪ the files its branch changed, without hot paths. */
export function busyFootprint(claims: readonly string[], changed: readonly string[]): string[] {
  return [...new Set([...claims, ...changed])].filter((p) => !isHotPath(p));
}

/**
 * The first busy ticket the claims overlap, with the claimed (non-hot) paths that overlap it; null
 * when the ticket may start.
 */
export function overlapWait(
  ticket: { id: string; body: string },
  busy: readonly BusyFootprint[],
): TicketOverlapWait | null {
  const claims = claimedPaths(ticket.body).filter((p) => !isHotPath(p));
  if (claims.length === 0) return null;
  for (const other of busy) {
    if (other.ticketId === ticket.id) continue;
    const paths = claims.filter((claim) => other.paths.some((p) => pathsOverlap(claim, p)));
    if (paths.length > 0) return { ticketId: other.ticketId, key: other.key, paths };
  }
  return null;
}

/** Runs git with the given args in `cwd` and returns stdout. */
export type GitStdout = (args: string[], cwd: string) => Promise<string>;

const gitStdout: GitStdout = async (args, cwd) => (await execGitFile(args, { cwd, timeout: 15_000 })).stdout;

/** A run whose branch footprint can be read: its worktree and the branch it merges into. */
export interface FootprintRun {
  id: string;
  worktreePath: string;
}

/**
 * Files each busy run's branch changed against its merge target (`git diff --name-only
 * <main>...HEAD`), cached per branch tip so a list call never shells out. A failed read leaves the
 * run with its ticket's claims only.
 */
export class BranchFootprints {
  private readonly byRun = new Map<string, { tip: string; target: string; changed: string[] }>();

  constructor(private readonly git: GitStdout = gitStdout) {}

  /** The files the run's branch changed as last read; empty when never read or the read failed. */
  changed(runId: string): readonly string[] {
    return this.byRun.get(runId)?.changed ?? [];
  }

  /** Reads the run's branch tip and, when it moved, the files it changed against `target`. */
  async refresh(run: FootprintRun, target: string): Promise<void> {
    try {
      const tip = (await this.git(['rev-parse', 'HEAD'], run.worktreePath)).trim();
      const cached = this.byRun.get(run.id);
      if (cached && cached.tip === tip && cached.target === target) return;
      const out = await this.git(['diff', '--name-only', '-z', `${target}...HEAD`, '--'], run.worktreePath);
      const changed = out.split('\0').filter((p) => p !== '');
      this.byRun.set(run.id, { tip, target, changed });
    } catch {
      this.byRun.delete(run.id);
    }
  }

  /** Forgets runs that are not busy any more. */
  retain(busyRunIds: ReadonlySet<string>): void {
    for (const id of this.byRun.keys()) if (!busyRunIds.has(id)) this.byRun.delete(id);
  }
}
