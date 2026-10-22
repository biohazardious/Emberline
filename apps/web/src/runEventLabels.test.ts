import { describe, expect, it } from 'vitest';
import { EVENT_LABEL } from './runEventLabels';

describe('EVENT_LABEL', () => {
  it('labels the headless refusal, the tickets import and the worktree events', () => {
    expect(EVENT_LABEL.headless_needs_auto).toBe('failed: needs Autonomous mode');
    expect(EVENT_LABEL.tickets_imported).toBe('tickets imported');
    expect(EVENT_LABEL.tickets_file_left_to_factory).toBe('Ticket plan left to the [Factory] ticket');
    expect(EVENT_LABEL.ticket_draft_duplicate).toBe('duplicate ticket draft skipped');
    expect(EVENT_LABEL.main_push_failed).toBe('main push failed');
    expect(EVENT_LABEL.no_changes).toBe('held: no changes');
    expect(EVENT_LABEL.worktree_setup_failed).toBeTruthy();
  });
});
