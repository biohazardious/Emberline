import type { Run, RunRecovery, RecoverySuggestion } from '@emberline/protocol';

/** Pure helpers of the held-run recovery block (components/HoldRecovery.tsx). */

/** Recovery is offered for held runs and for runs whose completion was blocked. */
export const recoveryApplies = (run: Pick<Run, 'attention'>): boolean =>
  run.attention?.reason === 'held' || run.attention?.reason === 'blocked';

/** Where a recovery prompt went, as a short note. */
export const deliveryNote = (delivery: 'session' | 'successor'): string =>
  delivery === 'session' ? 'Sent to the agent' : 'Continuing in a new run on the same branch';

const NO_PROMPT = "This run was stopped, so it can't take a prompt. Start a new run or discard the ticket.";

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
    case 'no_session':
      return NO_PROMPT;
    default:
      // Route checks (the successor's lane is out of quota) explain themselves; any other code is "cannot deliver".
      return MESSAGE_CODES.has(code) && message ? message : NO_PROMPT;
  }
}
const MESSAGE_CODES: ReadonlySet<string> = new Set(['lane_exhausted']);

/** Suggestions that can be acted on here: discard and merge need their callbacks. */
export function visibleSuggestions(
  rec: RunRecovery | null | undefined,
  have: { onDiscard?: unknown; onMerge?: unknown },
): RecoverySuggestion[] {
  if (!rec) return [];
  return rec.suggestions.filter((s) => (s.kind === 'discard' ? !!have.onDiscard : s.kind === 'merge' ? !!have.onMerge : true));
}

/** The API sends a lowercase fragment: first letter up, one final stop. */
export function sentenceCase(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const up = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(up) ? up : `${up}.`;
}
