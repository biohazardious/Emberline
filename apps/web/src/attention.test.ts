import type { Run, RunAttention } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import {
  attentionCount,
  dismissable,
  fleetSection,
  attentionDetail,
  groupAttention,
  holdLabel,
  inboxHeading,
  needsElsewhere,
  pendingAttention,
  pruneSeen,
  ticketEventRecomputesAttention,
} from './attention';
import { moreInOtherProjects } from './projectScope';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const attn = (reason: RunAttention['reason'], minutesAgo: number, id: string): RunAttention => ({
  reason,
  detail: null,
  since: iso(minutesAgo),
  occurrence: `${id}:${reason}:e1`,
});

const run = (id: string, overrides: Partial<Run> = {}): Run =>
  ({
    id,
    projectId: 'p',
    ticketId: null,
    title: null,
    agent: 'claude',
    persona: 'coder',
    state: 'working',
    prompt: '',
    permissionMode: 'default',
    branch: null,
    worktreePath: '',
    terminalId: null,
    agentSessionId: null,
    lastEvent: null,
    stateChangedAt: iso(1),
    createdAt: iso(60),
    endedAt: null,
    resumable: false,
    cancelled: false,
    attention: null,
    reviewReady: false,
    ...overrides,
  }) as Run;

describe('groupAttention', () => {
  it('orders groups permission, question, blocked, held, stalled, failed, rate_limited', () => {
    const runs = [
      run('a', { attention: attn('rate_limited', 1, 'a') }),
      run('b', { attention: attn('failed', 2, 'b') }),
      run('c', { attention: attn('stalled', 3, 'c') }),
      run('d', { attention: attn('held', 4, 'd') }),
      run('e', { attention: attn('blocked', 5, 'e') }),
      run('f', { attention: attn('question', 6, 'f') }),
      run('g', { attention: attn('permission', 7, 'g') }),
    ];
    expect(groupAttention(runs, {}).map((g) => g.reason)).toEqual([
      'permission',
      'question',
      'blocked',
      'held',
      'stalled',
      'failed',
      'rate_limited',
    ]);
  });

  it('puts the oldest first within a group and omits empty groups', () => {
    const runs = [
      run('new', { attention: attn('question', 1, 'new') }),
      run('old', { attention: attn('question', 30, 'old') }),
      run('mid', { attention: attn('question', 10, 'mid') }),
      run('idle'),
    ];
    const groups = groupAttention(runs, {});
    expect(groups).toHaveLength(1);
    expect(groups[0]?.runs.map((r) => r.id)).toEqual(['old', 'mid', 'new']);
  });
});

describe('seen by occurrence', () => {
  it('hides a dismissed failed occurrence but shows the next one for the same run', () => {
    const first = run('a', { attention: attn('failed', 5, 'a') });
    const seen = { [first.attention!.occurrence]: NOW };
    expect(pendingAttention([first], seen)).toEqual([]);
    const second = run('a', {
      attention: { ...attn('failed', 1, 'a'), occurrence: 'a:failed:e2' },
    });
    expect(pendingAttention([second], seen)).toHaveLength(1);
  });

  it('never hides reasons that are not dismissable', () => {
    const q = run('a', { attention: attn('question', 5, 'a') });
    const seen = { [q.attention!.occurrence]: NOW };
    expect(pendingAttention([q], seen)).toHaveLength(1);
  });

  it('only failed and rate_limited are dismissable', () => {
    expect(['permission', 'question', 'blocked', 'held', 'stalled'].some((r) => dismissable(r as never))).toBe(false);
    expect(dismissable('failed')).toBe(true);
    expect(dismissable('rate_limited')).toBe(true);
  });

  it('counts across all projects with one number', () => {
    const runs = [
      run('a', { projectId: 'p1', attention: attn('question', 5, 'a') }),
      run('b', { projectId: 'p2', attention: attn('held', 5, 'b') }),
      run('c', { projectId: 'p2', attention: attn('failed', 5, 'c') }),
      run('d'),
    ];
    expect(attentionCount(runs, {})).toBe(3);
    expect(attentionCount(runs, { 'c:failed:e1': NOW })).toBe(2);
  });

  it('prunes entries whose occurrence no run carries any more', () => {
    const runs = [run('a', { attention: attn('failed', 5, 'a') })];
    expect(pruneSeen({ 'a:failed:e1': 1, 'gone:failed:e1': 2 }, runs)).toEqual({ 'a:failed:e1': 1 });
  });
});

describe('fleetSection', () => {
  const ctx = { now: NOW, seen: {}, hidden: new Set<string>() };

  it('assigns needs, review, working and recent', () => {
    expect(fleetSection(run('a', { state: 'waiting_input', attention: attn('question', 1, 'a') }), ctx)).toBe('needs');
    expect(fleetSection(run('b', { state: 'done', endedAt: iso(1), reviewReady: true }), ctx)).toBe('review');
    expect(fleetSection(run('c', { state: 'queued' }), ctx)).toBe('working');
    expect(fleetSection(run('d', { state: 'starting' }), ctx)).toBe('working');
    expect(
      fleetSection(
        run('e', { state: 'rate_limited', autoRetry: { attempt: 1, max: 3, at: iso(-1) } }),
        ctx,
      ),
    ).toBe('working');
    expect(fleetSection(run('f', { state: 'done', endedAt: iso(5) }), ctx)).toBe('recent');
  });

  it('drops finished runs past the 15 minute window or hidden by the user', () => {
    expect(fleetSection(run('a', { state: 'done', endedAt: iso(16) }), ctx)).toBeNull();
    expect(fleetSection(run('b', { state: 'done', endedAt: iso(1) }), { ...ctx, hidden: new Set(['b']) })).toBeNull();
  });

  it('a dismissed failure leaves Needs you and falls back to the recent window', () => {
    const r = run('a', { state: 'failed', endedAt: iso(2), attention: attn('failed', 2, 'a') });
    expect(fleetSection(r, ctx)).toBe('needs');
    expect(fleetSection(r, { ...ctx, seen: { 'a:failed:e1': NOW } })).toBe('recent');
  });
});

describe('holdLabel', () => {
  it('maps known keys and leaves other text alone, including prototype names', () => {
    expect(holdLabel('constructor')).toBe('constructor');
    expect(holdLabel('toString')).toBe('toString');
    expect(holdLabel('some agent text')).toBe('some agent text');
  });
});

describe('attentionDetail', () => {
  const at = (reason: RunAttention['reason'], detail: string | null): RunAttention => ({ ...attn(reason, 0, 'x'), detail });
  it('says what a headless agent outside Autonomous mode needs instead of its failure code', () => {
    const text = attentionDetail(at('failed', 'headless_needs_auto'));
    expect(text).not.toContain('headless_needs_auto');
    expect(text).toContain('Autonomous mode');
  });
  it('maps hold keys, keeps other failure types and agent text, and has nothing for no detail', () => {
    expect(attentionDetail(at('held', 'no_changes'))).toBe('Finished without changes');
    expect(attentionDetail(at('failed', 'agent_not_signed_in'))).toBe('agent_not_signed_in');
    expect(attentionDetail(at('question', 'headless_needs_auto'))).toBe('headless_needs_auto');
    expect(attentionDetail(at('failed', null))).toBeNull();
  });
});

describe('inboxHeading', () => {
  it('names the ticket by key and current title, else the run title', () => {
    const ticketRun = run('a', { ticketId: 't1', title: 'EMB-4 Old name' });
    expect(inboxHeading(ticketRun, new Map([['t1', { key: 'EMB-4', title: 'New name' }]]))).toEqual({ key: 'EMB-4', title: 'New name' });
    // Tickets not loaded (yet): the run title, which starts with the key.
    expect(inboxHeading(ticketRun, new Map())).toEqual({ key: null, title: 'EMB-4 Old name' });
    expect(inboxHeading(run('b'), new Map())).toEqual({ key: null, title: 'Ad-hoc run' });
  });
});

describe('needsElsewhere', () => {
  it('counts pending attention outside the project in view, none when all projects are shown', () => {
    const runs = [
      run('a', { projectId: 'p1', attention: attn('question', 5, 'a') }),
      run('b', { projectId: 'p2', attention: attn('held', 5, 'b') }),
      run('c', { projectId: 'p2', attention: attn('failed', 5, 'c') }),
      run('d', { projectId: 'p2' }),
    ];
    expect(needsElsewhere(runs, {}, 'p1')).toBe(2);
    expect(needsElsewhere(runs, { 'c:failed:e1': NOW }, 'p1')).toBe(1);
    expect(needsElsewhere(runs, {}, 'p2')).toBe(1);
    expect(needsElsewhere(runs, {}, null)).toBe(0);
  });
});

describe('needs elsewhere line', () => {
  it("counts other projects' pending runs for the spec's line", () => {
    const runs = [
      run('a', { projectId: 'p1', attention: attn('question', 5, 'a') }),
      run('b', { projectId: 'p2', attention: attn('held', 5, 'b') }),
    ];
    expect(needsElsewhere(runs, {}, 'p3')).toBe(2);
    expect(moreInOtherProjects(needsElsewhere(runs, {}, 'p3'))).toBe('2 more in other projects');
    expect(moreInOtherProjects(needsElsewhere(runs, {}, null))).toBeNull();
  });
});

describe('ticketEventRecomputesAttention', () => {
  const ticket = (status: string) => ({ id: 't1', status }) as never;
  it('asks for fresh runs when a ticket changes column, is new, or its project is not cached; not for other edits', () => {
    expect(ticketEventRecomputesAttention([ticket('review')], ticket('done'))).toBe(true);
    expect(ticketEventRecomputesAttention([ticket('review')], ticket('in_progress'))).toBe(true);
    expect(ticketEventRecomputesAttention([], ticket('review'))).toBe(true);
    expect(ticketEventRecomputesAttention(undefined, ticket('review'))).toBe(true);
    expect(ticketEventRecomputesAttention([ticket('review')], ticket('review'))).toBe(false);
  });
});
