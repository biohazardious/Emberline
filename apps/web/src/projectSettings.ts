import {
  type ApproveWorktreeConfigBody,
  PROJECT_GATE_KEYS,
  type ProjectGateKey,
  type ProjectGateOverrides,
  type ProjectSettingsResponse,
  type UpdateProjectSettingsBody,
  type WorktreeConfigStatusResponse,
} from '@emberline/protocol';

export type GateChoice = 'inherit' | 'on' | 'off';

export const GATE_LABELS: Record<ProjectGateKey, { label: string; hint: string }> = {
  selfHealingBuildGate: { label: 'Self-healing build', hint: 'Build, lint and test before a run is merged; failures go back to the agent' },
  antiSlopGate: { label: 'Anti-slop audit', hint: 'Block placeholder code and leftover debug output' },
  secretGuardGate: { label: 'Secret guard', hint: 'Block a merge or commit that contains credentials' },
  crossProviderCritic: { label: 'Cross-provider critic', hint: 'A second agent reviews each finished run' },
  autoSyncToMain: { label: 'Auto-merge to main', hint: 'Merge a finished run into the main workspace' },
  requireCompletionSignal: { label: 'Require completion signal', hint: 'A stop is not "done" unless the agent called ticket_complete' },
};

export function gateChoice(overrides: ProjectGateOverrides, key: ProjectGateKey): GateChoice {
  const v = overrides[key];
  return v === undefined ? 'inherit' : v ? 'on' : 'off';
}

export interface GateRow {
  key: ProjectGateKey;
  label: string;
  hint: string;
  choice: GateChoice;
  options: { value: GateChoice; label: string }[];
}

/** One row per gate: the current choice and the three options, Inherit showing the global value. */
export function gateChoices(settings: ProjectSettingsResponse): GateRow[] {
  return PROJECT_GATE_KEYS.map((key) => ({
    key,
    ...GATE_LABELS[key],
    choice: gateChoice(settings.gates, key),
    options: [
      { value: 'inherit', label: `Inherit (${settings.global[key] ? 'On' : 'Off'})` },
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Off' },
    ],
  }));
}

export function gateUpdate(key: ProjectGateKey, choice: GateChoice): UpdateProjectSettingsBody {
  return { gates: { [key]: choice === 'inherit' ? null : choice === 'on' } };
}

export interface WorktreeBanner {
  kind: 'changed' | 'removed' | 'unreadable' | 'unusable';
  title: string;
  canApprove: boolean;
  approveBody: ApproveWorktreeConfigBody | null;
  errors: string[];
  diff: string;
  /** The diff was cut at its size cap: the person reviews HEAD's whole file instead. */
  truncated: boolean;
  /** HEAD's whole file, for a truncated diff. */
  fullFile: string | null;
}

/** The core's marker at the end of a diff cut at its size cap (worktree-config/diff.ts). */
const DIFF_TRUNCATED = '… diff truncated\n';

const quiet = { truncated: false, fullFile: null } as const;

/** What the worktree.yml review shows for a status response; null when nothing needs attention. */
export function worktreeBanner(s: WorktreeConfigStatusResponse | undefined): WorktreeBanner | null {
  if (!s) return null;
  if (s.headError) {
    return {
      kind: 'unreadable',
      title: "couldn't read worktree.yml from the repository",
      canApprove: false,
      approveBody: null,
      errors: [],
      diff: '',
      ...quiet,
    };
  }
  if (s.removed) {
    return {
      kind: 'removed',
      title: 'worktree.yml was removed — approve removal',
      canApprove: true,
      approveBody: { removal: true },
      errors: [],
      diff: s.diff,
      ...quiet,
    };
  }
  if (!s.changed) return null;
  if (s.unusable) {
    return {
      kind: 'unusable',
      title: "worktree.yml in the repository can't be used — runs keep the approved version",
      canApprove: false,
      approveBody: null,
      errors: s.errors,
      diff: s.diff,
      ...quiet,
    };
  }
  const canApprove = s.head !== null && s.errors.length === 0;
  const truncated = s.diff.endsWith(DIFF_TRUNCATED);
  return {
    kind: 'changed',
    title: 'worktree.yml changed — review',
    canApprove,
    approveBody: canApprove && s.head ? { sha256: s.head.sha256 } : null,
    errors: s.errors,
    diff: s.diff,
    truncated,
    fullFile: truncated ? (s.head?.content ?? null) : null,
  };
}

/** Approve is offered once the person can see everything they approve: a truncated diff needs the full file open. */
export function approveEnabled(banner: WorktreeBanner, view: { busy: boolean; fullFileShown: boolean }): boolean {
  return banner.canApprove && !view.busy && (!banner.truncated || view.fullFileShown);
}
