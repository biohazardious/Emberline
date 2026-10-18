/** Parsing `.emberline/worktree.yml` (schema v1): YAML first, then the protocol's zod schema. */
import { WorktreeConfig } from '@emberline/protocol';
import { parseDocument } from 'yaml';

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
