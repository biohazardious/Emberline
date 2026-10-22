import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runs } from '../db/schema.js';

/** How many runs of a handoff chain are followed by default. */
export const CHAIN_MAX = 20;

function walk(db: Db, runId: string, max: number, step: (id: string) => string | null | undefined): string[] {
  const chain: string[] = [];
  let id: string | null = runId;
  while (id && chain.length < max && !chain.includes(id)) {
    chain.push(id);
    id = step(id) ?? null;
  }
  return chain;
}

/** The run and the runs it took over from by handoff, the run first, then older (cycle-safe, at most `max`). */
export function predecessorChain(db: Db, runId: string, max = CHAIN_MAX): string[] {
  return walk(
    db,
    runId,
    max,
    (id) => db.select({ p: runs.predecessorRunId }).from(runs).where(eq(runs.id, id)).get()?.p,
  );
}

/** The run and the runs that took over from it by handoff, the run first, then newer (cycle-safe, at most `max`). */
export function successorChain(db: Db, runId: string, max = CHAIN_MAX): string[] {
  return walk(
    db,
    runId,
    max,
    (id) => db.select({ to: runs.handedOffTo }).from(runs).where(eq(runs.id, id)).get()?.to,
  );
}
