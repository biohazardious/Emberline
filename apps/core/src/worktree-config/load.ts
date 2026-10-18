/** Parsing `.emberline/worktree.yml` (schema v1): YAML first, then the protocol's zod schema. */
import { type WorktreeChecks, WorktreeConfig, type WorktreeService } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import { parseDocument } from 'yaml';
import type { Db } from '../db/index.js';
import { projectWorktreeConfig } from '../db/schema.js';

export type WorktreeYmlParse = { ok: true; config: WorktreeConfig } | { ok: false; errors: string[] };

/** Never throws: a file that is not valid YAML or not schema v1 comes back with readable errors. */
export function parseWorktreeYml(text: string): WorktreeYmlParse {
  // Aliases expand data; a hostile file could nest them to blow up memory (billion laughs).
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length > 0) return { ok: false, errors: doc.errors.map((e) => `YAML: ${e.message.split('\n')[0]}`) };
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return { ok: false, errors: [`YAML: ${(error as Error).message}`] };
  }
  const parsed = WorktreeConfig.safeParse(data);
  if (parsed.success) return { ok: true, config: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(file)'}: ${issue.message}`),
  };
}

export interface ApprovedConfig {
  sha256: string;
  config: WorktreeConfig;
}

/**
 * The project's approved worktree.yml, parsed: the only version runs, previews and the build gate
 * use (never the repo's file). Null without an approval, or when the stored content no longer
 * parses (it was valid when approved).
 */
export function loadApprovedWorktreeConfig(db: Db, projectId: string): ApprovedConfig | null {
  const row = db.select().from(projectWorktreeConfig).where(eq(projectWorktreeConfig.projectId, projectId)).get();
  if (!row) return null;
  const parsed = parseWorktreeYml(row.content);
  return parsed.ok ? { sha256: row.sha256, config: parsed.config } : null;
}

/** The approved `checks`, or null when none is set (the build gate then plans its own steps). */
export function approvedChecks(db: Db, projectId: string): WorktreeChecks | null {
  const checks = loadApprovedWorktreeConfig(db, projectId)?.config.checks;
  return checks && (checks.build || checks.lint || checks.test) ? checks : null;
}

/** The approved service with `preview: true`, if any. */
export function approvedPreviewService(db: Db, projectId: string): WorktreeService | null {
  return loadApprovedWorktreeConfig(db, projectId)?.config.services.find((s) => s.preview) ?? null;
}
