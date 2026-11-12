import { describe, expect, it } from 'vitest';
import { BULK_TICKET_LIMIT, BulkTicketBody } from './ticket-bulk.js';

describe('BulkTicketBody', () => {
  it('parses each action with its own value', () => {
    expect(BulkTicketBody.parse({ action: 'move', ids: [' a '], status: 'ready' })).toEqual({
      action: 'move',
      ids: ['a'],
      status: 'ready',
    });
    expect(BulkTicketBody.parse({ action: 'priority', ids: ['a'], priority: 3 }).action).toBe('priority');
    expect(BulkTicketBody.parse({ action: 'persona', ids: ['a'], persona: 'qa' }).action).toBe('persona');
    expect(BulkTicketBody.parse({ action: 'delete', ids: ['a', 'b'] }).ids).toEqual(['a', 'b']);
  });

  it('rejects a missing or foreign value, unknown actions and keys', () => {
    expect(BulkTicketBody.safeParse({ action: 'move', ids: ['a'] }).success).toBe(false);
    expect(BulkTicketBody.safeParse({ action: 'move', ids: ['a'], status: 'shipped' }).success).toBe(false);
    expect(BulkTicketBody.safeParse({ action: 'priority', ids: ['a'], priority: 4 }).success).toBe(false);
    expect(BulkTicketBody.safeParse({ action: 'delete', ids: ['a'], status: 'done' }).success).toBe(false);
    expect(BulkTicketBody.safeParse({ action: 'archive', ids: ['a'] }).success).toBe(false);
  });

  it('needs between one and the limit of ids', () => {
    expect(BulkTicketBody.safeParse({ action: 'delete', ids: [] }).success).toBe(false);
    const ids = Array.from({ length: BULK_TICKET_LIMIT + 1 }, (_, i) => `t${i}`);
    expect(BulkTicketBody.safeParse({ action: 'delete', ids }).success).toBe(false);
    expect(BulkTicketBody.safeParse({ action: 'delete', ids: ids.slice(1) }).success).toBe(true);
  });
});
