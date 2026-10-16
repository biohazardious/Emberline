import type { Run, RunState } from '@emberline/protocol';

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

/**
 * A user stop ends a run as `failed`; it is shown as cancelled instead. A run waiting to retry a
 * temporary provider error shows its attempt instead of "rate limited".
 */
export function RunStatePill({
  state,
  cancelled = false,
  autoRetry = null,
}: {
  state: RunState;
  cancelled?: boolean;
  autoRetry?: Run['autoRetry'];
}) {
  if (cancelled && state === 'failed') {
    return (
      <span className="run-pill run-cancelled" title="Stopped by you; this run will not resume">
        <span className="dot" />
        cancelled
      </span>
    );
  }
  if (autoRetry && state === 'rate_limited') {
    const at = new Date(autoRetry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return (
      <span
        className="run-pill run-rate_limited"
        title={`Temporary provider error; retries automatically at ${at} (attempt ${autoRetry.attempt} of ${autoRetry.max})`}
      >
        <span className="dot" />
        retrying {autoRetry.attempt}/{autoRetry.max}
      </span>
    );
  }
  return (
    <span className={`run-pill run-${state}`} title={HINT[state]}>
      <span className="dot" />
      {LABEL[state]}
    </span>
  );
}
