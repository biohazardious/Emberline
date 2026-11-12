import { NEEDS_PERSON_INPUT, type Run, type RunRecovery, type RecoverySuggestion } from '@emberline/protocol';

/** Pure helpers of the held-run recovery block (components/HoldRecovery.tsx). */

/** Recovery is offered for held runs and for runs whose completion was blocked. */
export const recoveryApplies = (run: Pick<Run, 'attention'>): boolean =>
  run.attention?.reason === 'held' || run.attention?.reason === 'blocked';

/**
 * What the Answer box starts with for a prompt suggestion: nothing for one that asks the person
 * (the dialog shows the question), else the suggested prompt.
 */
export const initialAnswerText = (s: RecoverySuggestion): string =>
  NEEDS_PERSON_INPUT.has(s.id) ? '' : (s.prompt ?? '');

/** Where a recovery prompt went, as a short note. */
export const deliveryNote = (delivery: 'session' | 'successor'): string =>
  delivery === 'session' ? 'Sent to the agent' : 'Continuing in a new run on the same branch';

const NO_PROMPT = "This run can't take a prompt any more. Start a new run or discard the ticket.";
const STOPPED = "This run was stopped, so it can't take a prompt. Start a new run or discard the ticket.";

/** Plain text for a `/recover` refusal; other codes (route checks) keep the server's message. */
export function recoverErrorText(code: string, message: string): string {
  switch (code) {
    case 'not_held':
      return 'This ticket is no longer held.';
    case 'run_busy':
      return 'The agent is working; try again when it stops.';
    case 'worktree_missing':
      return "This run's worktree was removed; start a new run.";
    case 'run_stopped_by_you':
      return STOPPED;
    case 'no_session':
      return NO_PROMPT;
    default:
      // Route checks (the successor's lane is out of quota, its agent needs Autonomous mode), a prompt
      // too long to go with a successor's handoff context and a one-shot agent still closing its
      // session explain themselves; any other code is "cannot deliver".
      return MESSAGE_CODES.has(code) && message ? message : NO_PROMPT;
  }
}
const MESSAGE_CODES: ReadonlySet<string> = new Set([
  'lane_exhausted',
  'headless_needs_auto',
  'prompt_too_long',
  'session_closing',
]);

/** A suggestion as offered here; `onTicket`: done on the ticket (a link to it), not here. */
export type VisibleSuggestion = RecoverySuggestion & { onTicket: boolean };

/**
 * Suggestions that can be acted on here. Discard and merge need their callbacks; without them they
 * become a link to the ticket (keeping label and detail) when the run has one, else they are left out.
 */
export function visibleSuggestions(
  rec: RunRecovery | null | undefined,
  have: { onDiscard?: unknown; onMerge?: unknown; ticket?: boolean },
): VisibleSuggestion[] {
  if (!rec) return [];
  return rec.suggestions.flatMap((s): VisibleSuggestion[] => {
    const here = s.kind === 'discard' ? !!have.onDiscard : s.kind === 'merge' ? !!have.onMerge : true;
    if (here) return [{ ...s, onTicket: false }];
    return have.ticket ? [{ ...s, onTicket: true }] : [];
  });
}

/** The API sends a lowercase fragment: first letter up, one final stop. */
export function sentenceCase(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const up = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(up) ? up : `${up}.`;
}

/**
 * The head of the recovery block: the hold's label (none in a row that already shows it) and why,
 * as a sentence.
 */
export function recoveryHeading(
  rec: Pick<RunRecovery, 'label' | 'why'>,
  hideLabel: boolean,
): { label: string | null; why: string } {
  return { label: hideLabel ? null : rec.label, why: sentenceCase(rec.why) };
}

/**
 * The confirm step of a discard suggestion, in its own words ("Close as not needed", "Discard this
 * work"); its detail, shown beside it, says what happens to the ticket and the branch.
 */
export function discardConfirm(s: Pick<RecoverySuggestion, 'label'>): { question: string; confirm: string } {
  const label = s.label.trim();
  return { question: `${label}?`, confirm: `Yes, ${label.charAt(0).toLowerCase()}${label.slice(1)}` };
}

export interface ConflictHoldFallback {
  conflicts: string[];
  mainBranch?: string;
  ticketKey?: string | null;
}

function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function shortFileList(files: readonly string[]): string {
  return files.length > 3 ? `${files.slice(0, 3).join(', ')} and ${files.length - 3} more` : files.join(', ');
}

/** Link target for core's in-flight `wait_for_agent` / `wait_for_resolver` recovery items, or null. */
export function waitSuggestionHref(
  s: Pick<RecoverySuggestion, 'id'>,
  run: Pick<Run, 'id' | 'handedOffTo'>,
  resolverRunId?: string | null,
): string | null {
  if (s.id === 'wait_for_agent') return `/runs/${run.id}/review`;
  if (s.id === 'wait_for_resolver') {
    const target = resolverRunId?.trim() || run.handedOffTo?.trim() || null;
    return target ? `/runs/${target}/review` : null;
  }
  return null;
}

/** Client-side Hold Recovery suggestions when a person-initiated merge hits a manual conflict on an unheld run. */
export function buildManualConflictRecovery(
  run: Pick<Run, 'endedAt' | 'cancelled' | 'resumable' | 'worktreePath'>,
  fallback: ConflictHoldFallback,
): RunRecovery {
  const mainBranch = fallback.mainBranch?.trim() || 'main';
  const files = fallback.conflicts;
  const canDeliver = Boolean(run.worktreePath && ((!run.endedAt && !run.cancelled) || run.resumable));
  const count = files.length;
  const plural = `${count} ${count === 1 ? 'conflict' : 'conflicts'}`;
  const main = shellWord(mainBranch);
  const commands = run.worktreePath
    ? [
        `git -C ${shellWord(run.worktreePath)} merge ${main}`,
        `git -C ${shellWord(run.worktreePath)} add -A`,
        `git -C ${shellWord(run.worktreePath)} commit --no-edit`,
      ]
    : [];

  return {
    hold: 'merge_failed',
    label: 'Merge failed',
    why: `the merge into ${mainBranch} conflicted: ${shortFileList(files)}`,
    delivery: canDeliver ? 'session' : 'none',
    suggestions: [
      {
        id: 'resolve_conflicts',
        kind: 'prompt',
        label: 'Resolve conflicts',
        detail: `Ask the agent to merge ${mainBranch} and resolve ${plural}.`,
        prompt: `Merge ${mainBranch} into your branch (git merge ${mainBranch}), resolve the conflicts in: ${files.join(', ')} keeping the intent of both changes, run the project's checks, commit, and finish.`,
        files,
        commands: [],
      },
      {
        id: 'discard',
        kind: 'discard',
        label: 'Discard this work',
        detail: `Move ${fallback.ticketKey ?? 'the ticket'} to Done without merging; the branch is kept until the next cleanup.`,
        prompt: null,
        files: [],
        commands: [],
      },
      {
        id: 'resolve_by_hand',
        kind: 'manual',
        label: 'Resolve by hand',
        detail: `Merge ${mainBranch} into the run's branch in its worktree, fix the conflicts, then commit.`,
        prompt: null,
        files,
        commands,
      },
    ],
  };
}
