import type { Db } from './db/index.js';

export interface SeedShape {
  projects: number;
  ticketsPerProject: number;
  runsPerTicket: number;
  eventsPerRun: number;
}

/** 4 × 25 × 5 runs × 200 events = 100k events, a long-lived single-user install. */
export const LARGE_SEED: SeedShape = {
  projects: 4,
  ticketsPerProject: 25,
  runsPerTicket: 5,
  eventsPerRun: 200,
};

const RUN_STATES = ['done', 'done', 'done', 'failed', 'waiting_input'] as const;
const EVENT_TYPES = ['PreToolUse', 'PostToolUse', 'Notification', 'transcript', 'screen'] as const;

/**
 * Fills a migrated database with projects, tickets, runs and their events through one prepared
 * statement per table inside a single transaction. Event timestamps start at `startMs` and step by
 * one second; each run ends with a `ticket_complete` and a `done`/`failed` state event.
 */
export function seedRunEvents(
  db: Db,
  shape: SeedShape,
  startMs = Date.UTC(2026, 0, 1),
): { runIds: string[] } {
  const sqlite = db.$client;
  const project = sqlite.prepare(
    `insert into projects (id, name, slug, path, created_at) values (?, ?, ?, ?, ?)`,
  );
  const ticket = sqlite.prepare(
    `insert into tickets (id, project_id, number, key, title, status, position, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const run = sqlite.prepare(
    `insert into runs (id, project_id, ticket_id, agent, state, worktree_path, hook_token_hash,
       state_changed_at, created_at, ended_at)
     values (?, ?, ?, 'claude', ?, '/w', 'h', ?, ?, ?)`,
  );
  const event = sqlite.prepare(
    `insert into run_events (run_id, ts, source, type, state, payload) values (?, ?, ?, ?, ?, ?)`,
  );
  const finish = sqlite.prepare(`update runs set state_changed_at = ?, ended_at = ? where id = ?`);
  const runIds: string[] = [];
  let clock = startMs;
  sqlite.transaction(() => {
    for (let p = 0; p < shape.projects; p++) {
      const projectId = `p${p}`;
      project.run(projectId, `P${p}`, `p${p}`, `/w/p${p}`, startMs);
      for (let t = 0; t < shape.ticketsPerProject; t++) {
        const ticketId = `${projectId}-t${t}`;
        const status = t % 3 === 0 ? 'done' : t % 3 === 1 ? 'review' : 'in_progress';
        ticket.run(ticketId, projectId, t + 1, `P${p}-${t + 1}`, `Ticket ${t}`, status, t, startMs, startMs);
        for (let r = 0; r < shape.runsPerTicket; r++) {
          const runId = `${ticketId}-r${r}`;
          const state = RUN_STATES[r % RUN_STATES.length] ?? 'done';
          const createdAt = clock;
          run.run(runId, projectId, ticketId, state, createdAt, createdAt, null);
          event.run(runId, clock, 'system', 'queued', 'queued', '{}');
          for (let e = 1; e < shape.eventsPerRun - 2; e++) {
            clock += 1000;
            const type = EVENT_TYPES[e % EVENT_TYPES.length] ?? 'PreToolUse';
            event.run(
              runId,
              clock,
              'hook',
              type,
              e === 1 ? 'working' : null,
              JSON.stringify({ tool: 'Bash', n: e }),
            );
          }
          clock += 1000;
          event.run(
            runId,
            clock,
            'hook',
            'ticket_complete',
            null,
            JSON.stringify({ summary: `Summary of ${runId}`, handoff: `Handoff of ${runId}` }),
          );
          clock += 1000;
          const final = state === 'waiting_input' ? 'waiting_input' : state;
          event.run(runId, clock, 'hook', final === 'failed' ? 'failed' : 'Stop', final, '{}');
          finish.run(clock, state === 'waiting_input' ? null : clock, runId);
          runIds.push(runId);
        }
      }
    }
  })();
  return { runIds };
}
