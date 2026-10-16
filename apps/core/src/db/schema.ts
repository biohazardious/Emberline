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
  /** Factory metadata: application type & structured tech stack. */
  appType: text('app_type').notNull().default('custom'),
  description: text('description').notNull().default(''),
  techStack: text('tech_stack', { mode: 'json' }).$type<Record<string, string> | null>(),
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
    persona: text('persona').notNull().default('coder'),
    status: text('status').notNull(),
    priority: integer('priority').notNull().default(1),
    position: real('position').notNull(),
    /** Agent-ticket generation: 0 = created by a person, n + 1 = created by a run of a depth-n ticket. */
    depth: integer('depth').notNull().default(0),
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
    persona: text('persona').notNull().default('coder'),
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
    /** Set when a user stopped the run; a cancelled run never resumes or turns `done` again. */
    cancelledAt: integer('cancelled_at', { mode: 'timestamp_ms' }),
    /** Automatic retries after temporary provider errors since the last finished turn. */
    autoRetryCount: integer('auto_retry_count').notNull().default(0),
    /** When the scheduler retries the run (it waits as `rate_limited` until then); null otherwise. */
    autoRetryAt: integer('auto_retry_at', { mode: 'timestamp_ms' }),
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
  (t) => [index('run_events_run_idx').on(t.runId, t.id), index('run_events_type_run_idx').on(t.type, t.runId)],
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

/** Recurring cron jobs that automatically spawn agent runs on a schedule (Phase 2.2). */
export const scheduledJobs = sqliteTable(
  'scheduled_jobs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    cronExpr: text('cron_expr').notNull(),
    prompt: text('prompt').notNull(),
    permissionMode: text('permission_mode').notNull().default('acceptEdits'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** IANA zone; null means core's configured zone. */
    timeZone: text('time_zone'),
    overlapPolicy: text('overlap_policy').notNull().default('skip'),
    lastRunId: text('last_run_id').references(() => runs.id, { onDelete: 'set null' }),
    lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
    nextRunAt: integer('next_run_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('scheduled_jobs_project_idx').on(t.projectId)],
);


/** Persistent line comments on a run's diff (Phase 4 code review). */
export const reviewComments = sqliteTable(
  'review_comments',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
    line: integer('line').notNull(),
    /** `modified` (new code) or `original` (removed code). */
    side: text('side').notNull(),
    body: text('body').notNull(),
    /** open -> sent (included in a "request changes" prompt) -> resolved. */
    status: text('status').notNull().default('open'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('review_comments_run_idx').on(t.runId)],
);

/** Files the user marked as viewed, with the diff signature they saw. */
export const reviewFileViews = sqliteTable(
  'review_file_views',
  {
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
    signature: text('signature').notNull(),
    viewedAt: integer('viewed_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('review_file_views_run_file_idx').on(t.runId, t.filePath)],
);
