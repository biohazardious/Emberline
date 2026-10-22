/** Parsing `.emberline/worktree.yml` (schema v1 or v2): YAML first, then the protocol's zod schema. */
import { type WorktreeChecks, WorktreeConfig, type WorktreeService } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import { parseDocument } from 'yaml';
import type { Db } from '../db/index.js';
import { projectWorktreeConfig } from '../db/schema.js';

export type WorktreeYmlParse = { ok: true; config: WorktreeConfig } | { ok: false; errors: string[] };

/** Never throws: a file that is not valid YAML or not a valid schema comes back with readable errors. */
export function parseWorktreeYml(text: string): WorktreeYmlParse {
  // Aliases expand data; a hostile file could nest them to blow up memory (billion laughs).
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length > 0)
    return { ok: false, errors: doc.errors.map((e) => `YAML: ${e.message.split('\n')[0]}`) };
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
    errors: parsed.error.issues.map((issue) => {
      const allowed = issue.code === 'unrecognized_keys' ? keysAt(issue.path) : null;
      const where = issue.path.length > 0 ? issue.path.join('.') : '(file)';
      return `${where}: ${issue.message}${allowed ? ` (allowed: ${allowed.join(', ')})` : ''}`;
    }),
  };
}

/** The parts of a zod schema's definition the walk below reads (zod 4: `.def`). */
interface SchemaNode {
  def: {
    type: string;
    innerType?: SchemaNode;
    element?: SchemaNode;
    options?: readonly SchemaNode[];
    shape?: Record<string, SchemaNode>;
  };
}

/** Wrappers that keep their inner schema's keys (`.default()`, `.optional()`, ...). */
const WRAPPERS = new Set(['default', 'prefault', 'optional', 'nullable', 'readonly', 'catch', 'nonoptional']);

/** The object schema `node` stands for: through wrappers, and the object option of a union (a copy entry). */
function objectOf(node: SchemaNode | undefined): SchemaNode | null {
  while (node && WRAPPERS.has(node.def.type)) node = node.def.innerType;
  if (!node) return null;
  if (node.def.type === 'object') return node;
  if (node.def.type === 'union')
    return node.def.options?.map(objectOf).find((option) => option !== null) ?? null;
  return null;
}

/**
 * The keys the schema allows at `path` (an object's issue path: root, `checks`, `services.N`,
 * `services.N.compose`, `copy.N`), read from WorktreeConfig itself; null when the path is not an object.
 */
function keysAt(path: readonly PropertyKey[]): string[] | null {
  let node: SchemaNode | undefined = WorktreeConfig as unknown as SchemaNode;
  for (const segment of path) {
    if (typeof segment === 'number') {
      while (node && WRAPPERS.has(node.def.type)) node = node.def.innerType;
      node = node?.def.type === 'array' ? node.def.element : undefined;
    } else {
      node = objectOf(node)?.def.shape?.[String(segment)];
    }
    if (!node) return null;
  }
  const object = objectOf(node);
  return object?.def.shape ? Object.keys(object.def.shape) : null;
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
  const row = db
    .select()
    .from(projectWorktreeConfig)
    .where(eq(projectWorktreeConfig.projectId, projectId))
    .get();
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

/** The approved `setup` commands (empty when none). */
export function approvedSetup(db: Db, projectId: string): string[] {
  return [...(loadApprovedWorktreeConfig(db, projectId)?.config.setup ?? [])];
}

/** Whether a run worktree's setup finished: the newest setup outcome event is `worktree_setup_finished`. */
export function setupFinishedIn(eventTypes: readonly string[]): boolean {
  const last = [...eventTypes]
    .reverse()
    .find((t) => ['worktree_setup_finished', 'worktree_setup_failed', 'worktree_setup_skipped'].includes(t));
  return last === 'worktree_setup_finished';
}
