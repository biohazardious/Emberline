import { describe, expect, it } from 'vitest';
import { ImportIssuesBody, IssueSyncSettings } from './issues.js';

describe('issue protocol', () => {
  it('limits an import to 50 issues and defaults the status', () => {
    const one = [{ externalId: '1', number: 1 }];
    expect(ImportIssuesBody.parse({ issues: one }).status).toBe('backlog');
    expect(
      ImportIssuesBody.safeParse({
        issues: Array.from({ length: 50 }, (_, i) => ({ externalId: String(i), number: i + 1 })),
      }).success,
    ).toBe(true);
    expect(
      ImportIssuesBody.safeParse({
        issues: Array.from({ length: 51 }, (_, i) => ({ externalId: String(i), number: i + 1 })),
      }).success,
    ).toBe(false);
    expect(ImportIssuesBody.safeParse({ issues: [] }).success).toBe(false);
    expect(ImportIssuesBody.safeParse({ issues: one, status: 'done' }).success).toBe(false);
  });
  it('trustedAuthors defaults to none and holds at most 50 names', () => {
    expect(IssueSyncSettings.parse({}).trustedAuthors).toEqual([]);
    expect(
      IssueSyncSettings.safeParse({ trustedAuthors: Array.from({ length: 50 }, (_, i) => `u${i}`) }).success,
    ).toBe(true);
    expect(
      IssueSyncSettings.safeParse({ trustedAuthors: Array.from({ length: 51 }, (_, i) => `u${i}`) }).success,
    ).toBe(false);
  });
  it('requires a label only when sync is enabled', () => {
    expect(IssueSyncSettings.safeParse({ enabled: true, label: '' }).success).toBe(false);
    expect(IssueSyncSettings.parse({ enabled: true, label: 'emberline' })).toMatchObject({
      status: 'backlog',
      commentOnProgress: true,
      closeOnDone: false,
    });
    expect(IssueSyncSettings.parse({})).toMatchObject({ enabled: false });
  });
});
