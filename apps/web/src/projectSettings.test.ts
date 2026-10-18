import type { ProjectSettingsResponse, WorktreeConfigStatusResponse } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { gateChoice, gateChoices, gateUpdate, worktreeBanner } from './projectSettings';

const status = (o: Partial<WorktreeConfigStatusResponse> = {}): WorktreeConfigStatusResponse => ({
  approved: null,
  head: null,
  headError: null,
  changed: false,
  removed: false,
  diff: '',
  errors: [],
  ...o,
});

describe('worktreeBanner', () => {
  it('shows nothing for an unchanged file', () => {
    expect(worktreeBanner(status())).toBeNull();
    expect(worktreeBanner(undefined)).toBeNull();
  });

  it('asks for a review of a changed file and approves HEAD by its sha256', () => {
    const b = worktreeBanner(status({ changed: true, head: { content: 'x', sha256: 'a'.repeat(64) }, diff: '+x' }));
    expect(b).toMatchObject({ kind: 'changed', title: 'worktree.yml changed — review', canApprove: true });
    expect(b?.approveBody).toEqual({ sha256: 'a'.repeat(64) });
  });

  it('disables Approve while the schema reports errors', () => {
    const b = worktreeBanner(
      status({ changed: true, head: { content: 'x', sha256: 'b'.repeat(64) }, errors: ['services: bad'] }),
    );
    expect(b).toMatchObject({ kind: 'changed', canApprove: false });
    expect(b?.errors).toEqual(['services: bad']);
  });

  it('a changed file without a readable head cannot be approved', () => {
    expect(worktreeBanner(status({ changed: true }))).toMatchObject({ canApprove: false });
  });

  it('asks to approve a removal', () => {
    const b = worktreeBanner(status({ changed: true, removed: true }));
    expect(b).toMatchObject({ kind: 'removed', title: 'worktree.yml was removed — approve removal', canApprove: true });
    expect(b?.approveBody).toEqual({ removal: true });
  });

  it('a git read failure is a quiet note, not a review', () => {
    const b = worktreeBanner(status({ headError: 'no commit', changed: true }));
    expect(b).toMatchObject({ kind: 'unreadable', canApprove: false });
    expect(b?.title).toBe("couldn't read worktree.yml from the repository");
  });
});

describe('gate controls', () => {
  const settings: ProjectSettingsResponse = {
    gates: { secretGuardGate: false, antiSlopGate: true },
    effective: {
      selfHealingBuildGate: true,
      antiSlopGate: true,
      secretGuardGate: false,
      crossProviderCritic: false,
      autoSyncToMain: true,
      requireCompletionSignal: true,
    },
    global: {
      selfHealingBuildGate: true,
      antiSlopGate: false,
      secretGuardGate: true,
      crossProviderCritic: false,
      autoSyncToMain: true,
      requireCompletionSignal: true,
    },
  };

  it('maps overrides to a choice', () => {
    expect(gateChoice(settings.gates, 'secretGuardGate')).toBe('off');
    expect(gateChoice(settings.gates, 'antiSlopGate')).toBe('on');
    expect(gateChoice(settings.gates, 'autoSyncToMain')).toBe('inherit');
  });

  it('labels Inherit with the global value', () => {
    const rows = gateChoices(settings);
    const secret = rows.find((r) => r.key === 'secretGuardGate')!;
    expect(secret.options.map((o) => o.label)).toEqual(['Inherit (On)', 'On', 'Off']);
    expect(rows.find((r) => r.key === 'antiSlopGate')!.options[0]!.label).toBe('Inherit (Off)');
    expect(rows).toHaveLength(6);
  });

  it('builds the PATCH body: inherit sends null', () => {
    expect(gateUpdate('secretGuardGate', 'inherit')).toEqual({ gates: { secretGuardGate: null } });
    expect(gateUpdate('secretGuardGate', 'on')).toEqual({ gates: { secretGuardGate: true } });
    expect(gateUpdate('secretGuardGate', 'off')).toEqual({ gates: { secretGuardGate: false } });
  });
});
