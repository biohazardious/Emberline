import { HOLD_LABELS, type Run, type RunAttention, type RunAttentionReason, type Ticket } from '@emberline/protocol';

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

/** Pending attention outside the project in view (Fleet is project-scoped, the count is global); 0 for all projects. */
export function needsElsewhere(runs: readonly Run[], seen: SeenMap, projectId: string | null | undefined): number {
  return projectId ? pendingAttention(runs, seen).filter((run) => run.projectId !== projectId).length : 0;
}

/**
 * Fleet's note on what other projects add to Needs you: "+N …" next to the section's own runs,
 * "N …" on its own when the project in view has none; null when nothing waits elsewhere.
 */
export function needsElsewhereHint(elsewhere: number, own: number): string | null {
  if (elsewhere <= 0) return null;
  return `${own > 0 ? '+' : ''}${elsewhere} in other projects`;
}

/**
 * Whether a pushed ticket must refresh the runs: a hold is attention only while its ticket is in
 * Review (core decides), and a ticket move emits no run event. True when the status changed, the
 * ticket is new, or its project's tickets are not cached (no way to tell); not for other edits.
 */
export function ticketEventRecomputesAttention(
  cached: readonly Pick<Ticket, 'id' | 'status'>[] | undefined,
  ticket: Pick<Ticket, 'id' | 'status'>,
): boolean {
  const before = cached?.find((t) => t.id === ticket.id);
  return !before || before.status !== ticket.status;
}

export type TicketName = { key: string; title: string };

/** An Inbox item's heading: the ticket's key and current title; the run title when the ticket is not known. */
export function inboxHeading(run: Run, ticketsById: ReadonlyMap<string, TicketName>): { key: string | null; title: string } {
  const ticket = run.ticketId ? ticketsById.get(run.ticketId) : undefined;
  return ticket ? { key: ticket.key, title: ticket.title } : { key: null, title: run.title ?? 'Ad-hoc run' };
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

/** A hold's detail is normally already a label; raw keys map through HOLD_LABELS, anything else (agent text) stays as is. */
export function holdLabel(detail: string): string {
  return Object.hasOwn(HOLD_LABELS, detail) ? HOLD_LABELS[detail]! : detail;
}

/** The failure type of a headless agent started outside Autonomous mode (core's `headless_needs_auto`). */
const HEADLESS_NEEDS_AUTO =
  'This agent runs without a terminal to answer in, so it needs Autonomous mode. Start it in Autonomous mode, or pick another agent.';

/** The Inbox detail: a failure's type is shown as text for the headless refusal; holds via {@link holdLabel}. */
export function attentionDetail(attention: Pick<RunAttention, 'reason' | 'detail'>): string | null {
  if (attention.detail === null) return null;
  if (attention.reason === 'failed' && attention.detail === 'headless_needs_auto') return HEADLESS_NEEDS_AUTO;
  return holdLabel(attention.detail);
}
