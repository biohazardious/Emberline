import type {
  DockerCleanupResponse,
  DockerCleanupState,
  DockerContainerState,
  DockerOwnerKind,
  DockerProject,
  DockerProjectOwner,
} from '@emberline/protocol';
import { ApiRequestError, errorMessage } from './api';

/** The Docker page's groups, in display order. */
export const DOCKER_GROUPS: { kind: DockerOwnerKind; label: string; hint: string }[] = [
  { kind: 'agent', label: 'Agents', hint: "Compose projects agents started for their run's worktree." },
  { kind: 'preview', label: 'Previews', hint: 'Compose previews started from a run’s Review page.' },
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

/** The projects by owner kind, in `DOCKER_GROUPS` order; empty groups are left out. */
export function groupDockerProjects(projects: DockerProject[]): DockerGroup[] {
  return DOCKER_GROUPS.map((g) => ({
    ...g,
    projects: projects.filter((p) => p.owner.kind === g.kind),
  })).filter((g) => g.projects.length > 0);
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
        prefix: 'Build & Verify of',
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
  if (owner.kind === 'preview') question += ` The preview of ${runOwnerName(owner)} stops.`;
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
    prune: cleanup.lastPruneAt ? `Images last pruned ${ago(cleanup.lastPruneAt)}.` : 'Images not pruned yet.',
  };
}

/** An action's error: the message (with the engine-off hint) and the failed command's output, shown as text. */
export function dockerErrorDetails(error: unknown): { message: string; output: string | null } {
  if (error instanceof ApiRequestError) {
    const hint = typeof error.data.hint === 'string' ? error.data.hint : null;
    const output = typeof error.data.output === 'string' && error.data.output ? error.data.output : null;
    return { message: hint ? `${error.message} (${hint})` : error.message, output };
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

/** A published port, on the host name Emberline was opened by. */
export function portHref(hostname: string, port: number): string {
  return `http://${hostname}:${port}`;
}

export function projectServices(project: DockerProject): string[] {
  return [...new Set(project.containers.map((c) => c.service).filter((s): s is string => !!s))].sort();
}
