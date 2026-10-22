import type {
  ForgeIssueListItem,
  ImportIssuesBody,
  ImportIssuesResponse,
  IssueSyncStatus,
} from '@emberline/protocol';

/** Core refuses more than this many issues in one import. */
export const MAX_IMPORT = 50;

/** Selecting an issue that is already linked to a ticket does nothing; so does exceeding the limit. */
export function toggleIssue(selected: ForgeIssueListItem[], item: ForgeIssueListItem): ForgeIssueListItem[] {
  if (item.linkedTicketKey) return selected;
  if (selected.some((s) => s.externalId === item.externalId))
    return selected.filter((s) => s.externalId !== item.externalId);
  if (selected.length >= MAX_IMPORT) return selected;
  return [...selected, item];
}

/** The ids of the issues a "select all" would pick: the ones not yet linked. */
export function visibleIssueKeys(items: ForgeIssueListItem[]): string[] {
  return items.filter((i) => !i.linkedTicketKey).map((i) => i.externalId);
}

export function buildImportBody(
  selected: ForgeIssueListItem[],
  status: 'backlog' | 'ready',
): ImportIssuesBody {
  return { issues: selected.map((i) => ({ externalId: i.externalId, number: i.number })), status };
}

export function issueListQuery(f: {
  state: 'open' | 'closed' | 'all';
  labels: string;
  search: string;
  page: number;
}): string {
  const q = new URLSearchParams({ state: f.state });
  if (f.labels.trim()) q.set('labels', f.labels.trim());
  if (f.search.trim()) q.set('search', f.search.trim());
  q.set('page', String(f.page));
  return q.toString();
}

/** Trusted authors are typed as a comma or line separated list. */
export function parseTrustedAuthors(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]*[,\n\r][\s,]*/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export function syncSettingsProblem(s: { enabled: boolean; label: string }): string | null {
  return s.enabled && !s.label.trim() ? 'A label is required when issue sync is enabled.' : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function describeImportResult(r: ImportIssuesResponse): string {
  const created = r.created.length;
  const parts: string[] = [];
  if (r.existing.length)
    parts.push(`${r.existing.length} ${r.existing.length === 1 ? 'was' : 'were'} already imported`);
  if (r.skipped.length) parts.push(`${r.skipped.length} skipped`);
  if (created === 0 && r.skipped.length === 0) return `Nothing new: ${parts.join(', ')}.`;
  return [`Imported ${plural(created, 'issue', 'issues')}`, ...parts].join(', ') + '.';
}

/** An issue URL to link to: http(s) only, so a forge cannot hand the page a `javascript:` link. Null otherwise. */
export function issueHref(url: string): string | null {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** What "Sync now" reports: the pass's error when it failed, else when it synced. */
export function describeSyncNow(
  status: IssueSyncStatus,
  formatTime: (iso: string) => string = (iso) => new Date(iso).toLocaleTimeString(),
): { error: boolean; text: string } {
  if (status.lastError) return { error: true, text: `Sync failed: ${status.lastError}` };
  return {
    error: false,
    text: status.lastSyncAt ? `Synced at ${formatTime(status.lastSyncAt)}.` : 'Sync finished.',
  };
}
