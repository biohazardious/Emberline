/**
 * Run notes by which the completion pipeline left a ticket in Review for a person: a later
 * dispatch must not merge it behind the gate's back. Tickets read them back, so event pruning
 * keeps them (runs/service.ts spreads this list into its protected kinds).
 */
export const HOLD_EVENTS: readonly string[] = [
  'merge_failed',
  'secret_guard_blocked',
  'slop_guard_blocked',
  'critic_blocked',
  'build_gate_error',
  'build_gate_failed',
  // Held while the agent answers the completion nudge (like build_gate_failed while it fixes the build).
  'completion_nudged',
  'completion_missing',
  'completion_blocked',
  // Open blocking review comments: the person decides (no prompt to the agent).
  'review_blocked',
  // The run changed nothing and did not say why: the person decides (no prompt to the agent).
  'no_changes',
  // The first start after an upgrade could not tell whether the run's checks finished (TicketService.holdUpgradeCandidates).
  'pipeline_interrupted',
];
/**
 * Run notes that end an earlier hold (TicketService.stillHeld): the work was merged (by the
 * pipeline, or by a person through sync-worktree: `merged_by_person`), or the completion gate
 * accepted the agent's signal. `review_unblocked` is different: it only lifts an earlier
 * `review_blocked` (hold-outcome's withoutUnblocked), never another hold. Not holds, and not pipeline outcomes: only `merged_to_main` counts
 * as "merged" for a dispatch's Review finalization. `ticket_removed` (a person deleted the run's
 * ticket) ends whatever hold the run had: nothing is left to review. Protected from pruning.
 */
export const HOLD_ENDING_EVENTS: readonly string[] = [
  'merged_to_main',
  'merged_by_person',
  'completion_accepted',
  'review_unblocked',
  'ticket_removed',
];
