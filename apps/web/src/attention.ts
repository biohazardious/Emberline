import type { Run, RunAttentionReason } from '@emberline/protocol';

/** Inbox group order: what blocks a run hardest comes first. */
export const ATTENTION_ORDER: readonly RunAttentionReason[] = [
  'permission',
  'question',
  'blocked',
  'held',
  'stalled',
  'failed',
  'rate_limited',
];

export const ATTENTION_LABELS: Record<RunAttentionReason, string> = {
  permission: 'Permission',
  question: 'Question',
  blocked: 'Blocked',
  held: 'Held',
  stalled: 'Stalled',
  failed: 'Failed',
  rate_limited: 'Rate limited',
};

/** Acknowledged occurrences: occurrence id -> time it was dismissed. */
export type SeenMap = Record<string, number>;

/** Only failures and usage limits can be dismissed; the rest clear when the run is unblocked. */
export function dismissable(reason: RunAttentionReason): boolean {
  return reason === 'failed' || reason === 'rate_limited';
}

function isDismissed(run: Run, seen: SeenMap): boolean {
  const a = run.attention;
  return Boolean(a && dismissable(a.reason) && seen[a.occurrence] !== undefined);
}

/** Runs that need a person right now, oldest first: attention set and not dismissed. */
export function pendingAttention(runs: readonly Run[], seen: SeenMap): Run[] {
  return runs
    .filter((run) => run.attention && !isDismissed(run, seen))
    .sort((a, b) => Date.parse(a.attention!.since) - Date.parse(b.attention!.since));
}

/** The one number shown in the sidebar, the header pill and the Fleet badge: all projects. */
export function attentionCount(runs: readonly Run[], seen: SeenMap): number {
  return pendingAttention(runs, seen).length;
}

export type AttentionGroup = { reason: RunAttentionReason; runs: Run[] };

/** Pending runs grouped in ATTENTION_ORDER, oldest first inside a group; empty groups are left out. */
export function groupAttention(runs: readonly Run[], seen: SeenMap): AttentionGroup[] {
  const pending = pendingAttention(runs, seen);
  return ATTENTION_ORDER.map((reason) => ({
    reason,
    runs: pending.filter((run) => run.attention?.reason === reason),
  })).filter((group) => group.runs.length > 0);
}

/** Drops acknowledgements for occurrences no run carries any more, so the stored map stays small. */
export function pruneSeen(seen: SeenMap, runs: readonly Run[]): SeenMap {
  const live = new Set(runs.flatMap((run) => (run.attention ? [run.attention.occurrence] : [])));
  return Object.fromEntries(Object.entries(seen).filter(([occurrence]) => live.has(occurrence)));
}

export type FleetSection = 'needs' | 'review' | 'working' | 'recent';

/** A finished run stays in the Active view this long, so its last answer can still be read. */
export const FINISHED_GRACE_MS = 15 * 60_000;

export function isRunCompleted(run: Run): boolean {
  return Boolean(run.endedAt) || run.state === 'done' || run.state === 'failed';
}

/** Section of the Fleet Active view a run belongs to, or null when it is not shown there. */
export function fleetSection(
  run: Run,
  ctx: { now: number; seen: SeenMap; hidden: ReadonlySet<string> },
): FleetSection | null {
  if (run.attention && !isDismissed(run, ctx.seen)) return 'needs';
  if (run.reviewReady && !ctx.hidden.has(run.id)) return 'review';
  if (!isRunCompleted(run)) return 'working';
  const ended = Date.parse(run.endedAt ?? run.stateChangedAt);
  if (!ctx.hidden.has(run.id) && ctx.now - ended < FINISHED_GRACE_MS) return 'recent';
  return null;
}

export const FLEET_SECTION_LABELS: Record<FleetSection, string> = {
  needs: 'Needs you',
  review: 'Ready for review',
  working: 'Working',
  recent: 'Recently finished',
};
export const FLEET_SECTION_ORDER: readonly FleetSection[] = ['needs', 'review', 'working', 'recent'];
