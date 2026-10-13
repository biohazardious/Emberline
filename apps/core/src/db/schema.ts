import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Free-form key/value settings (JSON values). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
});

/** Login sessions. `id` is the SHA-256 of the cookie token; the token itself is never stored. */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  userAgent: text('user_agent'),
});

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  repoUrl: text('repo_url'),
  defaultBranch: text('default_branch').notNull().default('main'),
  /** Absolute path inside the shared workspaces volume. */
  path: text('path').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

/** Board tickets (PROJECT.md §5.4). The column mirrors the latest run while one is active. */
export const tickets = sqliteTable(
  'tickets',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Per-project sequence number behind the key (EMB-<number>). */
    number: integer('number').notNull(),
    key: text('key').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    status: text('status').notNull(),
    priority: integer('priority').notNull().default(1),
    position: real('position').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('tickets_project_number_idx').on(t.projectId, t.number)],
);

/** One agent session working on a project, optionally for a ticket. */
export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ticketId: text('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    agent: text('agent').notNull(),
    state: text('state').notNull(),
    prompt: text('prompt').notNull().default(''),
    permissionMode: text('permission_mode').notNull().default('default'),
    branch: text('branch'),
    worktreePath: text('worktree_path').notNull(),
    /** Display title for the agent terminal (e.g. "DP-1 Fix login"); null uses the project name. */
    title: text('title'),
    ptydSessionId: text('ptyd_session_id'),
    agentSessionId: text('agent_session_id'),
    transcriptPath: text('transcript_path'),
    /** SHA-256 of the per-run hook token; the token only lives in the agent's env. */
    hookTokenHash: text('hook_token_hash').notNull(),
    lastEvent: text('last_event'),
    stateChangedAt: integer('state_changed_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('runs_project_idx').on(t.projectId)],
);

export const runEvents = sqliteTable(
  'run_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
    source: text('source').notNull(),
    type: text('type').notNull(),
    /** New state when this event caused a transition. */
    state: text('state'),
    payload: text('payload', { mode: 'json' }).$type<unknown>(),
  },
  (t) => [index('run_events_run_idx').on(t.runId, t.id)],
);

/**
 * Exhausted usage windows of the (single) subscription. A window with `resumedAt` null pauses
 * dispatch until `resumeAt`; timers are derived from these rows, so they survive restarts.
 */
export const quotaWindows = sqliteTable('quota_windows', {
  id: text('id').primaryKey(),
  /** Approximate window start (reset - 5h) when the reset time is known. */
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  exhaustedAt: integer('exhausted_at', { mode: 'timestamp_ms' }).notNull(),
  resetsAt: integer('resets_at', { mode: 'timestamp_ms' }),
  resumeAt: integer('resume_at', { mode: 'timestamp_ms' }).notNull(),
  /** hook | screen | probe */
  source: text('source').notNull(),
  message: text('message'),
  /** Run whose limit opened the window. */
  runId: text('run_id'),
  resumedAt: integer('resumed_at', { mode: 'timestamp_ms' }),
});
