import { BULK_TICKET_LIMIT, type BulkTicketResult, type Ticket } from '@emberline/protocol';

/** Ids of the tickets picked on the board, in the order they were picked. */
export type BoardSelection = readonly string[];

export const EMPTY_SELECTION: BoardSelection = [];

/** Adds or drops one ticket; adding stops at the bulk limit. */
export function toggleSelected(selection: BoardSelection, id: string): BoardSelection {
  if (selection.includes(id)) return selection.filter((x) => x !== id);
  if (selection.length >= BULK_TICKET_LIMIT) return selection;
  return [...selection, id];
}

/**
 * Shift-click: picks every ticket of `ordered` between the last pick (`anchor`) and `id`, both
 * included. Without an anchor in `ordered` it is a plain toggle.
 */
export function selectRange(
  selection: BoardSelection,
  ordered: readonly string[],
  anchor: string | undefined,
  id: string,
): BoardSelection {
  const from = anchor ? ordered.indexOf(anchor) : -1;
  const to = ordered.indexOf(id);
  if (from === -1 || to === -1) return toggleSelected(selection, id);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return addAll(selection, ordered.slice(lo, hi + 1));
}

/** Picks every id of `ids` not picked yet, up to the bulk limit. */
export function addAll(selection: BoardSelection, ids: readonly string[]): BoardSelection {
  const next = [...selection];
  for (const id of ids) {
    if (next.length >= BULK_TICKET_LIMIT) break;
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

/** Whether every id of `ids` (a column's visible tickets) is picked. */
export function allSelected(selection: BoardSelection, ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every((id) => selection.includes(id));
}

/** Drops picks whose ticket left the board (deleted elsewhere, or another project). */
export function pruneSelection(selection: BoardSelection, tickets: readonly Ticket[]): BoardSelection {
  const present = new Set(tickets.map((t) => t.id));
  const next = selection.filter((id) => present.has(id));
  return next.length === selection.length ? selection : next;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One line for the toast after a bulk action. */
export function bulkResultSummary(result: BulkTicketResult): string {
  const done =
    result.action === 'delete'
      ? `Deleted ${plural(result.removed.length, 'ticket')}`
      : `Updated ${plural(result.updated.length, 'ticket')}`;
  const parts = [done];
  if (result.unchanged.length > 0) parts.push(`${result.unchanged.length} already set`);
  if (result.failed.length > 0) parts.push(`${result.failed.length} skipped`);
  return parts.join(' · ');
}

/** The ids a bulk action leaves picked: only the tickets it could not change, so a retry targets them. */
export function selectionAfter(result: BulkTicketResult): BoardSelection {
  return result.failed.filter((f) => f.key !== null).map((f) => f.id);
}
