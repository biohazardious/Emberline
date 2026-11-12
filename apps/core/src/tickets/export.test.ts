import { type Ticket, TicketExport } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { buildTicketExport, csvCell, statusCounts, ticketExportCsv, ticketExportFileName } from './export.js';

const project = { id: 'p1', name: 'Demo', slug: 'demo' };
const now = new Date('2026-11-12T08:00:00.000Z');

function ticket(over: Partial<Ticket> & Pick<Ticket, 'id' | 'key' | 'status'>): Ticket {
  return {
    projectId: 'p1',
    title: over.key,
    body: '',
    persona: 'coder',
    priority: 1,
    position: 0,
    depth: 0,
    dependsOn: [],
    blockedBy: [],
    completion: null,
    external: null,
    waitingOn: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    ...over,
  };
}

const board = [
  ticket({ id: 'c', key: 'D-3', status: 'done', position: 1 }),
  ticket({
    id: 'b',
    key: 'D-2',
    status: 'ready',
    position: 2,
    dependsOn: ['a', 'gone'],
    blockedBy: [{ id: 'a', key: 'D-1', title: 'D-1', status: 'backlog' }],
  }),
  ticket({ id: 'a', key: 'D-1', status: 'backlog', position: 5 }),
  ticket({ id: 'd', key: 'D-4', status: 'ready', position: 1 }),
];

describe('buildTicketExport', () => {
  it('orders rows by column then position and resolves dependency keys', () => {
    const doc = buildTicketExport(project, board, [], now);
    expect(TicketExport.parse(doc)).toEqual(doc);
    expect(doc.tickets.map((t) => t.key)).toEqual(['D-1', 'D-4', 'D-2', 'D-3']);
    expect(doc.tickets[2]).toMatchObject({ dependsOn: ['D-1', 'gone'], blockedBy: ['D-1'] });
    expect(doc.statuses).toEqual(['backlog', 'ready', 'in_progress', 'review', 'done']);
    expect(doc.counts).toEqual({ backlog: 1, ready: 2, in_progress: 0, review: 0, done: 1 });
    expect(doc.doneRatio).toBe(0.25);
    expect(doc.exportedAt).toBe(now.toISOString());
  });

  it('filters rows by status but keeps whole-board counts', () => {
    const doc = buildTicketExport(project, board, ['done'], now);
    expect(doc.tickets.map((t) => t.key)).toEqual(['D-3']);
    expect(doc.statuses).toEqual(['done']);
    expect(doc.counts.ready).toBe(2);
  });

  it('handles an empty board', () => {
    const doc = buildTicketExport(project, [], [], now);
    expect(doc).toMatchObject({ doneRatio: 0, tickets: [] });
    expect(statusCounts([])).toEqual({ backlog: 0, ready: 0, in_progress: 0, review: 0, done: 0 });
  });
});

describe('CSV', () => {
  it('quotes separators, quotes and newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(3)).toBe('3');
    expect(csvCell(['D-1', 'D-2'])).toBe('D-1; D-2');
  });

  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('writes a BOM, a header row and one CRLF row per ticket', () => {
    const doc = buildTicketExport(
      project,
      [ticket({ id: 'a', key: 'D-1', status: 'review', title: 'Fix, then ship', body: 'line 1\nline 2' })],
      [],
      now,
    );
    const csv = ticketExportCsv(doc);
    expect(csv.startsWith('\uFEFFkey,title,status,priority,persona,')).toBe(true);
    expect(csv).toContain(
      '\r\nD-1,"Fix, then ship",review,1,coder,0,,,,,,2026-11-01T00:00:00.000Z,2026-11-02T00:00:00.000Z,"line 1\nline 2"\r\n',
    );
    expect(ticketExportFileName(doc, 'csv')).toBe('emberline-demo-tickets-2026-11-12.csv');
  });
});
