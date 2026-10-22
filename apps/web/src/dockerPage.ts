import type {
  DockerCleanupResponse,
  DockerCleanupState,
  DockerContainerState,
  DockerOverview,
  DockerOwnerKind,
  DockerProject,
  DockerProjectOwner,
  DockerPublishedPort,
} from '@emberline/protocol';
import { withHint } from '@emberline/protocol';
import { ApiRequestError, errorMessage } from './api';

/** The Docker page's groups, in display order. */
export const DOCKER_GROUPS: { kind: DockerOwnerKind; label: string; hint: string }[] = [
  { kind: 'agent', label: 'Agents', hint: "Compose projects agents started for their run's worktree." },
  {
    kind: 'preview',
    label: 'Previews',
    hint: 'Compose previews of a run (from its Review page) or of a project’s main workspace.',
  },
  { kind: 'main', label: 'Build & Verify', hint: "Run Build & Verify on a project's main workspace." },
  {
    kind: 'orphan',
    label: 'Leftovers — removed by the automatic cleanup',
    hint: 'No run or project uses these any more. The cleanup takes up to 10 per pass.',
  },
];

export interface DockerGroup {
  kind: DockerOwnerKind;
  label: string;
  hint: string;
  projects: DockerProject[];
}

/** The group a project is listed in: its owner kind, but main's container preview is a preview. */
function groupOf(owner: DockerProjectOwner): DockerOwnerKind {
  return owner.kind === 'main' && owner.preview ? 'preview' : owner.kind;
}

/** The project a card names under "All projects": the project's name, "No project" for none (or a name not loaded yet). */
export function dockerProjectLabel(projectId: string | null, names: ReadonlyMap<string, string>): string {
  return (projectId && names.get(projectId)) || 'No project';
}

/** The projects by owner kind, in `DOCKER_GROUPS` order; empty groups are left out. */
export function groupDockerProjects(projects: DockerProject[]): DockerGroup[] {
  return DOCKER_GROUPS.map((g) => ({
    ...g,
    projects: projects.filter((p) => groupOf(p.owner) === g.kind),
  })).filter((g) => g.projects.length > 0);
}

/** The sentence for a page with nothing listed; null when the engine or both listings failed, so "runs nothing" is never claimed without a list. */
export function dockerEmptyText(data: DockerOverview, scoped: boolean): string | null {
  if (data.error) return null;
  if (data.projectsError && data.containersError) return null;
  return scoped
    ? 'This project runs no compose projects in the engine right now.'
    : 'Emberline runs no compose projects in the engine right now.';
}

export const DOCKER_CLEANUP_SCOPE_HINT =
  'Clean up now works on the whole engine, not only on this project: it removes the leftovers of every project, and untagged images and build cache older than 72 hours.';

/** The note under "Clean up now" while the page lists one project only. */
export function cleanupScopeHint(scoped: boolean): string | null {
  return scoped ? DOCKER_CLEANUP_SCOPE_HINT : null;
}

type RunOwner = Extract<DockerProjectOwner, { kind: 'agent' | 'preview' }>;

/** A run's short name: its ticket key, else its title, else "run <id8>". */
export function runOwnerName(owner: RunOwner): string {
  return owner.ticketKey ?? owner.runTitle ?? `run ${owner.runId.slice(0, 8)}`;
}

export interface OwnerSummary {
  prefix: string;
  /** The linked part; null for a leftover. */
  text: string | null;
  detail: string | null;
  href: string | null;
}

/** Who a project belongs to, with a link to the run's Review page or the project's board. */
export function ownerSummary(owner: DockerProjectOwner): OwnerSummary {
  switch (owner.kind) {
    case 'agent':
    case 'preview': {
      const detail = [owner.ticketKey ? owner.ticketTitle : null, owner.projectName]
        .filter(Boolean)
        .join(' · ');
      return {
        prefix: owner.kind === 'agent' ? 'Agent of' : 'Preview of',
        text: runOwnerName(owner),
        detail: detail || null,
        href: `/runs/${owner.runId}/review`,
      };
    }
    case 'main':
      return {
        prefix: owner.preview ? 'Preview of main ·' : 'Build & Verify of',
        text: owner.projectName,
        detail: null,
        href: `/projects/${owner.projectId}/board`,
      };
    case 'orphan':
      return { prefix: 'No run or project uses it', text: null, detail: null, href: null };
  }
}

export type Tone = 'ok' | 'warn' | 'bad' | 'soft';

export function ownerBadges(owner: DockerProjectOwner): { text: string; tone: Tone }[] {
  if (owner.kind !== 'agent' && owner.kind !== 'preview') return [];
  if (owner.live) return [{ text: 'agent running', tone: 'warn' }];
  if (owner.inReview) return [{ text: 'in review', tone: 'soft' }];
  return [];
}

export type DockerAction = 'stop' | 'remove';

/**
 * The actions a project offers. A leftover only gets Remove: a stopped one keeps its volumes, and
 * with no containers left the cleanup can no longer find it (core refuses that Stop too).
 */
export function actionsFor(owner: DockerProjectOwner): DockerAction[] {
  return owner.kind === 'orphan' ? ['remove'] : ['stop', 'remove'];
}

/** The page's "Stopped/Removed <name>." line. */
export interface DockerDone {
  project: string;
  text: string;
}

/** The done line still describes the page until that project is listed again (something started it anew). */
export function doneStillCurrent(done: DockerDone | null, projects: DockerProject[]): boolean {
  return done !== null && !projects.some((p) => p.name === done.project);
}

/** The inline confirm row of Stop / Remove. A live agent only warns: a person may need to stop a runaway container. */
export function confirmText(
  project: DockerProject,
  action: DockerAction,
): { question: string; warning: string | null } {
  const { owner } = project;
  let question =
    action === 'stop'
      ? `Stop ${project.name}? Its containers are taken down; volumes and images stay.`
      : `Remove ${project.name}? Its containers, volumes and the images it built are deleted.`;
  if (owner.kind === 'preview') question += " The run's compose preview stops if it is running.";
  if (owner.kind === 'main' && owner.preview) question += " Main's container preview stops if it is running.";
  const warning =
    owner.kind === 'agent' && owner.live
      ? `The agent of ${runOwnerName(owner)} is running and may be using it.`
      : null;
  return { question, warning };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The inline result of Clean up now; `ok` false when the engine could not be listed. */
export function cleanupResultText(res: DockerCleanupResponse): { text: string; ok: boolean } {
  const pruned = res.pruned ? 'images were pruned.' : 'images were not pruned.';
  if (!res.listed)
    return { text: `Couldn't list projects: ${res.error ?? 'unknown error'}; ${pruned}`, ok: false };
  const names = res.removed.length ? ` (${res.removed.join(', ')})` : '';
  return { text: `Removed ${plural(res.removed.length, 'project')}${names}; ${pruned}`, ok: true };
}

/** The engine card's cleanup lines; `ago` formats an ISO time ("5m ago"). */
export function cleanupLines(
  cleanup: DockerCleanupState,
  ago: (iso: string) => string,
): { sweep: string; prune: string } {
  return {
    sweep: cleanup.lastSweepAt
      ? `Last cleanup ${ago(cleanup.lastSweepAt)}: removed ${plural(cleanup.lastSweepRemoved.length, 'project')}.`
      : 'No cleanup has run since Emberline started.',
    prune: pruneLine(cleanup, ago),
  };
}

function pruneLine(cleanup: DockerCleanupState, ago: (iso: string) => string): string {
  const ok = cleanup.lastPruneOkAt
    ? `Images last pruned ${ago(cleanup.lastPruneOkAt)}.`
    : 'Images not pruned yet.';
  // The latest attempt failed when it is not also the latest success.
  if (cleanup.lastPruneAt && cleanup.lastPruneAt !== cleanup.lastPruneOkAt) {
    return `Image prune last ran ${ago(cleanup.lastPruneAt)} (failed). ${ok}`;
  }
  return ok;
}

/** An action's error: the message (with the engine-off hint as its own sentence) and the failed command's output, shown as text. */
export function dockerErrorDetails(error: unknown): { message: string; output: string | null } {
  if (error instanceof ApiRequestError) {
    const hint = typeof error.data.hint === 'string' ? error.data.hint : null;
    const output = typeof error.data.output === 'string' && error.data.output ? error.data.output : null;
    return { message: hint ? withHint(error.message, hint) : error.message, output };
  }
  return { message: errorMessage(error), output: null };
}

export function containerStateTone(state: DockerContainerState): Exclude<Tone, 'soft'> | null {
  switch (state) {
    case 'running':
      return 'ok';
    case 'restarting':
    case 'paused':
    case 'created':
      return 'warn';
    case 'exited':
    case 'dead':
      return 'bad';
    case 'unknown':
      return null;
  }
}

/** `compose ls` status ("running(2)", "running(1), exited(1)"): all running ok, some running or not started warn, all stopped bad. */
export function projectStatusTone(status: string | null): Exclude<Tone, 'soft'> | null {
  if (!status) return null;
  const states = status.split(',').map((s) => s.trim().replace(/\(.*$/, ''));
  if (states.every((s) => s === 'running')) return 'ok';
  if (states.every((s) => s === 'exited' || s === 'dead')) return 'bad';
  return 'warn';
}

/** A published port: a link only when core gave it a URL (ports outside the engine's preview range are not on the host). */
export function portLink(port: DockerPublishedPort): { text: string; href: string | null } {
  return { text: `:${port.port}`, href: port.url };
}

export function projectServices(project: DockerProject): string[] {
  return [...new Set(project.containers.map((c) => c.service).filter((s): s is string => !!s))].sort();
}
