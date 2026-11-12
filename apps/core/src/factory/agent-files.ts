import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { firstZodIssue, type ProjectNotice } from '@emberline/protocol';
import type { z } from 'zod';

export type AgentFileParse<T> = { ok: true; data: T } | { ok: false; issue: string };

/** Parses an agent-written JSON file against its protocol schema; never throws. */
export function parseAgentFile<S extends z.ZodType>(raw: string, schema: S): AgentFileParse<z.output<S>> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { ok: false, issue: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, issue: firstZodIssue(parsed.error) };
}

/** `.emberline/new-tickets.json` -> `.emberline/new-tickets.rejected.json`. */
export function rejectedPathOf(relPath: string): string {
  return relPath.replace(/\.json$/, '') + '.rejected.json';
}

/** A rejected agent file: what was written, where it was kept, and why. */
export type AgentFileRejection = Pick<ProjectNotice, 'file' | 'rejectedAs' | 'issue'>;

/**
 * Moves a rejected agent file aside (replacing an older rejection of the same file), so it is not
 * read again but stays for a person to look at.
 */
export async function keepRejected(
  workspacePath: string,
  relPath: string,
  issue: string,
): Promise<AgentFileRejection> {
  const rejectedAs = rejectedPathOf(relPath);
  const from = path.join(workspacePath, relPath);
  await rename(from, path.join(workspacePath, rejectedAs)).catch(() => rm(from, { force: true }));
  return { file: relPath, rejectedAs, issue: issue.slice(0, 500) };
}
