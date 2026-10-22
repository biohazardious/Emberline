import { describe, expect, it } from 'vitest';
import { payloadSummary } from './components/RunInspector';

describe('payloadSummary', () => {
  it('shows why a merge failed', () => {
    expect(
      payloadSummary({ summary: 'fatal: .git/index: index file open failed: Permission denied' }).detail,
    ).toBe('fatal: .git/index: index file open failed: Permission denied');
  });

  it('prefers the message over the summary', () => {
    expect(payloadSummary({ message: 'the message', summary: 'the summary' }).detail).toBe('the message');
  });
});
