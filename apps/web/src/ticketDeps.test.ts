import type { Ticket } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import {
  dependencyCandidates,
  dropIntoInProgress,
  overlapWaitingFor,
  overlapWaitingLabel,
  overlapWaitingTitle,
  startableCount,
  waitingLabel,
  waitingTitle,
} from './ticketDeps';

const t = (id: string, dependsOn: string[] = []): Ticket =>
  ({ id, key: id.toUpperCase(), dependsOn, blockedBy: [] }) as unknown as Ticket;
const blocker = (key: string, status = 'ready') =>
  ({ id: key, key, title: `title ${key}`, status }) as Ticket['blockedBy'][number];

describe('waitingLabel', () => {
  it('is empty without blockers', () => expect(waitingLabel([])).toBeUndefined());
  it('names a single blocker', () => expect(waitingLabel([blocker('EMB-1')])).toBe('⏳ waiting for EMB-1'));
  it('counts several', () =>
    expect(waitingLabel([blocker('A'), blocker('B')])).toBe('⏳ waiting for 2 tickets'));
  it('lists key, title and status', () =>
    expect(waitingTitle([blocker('A', 'in_progress')])).toBe('A title A (in progress)'));
});

describe('overlapWaiting', () => {
  const wait = {
    ticketId: 't-12',
    key: 'EMB-12',
    paths: ['Makefile', '.github/workflows/ci.yml'],
  };

  it('applies only to ready tickets with waitingOn set', () => {
    expect(overlapWaitingFor({ status: 'ready', waitingOn: wait })).toEqual(wait);
    expect(overlapWaitingFor({ status: 'ready', waitingOn: null })).toBeNull();
    expect(overlapWaitingFor({ status: 'backlog', waitingOn: wait })).toBeNull();
    expect(overlapWaitingFor({ status: 'in_progress', waitingOn: wait })).toBeNull();
    expect(overlapWaitingFor({ status: 'review', waitingOn: wait })).toBeNull();
    expect(overlapWaitingFor({ status: 'done', waitingOn: wait })).toBeNull();
  });

  it('formats single and multi-path compact card labels', () => {
    expect(overlapWaitingLabel({ ticketId: 't-12', key: 'EMB-12', paths: ['Makefile'] })).toBe(
      'Waits for EMB-12 · Makefile',
    );
    expect(overlapWaitingLabel(wait)).toBe('Waits for EMB-12 · Makefile +1');
    expect(overlapWaitingLabel({ ticketId: 't-12', key: 'EMB-12', paths: [] })).toBe('Waits for EMB-12');
  });

  it('lists all overlapping paths in the tooltip title', () => {
    expect(overlapWaitingTitle(wait)).toBe('Waits for EMB-12:\nMakefile\n.github/workflows/ci.yml');
    expect(overlapWaitingTitle({ ticketId: 't-12', key: 'EMB-12', paths: [] })).toBe('Waits for EMB-12');
  });
});

describe('dependencyCandidates', () => {
  it('excludes itself, existing dependencies and transitive dependents', () => {
    const a = t('a', ['x']);
    const all = [a, t('b', ['a']), t('c', ['b']), t('d'), t('x')];
    expect(dependencyCandidates(a, all).map((k) => k.id)).toEqual(['d']);
  });
});

describe('dropIntoInProgress', () => {
  const ready = { ...t('a'), status: 'ready' } as Ticket;
  const blocked = { ...ready, blockedBy: [blocker('B')] } as Ticket;
  it('starts an unblocked ticket when auto-start is on', () =>
    expect(dropIntoInProgress(ready, { autoStart: true, hasLiveRun: false })).toBe('start'));
  it('keeps a ticket that still waits for others in place and asks first', () =>
    expect(dropIntoInProgress(blocked, { autoStart: true, hasLiveRun: false })).toBe('confirm'));
  it('only moves without auto-start or with a live run', () => {
    expect(dropIntoInProgress(blocked, { autoStart: false, hasLiveRun: false })).toBe('move');
    expect(dropIntoInProgress(ready, { autoStart: true, hasLiveRun: true })).toBe('move');
  });
  it('only moves a ticket already in progress', () =>
    expect(
      dropIntoInProgress({ ...ready, status: 'in_progress' } as Ticket, {
        autoStart: true,
        hasLiveRun: false,
      }),
    ).toBe('move'));
});

describe('startableCount', () => {
  const mk = (status: string, blocked = false) =>
    ({ ...t(status + blocked), status, blockedBy: blocked ? [blocker('B')] : [] }) as Ticket;
  const all = [mk('ready'), mk('ready', true), mk('backlog'), mk('backlog', true), mk('done')];
  it('counts unblocked ready tickets', () => expect(startableCount(all, false)).toBe(1));
  it('adds unblocked backlog tickets when backlog pickup is on', () =>
    expect(startableCount(all, true)).toBe(2));
});
