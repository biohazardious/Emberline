import type { Run, Ticket } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import {
  countBoardFlags,
  countBoardPersonas,
  EMPTY_BOARD_FILTER,
  filterBoardTickets,
  isBoardFilterActive,
  parseBoardFilter,
  ticketMatchesBoardFilter,
} from './boardFilter';

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    projectId: 'p1',
    key: 'EMB-19',
    title: 'Responsive dashboard UX & filtering',
    body: 'Polish filter bars and error boundaries across views.',
    persona: 'ui_ux',
    status: 'in_progress',
    priority: 2,
    position: 1024,
    depth: 0,
    dependsOn: [],
    blockedBy: [],
    completion: null,
    external: null,
    waitingOn: null,
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'r1',
    projectId: 'p1',
    ticketId: 't1',
    title: 'EMB-19 Responsive dashboard UX',
    agent: 'claude',
    persona: 'ui_ux',
    state: 'working',
    prompt: 'Implement board filter',
    permissionMode: 'default',
    branch: 'emberline/emb-19-responsive',
    worktreePath: '/workspaces/.worktrees/p1/r1',
    terminalId: 'term-1',
    agentSessionId: null,
    lastEvent: 'tool_use',
    stateChangedAt: '2026-11-12T00:05:00.000Z',
    createdAt: '2026-11-12T00:01:00.000Z',
    endedAt: null,
    resumable: false,
    cancelled: false,
    attention: null,
    reviewReady: false,
    ...overrides,
  } as Run;
}

describe('boardFilter', () => {
  it('recognizes when a filter is empty versus active', () => {
    expect(isBoardFilterActive(EMPTY_BOARD_FILTER)).toBe(false);
    expect(isBoardFilterActive({ ...EMPTY_BOARD_FILTER, query: '   ' })).toBe(false);
    expect(isBoardFilterActive({ ...EMPTY_BOARD_FILTER, query: 'emb' })).toBe(true);
    expect(isBoardFilterActive({ ...EMPTY_BOARD_FILTER, personas: ['qa'] })).toBe(true);
    expect(isBoardFilterActive({ ...EMPTY_BOARD_FILTER, priorities: [3] })).toBe(true);
    expect(isBoardFilterActive({ ...EMPTY_BOARD_FILTER, onlyBlocked: true })).toBe(true);
    expect(isBoardFilterActive({ ...EMPTY_BOARD_FILTER, onlyActiveRun: true })).toBe(true);
  });

  it('matches multi-word queries across ticket fields, external labels, and linked run branch', () => {
    const ticket = makeTicket({
      external: {
        source: 'github',
        number: 404,
        url: 'https://github.com/org/repo/issues/404',
        state: 'open',
        labels: ['accessibility', 'frontend'],
        triage: false,
      },
    });
    const run = makeRun({ branch: 'feat/mobile-drawer', agent: 'codex' });

    expect(
      ticketMatchesBoardFilter(ticket, run, { ...EMPTY_BOARD_FILTER, query: 'emb-19 accessibility' }),
    ).toBe(true);
    expect(
      ticketMatchesBoardFilter(ticket, run, { ...EMPTY_BOARD_FILTER, query: '#404 mobile-drawer' }),
    ).toBe(true);
    expect(ticketMatchesBoardFilter(ticket, run, { ...EMPTY_BOARD_FILTER, query: 'codex dashboard' })).toBe(
      true,
    );
    expect(ticketMatchesBoardFilter(ticket, run, { ...EMPTY_BOARD_FILTER, query: 'emb-19 postgres' })).toBe(
      false,
    );
  });

  it('filters by persona, priority, blocked status, and live run state', () => {
    const t1 = makeTicket({ id: 't1', key: 'EMB-1', persona: 'ui_ux', priority: 3 });
    const t2 = makeTicket({
      id: 't2',
      key: 'EMB-2',
      persona: 'dba',
      priority: 1,
      blockedBy: [{ id: 't1', key: 'EMB-1', title: 'Dep', status: 'in_progress' }],
    });
    const t3 = makeTicket({
      id: 't3',
      key: 'EMB-3',
      persona: 'qa',
      priority: 2,
      completion: {
        runId: 'r3',
        summary: 'Tested',
        handoff: '',
        blockers: ['Missing staging credentials'],
        at: '2026-11-12T01:00:00.000Z',
      },
    });

    const runs = new Map<string, Run>([
      ['t1', makeRun({ id: 'r1', ticketId: 't1', state: 'working', endedAt: null })],
      ['t2', makeRun({ id: 'r2', ticketId: 't2', state: 'done', endedAt: '2026-11-12T01:00:00.000Z' })],
    ]);

    const tickets = [t1, t2, t3];
    expect(countBoardPersonas(tickets)).toMatchObject({ ui_ux: 1, dba: 1, qa: 1, coder: 0 });
    expect(countBoardFlags(tickets, runs)).toEqual({ blocked: 2, activeRun: 1 });

    expect(
      filterBoardTickets(tickets, runs, { ...EMPTY_BOARD_FILTER, onlyBlocked: true }).tickets.map(
        (t) => t.key,
      ),
    ).toEqual(['EMB-2', 'EMB-3']);

    expect(
      filterBoardTickets(tickets, runs, { ...EMPTY_BOARD_FILTER, onlyActiveRun: true }).tickets.map(
        (t) => t.key,
      ),
    ).toEqual(['EMB-1']);

    expect(
      filterBoardTickets(tickets, runs, {
        ...EMPTY_BOARD_FILTER,
        personas: ['ui_ux', 'qa'],
        priorities: [3],
      }).tickets.map((t) => t.key),
    ).toEqual(['EMB-1']);
  });

  it('safely parses stored board filters and discards unknown values or invalid JSON', () => {
    expect(parseBoardFilter(null)).toEqual(EMPTY_BOARD_FILTER);
    expect(parseBoardFilter('{broken-json')).toEqual(EMPTY_BOARD_FILTER);
    expect(
      parseBoardFilter(
        JSON.stringify({
          query: 'kanban',
          personas: ['ui_ux', 'not_a_persona'],
          priorities: [3, 99, -1],
          onlyBlocked: 1,
          onlyActiveRun: false,
        }),
      ),
    ).toEqual({
      query: 'kanban',
      personas: ['ui_ux'],
      priorities: [3],
      onlyBlocked: true,
      onlyActiveRun: false,
    });
  });
});
