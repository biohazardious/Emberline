import type { RunState } from '@emberline/protocol';

const LABEL: Record<RunState, string> = {
  starting: 'starting',
  working: 'working',
  waiting_input: 'needs you',
  rate_limited: 'rate limited',
  done: 'done',
  failed: 'failed',
};

const HINT: Record<RunState, string> = {
  starting: 'Claude is starting up',
  working: 'Claude is working',
  waiting_input: 'Claude is waiting for a prompt or a permission decision',
  rate_limited: 'Usage limit reached; resumes after the window resets',
  done: 'Claude finished its turn; send a follow-up or review the changes',
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
