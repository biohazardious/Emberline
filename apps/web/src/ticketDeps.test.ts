import type { Ticket } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { dependencyCandidates, waitingLabel, waitingTitle } from './ticketDeps';

const t = (id: string, dependsOn: string[] = []): Ticket =>
  ({ id, key: id.toUpperCase(), dependsOn, blockedBy: [] }) as unknown as Ticket;
const blocker = (key: string, status = 'ready') =>
  ({ id: key, key, title: `title ${key}`, status }) as Ticket['blockedBy'][number];

describe('waitingLabel', () => {
  it('is empty without blockers', () => expect(waitingLabel([])).toBeUndefined());
  it('names a single blocker', () => expect(waitingLabel([blocker('EMB-1')])).toBe('⏳ waiting for EMB-1'));
  it('counts several', () => expect(waitingLabel([blocker('A'), blocker('B')])).toBe('⏳ waiting for 2 tickets'));
  it('lists key, title and status', () =>
    expect(waitingTitle([blocker('A', 'in_progress')])).toBe('A title A (in progress)'));
});

describe('dependencyCandidates', () => {
  it('excludes itself, existing dependencies and transitive dependents', () => {
    const a = t('a', ['x']);
    const all = [a, t('b', ['a']), t('c', ['b']), t('d'), t('x')];
    expect(dependencyCandidates(a, all).map((k) => k.id)).toEqual(['d']);
  });
});
