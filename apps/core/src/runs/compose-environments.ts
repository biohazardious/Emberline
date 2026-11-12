/**
 * The compose stacks of a project's worktrees, one per run plus the main workspace's, as
 * {@link ComposePreviewEnvironment}s (`GET /api/projects/:id/container-preview/environments`).
 */
import {
  type ComposePreviewEnvironment,
  composeEnvironmentState,
  type RunPreviewStatus,
} from '@emberline/protocol';

/** Runs listed per request, newest first: each running one costs one `compose ps`. */
export const MAX_LISTED_ENVIRONMENTS = 50;

/** A preview status as its stack: a stopped stack has no port, and only a failed one shows its error and logs. */
export function toComposeEnvironment(
  status: Pick<RunPreviewStatus, 'status' | 'port' | 'url' | 'error' | 'logs'>,
  owner: { runId: string | null; ticketId: string | null; project: string },
): ComposePreviewEnvironment {
  const state = composeEnvironmentState(status.status);
  const live = state !== 'stopped';
  return {
    ...owner,
    state,
    port: live ? status.port : null,
    url: live ? status.url : null,
    error: state === 'failed' ? (status.error ?? 'the preview failed') : null,
    logs: state === 'failed' ? status.logs : null,
  };
}
