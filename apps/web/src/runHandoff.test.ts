import type { Run } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { withHandoff } from './runHandoff';

const run = (id: string, patch: Partial<Run> = {}): Run =>
  ({ id, state: 'rate_limited', endedAt: null, handedOffTo: null, resumable: false, ...patch }) as Run;

describe('withHandoff', () => {
  it('shows the predecessor as handed off and lists the successor', () => {
    const predecessor = run('a');
    const successor = run('b', { state: 'queued', predecessorRunId: 'a' });
    const next = withHandoff([predecessor, run('c')], predecessor, successor, new Date('2026-10-16T12:00:00Z'));
    expect(next.map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(next[1]).toMatchObject({ state: 'done', handedOffTo: 'b', endedAt: '2026-10-16T12:00:00.000Z', resumable: false });
  });

  it('builds on the entries the event stream already updated, not on the older copies', () => {
    const stale = run('a');
    const pushed = run('a', { state: 'done', handedOffTo: 'b', endedAt: '2026-10-16T11:59:59.000Z' });
    const live = run('b', { state: 'working', predecessorRunId: 'a' });
    const next = withHandoff([live, pushed], stale, run('b', { state: 'queued', predecessorRunId: 'a' }));
    expect(next).toEqual([live, pushed]);
  });
});
