import { type AgentId, type ReleaseDraft, selectProviderModelByRank } from '@emberline/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { readRepositorySettings, workingBranchOf, writeRepositorySettings } from '../db/project-settings.js';
import { tickets } from '../db/schema.js';
import { badRequest } from '../errors.js';
import { getFactorySettings } from '../factory/settings.js';
import { runStructuredCommand, structuredCommand, supportsRivalReview } from '../factory/rival-critic.js';
import { realGit } from '../repository/git.js';
import { ticketKeyOf } from './history.js';
import { VERSION_TAG_MATCH } from './release.js';

export const ReleaseNotesAnswer = z.object({
  bump: z.enum(['patch', 'minor', 'major']),
  notes: z.string().min(1).max(20_000),
});
export type ReleaseNotesAnswer = z.infer<typeof ReleaseNotesAnswer>;

/** The schema the CLI enforces on its final answer (`--json-schema`). */
export const RELEASE_NOTES_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    bump: { type: 'string', enum: ['patch', 'minor', 'major'] },
    notes: { type: 'string' },
  },
  required: ['bump', 'notes'],
});

const MAX_COMMITS = 300;
const MAX_BODY_CHARS = 2_000;
const MAX_DIFFSTAT_CHARS = 20_000;
const DRAFT_TIMEOUT_MS = 5 * 60_000;
const DRAFT_STOP_TIMEOUT_MS = 2_000;
/** Agents that can write the notes, in the order they are tried. */
const NOTES_AGENTS: AgentId[] = ['claude', 'antigravity'];
/** Git's empty tree: the base of a diff when nothing was released yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbb4830c';

export const NO_AGENT_MESSAGE = 'No signed-in agent can write release notes; write them yourself below.';

/** The next version after `lastTag` (`null`: v0.1.0); the tag's `v` prefix is kept. */
export function suggestVersion(lastTag: string | null, bump: 'patch' | 'minor' | 'major'): string {
  if (lastTag === null) return 'v0.1.0';
  const match = /^(v?)(\d+)\.(\d+)\.(\d+)/.exec(lastTag);
  if (!match) return 'v0.1.0';
  const [major, minor, patch] = [Number(match[2]), Number(match[3]), Number(match[4])];
  const next =
    bump === 'major'
      ? [major + 1, 0, 0]
      : bump === 'minor'
        ? [major, minor + 1, 0]
        : [major, minor, patch + 1];
  return `${match[1]}${next.join('.')}`;
}

export interface ReleaseRange {
  baseTag: string | null;
  head: string;
  commits: { sha: string; subject: string; body: string }[];
  /** Commits beyond the cap that are not listed. */
  omittedCommits?: number;
  diffstat: string;
}

/** What goes into the next release: the commits of the working branch since main's last version tag. */
export async function releaseRange(mainPath: string, main: string, working: string): Promise<ReleaseRange> {
  const baseTag = await realGit(
    ['describe', '--tags', '--abbrev=0', ...VERSION_TAG_MATCH, main],
    mainPath,
  ).then(
    (r) => r.stdout.trim() || null,
    () => null,
  );
  const head = (await realGit(['rev-parse', '--verify', `refs/heads/${working}`], mainPath)).stdout.trim();
  const log = await realGit(
    [
      'log',
      `--max-count=${MAX_COMMITS}`,
      '--format=%H%x00%s%x00%b%x1e',
      baseTag ? `${baseTag}..${head}` : head,
    ],
    mainPath,
  );
  const total = Number(
    (await realGit(['rev-list', '--count', baseTag ? `${baseTag}..${head}` : head], mainPath).then(
      (r) => r.stdout.trim(),
      () => '0',
    )) || 0,
  );
  const commits = log.stdout
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha = '', subject = '', body = ''] = record.split('\0');
      return { sha, subject, body: body.trim().slice(0, MAX_BODY_CHARS) };
    });
  const stat = await realGit(['diff', '--stat', baseTag ?? EMPTY_TREE, head], mainPath).then(
    (r) => r.stdout,
    () => '',
  );
  return {
    baseTag,
    head,
    commits,
    ...(total > commits.length ? { omittedCommits: total - commits.length } : {}),
    diffstat: stat.slice(0, MAX_DIFFSTAT_CHARS),
  };
}

/** The whole prompt is one argv string; Linux refuses one argument over 128 KiB, so stay well below. */
export const MAX_PROMPT_CHARS = 100_000;
const COMMIT_BUDGET_CHARS = 80_000;
const MAX_TICKET_LINES = 100;
const oneLine = (text: string, max = 300) => text.replace(/\s+/g, ' ').trim().slice(0, max);

export function buildReleaseNotesPrompt(
  range: ReleaseRange,
  ticketTitles: { key: string; title: string }[],
): string {
  const withBodies = (c: ReleaseRange['commits'][number]) =>
    `- ${oneLine(c.subject)}${c.body ? `\n${indent(c.body)}` : ''}`;
  const size = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0);
  // Bodies go first, then the oldest commits (the list is newest first).
  let lines = range.commits.map(withBodies);
  let bodiesDropped = false;
  if (size(lines) > COMMIT_BUDGET_CHARS) {
    bodiesDropped = true;
    lines = range.commits.map((c) => `- ${oneLine(c.subject)}`);
  }
  let kept = lines.length;
  let used = size(lines);
  while (kept > 0 && used > COMMIT_BUDGET_CHARS) used -= (lines[--kept] as string).length + 1;
  const omitted = (range.omittedCommits ?? 0) + (lines.length - kept);
  const notes = [
    ...(bodiesDropped ? ['(Commit bodies were left out to keep this short.)'] : []),
    ...(omitted > 0 ? [`(${omitted} older commits omitted.)`] : []),
  ];
  const tickets = ticketTitles
    .slice(0, MAX_TICKET_LINES)
    .map((t) => `- ${oneLine(t.key, 40)}: ${oneLine(t.title)}`);
  const head = [
    'You write the release notes of the next release of this software, from the changes since the last release.',
    'Do NOT modify any files or run commands. You may read files in the repository for context.',
    'Write release notes in Keep a Changelog style with ### Added / ### Changed / ### Fixed / ### Security sections as needed, for the people who use this software, one bullet per user-visible change.',
    'Leave out internal work (refactors, tests, CI) unless a user can notice it.',
    'Choose bump: major for breaking changes, minor for new features, patch otherwise.',
    '',
    `Last release: ${range.baseTag ?? '(none yet)'}`,
    '',
    'Commits since then (newest first):',
    ...lines.slice(0, kept),
    ...notes,
    ...(tickets.length > 0 ? ['', 'Tickets named in the commits:', ...tickets] : []),
    '',
    'Files changed:',
  ];
  const fixed = size(head) + '```\n\n```'.length + 40;
  const stat = (range.diffstat || '(no changes)').slice(0, Math.max(0, MAX_PROMPT_CHARS - fixed));
  return [...head, '```', stat, '```'].join('\n');
}

const indent = (text: string) =>
  text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');

/** The drafts running in the background; core stopping gives them up. */
export class DraftJobs {
  private readonly jobs = new Set<Promise<void>>();
  private readonly owners = new Map<string, number>();
  private stopping = false;

  get stopped(): boolean {
    return this.stopping;
  }

  /** Whether a draft of this project runs right now. */
  runs(projectId: string): boolean {
    return (this.owners.get(projectId) ?? 0) > 0;
  }

  start(projectId: string, fn: () => Promise<void>): void {
    if (this.stopping) return;
    this.owners.set(projectId, (this.owners.get(projectId) ?? 0) + 1);
    const done = fn()
      .catch(() => undefined)
      .finally(() => {
        this.jobs.delete(done);
        const left = (this.owners.get(projectId) ?? 1) - 1;
        if (left > 0) this.owners.set(projectId, left);
        else this.owners.delete(projectId);
      });
    this.jobs.add(done);
  }

  async idle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.all([...this.jobs]);
  }

  /** Waits for running drafts at most `timeoutMs`; one that ends later writes nothing. */
  async stop(timeoutMs = DRAFT_STOP_TIMEOUT_MS): Promise<void> {
    this.stopping = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.idle(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref();
      }),
    ]);
    clearTimeout(timeout);
  }
}

export interface DraftDeps {
  db: Db;
  jobs: DraftJobs;
}

/** The first agent that can write the notes and is signed in, or null. */
function notesAgent(db: Db): AgentId | null {
  const auth = getFactorySettings(db).providerAuth;
  return NOTES_AGENTS.find((a) => supportsRivalReview(a) && auth?.[a]?.authenticated) ?? null;
}

/**
 * Starts the draft and returns it at once (`drafting`); the agent runs in the background and the
 * stored draft turns `ready` or `failed`. A draft whose `head` is no longer the working branch's tip
 * is stale in the UI; nothing deletes it.
 */
export async function draftReleaseNotes(
  deps: DraftDeps,
  project: { id: string; path: string; defaultBranch: string },
): Promise<ReleaseDraft> {
  const { db, jobs } = deps;
  const working = workingBranchOf(readRepositorySettings(db, project.id), project.defaultBranch);
  const head = await realGit(['rev-parse', '--verify', `refs/heads/${working}`], project.path).then(
    (r) => r.stdout.trim(),
    () => {
      throw badRequest('The working branch has no commits to write release notes for.');
    },
  );
  const agent = notesAgent(db);
  const at = new Date().toISOString();
  const base: ReleaseDraft = {
    status: 'drafting',
    head,
    baseTag: null,
    version: null,
    bump: null,
    notes: '',
    agent,
    error: null,
    at,
  };
  // Only the newest draft of the project may write its outcome.
  const finish = (patch: Partial<ReleaseDraft>) => {
    if (jobs.stopped || readRepositorySettings(db, project.id).releaseDraft?.at !== at) return;
    writeRepositorySettings(db, project.id, { releaseDraft: { ...base, ...patch } });
  };
  if (!agent) {
    const failed = { ...base, status: 'failed' as const, error: NO_AGENT_MESSAGE };
    writeRepositorySettings(db, project.id, { releaseDraft: failed });
    return failed;
  }
  writeRepositorySettings(db, project.id, { releaseDraft: base });
  jobs.start(project.id, async () => {
    let baseTag: string | null = null;
    try {
      const range = await releaseRange(project.path, project.defaultBranch, working);
      baseTag = range.baseTag;
      const keys = [...new Set(range.commits.map((c) => ticketKeyOf(c.subject)).filter((k) => k !== null))];
      const titles =
        keys.length === 0
          ? []
          : db
              .select({ key: tickets.key, title: tickets.title })
              .from(tickets)
              .where(and(eq(tickets.projectId, project.id), inArray(tickets.key, keys)))
              .all();
      const command = structuredCommand(
        agent,
        buildReleaseNotesPrompt(range, titles),
        selectProviderModelByRank(agent, 4),
        RELEASE_NOTES_JSON_SCHEMA,
      );
      if (!command) return finish({ status: 'failed', baseTag, error: NO_AGENT_MESSAGE });
      const run = await runStructuredCommand(agent, command, project.path, DRAFT_TIMEOUT_MS);
      if (!run.ok) {
        return finish({
          status: 'failed',
          baseTag,
          error: `The agent could not write the notes: ${run.reason}.`,
        });
      }
      const answer = ReleaseNotesAnswer.safeParse(run.output);
      if (!answer.success) {
        return finish({
          status: 'failed',
          baseTag,
          error: `The ${agent} agent returned no usable release notes.`,
        });
      }
      finish({
        status: 'ready',
        baseTag,
        bump: answer.data.bump,
        notes: answer.data.notes,
        version: suggestVersion(baseTag, answer.data.bump),
      });
    } catch (error) {
      finish({
        status: 'failed',
        baseTag,
        error: `The release notes could not be drafted: ${(error as Error).message}`,
      });
    }
  });
  return base;
}

/**
 * The stored draft as the page shows it: one still `drafting` that no running job owns (core
 * restarted or stopped meanwhile) will never change, so it reads as failed.
 */
export function currentReleaseDraft(deps: DraftDeps, projectId: string): ReleaseDraft | null {
  const draft = readRepositorySettings(deps.db, projectId).releaseDraft;
  if (draft?.status !== 'drafting' || deps.jobs.runs(projectId)) return draft;
  return { ...draft, status: 'failed', error: 'The draft was interrupted; draft again.' };
}
