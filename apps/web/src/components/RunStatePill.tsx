import type { RunState } from '@emberline/protocol';

const LABEL: Record<RunState, string> = {
  queued: 'queued',
  starting: 'starting',
  working: 'working',
  waiting_input: 'needs you',
  rate_limited: 'rate limited',
  done: 'done',
  failed: 'failed',
};

const HINT: Record<RunState, string> = {
  queued: 'Waiting for a free slot and available quota',
  starting: 'Agent is starting up',
  working: 'Agent is working',
  waiting_input: 'Agent is waiting for a prompt or a permission decision',
  rate_limited: 'Usage limit reached; resumes automatically after the window resets',
  done: 'Agent finished its turn; send a follow-up or review the changes',
  failed: 'The agent process failed',
};

export function RunStatePill({ state }: { state: RunState }) {
  return (
    <span className={`run-pill run-${state}`} title={HINT[state]}>
      <span className="dot" />
      {LABEL[state]}
    </span>
  );
}
