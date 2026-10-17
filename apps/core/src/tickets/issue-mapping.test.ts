import type { ForgeIssue } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { mapIssueToTicket } from './issue-mapping.js';

const issue = (extra: Partial<ForgeIssue> = {}): ForgeIssue => ({
  externalId: '9001',
  number: 1,
  title: 'Fix the thing',
  body: 'It is broken.',
  labels: [],
  url: 'https://github.com/acme/widget/issues/1',
  author: 'octo',
  updatedAt: '2026-10-01T10:00:00Z',
  state: 'open',
  ...extra,
});

describe('mapIssueToTicket', () => {
  it('uses defaults: coder, priority 1, backlog, source line', () => {
    expect(mapIssueToTicket(issue(), 'backlog')).toEqual({
      title: 'Fix the thing',
      body: 'It is broken.\n\nSource: https://github.com/acme/widget/issues/1',
      persona: 'coder',
      priority: 1,
      status: 'backlog',
    });
  });

  it('passes the target status through', () => {
    expect(mapIssueToTicket(issue(), 'ready').status).toBe('ready');
  });

  it.each([
    ['priority:critical', 3],
    ['P0', 3],
    ['priority:high', 2],
    ['P1', 2],
    ['priority:low', 0],
    ['P3', 0],
    ['p3', 0],
    ['P2', 1],
    ['priority:whatever', 1],
  ])('label %s -> priority %i', (label, priority) => {
    expect(mapIssueToTicket(issue({ labels: ['bug', label] }), 'backlog').priority).toBe(priority);
  });

  it('takes persona from persona:<id> or an exact persona id, first match wins', () => {
    expect(mapIssueToTicket(issue({ labels: ['persona:qa'] }), 'backlog').persona).toBe('qa');
    expect(mapIssueToTicket(issue({ labels: ['bug', 'architect'] }), 'backlog').persona).toBe('architect');
    expect(mapIssueToTicket(issue({ labels: ['persona:dba', 'qa'] }), 'backlog').persona).toBe('dba');
    expect(mapIssueToTicket(issue({ labels: ['persona:nobody', 'security'] }), 'backlog').persona).toBe('security');
    expect(mapIssueToTicket(issue({ labels: ['persona:nobody', 'qaa'] }), 'backlog').persona).toBe('coder');
  });

  it('cuts the title at 200 characters', () => {
    expect(mapIssueToTicket(issue({ title: 'x'.repeat(250) }), 'backlog').title).toHaveLength(200);
    expect(mapIssueToTicket(issue({ title: '   ' }), 'backlog').title).toBe('Issue #1');
  });

  it('cuts the body at 18000 characters with an ellipsis, then the source line', () => {
    const out = mapIssueToTicket(issue({ body: 'a'.repeat(18_000) }), 'backlog');
    expect(out.body).toBe(`${'a'.repeat(18_000)}\n\nSource: https://github.com/acme/widget/issues/1`);
    const cut = mapIssueToTicket(issue({ body: 'a'.repeat(18_001) }), 'backlog');
    expect(cut.body).toBe(`${'a'.repeat(18_000)}…\n\nSource: https://github.com/acme/widget/issues/1`);
  });

  it('an empty body is just the source line', () => {
    expect(mapIssueToTicket(issue({ body: '' }), 'backlog').body).toBe('Source: https://github.com/acme/widget/issues/1');
  });
});
