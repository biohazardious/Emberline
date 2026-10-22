/**
 * The Docker page's inventory: what Emberline runs in the engine sidecar. Parsing of `compose ls`,
 * `docker ps` and `system df` (all untrusted CLI output: anything unexpected is an error string for
 * that part, never an exception), the ownership of each compose project from plain DB facts, and the
 * one function that gathers the three listings through the runner.
 *
 * The in-use rule here is the GC sweep's too (RunService.composeProjectsInUse): a project the page
 * shows as `orphan` (stale) is exactly one the next sweep removes.
 */
import type {
  DockerContainer,
  DockerContainerState,
  DockerDiskRow,
  DockerProject,
  DockerProjectOwner,
  RunState,
} from '@emberline/protocol';
import { clipText, stripControlChars } from '../text/control-chars.js';
import { composeLsArgs, dockerPsArgs, isEmberlineComposeProject, systemDfArgs } from './compose.js';
import { dockerQuery, type Ran } from './compose-preview.js';
import { composeProjectName, mainComposeProjectName, mainPreviewComposeProjectName, previewComposeProjectName } from './engine.js';

/** A parse or a docker call: its value, or why there is none (one line, Emberline's words plus CLI output). */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ComposeLsRow {
  name: string;
  status: string | null;
}

/** A container as `docker ps` lists it: its published ports are plain numbers until the page links them. */
export type InventoryContainer = Omit<DockerContainer, 'ports'> & { project: string; ports: number[] };

const TEXT_MAX = 300;
const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';
const CONTAINER_STATES = new Set<string>(['running', 'exited', 'created', 'restarting', 'paused', 'dead']);
/** A published range (`8000-8100->…`) lists at most this many ports. */
const MAX_PORTS_PER_RANGE = 32;

/** One line of CLI text fit for the API: no control characters, at most 300 chars. */
function text(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return '';
  return clipText(stripControlChars(value.replace(/\s+/g, ' '), '').trim(), TEXT_MAX);
}

/** JSON lines; lines that are not a JSON object are skipped. `null` when there were lines but none parsed. */
function jsonLines(stdout: string): Record<string, unknown>[] | null {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');
  const rows: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value))
        rows.push(value as Record<string, unknown>);
    } catch {
      // not JSON: skipped
    }
  }
  return lines.length > 0 && rows.length === 0 ? null : rows;
}

/** `compose ls -a --format json`: one JSON array of {Name, Status, ConfigFiles}. */
export function parseComposeLsRows(stdout: string): Parsed<ComposeLsRow[]> {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout.trim() || '[]');
  } catch {
    return { ok: false, error: 'unexpected `docker compose ls` output' };
  }
  if (!Array.isArray(rows)) return { ok: false, error: 'unexpected `docker compose ls` output' };
  return {
    ok: true,
    value: rows.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const r = row as Record<string, unknown>;
      if (typeof r.Name !== 'string' || r.Name === '') return [];
      return [{ name: r.Name, status: typeof r.Status === 'string' ? text(r.Status) : null }];
    }),
  };
}

/** Docker's `Labels` column: `k=v` pairs joined by commas; a part without `=` belongs to the value before it. */
export function parseDockerLabels(labels: string): Record<string, string> {
  const out: Record<string, string> = {};
  let last: string | null = null;
  for (const part of labels.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      last = part.slice(0, eq);
      out[last] = part.slice(eq + 1);
    } else if (last !== null) {
      out[last] += `,${part}`;
    }
  }
  return out;
}

/** Host ports from Docker's `Ports` column (`0.0.0.0:4326->80/tcp, [::]:4326->80/tcp`), unique, ascending. */
export function parseHostPorts(ports: string): number[] {
  const found = new Set<number>();
  for (const match of ports.matchAll(/:(\d{1,5})(?:-(\d{1,5}))?->/g)) {
    const first = Number(match[1]);
    const last = match[2] ? Math.min(Number(match[2]), first + MAX_PORTS_PER_RANGE - 1) : first;
    for (let port = first; port <= last; port++) if (port > 0 && port <= 65535) found.add(port);
  }
  return [...found].sort((a, b) => a - b);
}

/** `docker ps -a --filter label=com.docker.compose.project --format '{{json .}}'`. */
export function parseDockerPs(stdout: string): Parsed<InventoryContainer[]> {
  const rows = jsonLines(stdout);
  if (rows === null) return { ok: false, error: 'unexpected `docker ps` output' };
  return {
    ok: true,
    value: rows.flatMap((r) => {
      const labels = parseDockerLabels(typeof r.Labels === 'string' ? r.Labels : '');
      const project = labels[PROJECT_LABEL];
      if (!project) return [];
      const state = text(r.State).toLowerCase();
      return [
        {
          project,
          name: text(r.Names).split(',')[0] ?? '',
          service: labels[SERVICE_LABEL] ? text(labels[SERVICE_LABEL]) : null,
          state: (CONTAINER_STATES.has(state) ? state : 'unknown') as DockerContainerState,
          status: text(r.Status),
          ports: parseHostPorts(typeof r.Ports === 'string' ? r.Ports : ''),
          image: text(r.Image),
          createdAt: text(r.CreatedAt),
          runningFor: text(r.RunningFor),
        },
      ];
    }),
  };
}

/** `docker system df --format '{{json .}}'`: one row per type, values kept as Docker prints them. */
export function parseSystemDf(stdout: string): Parsed<DockerDiskRow[]> {
  const rows = jsonLines(stdout);
  if (rows === null) return { ok: false, error: 'unexpected `docker system df` output' };
  return {
    ok: true,
    value: rows.flatMap((r) =>
      typeof r.Type === 'string'
        ? [
            {
              type: text(r.Type),
              total: text(r.TotalCount),
              active: text(r.Active),
              size: text(r.Size),
              reclaimable: text(r.Reclaimable),
            },
          ]
        : [],
    ),
  };
}

/** A run as ownership sees it (plain values gathered from the DB and the file system by RunService). */
export interface OwnershipRun {
  id: string;
  projectId: string;
  ticketId: string | null;
  ticketKey: string | null;
  ticketTitle: string | null;
  title: string | null;
  state: RunState;
  worktreePath: string;
  createdAt: number;
  endedAt: number | null;
  cancelledAt: number | null;
  worktreeExists: boolean;
}

export interface OwnershipFacts {
  runs: readonly OwnershipRun[];
  projects: readonly { id: string; name: string }[];
}

/** The run's agent is alive, or rate limited and waiting for its window (not cancelled). */
export function runIsLive(r: Pick<OwnershipRun, 'endedAt' | 'state' | 'cancelledAt'>): boolean {
  return !r.endedAt || (r.state === 'rate_limited' && !r.cancelledAt);
}

/** A run keeps its compose projects while it is live or still has its worktree (a run in Review). */
function holdsProjects(r: OwnershipRun): boolean {
  return runIsLive(r) || r.worktreeExists;
}

/**
 * Compose projects still in use: those of every run that is live or still has its worktree (a run
 * in Review keeps its worktree, so its preview stays), and every project's main workspace (Build &
 * Verify's and the main preview's). The GC sweep removes Emberline's other projects.
 */
export function composeProjectsInUse(facts: OwnershipFacts): Set<string> {
  const inUse = new Set<string>();
  for (const p of facts.projects) {
    inUse.add(mainComposeProjectName(p.id));
    inUse.add(mainPreviewComposeProjectName(p.id));
  }
  for (const r of facts.runs) {
    if (!holdsProjects(r)) continue;
    inUse.add(composeProjectName(r.id, r.worktreePath));
    inUse.add(previewComposeProjectName(r.id));
  }
  return inUse;
}

/**
 * Who a compose project belongs to. Agent projects: the runs whose project it is (handoff successors
 * share the worktree's), newest live first, else newest. `orphan` when nothing holds it, the same
 * rule as {@link composeProjectsInUse}.
 */
/** Live runs before ended ones, then the newer one. */
function holdsBetter(a: OwnershipRun, b: OwnershipRun): boolean {
  return runIsLive(a) === runIsLive(b) ? a.createdAt > b.createdAt : runIsLive(a);
}

export function resolveDockerOwner(name: string, facts: OwnershipFacts): DockerProjectOwner {
  if (name.startsWith('emberline-main-')) {
    // Build & Verify's project, or (`-preview`) the main workspace's container preview.
    const preview = name.endsWith('-preview');
    const project = facts.projects.find(
      (p) => (preview ? mainPreviewComposeProjectName(p.id) : mainComposeProjectName(p.id)) === name,
    );
    if (!project) return { kind: 'orphan' };
    return { kind: 'main', projectId: project.id, projectName: project.name, ...(preview ? { preview: true } : {}) };
  }
  const preview = name.endsWith('-preview');
  const r = facts.runs
    .filter(
      (x) =>
        holdsProjects(x) &&
        (preview ? previewComposeProjectName(x.id) : composeProjectName(x.id, x.worktreePath)) === name,
    )
    .reduce<OwnershipRun | undefined>((best, x) => (!best || holdsBetter(x, best) ? x : best), undefined);
  if (!r) return { kind: 'orphan' };
  const live = runIsLive(r);
  return {
    kind: preview ? 'preview' : 'agent',
    runId: r.id,
    runTitle: r.title,
    ticketId: r.ticketId,
    ticketKey: r.ticketKey,
    ticketTitle: r.ticketTitle,
    projectId: r.projectId,
    projectName: facts.projects.find((p) => p.id === r.projectId)?.name ?? null,
    runState: r.state,
    live,
    inReview: !live && r.worktreeExists,
  };
}

/** `id` when it is a project in the database, else null (a run's project may be gone). */
export function knownProjectId(id: string | null | undefined, facts: OwnershipFacts): string | null {
  return id && facts.projects.some((p) => p.id === id) ? id : null;
}

/**
 * The Emberline project of a compose project, by its name (docker/engine.ts): Build & Verify's and
 * the main preview's through the project, a run's own and its preview's through the run — any run
 * still in the database, so a leftover of a known run keeps its project. Null when no project or
 * run has the name.
 */
export function dockerProjectIdOf(name: string, facts: OwnershipFacts): string | null {
  const known = (id: string | undefined): string | null => knownProjectId(id ?? null, facts);
  const preview = name.endsWith('-preview');
  if (name.startsWith('emberline-main-')) {
    return known(
      facts.projects.find((p) => (preview ? mainPreviewComposeProjectName(p.id) : mainComposeProjectName(p.id)) === name)?.id,
    );
  }
  const newest = facts.runs
    .filter((r) => (preview ? previewComposeProjectName(r.id) : composeProjectName(r.id, r.worktreePath)) === name)
    .reduce<OwnershipRun | undefined>((best, r) => (!best || r.createdAt > best.createdAt ? r : best), undefined);
  return known(newest?.projectId);
}

/**
 * The page's projects: Emberline's names from `compose ls` and from the containers' labels (either
 * listing may have failed), each with its containers, owner and whether the next sweep removes it.
 */
export function buildDockerProjects(input: {
  ls: Parsed<ComposeLsRow[]>;
  ps: Parsed<InventoryContainer[]>;
  facts: OwnershipFacts;
  /** The browser link of a published port, or null when it is not published on the host. */
  portUrl?: (port: number) => string | null;
}): { projects: DockerProject[]; projectsError?: string; containersError?: string } {
  const portUrl = input.portUrl ?? (() => null);
  const status = new Map<string, string | null>();
  if (input.ls.ok)
    for (const row of input.ls.value)
      if (isEmberlineComposeProject(row.name)) status.set(row.name, row.status);
  const containers = new Map<string, DockerContainer[]>();
  if (input.ps.ok) {
    for (const { project, ports, ...container } of input.ps.value) {
      if (!isEmberlineComposeProject(project)) continue;
      const linked = { ...container, ports: ports.map((port) => ({ port, url: portUrl(port) })) };
      containers.set(project, [...(containers.get(project) ?? []), linked]);
    }
  }
  const names = [...new Set([...status.keys(), ...containers.keys()])].sort();
  const projects = names.map((name): DockerProject => {
    const owner = resolveDockerOwner(name, input.facts);
    return {
      name,
      status: status.get(name) ?? null,
      owner,
      containers: (containers.get(name) ?? []).sort(
        (a, b) => (a.service ?? '').localeCompare(b.service ?? '') || a.name.localeCompare(b.name),
      ),
      stale: owner.kind === 'orphan',
      projectId: owner.kind === 'orphan' ? dockerProjectIdOf(name, input.facts) : knownProjectId(owner.projectId, input.facts),
    };
  });
  return {
    projects,
    ...(input.ls.ok ? {} : { projectsError: input.ls.error }),
    ...(input.ps.ok ? {} : { containersError: input.ps.error }),
  };
}

export interface DockerInventory {
  ls: Parsed<ComposeLsRow[]>;
  ps: Parsed<InventoryContainer[]>;
  df: Parsed<DockerDiskRow[]>;
}

/** The three listings, at once, through the runner. Never throws: a failed call is that part's error. */
export async function gatherDockerInventory(env: Record<string, string>): Promise<DockerInventory> {
  const [ls, ps, df] = await Promise.all([
    dockerQuery(composeLsArgs(), env),
    dockerQuery(dockerPsArgs(), env),
    dockerQuery(systemDfArgs(), env),
  ]);
  return {
    ls: parsedFrom(ls, 'docker compose ls', parseComposeLsRows),
    ps: parsedFrom(ps, 'docker ps', parseDockerPs),
    df: parsedFrom(df, 'docker system df', parseSystemDf),
  };
}

function parsedFrom<T>(ran: Ran, what: string, parse: (stdout: string) => Parsed<T>): Parsed<T> {
  if (!ran.ok || !ran.result) {
    const detail = text(ran.output);
    return {
      ok: false,
      error: clipText(`${what} failed (${ran.how})${detail ? `: ${detail}` : ''}`, TEXT_MAX),
    };
  }
  return parse(ran.result.stdout);
}
