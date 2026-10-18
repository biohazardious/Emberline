/**
 * Label sync and write-back for forge issues. Every 10 minutes the poller lists each enabled
 * project's issues with its sync label and imports the open, unlinked ones; linked tickets get the
 * issue's state and labels. Progress on linked tickets (a PR, a merge, Done) is written back as
 * issue comments, each at most once.
 */
import {
  type ForgeIssue,
  type ForgeProvider,
  type ForgePullRequest,
  IssueSyncSettings,
  type IssueSyncStatus,
  type Run,
  type Ticket,
} from '@emberline/protocol';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { readIssueSync } from '../db/project-settings.js';
import { projects, projectSettings, runEvents, runs, tickets } from '../db/schema.js';
import { conflict } from '../errors.js';
import { mainWorkspaceBranch } from '../factory/merge.js';
import { KeyedMutex } from '../keyed-mutex.js';
import type { RunService } from '../runs/service.js';
import type { TicketService } from '../tickets/service.js';
import { type ForgeTarget, RateLimitError } from './issues.js';
import type { ForgeService } from './service.js';

export const ISSUE_SYNC_INTERVAL_MS = 10 * 60_000;
/** Pages read per project and tick, sorted by last update. */
export const SYNC_PAGES = 2;
export const SYNC_PAGE_SIZE = 100;
/** Forge requests one tick may make across all projects. */
export const SYNC_TICK_REQUEST_CAP = 20;

/**
 * One write-back per ticket at a time, process-wide: the check for an earlier record and the
 * comment it guards never interleave, also not between two service instances.
 */
const writeBackLock = new KeyedMutex();

type TicketRow = typeof tickets.$inferSelect;
type LinkedRow = TicketRow & { externalSource: ForgeProvider; externalNumber: number; externalUrl: string; externalId: string };

interface ProjectSyncState {
  lastSyncAt: number | null;
  lastError: string | null;
  /** The ETag of the first list page, valid only for the same repo and label (`key`). */
  etag: { key: string; value: string } | null;
}

export interface IssueSyncOptions {
  now?: () => number;
  log?: (message: string, err?: unknown) => void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/** A short commit sha from a merge note, when it looks like one. */
function shaOf(payload: unknown): string | null {
  const sha = (payload as { commitSha?: unknown } | null)?.commitSha;
  return typeof sha === 'string' && /^[0-9a-f]{4,64}$/i.test(sha) ? sha : null;
}

/** A branch name for a comment: one line, no backticks (it sits inside a code span). */
function branchOf(payload: unknown): string | null {
  const branch = (payload as { branch?: unknown } | null)?.branch;
  if (typeof branch !== 'string') return null;
  const clean = branch.replace(/[`\s\p{Cc}]+/gu, '').slice(0, 200);
  return clean || null;
}

/** Whether the issue URL is in the repository (the path starts with the repo path; any URL style). */
function issueInRepo(issueUrl: string, repoPath: string): boolean {
  try {
    return new URL(issueUrl).pathname.toLowerCase().startsWith(`/${repoPath.toLowerCase()}/`);
  } catch {
    return false;
  }
}

export class IssueSyncService {
  private readonly now: () => number;
  private readonly log: (message: string, err?: unknown) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  /** All forge sync waits until then (epoch ms); in memory, logged once per pause. */
  private pausedUntil: number | null = null;
  /** The project the next tick starts with, after a tick stopped early (cap or pause). */
  private cursor: string | null = null;
  private readonly states = new Map<string, ProjectSyncState>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly tickets: TicketService,
    private readonly runs: RunService,
    private readonly forge: ForgeService,
    options: IssueSyncOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  start(intervalMs = ISSUE_SYNC_INTERVAL_MS): void {
    if (this.timer) return;
    this.runs.on('note', this.onNote);
    this.forge.on('pullRequest', this.onPullRequest);
    this.tickets.on('ticket', this.onTicket);
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.runs.off('note', this.onNote);
    this.forge.off('pullRequest', this.onPullRequest);
    this.tickets.off('ticket', this.onTicket);
  }

  /** Resolves when every write-back started so far has finished. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  status(projectId: string): IssueSyncStatus {
    const state = this.states.get(projectId);
    const paused = this.pausedUntil !== null && this.now() < this.pausedUntil ? this.pausedUntil : null;
    return {
      lastSyncAt: state?.lastSyncAt != null ? new Date(state.lastSyncAt).toISOString() : null,
      lastError: state?.lastError ?? null,
      pausedUntil: paused !== null ? new Date(paused).toISOString() : null,
    };
  }

  // --- Label sync ---------------------------------------------------------------------------

  /** One poll over the enabled projects. Never throws; never overlaps itself. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.runTick();
    } catch (err) {
      this.log('issue sync failed', err);
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(): Promise<void> {
    if (this.isPaused()) return;
    const enabled = this.enabledProjects();
    if (enabled.length === 0) return;
    const from = this.cursor === null ? 0 : Math.max(0, enabled.findIndex((p) => p.projectId >= this.cursor!));
    const order = [...enabled.slice(from), ...enabled.slice(0, from)];
    this.cursor = null;
    const budget = { left: SYNC_TICK_REQUEST_CAP };
    for (const [i, project] of order.entries()) {
      if (budget.left <= 0) {
        this.cursor = project.projectId;
        return;
      }
      const paused = await this.syncProject(project.projectId, project.settings, budget);
      if (paused) {
        this.cursor = order[i + 1]?.projectId ?? null;
        return;
      }
    }
  }

  private isPaused(): boolean {
    if (this.pausedUntil === null) return false;
    if (this.now() < this.pausedUntil) return true;
    this.pausedUntil = null;
    this.log('forge sync resumed');
    return false;
  }

  /** Stops all forge sync until `until`; only the start of a pause is logged. */
  private pause(until: number, reason: string): void {
    const active = this.pausedUntil !== null && this.now() < this.pausedUntil;
    if (active && this.pausedUntil! >= until) return;
    this.pausedUntil = until;
    if (!active) this.log(`forge sync paused until ${new Date(until).toISOString()}: ${reason}`);
  }

  private noteRateLimit(err: unknown): void {
    if (err instanceof RateLimitError) this.pause(err.resetAt, err.message);
  }

  private enabledProjects(): { projectId: string; settings: IssueSyncSettings }[] {
    const out: { projectId: string; settings: IssueSyncSettings }[] = [];
    for (const row of this.db.select().from(projectSettings).all()) {
      const parsed = IssueSyncSettings.safeParse((row.settings as { issueSync?: unknown } | null)?.issueSync ?? {});
      if (parsed.success && parsed.data.enabled && parsed.data.label) out.push({ projectId: row.projectId, settings: parsed.data });
    }
    return out.sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0));
  }

  private stateOf(projectId: string): ProjectSyncState {
    let state = this.states.get(projectId);
    if (!state) {
      state = { lastSyncAt: null, lastError: null, etag: null };
      this.states.set(projectId, state);
    }
    return state;
  }

  /** Syncs one project within the tick's budget; true when the forge asked to pause. */
  private async syncProject(projectId: string, settings: IssueSyncSettings, budget: { left: number }): Promise<boolean> {
    const state = this.stateOf(projectId);
    try {
      const target = await this.forge.projectRemote(projectId);
      const source = target.remote.provider;
      const key = `${source}|${target.remote.apiBaseUrl}|${target.remote.repoPath}|${settings.label}`;
      const known = state.etag?.key === key ? state.etag.value : null;
      const items: ForgeIssue[] = [];
      let etag: string | null = null;
      let complete = false;
      let low: { remaining: number | null; resetAt: number | null } | null = null;
      for (let page = 1; page <= SYNC_PAGES && budget.left > 0; page++) {
        budget.left--;
        // All states: a linked issue that was closed must show up too. Only open ones are imported.
        const res = await this.forge.issues.list(target, {
          state: 'all',
          labels: settings.label,
          page,
          perPage: SYNC_PAGE_SIZE,
          etag: page === 1 ? known : null,
        });
        if (res.rateLimit.low) low = res.rateLimit;
        if (page === 1 && res.notModified) {
          etag = known;
          complete = true;
          break;
        }
        if (page === 1) etag = res.etag;
        items.push(...res.items);
        if (res.nextPage === null || page === SYNC_PAGES) {
          complete = true;
          break;
        }
        if (low) break;
      }
      this.apply(projectId, source, settings, items);
      state.lastSyncAt = this.now();
      state.lastError = null;
      // A page 1 that was read without what follows it must be read again next time.
      state.etag = complete && etag ? { key, value: etag } : null;
      if (low) {
        this.pause(low.resetAt ?? this.now() + ISSUE_SYNC_INTERVAL_MS, `${low.remaining ?? 'few'} forge requests left`);
        return true;
      }
      return false;
    } catch (err) {
      state.lastError = messageOf(err);
      if (err instanceof RateLimitError) {
        this.noteRateLimit(err);
        return true;
      }
      return false;
    }
  }

  /**
   * Imports the open, unlinked issues: into the configured status only when a trusted author opened
   * them (anyone can open an issue with an auto-applied label), into Backlog otherwise. Linked
   * tickets get the issue's state and labels and are never moved.
   */
  private apply(projectId: string, source: ForgeProvider, settings: IssueSyncSettings, items: ForgeIssue[]): void {
    if (items.length === 0) return;
    const linked = this.tickets.linkedTickets(
      projectId,
      source,
      items.map((i) => i.externalId),
    );
    const trusted = new Set(settings.trustedAuthors.map((a) => a.toLowerCase()));
    const isTrusted = (issue: ForgeIssue) => issue.author !== null && trusted.has(issue.author.toLowerCase());
    const fresh = items.filter((i) => i.state === 'open' && !linked.has(i.externalId));
    const promoted = settings.status === 'backlog' ? [] : fresh.filter(isTrusted);
    const backlog = fresh.filter((i) => !promoted.includes(i));
    if (promoted.length > 0) this.tickets.importIssues(projectId, source, promoted, settings.status);
    if (backlog.length > 0) this.tickets.importIssues(projectId, source, backlog, 'backlog');
    const known = items.filter((i) => linked.has(i.externalId));
    if (known.length > 0) this.tickets.syncIssueLinks(projectId, source, known, new Date(this.now()));
  }

  // --- Write-back ---------------------------------------------------------------------------

  private readonly onNote = (run: Run, type: string, payload: unknown): void => {
    if (type === 'merged_to_main') this.track(() => this.commentMerge(run, payload));
  };

  private readonly onPullRequest = (runId: string, pr: ForgePullRequest): void => {
    this.track(() => this.commentPullRequest(runId, pr));
  };

  private readonly onTicket = (ticket: Ticket): void => {
    if (ticket.status === 'done' && ticket.external?.state === 'open') this.track(() => this.closeDone(ticket.id));
  };

  /** Runs a write-back in the background; it never throws into the caller (the pipeline). */
  private track(fn: () => Promise<void>): void {
    const task = (async () => {
      try {
        await fn();
      } catch (err) {
        this.log('issue write-back failed', err);
      }
    })();
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  private linkedRow(ticketId: string | null | undefined): LinkedRow | null {
    if (!ticketId) return null;
    const row = this.db.select().from(tickets).where(eq(tickets.id, ticketId)).get();
    if (!row?.externalSource || !row.externalId || row.externalNumber === null || !row.externalUrl) return null;
    return row as LinkedRow;
  }

  /** The project's forge, and only when it is still the repository the issue is in. */
  private async targetFor(row: LinkedRow): Promise<ForgeTarget> {
    const target = await this.forge.projectRemote(row.projectId);
    if (target.remote.provider !== row.externalSource || !issueInRepo(row.externalUrl, target.remote.repoPath)) {
      throw conflict(`the project's repository is no longer the one the issue of ${row.key} is in`);
    }
    return target;
  }

  /** Whether a run of the ticket has a note of one of `types` with this ref (and kind, if given). */
  private recorded(ticketId: string, types: string[], ref: string, kind?: string): boolean {
    const rows = this.db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .innerJoin(runs, eq(runEvents.runId, runs.id))
      .where(and(eq(runs.ticketId, ticketId), inArray(runEvents.type, types)))
      .all();
    return rows.some((r) => {
      const p = r.payload as { kind?: unknown; ref?: unknown } | null;
      return p?.ref === ref && (kind === undefined || p.kind === kind);
    });
  }

  /** Posts one comment for (ticket, kind, ref) unless an earlier one was recorded. */
  private async postOnce(runId: string, row: LinkedRow, kind: 'pr' | 'merge', ref: string, text: string): Promise<void> {
    await writeBackLock.run(row.id, async () => {
      if (this.recorded(row.id, ['issue_commented'], ref, kind)) return;
      const info = { kind, ticketKey: row.key, ref };
      try {
        await this.forge.issues.comment(await this.targetFor(row), row.externalNumber, text);
      } catch (err) {
        this.noteRateLimit(err);
        this.runs.note(runId, 'issue_comment_failed', { ...info, message: messageOf(err) });
        return;
      }
      this.runs.note(runId, 'issue_commented', info);
    });
  }

  private async commentPullRequest(runId: string, pr: ForgePullRequest): Promise<void> {
    const run = this.db.select({ ticketId: runs.ticketId }).from(runs).where(eq(runs.id, runId)).get();
    const row = this.linkedRow(run?.ticketId);
    if (!row || !readIssueSync(this.db, row.projectId).commentOnProgress) return;
    await this.postOnce(runId, row, 'pr', pr.url, `Emberline opened ${pr.url} for ${row.key}.`);
  }

  private async commentMerge(run: Run, payload: unknown): Promise<void> {
    const row = this.linkedRow(run.ticketId);
    if (!row || !readIssueSync(this.db, row.projectId).commentOnProgress) return;
    const sha = shaOf(payload);
    // The pipeline notes the merge commit; the branch is what the main workspace has checked out.
    const branch = branchOf(payload) ?? (await this.mainBranch(row.projectId));
    const text = `Emberline merged ${row.key} into \`${branch}\` locally${sha ? ` (${sha})` : ''}. It reaches the remote when the branch is pushed.`;
    await this.postOnce(run.id, row, 'merge', sha ?? `run:${run.id}`, text);
  }

  /** What the main workspace has checked out (runs merge into it), else the project's default branch. */
  private async mainBranch(projectId: string): Promise<string> {
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    const checkedOut = project ? branchOf({ branch: await mainWorkspaceBranch(project.path) }) : null;
    return checkedOut ?? branchOf({ branch: project?.defaultBranch }) ?? 'main';
  }

  /** The ticket's newest merge into main: the run that noted it and its ref (the sha, else the run). */
  private latestMerge(ticketId: string): { runId: string; ref: string } | null {
    const event = this.db
      .select({ runId: runEvents.runId, payload: runEvents.payload })
      .from(runEvents)
      .innerJoin(runs, eq(runEvents.runId, runs.id))
      .where(and(eq(runs.ticketId, ticketId), eq(runEvents.type, 'merged_to_main')))
      .orderBy(desc(runEvents.id))
      .limit(1)
      .get();
    return event ? { runId: event.runId, ref: shaOf(event.payload) ?? `run:${event.runId}` } : null;
  }

  /**
   * closeOnDone: a merged ticket in Done closes its issue, with a comment. One attempt per merge:
   * a failure is noted (`issue_close_failed`) and not retried.
   */
  private async closeDone(ticketId: string): Promise<void> {
    const first = this.linkedRow(ticketId);
    if (!first || !readIssueSync(this.db, first.projectId).closeOnDone) return;
    const merge = this.latestMerge(ticketId);
    if (!merge) return;
    await writeBackLock.run(ticketId, async () => {
      const row = this.linkedRow(ticketId);
      if (!row || row.status !== 'done' || row.externalState !== 'open') return;
      if (this.recorded(ticketId, ['issue_closed', 'issue_close_failed'], merge.ref)) return;
      const info = { ticketKey: row.key, ref: merge.ref };
      let target: ForgeTarget;
      try {
        target = await this.targetFor(row);
        await this.forge.issues.close(target, row.externalNumber);
      } catch (err) {
        this.noteRateLimit(err);
        this.runs.note(merge.runId, 'issue_close_failed', { ...info, message: messageOf(err) });
        return;
      }
      this.runs.note(merge.runId, 'issue_closed', info);
      this.tickets.syncIssueLinks(
        row.projectId,
        row.externalSource,
        [{ externalId: row.externalId, state: 'closed', labels: row.externalLabels ?? [] }],
        new Date(this.now()),
      );
      try {
        await this.forge.issues.comment(target, row.externalNumber, `Emberline closed this issue because ${row.key} is done.`);
        this.runs.note(merge.runId, 'issue_commented', { kind: 'close', ...info });
      } catch (err) {
        this.noteRateLimit(err);
        this.runs.note(merge.runId, 'issue_comment_failed', { kind: 'close', ...info, message: messageOf(err) });
      }
    });
  }
}
