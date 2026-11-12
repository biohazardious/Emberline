import { describe, expect, it } from 'vitest';
import { Ticket } from './tickets.js';

const base = {
  id: 't1',
  projectId: 'p1',
  key: 'EMB-1',
  title: 'Title',
  body: '',
  persona: 'coder',
  status: 'ready',
  priority: 1,
  position: 0,
  depth: 0,
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
};

describe('Ticket.waitingOn', () => {
  it('defaults to null when absent', () => {
    expect(Ticket.parse(base).waitingOn).toBeNull();
  });

  it('carries the busy ticket and the overlapping paths', () => {
    const waitingOn = { ticketId: 't2', key: 'EMB-2', paths: ['apps/core/src/a.ts'] };
    expect(Ticket.parse({ ...base, waitingOn }).waitingOn).toEqual(waitingOn);
  });

  it('rejects a wait without paths', () => {
    expect(Ticket.safeParse({ ...base, waitingOn: { ticketId: 't2', key: 'EMB-2' } }).success).toBe(false);
  });
});
