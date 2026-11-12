import { describe, expect, it } from 'vitest';
import { HookEnvelope, HookPayload } from './hooks.js';

const envelope = { runId: 'run-1', event: 'Stop', receivedAt: '2026-01-01T00:00:00Z', payload: {} };

describe('HookEnvelope', () => {
  it('round-trips a valid envelope', () => {
    expect(HookEnvelope.parse(envelope)).toEqual(envelope);
  });

  it('rejects an empty runId', () => {
    expect(HookEnvelope.safeParse({ ...envelope, runId: '' }).success).toBe(false);
  });

  it('rejects an unknown event name', () => {
    expect(HookEnvelope.safeParse({ ...envelope, event: 'Bogus' }).success).toBe(false);
  });
});

describe('HookPayload', () => {
  it('passes unknown keys through', () => {
    const parsed = HookPayload.parse({ session_id: 's', tool_name: 'Bash' });
    expect(parsed).toEqual({ session_id: 's', tool_name: 'Bash' });
  });

  it('rejects a non-string session_id', () => {
    expect(HookPayload.safeParse({ session_id: 5 }).success).toBe(false);
  });
});
