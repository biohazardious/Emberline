import { describe, expect, it } from 'vitest';
import { TicketExportQuery } from './ticket-export.js';

describe('TicketExportQuery', () => {
  it('defaults to JSON over every column', () => {
    expect(TicketExportQuery.parse({})).toEqual({ format: 'json', status: [] });
  });

  it('parses a status list into board order without repeats', () => {
    expect(TicketExportQuery.parse({ format: 'csv', status: ' review, ready,review,' })).toEqual({
      format: 'csv',
      status: ['ready', 'review'],
    });
  });

  it('rejects unknown statuses, formats and keys', () => {
    expect(TicketExportQuery.safeParse({ status: 'ready,shipped' }).success).toBe(false);
    expect(TicketExportQuery.safeParse({ format: 'xlsx' }).success).toBe(false);
    expect(TicketExportQuery.safeParse({ formats: 'csv' }).success).toBe(false);
    expect(TicketExportQuery.safeParse({ status: 'ready,'.repeat(50) }).success).toBe(false);
  });
});
