import type { SyncWorktreeResponse } from '@emberline/protocol';

export interface SyncResolvingNotice {
  ticketId: string;
  resolution: 'agent_resolving' | 'resolver_started';
  text: string;
  runId: string;
  href: string;
  linkLabel: string;
}

export interface ManualConflictState {
  ticketId: string;
  runId: string;
  conflicts: string[];
}

export type SyncWorktreeOutcome =
  | { kind: 'merged'; toast: string }
  | {
      kind: 'resolving';
      resolution: 'agent_resolving' | 'resolver_started';
      text: string;
      runId: string;
      href: string;
      linkLabel: string;
    }
  | { kind: 'manual_conflict'; conflicts: string[]; summary: string }
  | { kind: 'error'; text: string };

function conflictCountPhrase(count: number): string {
  if (count <= 0) return 'conflicts';
  return `${count} ${count === 1 ? 'conflict' : 'conflicts'}`;
}

/** Maps a `POST /api/projects/:id/sync-worktree` response to its UI outcome (toast, resolving info, Hold Recovery, or error). */
export function syncWorktreeOutcome(sync: SyncWorktreeResponse): SyncWorktreeOutcome {
  if (sync.ok) {
    if (sync.resolution === 'auto_resolved') {
      const toast =
        sync.autoResolved.length > 0
          ? `Merged; auto-resolved additive conflicts in ${sync.autoResolved.join(', ')}`
          : 'Merged; auto-resolved additive conflicts';
      return { kind: 'merged', toast };
    }
    return { kind: 'merged', toast: sync.summary };
  }

  if (sync.resolution === 'agent_resolving') {
    const conflicts = conflictCountPhrase(sync.conflicts.length);
    return {
      kind: 'resolving',
      resolution: 'agent_resolving',
      text: `The agent is merging main and resolving ${conflicts}; the ticket merges when it finishes`,
      runId: sync.runId,
      href: `/runs/${sync.runId}/review`,
      linkLabel: 'Open run →',
    };
  }

  if (sync.resolution === 'resolver_started') {
    const conflicts = conflictCountPhrase(sync.conflicts.length);
    // Core names the resolver run it started; a core without the field gets the held run's link,
    // labelled as what it is.
    const resolver = sync.resolverRunId;
    const runId = resolver ?? sync.runId;
    return {
      kind: 'resolving',
      resolution: 'resolver_started',
      text: `The agent is merging main and resolving ${conflicts}; the ticket merges when it finishes`,
      runId,
      href: `/runs/${runId}/review`,
      linkLabel: resolver ? 'Open resolver run →' : 'Open run →',
    };
  }

  if ((sync.resolution === 'manual' || sync.resolution === null) && sync.conflicts.length > 0) {
    return {
      kind: 'manual_conflict',
      conflicts: sync.conflicts,
      summary: sync.summary,
    };
  }

  return { kind: 'error', text: sync.summary };
}
