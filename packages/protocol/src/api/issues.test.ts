import { describe, expect, it } from 'vitest';
import { ImportIssuesBody, IssueSyncSettings } from './issues.js';

describe('issue protocol', () => {
  it('limits an import to 50 ids and defaults the status', () => {
    expect(ImportIssuesBody.parse({ externalIds: ['1'] }).status).toBe('backlog');
    expect(ImportIssuesBody.safeParse({ externalIds: Array.from({ length: 51 }, (_, i) => String(i)) }).success).toBe(false);
    expect(ImportIssuesBody.safeParse({ externalIds: ['1'], status: 'done' }).success).toBe(false);
  });
  it('requires a label only when sync is enabled', () => {
    expect(IssueSyncSettings.safeParse({ enabled: true, label: '' }).success).toBe(false);
    expect(IssueSyncSettings.parse({ enabled: true, label: 'emberline' })).toMatchObject({ status: 'backlog', commentOnProgress: true, closeOnDone: false });
    expect(IssueSyncSettings.parse({})).toMatchObject({ enabled: false });
  });
});
