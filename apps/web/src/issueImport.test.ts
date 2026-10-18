import type { ForgeIssueListItem, ImportIssuesResponse } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildImportBody,
  describeImportResult,
  issueListQuery,
  MAX_IMPORT,
  parseTrustedAuthors,
  syncSettingsProblem,
  toggleIssue,
  visibleIssueKeys,
} from './issueImport';

const issue = (n: number, linkedTicketKey: string | null = null): ForgeIssueListItem => ({
  externalId: `id-${n}`,
  number: n,
  title: `Issue ${n}`,
  labels: [],
  url: `https://x/${n}`,
  author: 'a',
  updatedAt: '2026-10-18T00:00:00Z',
  state: 'open',
  linkedTicketKey,
});

describe('toggleIssue', () => {
  it('adds and removes an issue', () => {
    const a = toggleIssue([], issue(1));
    expect(a.map((i) => i.number)).toEqual([1]);
    expect(toggleIssue(a, issue(1))).toEqual([]);
  });
  it('ignores an already linked issue', () => {
    expect(toggleIssue([], issue(1, 'EMB-1'))).toEqual([]);
  });
  it('stops at the import limit', () => {
    let sel: ForgeIssueListItem[] = [];
    for (let n = 1; n <= MAX_IMPORT + 3; n++) sel = toggleIssue(sel, issue(n));
    expect(sel).toHaveLength(MAX_IMPORT);
  });
});

describe('visibleIssueKeys', () => {
  it('lists the ids of the selectable issues only', () => {
    expect(visibleIssueKeys([issue(1), issue(2, 'EMB-2')])).toEqual(['id-1']);
  });
});

describe('buildImportBody', () => {
  it('sends id and number plus the status', () => {
    expect(buildImportBody([issue(3), issue(4)], 'ready')).toEqual({
      issues: [
        { externalId: 'id-3', number: 3 },
        { externalId: 'id-4', number: 4 },
      ],
      status: 'ready',
    });
  });
});

describe('issueListQuery', () => {
  it('encodes the filters and leaves out empty ones', () => {
    expect(issueListQuery({ state: 'open', labels: ' bug, ui ', search: '', page: 1 })).toBe('state=open&labels=bug%2C+ui&page=1');
    expect(issueListQuery({ state: 'all', labels: '', search: 'a&b', page: 2 })).toBe('state=all&search=a%26b&page=2');
  });
});

describe('parseTrustedAuthors', () => {
  it('splits on commas and lines, trims, drops empties and duplicates', () => {
    expect(parseTrustedAuthors('alice, bob\n\n alice ,carol\r\ndave')).toEqual(['alice', 'bob', 'carol', 'dave']);
    expect(parseTrustedAuthors('')).toEqual([]);
  });
});

describe('syncSettingsProblem', () => {
  it('needs a label when enabled', () => {
    expect(syncSettingsProblem({ enabled: true, label: ' ' })).toMatch(/label/i);
    expect(syncSettingsProblem({ enabled: true, label: 'emberline' })).toBeNull();
    expect(syncSettingsProblem({ enabled: false, label: '' })).toBeNull();
  });
});

describe('describeImportResult', () => {
  const res = (created: number, existing: number, skipped: number) =>
    ({
      created: Array.from({ length: created }, () => ({})),
      existing: Array.from({ length: existing }, () => ({})),
      skipped: Array.from({ length: skipped }, (_, i) => ({ externalId: `s${i}`, reason: 'gone' })),
    }) as unknown as ImportIssuesResponse;
  it('summarises the counts', () => {
    expect(describeImportResult(res(2, 0, 0))).toBe('Imported 2 issues.');
    expect(describeImportResult(res(1, 1, 1))).toBe('Imported 1 issue, 1 was already imported, 1 skipped.');
    expect(describeImportResult(res(0, 2, 0))).toBe('Nothing new: 2 were already imported.');
  });
});
