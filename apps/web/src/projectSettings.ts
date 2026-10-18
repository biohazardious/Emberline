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
  kind: 'changed' | 'removed' | 'unreadable';
  title: string;
  canApprove: boolean;
  approveBody: ApproveWorktreeConfigBody | null;
  errors: string[];
  diff: string;
}

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
    };
  }
  if (!s.changed) return null;
  const canApprove = s.head !== null && s.errors.length === 0;
  return {
    kind: 'changed',
    title: 'worktree.yml changed — review',
    canApprove,
    approveBody: canApprove && s.head ? { sha256: s.head.sha256 } : null,
    errors: s.errors,
    diff: s.diff,
  };
}
