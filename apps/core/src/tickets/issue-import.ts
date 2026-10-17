import {
  type ForgeIssue,
  ForgeIssueListQuery,
  type ForgeIssueListResponse,
  ImportIssuesBody,
  type ImportIssuesResponse,
  IssueSyncSettings,
  type Ticket,
  UpdateIssueSyncBody,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { readIssueSync, writeIssueSync } from '../db/project-settings.js';
import { projects } from '../db/schema.js';
import { badRequest, HttpError, notFound } from '../errors.js';
import type { ForgeService } from '../forge/service.js';
import type { TicketService } from './service.js';

/** Listing and importing forge issues for a project, and its issue sync settings. */
export class IssueImportService {
  constructor(
    private readonly db: Db,
    private readonly tickets: TicketService,
    private readonly forge: ForgeService,
  ) {}

  private assertProject(projectId: string): void {
    if (!this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()) {
      throw notFound('no such project');
    }
  }

  async list(projectId: string, rawQuery: unknown): Promise<ForgeIssueListResponse> {
    const query = ForgeIssueListQuery.parse(rawQuery ?? {});
    const target = await this.forge.projectRemote(projectId);
    const page = await this.forge.issues.list(target, query);
    const linked = this.tickets.linkedTickets(
      projectId,
      target.remote.provider,
      page.items.map((i) => i.externalId),
    );
    return {
      provider: target.remote.provider,
      items: page.items.map(({ body: _body, ...rest }) => ({
        ...rest,
        linkedTicketKey: linked.get(rest.externalId)?.key ?? null,
      })),
      nextPage: page.nextPage,
    };
  }

  /**
   * Imports the selected issues. Core fetches each one by number and only trusts that content: the
   * client supplies identifiers, never text. Nothing is created if a fetch fails with anything other
   * than "gone / not an issue / wrong id" (those are skipped, with the reason).
   */
  async import(projectId: string, rawBody: unknown): Promise<ImportIssuesResponse> {
    const body = ImportIssuesBody.parse(rawBody ?? {});
    const target = await this.forge.projectRemote(projectId);
    const source = target.remote.provider;
    const selected = [...new Map(body.issues.map((i) => [i.externalId, i])).values()];
    const linked = this.tickets.linkedTickets(
      projectId,
      source,
      selected.map((i) => i.externalId),
    );
    const skipped: ImportIssuesResponse['skipped'] = [];
    const fetched: ForgeIssue[] = [];
    for (const sel of selected) {
      if (linked.has(sel.externalId)) continue;
      try {
        const issue = await this.forge.issues.get(target, sel.number);
        if (issue.externalId !== sel.externalId) {
          skipped.push({ externalId: sel.externalId, reason: `#${sel.number} does not match the selected issue` });
        } else {
          fetched.push(issue);
        }
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 404) {
          skipped.push({ externalId: sel.externalId, reason: err.message });
        } else {
          throw err;
        }
      }
    }
    const result = this.tickets.importIssues(projectId, source, fetched, body.status);
    const existing: Ticket[] = [...selected.flatMap((s) => linked.get(s.externalId) ?? []), ...result.existing];
    return { created: result.created, existing, skipped };
  }

  getSync(projectId: string): IssueSyncSettings {
    this.assertProject(projectId);
    return readIssueSync(this.db, projectId);
  }

  updateSync(projectId: string, rawBody: unknown): IssueSyncSettings {
    this.assertProject(projectId);
    const patch = UpdateIssueSyncBody.parse(rawBody ?? {});
    const merged = IssueSyncSettings.safeParse({ ...readIssueSync(this.db, projectId), ...patch });
    if (!merged.success) throw badRequest(merged.error.issues.map((i) => i.message).join('; '));
    writeIssueSync(this.db, projectId, merged.data);
    return merged.data;
  }
}
