import { randomUUID } from 'node:crypto';
import {
  CreateReviewCommentBody,
  MarkFileViewedBody,
  RequestChangesBody,
  type ReviewComment,
  type Run,
  type RunReviewState,
  UpdateReviewCommentBody,
} from '@emberline/protocol';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { reviewComments, reviewFileViews } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import type { RunService } from '../runs/service.js';
import { anchorTextOf, type Anchored, reanchor } from './anchor.js';

type CommentRow = typeof reviewComments.$inferSelect;

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
 * Line comments and per-file "viewed" marks on a run's diff, stored in SQLite so a review survives
 * reloads and can be continued after the agent has addressed part of it.
 */
export class ReviewService {
  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly log: (message: string, error?: unknown) => void = (message, error) => console.warn(message, error),
  ) {}

  /** The file hashes of the run's branch diff; null when the diff cannot be read. */
  private async fileHashes(runId: string): Promise<Map<string, string> | null> {
    try {
      return new Map((await this.runs.diff(runId, 'branch')).files.map((f) => [f.path, f.hash]));
    } catch (error) {
      this.log(`review: reading the diff of run ${runId} failed`, error);
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
              this.log(`review: re-anchoring ${filePath} failed`, error);
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
    const anchorHash = (await this.fileHashes(runId))?.get(body.filePath) ?? null;
    let anchorText: string | null = null;
    if (line !== null) {
      try {
        const text = await this.runs.reviewSide(runId, body.filePath, body.side);
        const lineText = text?.split(/\r?\n/)[line - 1];
        if (lineText !== undefined) anchorText = anchorTextOf(lineText);
      } catch (error) {
        this.log(`review: reading ${body.filePath} for the comment anchor failed`, error);
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

  updateComment(runId: string, commentId: string, raw: unknown): ReviewComment {
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
    // Reopening keeps the history of whether it was sent.
    if (body.status === 'open' && existing.status !== 'open') {
      Object.assign(patch, { status: existing.sentAt ? 'sent' : 'open', resolvedAt: null, verifiedAt: null });
    }
    if (Object.keys(patch).length === 0) return toComment(existing);
    const updated = this.db
      .update(reviewComments)
      .set(patch)
      .where(eq(reviewComments.id, commentId))
      .returning()
      .get();
    return toComment(updated!);
  }

  deleteComment(runId: string, commentId: string): void {
    this.comment(runId, commentId);
    this.db.delete(reviewComments).where(eq(reviewComments.id, commentId)).run();
  }

  /** Sends every open comment (plus an optional note) to the agent as one prompt and marks them sent. */
  async requestChanges(runId: string, raw: unknown): Promise<{ run: Run; sent: number }> {
    const { note } = parse(RequestChangesBody, raw);
    const open = this.db
      .select()
      .from(reviewComments)
      .where(and(eq(reviewComments.runId, runId), eq(reviewComments.status, 'open')))
      .orderBy(asc(reviewComments.filePath), asc(reviewComments.line))
      .all();
    if (open.length === 0 && !note) throw badRequest('nothing to send: add a line comment or a note');
    const lines = ['Please address the following code review feedback on this branch:', ''];
    if (note) lines.push(`Overall note: ${note}`, '');
    if (open.length > 0) {
      lines.push('Line comments:');
      for (const c of open) {
        lines.push(`- \`${c.filePath}${c.line === null ? '' : `:${c.line}`}\`${c.line === null ? ' (whole file)' : ''}${c.side === 'original' ? ' (removed code)' : ''}: ${c.body}`);
      }
    }
    const run = await this.runs.prompt(runId, lines.join('\n'));
    const sentAt = new Date();
    for (const c of open) {
      this.db.update(reviewComments).set({ status: 'sent', sentAt }).where(eq(reviewComments.id, c.id)).run();
    }
    return { run, sent: open.length };
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
