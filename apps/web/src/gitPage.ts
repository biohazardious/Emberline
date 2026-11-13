import type {
  BranchRemoteState,
  GitBranch,
  GitPageStatus,
  GitSync,
  ReleaseJob,
  ReleaseStepName,
} from '@emberline/protocol';

const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'}`;

/** How a branch stands against origin, in words. The counts are only used where they are known. */
export function remoteStateText(
  state: BranchRemoteState,
  ahead?: number | null,
  behind?: number | null,
): string {
  switch (state) {
    case 'up_to_date':
      return 'Up to date with origin';
    case 'behind':
      return behind
        ? `${behind} new ${behind === 1 ? 'commit' : 'commits'} on origin`
        : 'New commits on origin';
    case 'ahead':
      return ahead ? `${commits(ahead)} not on origin yet` : 'Commits not on origin yet';
    case 'diverged':
      return 'Origin and Emberline both have new commits';
    case 'rewritten':
      return "Origin's history was rewritten";
    case 'unpublished':
      return 'Not on origin yet';
    case 'unknown':
      return 'Not read yet';
  }
}

/** The files a banner names, at most this many; the strip can show them all. */
export const FILES_NAMED = 10;

/** The first {@link FILES_NAMED} files, then how many more. */
export function fileList(files: readonly string[]): string {
  const more = files.length - FILES_NAMED;
  const shown = files.slice(0, FILES_NAMED).join(', ');
  return more > 0 ? `${shown} and ${more} more ${more === 1 ? 'file' : 'files'}` : shown;
}

/**
 * The banner for the last pull, or null when there is nothing to say. A pull's background heal is
 * stored as `idle` with a message, so an idle sync with a message is shown too. `pulledCount` is
 * the number of commits the pull brought in, when the caller knows it.
 */
export function syncText(sync: GitSync, pulledCount?: number): string | null {
  switch (sync.state) {
    case 'conflict':
      // Core's message says what to do (Resolve with a ticket, Match origin), naming ten files at most.
      return sync.message ?? `Pull stopped: ${fileList(sync.files) || 'files'} conflict`;
    case 'workspace_dirty':
      return 'Pull waits: the main workspace has uncommitted changes';
    case 'main_unpushed':
      // Core says what to do: push main, or Retry / Undo promote after a release that stopped.
      return sync.message ?? 'Main has commits origin lacks; push or promote first';
    case 'rewritten':
      // Core says why it reads as rewritten (no shared history, or the commits under new hashes).
      return (
        sync.message ?? "Origin's history was rewritten. Match origin keeps your old commits under a backup."
      );
    case 'diverged':
      return sync.message ?? remoteStateText('diverged');
    case 'error':
      return sync.message ?? 'The last pull failed.';
    case 'pulled':
      return pulledCount !== undefined
        ? `Pulled ${commits(pulledCount)}`
        : (sync.message ?? 'Pulled from origin');
    case 'idle':
      return sync.message;
    case 'up_to_date':
    case 'no_remote':
      return null;
  }
}

/**
 * The note about tags here that differ from origin's tags of the same name (origin was rewritten,
 * or a tag was made twice): Emberline never moves a local tag. Null when none differ.
 */
export function tagsDifferText(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1)
    return `The tag ${names[0]} here is not the same as origin's ${names[0]}. Emberline never moves a local tag, so it stays as it is.`;
  const shown = names.slice(0, 5).join(', ');
  const more = names.length > 5 ? ` and ${names.length - 5} more` : '';
  return `${names.length} tags here are not the same as origin's tags of the same name: ${shown}${more}. Emberline never moves a local tag, so they stay as they are.`;
}

/** Why a release cannot start right now, or null when it can. */
export function releaseBlockedText(status: GitPageStatus): string | null {
  if (!status.isGitRepo) return 'This project folder is not a git repository.';
  if (status.releaseJob?.state === 'running') return 'A release is running.';
  if (status.release.ok) return null;
  return status.release.reason ?? 'A release is not possible right now.';
}

/** A run branch of the factory's (`emberline/…`), here or only on origin. */
export const isRunBranch = (b: GitBranch): boolean =>
  b.kind === 'run' || (b.kind === 'origin' && b.name.startsWith('emberline/'));

/** The branches the Branches tab lists, and the run branches (`emberline/…`) kept behind a count. */
export function splitBranches(branches: GitBranch[]): { shown: GitBranch[]; runBranches: GitBranch[] } {
  return {
    shown: branches.filter((b) => !isRunBranch(b)),
    runBranches: branches.filter(isRunBranch),
  };
}

export const GIT_TABS = ['commits', 'branches', 'release'] as const;
export type GitTab = (typeof GIT_TABS)[number];

/** The tab a URL hash names (`#branches`); the Commits tab for anything else. */
export function tabFromHash(hash: string): GitTab {
  const name = hash.replace(/^#/, '');
  return (GIT_TABS as readonly string[]).includes(name) ? (name as GitTab) : 'commits';
}

/** How often the page reads its status: fast while a release or a draft is in progress. */
export function gitRefetchMs(status: GitPageStatus | undefined): number {
  return status?.releaseJob?.state === 'running' || status?.releaseDraft?.status === 'drafting'
    ? 5_000
    : 60_000;
}

/** The host of origin's URL for a sentence ("github.com"); "origin" when it has none. */
function originHost(url: string | null): string {
  if (!url) return 'origin';
  try {
    return new URL(url).host || 'origin';
  } catch {
    return /@([^:/]+)[:/]/.exec(url)?.[1] ?? 'origin';
  }
}

/** One line of the release's plan, or of a job's progress. */
export interface ReleaseLine {
  name: ReleaseStepName;
  text: string;
}

/** The plain-words label of a release step, for the plan and for a job that ran it. */
export function releaseStepText(
  name: ReleaseStepName,
  status: GitPageStatus,
  version: string | null,
  working = status.workingBranch,
): string {
  const main = status.defaultBranch;
  const { checks } = status.releaseSummary;
  switch (name) {
    case 'promote':
      return `Merge ${working} into ${main}`;
    case 'checks':
      return checks.length > 0
        ? `Run the checks on ${main}: ${checks.join(', ')}`
        : 'No approved checks; none run';
    case 'changelog':
      return 'Add the notes to CHANGELOG.md in the release commit';
    case 'push_main':
      return `Push ${main} to origin`;
    case 'tag':
      return version ? `Tag ${version}` : 'Tag the release';
    case 'push_tag':
      return 'Push the tag to origin';
    case 'forge_release':
      return status.forgeRelease
        ? `Create the release on ${originHost(status.originUrl)}`
        : `No forge account for ${originHost(status.originUrl)}: only the tag is pushed`;
    case 'sync_working':
      return `Bring ${working} up to date with ${main}`;
  }
}

/** What approving would do, in order: one line per step that will run. */
export function releasePlan(
  status: GitPageStatus,
  mode: 'publish' | 'promote_only',
  version: string | null,
): ReleaseLine[] {
  const separate = status.workingBranch !== status.defaultBranch;
  const publish = mode === 'publish';
  const names: ReleaseStepName[] = [
    ...(separate ? (['promote'] as const) : []),
    'checks',
    // Only a project with a CHANGELOG.md gets the notes in it.
    ...(publish && status.releaseSummary.hasChangelog ? (['changelog'] as const) : []),
    'push_main',
    ...(publish ? (['tag', 'push_tag', 'forge_release'] as const) : []),
    ...(separate ? (['sync_working'] as const) : []),
  ];
  return names.map((name) => ({ name, text: releaseStepText(name, status, version) }));
}

/**
 * With main as the working branch the release runs on main itself, and core holds the factory's
 * merges into it back until the release ends: said so on the Release tab. Null otherwise.
 */
export function factoryMergesWaitText(status: GitPageStatus, working = status.workingBranch): string | null {
  return working === status.defaultBranch
    ? `Factory merges into ${status.defaultBranch} wait while the release runs.`
    : null;
}

/** The summary line: what the release carries. */
export function releaseSummaryText(status: GitPageStatus): string {
  const { commits, tickets } = status.releaseSummary;
  if (status.workingBranch === status.defaultBranch) return `Release ${status.defaultBranch} as it is`;
  return `${status.workingBranch} → ${status.defaultBranch}: ${commits} ${commits === 1 ? 'commit' : 'commits'}, ${tickets} ${tickets === 1 ? 'ticket' : 'tickets'}`;
}

/** The checks line under the summary. */
export function releaseChecksText(status: GitPageStatus): string {
  const { checks } = status.releaseSummary;
  return checks.length > 0 ? `Checks: ${checks.join(', ')}` : 'No approved checks; the release runs none';
}

/** The next patch after the latest tag, keeping its "v"; v0.1.0 when there is no tag yet. */
export function suggestedVersion(latestTag: string | null): string {
  const m = latestTag ? /^(v?)(\d+)\.(\d+)\.(\d+)/.exec(latestTag) : null;
  return m ? `${m[1]}${m[2]}.${m[3]}.${Number(m[4]) + 1}` : 'v0.1.0';
}

/** Undo promote is offered when the promote merged and main was not pushed yet; the server has the last word. */
export function canUndoPromote(job: ReleaseJob): boolean {
  if (job.state !== 'failed') return false;
  const step = (name: ReleaseStepName) => job.steps.find((s) => s.name === name)?.status;
  return step('promote') === 'done' && step('push_main') !== 'done' && step('push_main') !== 'running';
}
