/**
 * Who Emberline's commits are made as, and what its run-output commits are called. The identity is
 * the factory's (Settings → Factory) unless the project has its own (Project settings → Repository);
 * Emberline's git commands get it as `-c` options and the agents' sessions as GIT_AUTHOR_* /
 * GIT_COMMITTER_* environment variables, so whichever CLI commits, the commit says the same.
 */
import {
  type AgentPersona,
  type CommitIdentity,
  DEFAULT_COMMIT_IDENTITY,
  type Run,
  type Ticket,
} from '@emberline/protocol';
import type { Db } from '../db/index.js';
import { readRepositorySettings } from '../db/project-settings.js';
import { getCommitIdentity } from './settings.js';

/** The project's own identity, else the factory's. A project id that is unknown gets the factory's. */
export function commitIdentityFor(db: Db, projectId: string | null): CommitIdentity {
  if (projectId) {
    const own = readRepositorySettings(db, projectId).commitIdentity;
    if (own) return own;
  }
  return getCommitIdentity(db);
}

/**
 * Command-line config beats repo config, and `author.*` / `committer.*` beat `user.*`: setting all
 * of them keeps a repo's own config from forging who made Emberline's commits.
 */
export function gitIdentityArgs(identity: CommitIdentity = DEFAULT_COMMIT_IDENTITY): string[] {
  return (['user', 'author', 'committer'] as const).flatMap((who) => [
    '-c',
    `${who}.name=${identity.name}`,
    '-c',
    `${who}.email=${identity.email}`,
  ]);
}

/** The environment that makes every commit an agent's git makes carry the identity (it beats any config). */
export function gitIdentityEnv(identity: CommitIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

/** A `Co-Authored-By:` trailer line (any case), as AI CLIs append them. */
const CO_AUTHOR_LINE = /^\s*co-authored-by:.*$/gim;

/** The message without `Co-Authored-By:` trailer lines, and without the blank lines they leave at its end. */
export function stripAttributionTrailers(message: string): string {
  return message.replace(CO_AUTHOR_LINE, '').replace(/\s+$/, '');
}

/** The longest subject a run-output commit gets. */
export const SUBJECT_MAX = 72;

/** `prefix` + `text`, cut on a word boundary with `…` when longer than `max`. */
function capSubject(prefix: string, text: string, max = SUBJECT_MAX): string {
  const full = `${prefix}${text}`;
  if (full.length <= max) return full;
  const room = max - prefix.length - 1;
  if (room <= 0) return `${full.slice(0, max - 1).trimEnd()}…`;
  // One character more: a space right after the cut means the cut already ends a word.
  const head = text.slice(0, room + 1);
  const space = head.lastIndexOf(' ');
  const cut = space > 0 ? text.slice(0, space) : text.slice(0, room);
  return `${prefix}${cut.trimEnd()}…`;
}

/** One line: trailers out, runs of whitespace (line breaks too) collapsed, trimmed. */
function oneLine(text: string): string {
  return stripAttributionTrailers(text).replace(/\s+/g, ' ').trim();
}

/** The conventional type a persona's output is committed as. */
function commitType(persona: AgentPersona | null | undefined): 'test' | 'docs' | 'feat' {
  if (persona === 'qa') return 'test';
  if (persona === 'product_owner') return 'docs';
  return 'feat';
}

/**
 * The subject of a run's output commit: `<type>(<KEY>): <ticket title>` for a ticket's run,
 * `feat: <run title>` for one without a ticket, and the old `feat(<label>): factory run output` when
 * there is no title to use.
 */
export function runOutputSubject(params: {
  label: string;
  ticketKey?: string | null;
  ticketTitle?: string | null;
  runTitle?: string | null;
  persona?: AgentPersona | null;
}): string {
  const ticketTitle = oneLine(params.ticketTitle ?? '');
  if (params.ticketKey && ticketTitle) {
    return capSubject(`${commitType(params.persona)}(${params.ticketKey}): `, ticketTitle);
  }
  const runTitle = oneLine(params.runTitle ?? '');
  if (!params.ticketKey && runTitle) return capSubject('feat: ', runTitle);
  return `feat(${params.label}): factory run output`;
}

/** What a run's merge commits with: the project's identity and the output commit's subject. */
export function runCommit(
  db: Db,
  run: Pick<Run, 'id' | 'projectId' | 'persona' | 'title'>,
  ticket: Pick<Ticket, 'key' | 'title'> | null,
): { identity: CommitIdentity; subject: string } {
  return {
    identity: commitIdentityFor(db, run.projectId),
    subject: runOutputSubject({
      label: ticket?.key ?? run.id.slice(0, 8),
      ticketKey: ticket?.key ?? null,
      ticketTitle: ticket?.title ?? null,
      runTitle: run.title,
      persona: run.persona,
    }),
  };
}
