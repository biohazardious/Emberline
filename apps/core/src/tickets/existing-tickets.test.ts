import { describe, expect, it } from 'vitest';
import { existingTicketsSection } from './existing-tickets.js';

describe('existingTicketsSection', () => {
  it('is empty without tickets', () => {
    expect(existingTicketsSection([])).toBe('');
  });

  it('lists open tickets before done ones, one line each', () => {
    const section = existingTicketsSection([
      { key: 'EL-1', title: 'Split the big pages', status: 'done' },
      { key: 'EL-2', title: 'Virtualise\n the board', status: 'in_progress' },
      { key: 'EL-3', title: 'Docs', status: 'backlog' },
    ]);
    const lines = section.split('\n');
    expect(lines[0]).toBe('## Existing tickets');
    expect(lines.slice(2)).toEqual([
      '- EL-2 [in progress] Virtualise the board',
      '- EL-3 [backlog] Docs',
      '- EL-1 [done] Split the big pages',
    ]);
  });

  it('stays within its size and says how many it left out', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      key: `EL-${i}`,
      title: `Ticket number ${i}`,
      status: 'done',
    }));
    const section = existingTicketsSection(rows, 1_000);
    expect(section.length).toBeLessThanOrEqual(1_000);
    expect(section).toMatch(/\n- … and \d+ more$/);
    expect(existingTicketsSection(rows, 10)).toBe('');
  });
});
