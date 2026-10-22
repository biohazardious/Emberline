import type { ProjectSettingsResponse, WorktreeConfigStatusResponse } from '@emberline/protocol';
import { WORKTREE_YML_EDIT_IN_SETTINGS } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api';
import {
  approveEnabled,
  bannerOffersEdit,
  gateChoice,
  gateChoices,
  gateUpdate,
  refreshWorktreeConfigViews,
  WORKTREE_EDIT_HINT,
  WORKTREE_SAVE_LABEL,
  worktreeBanner,
  worktreeEditAvailable,
  worktreeEditorStart,
  worktreeReloadStep,
  worktreeYmlExplorerNote,
  WORKTREE_RELOAD_WARNING,
  worktreeSaveEnabled,
  worktreeSaveFailure,
} from './projectSettings';

const status = (o: Partial<WorktreeConfigStatusResponse> = {}): WorktreeConfigStatusResponse => ({
  approved: null,
  head: null,
  headError: null,
  changed: false,
  removed: false,
  diff: '',
  errors: [],
  unusable: false,
  ...o,
});

describe('worktreeBanner', () => {
  it('shows nothing for an unchanged file', () => {
    expect(worktreeBanner(status())).toBeNull();
    expect(worktreeBanner(undefined)).toBeNull();
  });

  it('asks for a review of a changed file and approves HEAD by its sha256', () => {
    const b = worktreeBanner(
      status({ changed: true, head: { content: 'x', sha256: 'a'.repeat(64) }, diff: '+x' }),
    );
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
    expect(b).toMatchObject({
      kind: 'removed',
      title: 'worktree.yml was removed — approve removal',
      canApprove: true,
    });
    expect(b?.approveBody).toEqual({ removal: true });
  });

  it('a HEAD file that cannot be used shows its errors and cannot be approved', () => {
    const b = worktreeBanner(
      status({
        changed: true,
        unusable: true,
        errors: ['.emberline/worktree.yml is a symbolic link in HEAD'],
      }),
    );
    expect(b).toMatchObject({ kind: 'unusable', canApprove: false, approveBody: null });
    expect(b?.title).toBe("worktree.yml in the repository can't be used — runs keep the approved version");
    expect(b?.errors).toEqual(['.emberline/worktree.yml is a symbolic link in HEAD']);
  });

  it('a truncated diff offers the full file, and Approve waits until it is shown', () => {
    const head = { content: 'version: 1\nsetup:\n  - big\n', sha256: 'c'.repeat(64) };
    const b = worktreeBanner(
      status({ changed: true, head, diff: '--- approved\n+++ HEAD\n+x\n… diff truncated\n' }),
    );
    expect(b).toMatchObject({ truncated: true, fullFile: head.content, canApprove: true });
    expect(approveEnabled(b!, { busy: false, fullFileShown: false })).toBe(false);
    expect(approveEnabled(b!, { busy: false, fullFileShown: true })).toBe(true);
    expect(approveEnabled(b!, { busy: true, fullFileShown: true })).toBe(false);

    const whole = worktreeBanner(status({ changed: true, head, diff: '+x\n' }))!;
    expect(whole.truncated).toBe(false);
    expect(approveEnabled(whole, { busy: false, fullFileShown: false })).toBe(true);
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

describe('worktree.yml editor helpers', () => {
  it('starts from HEAD, or from the template without one', () => {
    expect(
      worktreeEditorStart(status({ head: { content: 'version: 2\n', sha256: 'a'.repeat(64) } })),
    ).toEqual({
      content: 'version: 2\n',
      baseSha256: 'a'.repeat(64),
    });
    expect(worktreeEditorStart(status({ head: null }))).toEqual({
      content: 'version: 1\n',
      baseSha256: null,
    });
    expect(worktreeEditorStart(undefined)).toEqual({ content: 'version: 1\n', baseSha256: null });
  });

  it('Save waits for a clean, finished validation', () => {
    expect(worktreeSaveEnabled({ errors: [], validating: false, busy: false })).toBe(true);
    expect(worktreeSaveEnabled({ errors: ['x'], validating: false, busy: false })).toBe(false);
    expect(worktreeSaveEnabled({ errors: [], validating: true, busy: false })).toBe(false);
    expect(worktreeSaveEnabled({ errors: [], validating: false, busy: true })).toBe(false);
  });

  it('a 409 offers Reload with its message; a 400 shows the errors', () => {
    expect(worktreeSaveFailure(new ApiRequestError(409, 'worktree_config_changed', 'changed'))).toEqual({
      message: 'changed',
      errors: [],
      reload: true,
    });
    expect(
      worktreeSaveFailure(new ApiRequestError(400, 'worktree_config_invalid', 'bad', { errors: ['e1'] })),
    ).toEqual({
      message: 'bad',
      errors: ['e1'],
      reload: false,
    });
    expect(worktreeSaveFailure(new ApiRequestError(500, 'http_error', 'git said no'))).toEqual({
      message: 'git said no',
      errors: [],
      reload: false,
    });
    expect(worktreeSaveFailure(new Error('offline'))).toEqual({
      message: 'offline',
      errors: [],
      reload: false,
    });
  });

  it('the Board banner offers Edit only for an unusable file', () => {
    expect(
      bannerOffersEdit(worktreeBanner(status({ changed: true, unusable: true, errors: ['link'] }))),
    ).toBe(true);
    expect(
      bannerOffersEdit(
        worktreeBanner(status({ changed: true, head: { content: 'x', sha256: 'a'.repeat(64) } })),
      ),
    ).toBe(false);
    expect(bannerOffersEdit(null)).toBe(false);
  });

  it("the copy is the spec's", () => {
    expect(WORKTREE_SAVE_LABEL).toBe('Save and approve');
    expect(WORKTREE_EDIT_HINT).toBe(
      'Saving commits the file to main and approves it. Runs use it from their next start.',
    );
  });
});

describe('worktreeEditAvailable', () => {
  it('waits for the status so the editor starts from HEAD', () => {
    expect(worktreeEditAvailable(undefined)).toBe(false);
    expect(worktreeEditAvailable(status())).toBe(true);
  });
});

describe('refreshWorktreeConfigViews', () => {
  it('refetches the container preview answer and the repository block of that project', async () => {
    const keys: unknown[] = [];
    await refreshWorktreeConfigViews(
      { invalidateQueries: async ({ queryKey }) => void keys.push(queryKey) },
      'p1',
    );
    expect(keys).toEqual([
      ['api', '/api/projects/p1/container-preview'],
      ['api', '/api/projects/p1/repository'],
    ]);
  });
});

describe('worktree editor Reload', () => {
  it('Reload warns once before it replaces edits, and does nothing while busy', () => {
    expect(worktreeReloadStep({ busy: false, edited: true, warned: false })).toBe('warn');
    expect(worktreeReloadStep({ busy: false, edited: true, warned: true })).toBe('fetch');
    expect(worktreeReloadStep({ busy: false, edited: false, warned: false })).toBe('fetch');
    expect(worktreeReloadStep({ busy: true, edited: true, warned: true })).toBe('ignore');
    expect(WORKTREE_RELOAD_WARNING).toBe(
      'Reload replaces your edits with the file on main. Copy anything you want to keep, then press Reload again.',
    );
  });
});

describe('worktreeYmlExplorerNote', () => {
  it('points main to Project settings and a run to main', () => {
    expect(worktreeYmlExplorerNote('main')).toEqual({
      text: WORKTREE_YML_EDIT_IN_SETTINGS,
      link: 'Open Project settings',
    });
    expect(worktreeYmlExplorerNote('run-1')).toEqual({
      text: "This is the run's copy. Runs use the approved file from main, which you edit in Project settings.",
      link: "Edit main's worktree.yml",
    });
  });
});
