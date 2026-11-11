// @vitest-environment happy-dom
import type { SshKeyPublic } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api';
import type * as ApiModule from '../../api';
import { apiRoutes, cleanup, click, getButton, renderDom, waitFor } from '../../domRender';
import { OWN_KEY_BUTTON } from '../../sshKeys';
import { RepoSshKey } from './RepoSshKey';
import { initialWizardState, type WizardState } from './wizardLogic';

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('../../clipboard', () => ({ copyText: vi.fn(async () => true) }));

const key: SshKeyPublic = {
  publicKey: 'ssh-ed25519 AAAAshared emberline',
  fingerprint: 'SHA256:shared',
  createdAt: '2026-11-10T09:00:00.000Z' as unknown as Date,
  algorithm: 'ed25519',
};
const state = (patch: Partial<WizardState> = {}): WizardState => ({
  ...initialWizardState(),
  source: 'import_url',
  step: 'repo',
  name: 'shop',
  repoUrl: 'git@github.com:alice/shop.git',
  ...patch,
});

let shared: SshKeyPublic | null;
let generated: number;

beforeEach(() => {
  shared = null;
  generated = 0;
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/ssh-key': () => ({ key: shared }),
      'POST /api/ssh-key': () => {
        generated += 1;
        shared = key;
        return { key };
      },
    }),
  );
});
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

const text = () => document.body.textContent ?? '';

describe('wizard Repository step: the ssh key', () => {
  it('shows the shared key that will be used, with Copy and the own-key choice', async () => {
    shared = key;
    const dispatch = vi.fn();
    await renderDom(createElement(RepoSshKey, { state: state(), dispatch }));
    await waitFor(() => expect(text()).toContain(key.publicKey));
    expect(text()).toContain("Emberline's shared key");
    expect(text()).toContain('SHA256:shared');
    expect(getButton('Copy')).toBeTruthy();
    await click(getButton(OWN_KEY_BUTTON));
    expect(dispatch).toHaveBeenCalledWith({ type: 'sshKeyChoice', choice: 'own' });
  });

  it('without a shared key offers both ways to get one', async () => {
    const dispatch = vi.fn();
    await renderDom(createElement(RepoSshKey, { state: state(), dispatch }));
    await waitFor(() => expect(text()).toContain('Emberline has no SSH key yet'));
    expect(getButton(OWN_KEY_BUTTON)).toBeTruthy();
    await click(getButton('Create a shared key'));
    await waitFor(() => expect(text()).toContain(key.publicKey));
    expect(generated).toBe(1);
  });

  it("with the project's own key says when it is made, and goes back to the shared key", async () => {
    shared = key;
    const dispatch = vi.fn();
    await renderDom(createElement(RepoSshKey, { state: state({ sshKeyChoice: 'own' }), dispatch }));
    await waitFor(() => expect(text()).toContain("This project's own key"));
    expect(text()).not.toContain(key.publicKey);
    expect(text()).toContain('deploy key');
    await click(getButton("Use Emberline's shared key"));
    expect(dispatch).toHaveBeenCalledWith({ type: 'sshKeyChoice', choice: 'shared' });
  });

  it('is not there for an https address', async () => {
    await renderDom(
      createElement(RepoSshKey, {
        state: state({ repoUrl: 'https://github.com/a/s.git' }),
        dispatch: vi.fn(),
      }),
    );
    expect(text()).toBe('');
    expect(vi.mocked(api)).not.toHaveBeenCalled();
  });
});
