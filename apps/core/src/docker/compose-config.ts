/**
 * The Container preview box's read of a compose file: HEAD's committed file goes to
 * `docker compose config --format json` in the runner on stdin (never to disk, as the preview
 * override in compose.ts), so what is listed is what a run worktree will start. No engine is
 * needed; interpolation reads only the main workspace's `.env` (compose's own lookup). Bounded in
 * time and output; cached per HEAD commit + file + `.env`.
 */
import { createHash } from 'node:crypto';
import {
  COMPOSE_FILE_NAMES,
  COMPOSE_SERVICE_NAME,
  type ComposeFileName,
  type ContainerPreviewService,
} from '@emberline/protocol';
import { dockerCommand, type ExecResult, execCommand } from '../command-exec.js';
import { execGitFile } from '../git-exec.js';
import { isMissing } from '../outputs/safe-fs.js';
import { readWorktreeBytes } from '../runs/git.js';
import { clipText, stripControlChars } from '../text/control-chars.js';
import { COMPOSE_OVERRIDE_ENV, composeShell } from './compose.js';
import { mainComposeProjectName } from './engine.js';

export const COMPOSE_CONFIG_TIMEOUT_MS = 15_000;
export const COMPOSE_CONFIG_MAX_OUTPUT_BYTES = 1024 * 1024;
export const COMPOSE_FILE_MAX_BYTES = 64 * 1024;
const MAX_SERVICES = 100;
const MAX_PORTS_PER_SERVICE = 20;
/** Port and `expose` entries examined over all services (an agent's file can list thousands). */
const MAX_PORT_ENTRIES = 2000;
/** Service keys examined, listed or not (names the box drops count too). */
const MAX_SERVICE_ENTRIES = 1000;
const MAX_PORT = 65535;
const ENV_FILE_MAX_BYTES = 256 * 1024;
const LINE_MAX_CHARS = 200;
/**
 * Compose fetches a remote `include:` (a git URL or `oci://`) by default; the box reads only the
 * committed file and the workspace, never the network. A project's `.env` cannot turn these back on.
 */
const NO_REMOTE_RESOURCES_ENV = {
  COMPOSE_EXPERIMENTAL_GIT_REMOTE: 'false',
  COMPOSE_EXPERIMENTAL_OCI_REMOTE: 'false',
};

/** `-p` is fixed (a `name:` in the file cannot pick it), the directory is the main workspace (its `.env`). */
export function composeConfigArgs(project: string, projectDir: string): string[] {
  return [
    'compose',
    '-p',
    project,
    '--project-directory',
    projectDir,
    '-f',
    '-',
    'config',
    '--format',
    'json',
  ];
}

/** Counts the port entries a parse examines and the ports it walks (the budget test reads it). */
export interface ComposeParseMeter {
  entries: number;
  ports: number;
}

function addPorts(into: Set<number>, value: unknown, meter?: ComposeParseMeter): void {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  // A short-syntax item `[ip:]host:container[/proto]`: the container side is last.
  const m = /^(\d{1,5})(?:-(\d{1,5}))?(?:\/\w+)?$/.exec(text.trim().split(':').pop() ?? '');
  if (!m) return;
  // Compose prints ranges above 65535 unchanged: clamp, never walk ports that cannot be listed.
  const start = Math.max(Number(m[1]), 1);
  if (start > MAX_PORT) return;
  const end = Math.min(m[2] ? Number(m[2]) : start, MAX_PORT);
  for (let port = start; port <= end && into.size < MAX_PORTS_PER_SERVICE; port++) {
    if (meter) meter.ports++;
    into.add(port);
  }
}

/** Services (compose's order) with their published targets, then `expose`; null when the output is not a config. */
export function parseComposeConfig(
  stdout: string,
  meter?: ComposeParseMeter,
): ContainerPreviewService[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return null;
  }
  const services =
    doc && typeof doc === 'object' && !Array.isArray(doc)
      ? (doc as { services?: unknown }).services
      : undefined;
  if (!services || typeof services !== 'object' || Array.isArray(services)) return null;
  const out: ContainerPreviewService[] = [];
  let serviceEntries = 0;
  let portEntries = 0;
  for (const name in services) {
    if (out.length >= MAX_SERVICES || ++serviceEntries > MAX_SERVICE_ENTRIES) break;
    if (!Object.hasOwn(services, name) || !COMPOSE_SERVICE_NAME.test(name)) continue;
    const raw = (services as Record<string, unknown>)[name];
    const def = (raw && typeof raw === 'object' ? raw : {}) as { ports?: unknown; expose?: unknown };
    const ports = new Set<number>();
    const published = Array.isArray(def.ports) ? (def.ports as unknown[]) : [];
    const exposed = Array.isArray(def.expose) ? (def.expose as unknown[]) : [];
    // Indexes, not copies: an entry past a cap or the budget is never touched.
    for (let i = 0; i < published.length + exposed.length; i++) {
      if (ports.size >= MAX_PORTS_PER_SERVICE || ++portEntries > MAX_PORT_ENTRIES) break;
      const p = i < published.length ? published[i] : exposed[i - published.length];
      if (meter) meter.entries++;
      addPorts(
        ports,
        i < published.length && p && typeof p === 'object' ? (p as { target?: unknown }).target : p,
        meter,
      );
    }
    out.push({ name, ports: [...ports] });
  }
  return out;
}

/** The first line of compose's output that is not a warning, without its log prefix; null when there is none. */
export function firstErrorLine(stderr: string, stdout = ''): string | null {
  for (const raw of `${stderr}\n${stdout}`.split('\n')) {
    const line = stripControlChars(raw, '').trim();
    if (!line || /^WARN\[|level=warn/i.test(line)) continue;
    return clipText(line.replace(/^(?:time="[^"]*"\s+)?level=\w+\s+msg=/, ''), LINE_MAX_CHARS);
  }
  return null;
}

/** "Docker Compose couldn't read <file>: <first line>." (spec §2), one full stop. */
export function composeConfigFailure(file: string, detail: string): string {
  return `Docker Compose couldn't read ${file}: ${detail.trim().replace(/[\s.]+$/, '')}.`;
}

export interface HeadComposeFile {
  file: ComposeFileName;
  commit: string;
  oid: string;
  mode: string;
  type: string;
  size: number | null;
}
export type HeadComposeLookup =
  { kind: 'present'; entry: HeadComposeFile } | { kind: 'absent' } | { kind: 'unknown'; error: string };

/** The first of {@link COMPOSE_FILE_NAMES} in the main workspace's HEAD (git in the runner). */
export async function findHeadComposeFile(projectPath: string): Promise<HeadComposeLookup> {
  const inRepo = { cwd: projectPath };
  let commit: string;
  let listing: string;
  try {
    commit = (await execGitFile(['rev-parse', '--verify', 'HEAD^{commit}'], inRepo)).stdout.trim();
    listing = (await execGitFile(['ls-tree', '-l', '-z', commit, '--', ...COMPOSE_FILE_NAMES], inRepo))
      .stdout;
  } catch (error) {
    const message = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
    return { kind: 'unknown', error: clipText(message, 300) };
  }
  const entries = new Map<string, Omit<HeadComposeFile, 'file' | 'commit'>>();
  for (const record of listing.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode = '', type = '', oid = '', size = ''] = record.slice(0, tab).split(/\s+/);
    entries.set(record.slice(tab + 1), { mode, type, oid, size: /^\d+$/.test(size) ? Number(size) : null });
  }
  const file = COMPOSE_FILE_NAMES.find((name) => entries.has(name));
  return file ? { kind: 'present', entry: { file, commit, ...entries.get(file)! } } : { kind: 'absent' };
}

export type ComposeConfigRead =
  { ok: true; services: ContainerPreviewService[] } | { ok: false; reason: string };

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** The `.env` compose interpolates from, as a cache key part (its content never leaves this function). */
async function envFileKey(projectPath: string): Promise<string> {
  try {
    const bytes = await readWorktreeBytes(projectPath, '.env', ENV_FILE_MAX_BYTES);
    return bytes ? sha(bytes) : 'large';
  } catch (error) {
    return isMissing(error) ? 'none' : 'unreadable';
  }
}

/**
 * The key is HEAD's commit and file plus the main workspace's `.env`: workspace files the compose file
 * `include`s, `extends` or names in `env_file` are read uncommitted and do not invalidate it.
 */
export class ComposeConfigReader {
  private readonly cache = new Map<string, { key: string; result: ComposeConfigRead }>();
  /** The read in flight per project and HEAD file, joined synchronously by every caller that asks meanwhile. */
  private readonly inFlight = new Map<string, { id: string; promise: Promise<ComposeConfigRead> }>();

  /** HEAD's `entry` read by compose, from the cache when HEAD, the file and `.env` are unchanged. */
  read(projectId: string, projectPath: string, entry: HeadComposeFile): Promise<ComposeConfigRead> {
    const id = `${entry.commit}:${entry.oid}`;
    const running = this.inFlight.get(projectId);
    if (running?.id === id) return running.promise;
    const flight: { id: string; promise: Promise<ComposeConfigRead> } = {
      id,
      promise: (async () => {
        const key = `${id}:${await envFileKey(projectPath)}`;
        const hit = this.cache.get(projectId);
        if (hit?.key === key) return hit.result;
        const { result, cacheable } = await this.run(projectId, projectPath, entry);
        if (cacheable) this.cache.set(projectId, { key, result });
        return result;
      })().finally(() => {
        if (this.inFlight.get(projectId) === flight) this.inFlight.delete(projectId);
      }),
    };
    this.inFlight.set(projectId, flight);
    return flight.promise;
  }

  private async run(
    projectId: string,
    projectPath: string,
    entry: HeadComposeFile,
  ): Promise<{ result: ComposeConfigRead; cacheable: boolean }> {
    const fail = (detail: string, cacheable = true) => ({
      result: { ok: false as const, reason: composeConfigFailure(entry.file, detail) },
      cacheable,
    });
    if (entry.mode === '120000') return fail('it is a symbolic link in HEAD');
    if (entry.type !== 'blob' || !/^[0-9a-f]{40,64}$/.test(entry.oid))
      return fail('it is not a file in HEAD');
    if (entry.size === null || entry.size > COMPOSE_FILE_MAX_BYTES)
      return fail(`it is larger than ${COMPOSE_FILE_MAX_BYTES / 1024} KB`);
    let content: string;
    try {
      content = (
        await execGitFile(['cat-file', 'blob', entry.oid], {
          cwd: projectPath,
          maxBuffer: COMPOSE_FILE_MAX_BYTES + 1,
        })
      ).stdout;
    } catch (error) {
      return fail((error as Error).message, false);
    }
    // An environment variable cannot carry a NUL byte (and YAML has none): the same answer every time.
    if (content.includes('\0')) return fail('it is not a text file');
    const shell = composeShell(composeConfigArgs(mainComposeProjectName(projectId), projectPath));
    let ran: ExecResult;
    try {
      ran = await execCommand(
        dockerCommand({
          file: shell.file,
          args: shell.args,
          cwd: projectPath,
          env: { [COMPOSE_OVERRIDE_ENV]: content, ...NO_REMOTE_RESOURCES_ENV },
          timeoutMs: COMPOSE_CONFIG_TIMEOUT_MS,
          maxOutputBytes: COMPOSE_CONFIG_MAX_OUTPUT_BYTES,
        }),
      );
    } catch (error) {
      return fail((error as Error).message, false);
    }
    if (ran.timedOut) return fail(`no answer within ${COMPOSE_CONFIG_TIMEOUT_MS / 1000} s`, false);
    if (ran.truncated)
      return fail(`its configuration is larger than ${COMPOSE_CONFIG_MAX_OUTPUT_BYTES / 1024 / 1024} MB`);
    if (ran.exitCode !== 0) {
      // 127: no Docker CLI in the runner (an old image): not the file's fault, ask again later.
      const line = firstErrorLine(ran.stderr, ran.stdout)?.replace(
        /^failed to parse -:/,
        `failed to parse ${entry.file}:`,
      );
      const exited = ran.signal ? `was stopped by ${ran.signal}` : `exited with ${ran.exitCode}`;
      return fail(line ?? `docker compose config ${exited}`, ran.exitCode !== 127);
    }
    const services = parseComposeConfig(ran.stdout);
    if (!services) return fail('docker compose config printed something unexpected');
    if (services.length === 0)
      return { result: { ok: false, reason: `${entry.file} has no services.` }, cacheable: true };
    return { result: { ok: true, services }, cacheable: true };
  }
}
