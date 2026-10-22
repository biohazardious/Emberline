import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db/index.js';
import { projects, runs } from '../db/schema.js';
import { CHAIN_MAX, predecessorChain, successorChain } from './handoff-chain.js';

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = openDb(':memory:'));
  db.insert(projects).values({ id: 'p', name: 'p', slug: 'p', path: '/tmp/p', createdAt: new Date() }).run();
});
afterEach(() => close());

function add(id: string, predecessorRunId: string | null = null): void {
  db.insert(runs)
    .values({
      id,
      projectId: 'p',
      agent: 'claude',
      state: 'done',
      worktreePath: '/tmp/w',
      hookTokenHash: 'x',
      stateChangedAt: new Date(),
      createdAt: new Date(),
      ...(predecessorRunId ? { predecessorRunId } : {}),
    })
    .run();
}

function link(from: string, to: string): void {
  db.update(runs).set({ handedOffTo: to }).where(eq(runs.id, from)).run();
}

describe('handoff chains', () => {
  it('walks back from the newest and forward from the oldest', () => {
    add('A');
    add('B', 'A');
    add('C', 'B');
    link('A', 'B');
    link('B', 'C');
    expect(predecessorChain(db, 'C')).toEqual(['C', 'B', 'A']);
    expect(predecessorChain(db, 'A')).toEqual(['A']);
    expect(successorChain(db, 'A')).toEqual(['A', 'B', 'C']);
    expect(successorChain(db, 'C')).toEqual(['C']);
  });

  it('ends on a planted cycle', () => {
    add('A');
    add('B', 'A');
    add('C', 'B');
    link('A', 'B');
    link('B', 'C');
    link('C', 'A');
    db.update(runs).set({ predecessorRunId: 'C' }).where(eq(runs.id, 'A')).run();
    expect(predecessorChain(db, 'C')).toEqual(['C', 'B', 'A']);
    expect(successorChain(db, 'A')).toEqual(['A', 'B', 'C']);
  });

  it('is bounded by max', () => {
    add('r0');
    for (let i = 1; i < 30; i += 1) add(`r${i}`, `r${i - 1}`);
    expect(predecessorChain(db, 'r29')).toHaveLength(CHAIN_MAX);
    expect(predecessorChain(db, 'r29', 5)).toEqual(['r29', 'r28', 'r27', 'r26', 'r25']);
  });
});
