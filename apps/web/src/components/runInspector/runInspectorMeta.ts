import type { Run, RunEvent } from '@emberline/protocol';
import { formatAgentDisplayName } from '../../agentLabel';
import { AGENT_REMOVED_TEXT } from '../../holdRecovery';

export interface StageTemplate {
  id: string;
  label: string;
  hint: string;
  prompt: string;
}

/** Pipeline stage prompt templates inspired by herdr-board & Omnigent critic flows. */
export const STAGE_TEMPLATES: StageTemplate[] = [
  {
    id: 'plan',
    label: 'Plan scope',
    hint: 'Ask the agent to inspect the codebase and propose a plan first',
    prompt:
      'Analyze the task and relevant files first. Propose a concise step-by-step implementation plan and list the files to touch before making code changes.',
  },
  {
    id: 'implement',
    label: 'Implement',
    hint: 'Execute the planned changes cleanly',
    prompt:
      'Proceed with the implementation. Follow existing codebase conventions, keep edits minimal and focused, and verify compilation.',
  },
  {
    id: 'verify',
    label: 'Verify tests',
    hint: 'Run tests, typecheck, and fix any failures',
    prompt: 'Run the relevant tests, typecheck, and linter. Fix any failures or regressions you uncover.',
  },
  {
    id: 'review',
    label: 'Review diff',
    hint: 'Critic pass over git diff before accepting',
    prompt:
      'Review your git diff critically for edge cases, security issues, or unintended changes. Fix anything questionable and summarize what was done.',
  },
];

export { formatAgentDisplayName };

export function formatAgentResumePlaceholder(agent?: string | null): string {
  switch (agent) {
    case 'antigravity':
      return 'Continue the ended session (agy --continue)…';
    case 'gemini':
      return AGENT_REMOVED_TEXT;
    case 'codex':
      return 'Continue the ended session (codex)…';
    case 'copilot':
      return 'Continue the ended session (copilot)…';
    case 'aider':
      return 'Continue the ended session (aider)…';
    default:
      return 'Continue the ended session (claude --resume)…';
  }
}

/** The tool and the one line shown under a run event. */
export function payloadSummary(payload: unknown): { tool?: string; detail?: string } {
  if (!payload || typeof payload !== 'object') return {};
  const rec = payload as Record<string, unknown>;
  const tool = typeof rec.tool_name === 'string' ? rec.tool_name : undefined;
  const exitPrefix =
    typeof rec.exitCode === 'number' && rec.exitCode !== 0 ? `Exit code ${rec.exitCode}` : undefined;
  const msg =
    (typeof rec.tool_input_summary === 'string' && rec.tool_input_summary) ||
    (typeof rec.message === 'string' && rec.message) ||
    (typeof rec.error_details === 'string' && rec.error_details) ||
    (typeof rec.last_assistant_message === 'string' && rec.last_assistant_message) ||
    (typeof rec.reason === 'string' && rec.reason) ||
    (typeof rec.error === 'string' && rec.error) ||
    // A merge's outcome (why it failed).
    (typeof rec.summary === 'string' && rec.summary) ||
    undefined;
  const detail = exitPrefix && msg ? `${exitPrefix}: ${msg}` : msg || exitPrefix;
  return { tool, detail };
}

export function extractFailureDetails(
  events: RunEvent[],
  agent?: string | null,
): {
  reason: string;
  exitCode?: number;
  needsAuth: boolean;
} {
  let reason = '';
  let exitCode: number | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || !ev.payload || typeof ev.payload !== 'object') continue;
    const rec = ev.payload as Record<string, unknown>;
    if (typeof rec.exitCode === 'number' && exitCode === undefined) {
      exitCode = rec.exitCode;
    }
    if (!reason) {
      const candidate =
        (typeof rec.message === 'string' && rec.message) ||
        (typeof rec.error_details === 'string' && rec.error_details) ||
        (typeof rec.reason === 'string' && rec.reason) ||
        (typeof rec.error === 'string' && rec.error !== 'cli_exit' ? rec.error : '');
      if (candidate) {
        reason = candidate;
      }
    }
  }
  const lower = reason.toLowerCase();
  const needsAuth =
    exitCode === 41 ||
    lower.includes('api_key') ||
    lower.includes('api key') ||
    lower.includes('not authenticated') ||
    lower.includes('authentication') ||
    lower.includes('login') ||
    lower.includes('oauth') ||
    lower.includes('credentials');

  if (!reason || reason === `${agent ?? 'Agent'} exited with non-zero code`) {
    if (exitCode === 41) {
      reason = `${formatAgentDisplayName(agent)} exited with code 41 (Authentication / API Key required). Open Settings → Providers to sign in or save your API key.`;
    } else if (exitCode !== undefined) {
      reason = `${formatAgentDisplayName(agent)} process exited unexpectedly with exit code ${exitCode}.`;
    } else {
      reason = `${formatAgentDisplayName(agent)} execution failed.`;
    }
  }
  return { reason, exitCode, needsAuth };
}

/**
 * Whether the run shows a failure, so its events are fetched for the reason. A stop is `failed` +
 * `cancelled`: the pill already says "cancelled", and nothing exited unexpectedly.
 */
export function failureFetchNeeded(run: Pick<Run, 'state' | 'cancelled'>): boolean {
  return run.state === 'failed' && !run.cancelled;
}

/** The other run of a handoff or conflict resolver escalation (`handed_off`, `handoff_from`, `conflict_resolver_started`). */
export function handoffTarget(ev: RunEvent): string | undefined {
  const payload = ev.payload as { toRunId?: unknown; fromRunId?: unknown; runId?: unknown } | null;
  const id =
    ev.type === 'handed_off'
      ? payload?.toRunId
      : ev.type === 'handoff_from'
        ? payload?.fromRunId
        : ev.type === 'conflict_resolver_started'
          ? payload?.runId
          : undefined;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

/** The text after the label of a `dependency_dropped` event: "<ticket> → <ref> (<reason>)". */
export function droppedDependencyText(payload: unknown): string | undefined {
  const rec = (payload ?? {}) as Record<string, unknown>;
  if (typeof rec.ticket !== 'string' || typeof rec.ref !== 'string') return undefined;
  const reason = typeof rec.reason === 'string' ? ` (${rec.reason.replace(/_/g, ' ')})` : '';
  return `${rec.ticket} → ${rec.ref}${reason}`;
}
