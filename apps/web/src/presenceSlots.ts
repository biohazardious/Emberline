export type PresenceSource = 'inspector' | 'fleet' | 'inbox';
export const PRESENCE_PRIORITY: readonly PresenceSource[] = ['inspector', 'inbox', 'fleet'];

/** Run reported by the highest-priority slot that holds one. */
export function presentRunId(slots: ReadonlyMap<PresenceSource, string>): string | null {
  return PRESENCE_PRIORITY.map((source) => slots.get(source)).find(Boolean) ?? null;
}

/** Clears a slot only while it still holds `runId`, so a card that lost focus to another does not wipe the new owner. */
export function clearSlotIfOwner(
  slots: Map<PresenceSource, string>,
  runId: string,
  source: PresenceSource,
): boolean {
  if (slots.get(source) !== runId) return false;
  slots.delete(source);
  return true;
}
