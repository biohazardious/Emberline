import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
