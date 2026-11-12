import { BULK_TICKET_LIMIT, type BulkTicketResult, type Ticket } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import {
  addAll,
  allSelected,
  bulkResultSummary,
  EMPTY_SELECTION,
  pruneSelection,
  selectionAfter,
  selectRange,
  toggleSelected,
} from './boardSelection';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

const result = (patch: Partial<BulkTicketResult>): BulkTicketResult => ({
  action: 'move',
  updated: [],
  removed: [],
  unchanged: [],
  failed: [],
  ...patch,
});

describe('board selection', () => {
  it('toggles a ticket in and out', () => {
    const once = toggleSelected(EMPTY_SELECTION, 'a');
    expect(once).toEqual(['a']);
    expect(toggleSelected(once, 'a')).toEqual([]);
  });

  it('stops adding at the bulk limit', () => {
    const full = addAll(EMPTY_SELECTION, ids(BULK_TICKET_LIMIT + 5));
    expect(full).toHaveLength(BULK_TICKET_LIMIT);
    expect(toggleSelected(full, 'extra')).toBe(full);
    expect(toggleSelected(full, 't0')).toHaveLength(BULK_TICKET_LIMIT - 1);
  });

  it('selects a range between the anchor and the clicked ticket in either direction', () => {
    const ordered = ['a', 'b', 'c', 'd', 'e'];
    expect(selectRange(['b'], ordered, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(selectRange(['x'], ordered, 'd', 'b')).toEqual(['x', 'b', 'c', 'd']);
    expect(selectRange([], ordered, undefined, 'c')).toEqual(['c']);
    expect(selectRange(['a'], ordered, 'gone', 'c')).toEqual(['a', 'c']);
  });

  it('tells whether a column is fully picked', () => {
    expect(allSelected(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(allSelected(['a'], ['a', 'b'])).toBe(false);
    expect(allSelected(['a'], [])).toBe(false);
  });

  it('prunes picks whose ticket is gone and keeps identity when nothing changed', () => {
    const tickets = [{ id: 'a' }, { id: 'b' }] as Ticket[];
    const kept = ['a', 'b'];
    expect(pruneSelection(kept, tickets)).toBe(kept);
    expect(pruneSelection(['a', 'z'], tickets)).toEqual(['a']);
  });
});

describe('bulk results', () => {
  const failure = (id: string, key: string | null) => ({
    id,
    key,
    code: key ? ('run_active' as const) : ('not_found' as const),
    message: 'x',
  });

  it('summarises updates, unchanged and skipped tickets', () => {
    expect(bulkResultSummary(result({ updated: [{} as Ticket] }))).toBe('Updated 1 ticket');
    expect(
      bulkResultSummary(
        result({ updated: [{} as Ticket, {} as Ticket], unchanged: ['u'], failed: [failure('f', 'K-1')] }),
      ),
    ).toBe('Updated 2 tickets · 1 already set · 1 skipped');
    expect(bulkResultSummary(result({ action: 'delete', removed: ['a', 'b', 'c'] }))).toBe(
      'Deleted 3 tickets',
    );
  });

  it('keeps only the existing tickets that failed picked', () => {
    expect(selectionAfter(result({ failed: [failure('f', 'K-1'), failure('nope', null)] }))).toEqual(['f']);
  });
});
