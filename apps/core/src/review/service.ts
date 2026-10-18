import { randomUUID } from 'node:crypto';
import {
  CreateReviewCommentBody,
  MarkFileViewedBody,
  RequestChangesBody,
  type RequestChangesResponse,
  type ReviewComment,
  type Run,
  type RunReviewState,
  UpdateReviewCommentBody,
} from '@emberline/protocol';
import { and, asc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { reviewComments, reviewFileViews, runEvents, runs as runsTable } from '../db/schema.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { reviewBlockedIsCurrent } from '../runs/hold-outcome.js';
import { KeyedMutex } from '../keyed-mutex.js';
import type { RunService } from '../runs/service.js';
import { anchorTextOf, type Anchored, reanchor } from './anchor.js';
import { openBlockingCount } from './blocking.js';
import { type BatchComment, type BatchKind, newRunFeedbackSection, sameRunPrompt } from './batch.js';

type CommentRow = typeof reviewComments.$inferSelect;
/** A comment as it goes out, with the status it had when the batch was built. */
type Batched = BatchComment & Pick<ReviewComment, 'status'>;

const toComment = (row: CommentRow, anchored: Anchored = { currentLine: row.line, outdated: false }): ReviewComment => ({
  id: row.id,
  runId: row.runId,
  filePath: row.filePath,
  line: row.line,
  side: row.side as ReviewComment['side'],
  body: row.body,
  status: row.status as ReviewComment['status'],
  createdAt: row.createdAt.toISOString(),
  sentAt: row.sentAt?.toISOString() ?? null,
  resolvedAt: row.resolvedAt?.toISOString() ?? null,
  intent: row.intent as ReviewComment['intent'],
  priority: row.priority as ReviewComment['priority'],
  anchorText: row.anchorText,
  anchorHash: row.anchorHash,
  round: row.round,
  verifiedAt: row.verifiedAt?.toISOString() ?? null,
  carriedTo: row.carriedTo,
  currentLine: row.line === null ? null : anchored.currentLine,
  outdated: row.line === null ? false : anchored.outdated,
});

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }, raw: unknown): T {
  const res = schema.safeParse(raw ?? {});
  if (!res.success) throw badRequest(res.error.issues.map((i) => i.message).join('; '));
  return res.data;
}

/**
 * Starts a fresh run of a ticket (TicketService.start, injected to avoid a cycle). `section` builds
 * the extra prompt section for the room the ticket prompt leaves; an idle active run among
 * `replaceIdleRuns` is stopped first.
 */
export type StartTicketRun = (input: {
  ticketId: string;
  permissionMode: Run['permissionMode'];
  persona: Run['persona'];
  section: (room: number) => string;
  replaceIdleRuns: string[];
}) => Promise<Run>;

/** The prompt limit of a run (CreateRunBody / TicketPromptBody). */
const PROMPT_MAX = 20_000;
/** Longest handoff chain followed when settling comments. */
const CHAIN_MAX = 20;
/**
 * A `done` from these is not the agent finishing a turn: it never addresses comments. A CLI that
 * exits cleanly mid-turn reports SessionEnd (working -> done) before its process exit is noticed.
 */
const NOT_A_TURN = new Set(['handed_off', 'process_exited', 'session_lost', 'cancelled', 'SessionEnd', 'idle_session_closed']);

/**
 * Line comments and per-file "viewed" marks on a run's diff, stored in SQLite so a review survives
 * reloads and can be continued after the agent has addressed part of it.
 */
export class ReviewService {
  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly log: (message: string, error?: unknown) => void = (message, error) => console.warn(message, error),
    private readonly startTicketRun?: StartTicketRun,
  ) {}

  /** One request-changes per run at a time: two racing sends would send (and count) a batch twice. */
  private readonly sending = new KeyedMutex();

  private readonly onRun = (run: Run, stateChanged: boolean): void => {
    if (!stateChanged || run.state !== 'done') return;
    try {
      // The done of a handoff successor settles what its predecessors were sent.
      let id: string | null = run.id;
      for (let i = 0; id && i < CHAIN_MAX; i += 1) {
        this.settle(id);
        id = this.db.select({ p: runsTable.predecessorRunId }).from(runsTable).where(eq(runsTable.id, id)).get()?.p ?? null;
      }
    } catch (error) {
      this.log(`review: marking the comments of run ${run.id} addressed failed`, error);
    }
  };

  /** Follows the runs: a run that finishes a turn after comments were sent to it has addressed them. */
  start(): void {
    this.runs.on('run', this.onRun);
  }

  stop(): void {
    this.runs.off('run', this.onRun);
  }

  /** The run and the runs that took over from it by handoff, in order. */
  private chain(runId: string): string[] {
    const ids = [runId];
    let next = this.db.select({ to: runsTable.handedOffTo }).from(runsTable).where(eq(runsTable.id, runId)).get()?.to ?? null;
    while (next && ids.length < CHAIN_MAX && !ids.includes(next)) {
      ids.push(next);
      next = this.db.select({ to: runsTable.handedOffTo }).from(runsTable).where(eq(runsTable.id, next)).get()?.to ?? null;
    }
    return ids;
  }

  /**
   * `sent` -> `addressed` once the agent has taken the prompt and finished that turn: a transition to
   * `working` after the comment's sentAt, followed by a `done` that ends a turn. A done from a
   * handoff, a process exit or a stop is not one, and a prompt queued mid-turn does not count on
   * that turn's Stop. A handed-off run's comments settle on its successors' turns. Run on every
   * done by the listener, and lazily before reads and sends (a done missed across a restart).
   */
  private settle(runId: string): void {
    const pending = this.db
      .select({ sentAt: reviewComments.sentAt })
      .from(reviewComments)
      .where(and(eq(reviewComments.runId, runId), eq(reviewComments.status, 'sent'), isNotNull(reviewComments.sentAt)))
      .all();
    if (pending.length === 0) return;
    const since = new Date(Math.min(...pending.map((p) => p.sentAt!.getTime())));
    const events = this.db
      .select({ runId: runEvents.runId, ts: runEvents.ts, type: runEvents.type, state: runEvents.state })
      .from(runEvents)
      .where(and(inArray(runEvents.runId, this.chain(runId)), isNotNull(runEvents.state), gte(runEvents.ts, since)))
      .orderBy(asc(runEvents.ts), asc(runEvents.id))
      .all();
    const handedOff = new Set<string>();
    let working: Date | null = null;
    let addressedBefore: Date | null = null;
    for (const e of events) {
      if (e.type === 'handed_off') handedOff.add(e.runId);
      if (handedOff.has(e.runId)) continue;
      if (e.state === 'working') working = e.ts;
      else if (e.state === 'done' && working && !NOT_A_TURN.has(e.type)) addressedBefore = working;
    }
    if (!addressedBefore) return;
    this.db
      .update(reviewComments)
      .set({ status: 'addressed' })
      .where(and(eq(reviewComments.runId, runId), eq(reviewComments.status, 'sent'), lt(reviewComments.sentAt, addressedBefore)))
      .run();
  }

  private readonly warned = new Set<string>();

  /** Reads happen on every GET: log a run's problem once, not per request. */
  private warnOnce(runId: string, message: string, error: unknown): void {
    if (this.warned.has(runId)) return;
    if (this.warned.size > 1000) this.warned.clear();
    this.warned.add(runId);
    this.log(message, error);
  }

  /** The file hashes of the run's branch diff; null when the diff cannot be read. */
  private async fileHashes(runId: string): Promise<Map<string, string> | null> {
    try {
      const summary = await this.runs.diff(runId, 'branch');
      // A worktree that is gone says nothing about the files: keep the stored lines.
      if (!summary.isGitRepo) return null;
      return new Map(summary.files.map((f) => [f.path, f.hash]));
    } catch (error) {
      this.warnOnce(runId, `review: reading the diff of run ${runId} failed`, error);
      return null;
    }
  }

  /**
   * Where each comment's code is now. Computed on read, never stored. Only comments whose file hash
   * differs from the one at creation read the file (once per file side, capped at 2 MB); any
   * failure keeps the stored line and is logged.
   */
  private async anchor(runId: string, rows: CommentRow[]): Promise<ReviewComment[]> {
    const lineRows = rows.filter((r) => r.line !== null && r.anchorText !== null && r.anchorHash !== null);
    const hashes = lineRows.length > 0 ? await this.fileHashes(runId) : null;
    const sides = new Map<string, Promise<string[] | null>>();
    const lines = (filePath: string, side: 'modified' | 'original') => {
      const key = `${side}:${filePath}`;
      if (!sides.has(key)) {
        sides.set(
          key,
          this.runs.reviewSide(runId, filePath, side).then(
            (text) => (text === null ? null : text.split(/\r?\n/)),
            (error) => {
              this.warnOnce(runId, `review: re-anchoring ${filePath} failed`, error);
              throw error;
            },
          ),
        );
      }
      return sides.get(key)!;
    };
    const out: ReviewComment[] = [];
    for (const row of rows) {
      let anchored: Anchored = { currentLine: row.line, outdated: false };
      if (row.line !== null && row.anchorText !== null && row.anchorHash !== null && hashes) {
        const hash = hashes.get(row.filePath);
        if (hash === undefined) anchored = { currentLine: null, outdated: true };
        else if (hash !== row.anchorHash) {
          try {
            const fileLines = await lines(row.filePath, row.side as 'modified' | 'original');
            anchored = fileLines ? reanchor(row.line, row.anchorText, fileLines) : { currentLine: null, outdated: true };
          } catch {
            // already logged; keep the stored line
          }
        }
      }
      out.push(toComment(row, anchored));
    }
    return out;
  }

  async state(runId: string): Promise<RunReviewState> {
    this.runs.getRun(runId);
    this.settle(runId);
    const rows = this.db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.runId, runId))
      .orderBy(asc(reviewComments.filePath), asc(reviewComments.line), asc(reviewComments.createdAt))
      .all();
    const comments = await this.anchor(runId, rows);
    const viewed = this.db
      .select()
      .from(reviewFileViews)
      .where(eq(reviewFileViews.runId, runId))
      .all()
      .map((row) => ({ filePath: row.filePath, signature: row.signature, viewedAt: row.viewedAt.toISOString() }));
    return { comments, viewed };
  }

  async addComment(runId: string, raw: unknown): Promise<ReviewComment> {
    this.runs.getRun(runId);
    const body = parse(CreateReviewCommentBody, raw);
    const line = body.line ?? null;
    let anchorHash: string | null = null;
    try {
      anchorHash = await this.runs.fileHash(runId, body.filePath);
    } catch (error) {
      this.warnOnce(runId, `review: hashing ${body.filePath} for the comment anchor failed`, error);
    }
    let anchorText: string | null = null;
    if (line !== null) {
      try {
        const text = await this.runs.reviewSide(runId, body.filePath, body.side);
        const lineText = text?.split(/\r?\n/)[line - 1];
        // A blank line is no anchor: such a comment keeps its line number.
        if (lineText !== undefined && lineText.trim() !== '') anchorText = anchorTextOf(lineText);
      } catch (error) {
        this.warnOnce(runId, `review: reading ${body.filePath} for the comment anchor failed`, error);
      }
    }
    const row: CommentRow = {
      id: randomUUID(),
      runId,
      filePath: body.filePath,
      line,
      side: body.side,
      body: body.body,
      status: 'open',
      intent: body.intent,
      priority: body.priority,
      anchorText,
      anchorHash,
      round: 0,
      verifiedAt: null,
      carriedTo: null,
      createdAt: new Date(),
      sentAt: null,
      resolvedAt: null,
    };
    this.db.insert(reviewComments).values(row).run();
    return toComment(row);
  }

  private comment(runId: string, commentId: string): CommentRow {
    const row = this.db
      .select()
      .from(reviewComments)
      .where(and(eq(reviewComments.id, commentId), eq(reviewComments.runId, runId)))
      .get();
    if (!row) throw notFound('no such review comment');
    return row;
  }

  async updateComment(runId: string, commentId: string, raw: unknown): Promise<ReviewComment> {
    const existing = this.comment(runId, commentId);
    const body = parse(UpdateReviewCommentBody, raw);
    const patch: Partial<CommentRow> = {};
    if (body.body !== undefined) patch.body = body.body;
    if (body.intent !== undefined) patch.intent = body.intent;
    if (body.priority !== undefined) patch.priority = body.priority;
    if (body.status === 'resolved' && existing.status !== 'resolved') {
      // Accepting an addressed comment is the verification.
      Object.assign(patch, {
        status: 'resolved',
        resolvedAt: new Date(),
        verifiedAt: existing.status === 'addressed' ? new Date() : existing.verifiedAt,
      });
    }
    // Reopening ("Not done") is for feedback the agent turned in or a person accepted: it becomes
    // open again, so the next batch sends it; round and sentAt stay as history. A carried comment
    // reopened here belongs to this run again.
    if (body.status === 'open') {
      if (existing.status !== 'addressed' && existing.status !== 'resolved') {
        throw conflict(`a ${existing.status} comment cannot be reopened`);
      }
      Object.assign(patch, { status: 'open', resolvedAt: null, verifiedAt: null, carriedTo: null });
    }
    if (Object.keys(patch).length === 0) return (await this.anchor(runId, [existing]))[0]!;
    const updated = this.db
      .update(reviewComments)
      .set(patch)
      .where(eq(reviewComments.id, commentId))
      .returning()
      .get();
    this.noteUnblocked(runId);
    return (await this.anchor(runId, [updated!]))[0]!;
  }

  deleteComment(runId: string, commentId: string): void {
    this.comment(runId, commentId);
    this.db.delete(reviewComments).where(eq(reviewComments.id, commentId)).run();
    this.noteUnblocked(runId);
  }

  /** The last open blocking comment is gone (resolved, deleted, downgraded): the merge gate opens. */
  private noteUnblocked(runId: string): void {
    // The hold sits on the run the pipeline last ran for: the comment's run or a handoff successor.
    for (const id of this.chain(runId)) {
      if (openBlockingCount(this.db, id) > 0 || !reviewBlockedIsCurrent(this.db, id)) continue;
      this.runs.note(id, 'review_unblocked', {});
    }
  }

  /**
   * What the next request-changes sends: every open comment; every addressed one (pinned until a
   * person resolves it); and sent ones only once the run has ended without addressing them (while
   * it is still at work they are with the agent already).
   */
  private async batch(run: Run): Promise<Batched[]> {
    this.settle(run.id);
    const ended = run.state === 'failed' || run.endedAt !== null || run.cancelled;
    const statuses = ended ? ['open', 'addressed', 'sent'] : ['open', 'addressed'];
    const rows = this.db
      .select()
      .from(reviewComments)
      .where(and(eq(reviewComments.runId, run.id), inArray(reviewComments.status, statuses)))
      .orderBy(asc(reviewComments.filePath), asc(reviewComments.line), asc(reviewComments.createdAt))
      .all();
    const kindOf: Record<string, BatchKind> = { open: 'new', sent: 'reminder', addressed: 'pinned' };
    const anchored = await this.anchor(run.id, rows);
    return anchored.map((c) => ({ ...c, kind: kindOf[c.status] ?? 'new' }));
  }

  /**
   * Sends the batch (plus an optional note) as one prompt. `same` types into or resumes the run and
   * marks the comments sent (round + 1); `new` starts a fresh run of the ticket carrying as much of
   * the feedback as fits and resolves those comments here with `carriedTo`. A failed send changes no
   * status. One send per run at a time.
   */
  async requestChanges(runId: string, raw: unknown): Promise<RequestChangesResponse> {
    const { note, target } = parse(RequestChangesBody, raw);
    this.runs.getRun(runId);
    return this.sending.run(runId, () => (target === 'new' ? this.sendToNewRun(runId, note) : this.sendToSameRun(runId, note)));
  }

  private async sendToSameRun(runId: string, note: string): Promise<RequestChangesResponse> {
    const run = this.runs.getRun(runId);
    const comments = await this.batch(run);
    if (comments.length === 0 && !note) throw badRequest('nothing to send: add a comment or a note');
    const text = sameRunPrompt(note, comments);
    if (text.length > PROMPT_MAX) throw badRequest('too much feedback in one round — resolve or split');
    // Taken before the send: the agent's next turn must start after it to count as addressing these.
    const sentAt = new Date();
    let prompted: Run;
    try {
      prompted = await this.runs.prompt(runId, text);
    } catch (error) {
      throw this.cannotPrompt(runId, error);
    }
    this.markAll(comments, { status: 'sent', sentAt });
    return { run: prompted, sent: comments.length };
  }

  private async sendToNewRun(runId: string, note: string): Promise<RequestChangesResponse> {
    const run = this.runs.getRun(runId);
    if (!run.ticketId || !this.startTicketRun) throw conflict('only a ticket run can start a new run');
    const comments = await this.batch(run);
    if (comments.length === 0 && !note) throw badRequest('nothing to send: add a comment or a note');
    let included: Batched[] = [];
    const sentAt = new Date();
    const fresh = await this.startTicketRun({
      ticketId: run.ticketId,
      permissionMode: run.permissionMode,
      persona: run.persona,
      section: (room) => {
        const built = newRunFeedbackSection(run.id, note, comments, room);
        if (!built) throw conflict('the ticket text leaves no room for review feedback');
        included = built.included as Batched[];
        return built.text;
      },
      // The reviewed run, or the run that took it over, may still sit idle at its prompt.
      replaceIdleRuns: this.chain(run.id),
    });
    this.markAll(included, { status: 'resolved', sentAt, resolvedAt: sentAt, carriedTo: fresh.id });
    return { run: fresh, sent: included.length };
  }

  /** A run that can no longer take a prompt (stopped, handed off, no session) offers a new run of its ticket. */
  private cannotPrompt(runId: string, error: unknown): unknown {
    if (!(error instanceof HttpError) || error.statusCode !== 409) return error;
    const run = this.runs.getRun(runId);
    // Queued or starting is only a wait: sending again soon works.
    const waiting = run.state === 'queued' || run.state === 'starting';
    if (!run.ticketId || !this.startTicketRun || waiting) return error;
    return new HttpError(409, error.code, error.message, { ...error.details, canStartNew: true });
  }

  /**
   * Applies a status change to the batch's comments; every send counts a round. Each comment is
   * changed only if it still has the status it was sent with, so one resolved or deleted while the
   * prompt was on its way keeps what the person did.
   */
  private markAll(comments: Batched[], set: Partial<CommentRow>): void {
    const byStatus = new Map<string, string[]>();
    for (const c of comments) byStatus.set(c.status, [...(byStatus.get(c.status) ?? []), c.id]);
    this.db.transaction((tx) => {
      for (const [status, ids] of byStatus) {
        tx.update(reviewComments)
          .set({ ...set, round: sql`${reviewComments.round} + 1` })
          .where(and(inArray(reviewComments.id, ids), eq(reviewComments.status, status)))
          .run();
      }
    });
  }

  async markViewed(runId: string, raw: unknown): Promise<RunReviewState> {
    this.runs.getRun(runId);
    const body = parse(MarkFileViewedBody, raw);
    if (body.viewed) {
      this.db
        .insert(reviewFileViews)
        .values({ runId, filePath: body.filePath, signature: body.signature, viewedAt: new Date() })
        .onConflictDoUpdate({
          target: [reviewFileViews.runId, reviewFileViews.filePath],
          set: { signature: body.signature, viewedAt: new Date() },
        })
        .run();
    } else {
      this.db
        .delete(reviewFileViews)
        .where(and(eq(reviewFileViews.runId, runId), eq(reviewFileViews.filePath, body.filePath)))
        .run();
    }
    return this.state(runId);
  }
}
