import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

/** One agent session working on a project. Ticket linkage arrives with the board (M4). */
export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    agent: text('agent').notNull(),
    state: text('state').notNull(),
    prompt: text('prompt').notNull().default(''),
    permissionMode: text('permission_mode').notNull().default('default'),
    branch: text('branch'),
    worktreePath: text('worktree_path').notNull(),
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
