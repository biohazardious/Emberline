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
  'completion_missing',
  'completion_blocked',
];
