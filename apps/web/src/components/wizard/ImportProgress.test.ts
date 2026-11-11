// @vitest-environment happy-dom
import type {
  CreateProjectBody,
  HostKeyDetails,
  ImportStatusResponse,
  ProjectSshKeyResponse,
  SshKeyPublic,
} from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api';
import type * as ApiModule from '../../api';
import { apiRoutes, cleanup, click, getButton, queryButton, renderDom, waitFor } from '../../domRender';
import { MISSING_KEY_TEXT, OWN_KEY_BUTTON } from '../../sshKeys';
import { ImportProgress } from './ImportProgress';

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('../../clipboard', () => ({ copyText: vi.fn(async () => true) }));

const k = (name: string): SshKeyPublic => ({
  publicKey: `ssh-ed25519 AAAA${name} emberline-${name}`,
  fingerprint: `SHA256:${name}`,
  createdAt: '2026-11-10T09:00:00.000Z' as unknown as Date,
  algorithm: 'ed25519',
});
const hostKey: HostKeyDetails = {
  host: 'git.example.com',
  port: 22,
  keyType: 'ssh-ed25519',
  key: 'AAAAhost',
  fingerprint: 'SHA256:Hk3y',
};
const sshBody: CreateProjectBody = {
  name: 'shop',
  source: 'import_url',
  repoUrl: 'git@github.com:alice/shop.git',
};
const detect = { detected: { appType: 'web' } };
const failed = (patch: Partial<ImportStatusResponse>): ImportStatusResponse => ({
  status: 'failed',
  exitCode: 128,
  terminalId: 't1',
  tail: 'fatal: …',
  ...patch,
});

let statuses: ImportStatusResponse[];
let keyState: ProjectSshKeyResponse;
let calls: string[];

const ready: ImportStatusResponse = { status: 'ready', exitCode: 0, terminalId: 't2', tail: '' };

beforeEach(() => {
  statuses = [];
  keyState = { choice: 'shared', key: null, shared: k('shared') };
  calls = [];
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/projects/p1/import-status': () => statuses.shift() ?? ready,
      'POST /api/projects/p1/import-clone': () => {
        calls.push('import-clone');
        return { terminalId: 't2' };
      },
      'GET /api/projects/p1/detect': () => detect,
      'GET /api/projects/p1/ssh-key': () => keyState,
      'POST /api/projects/p1/ssh-key': () => {
        calls.push('own-key');
        keyState = { ...keyState, key: k('own') };
        return keyState;
      },
      'PUT /api/projects/p1/ssh-key-choice': (body) => {
        calls.push(`choice-${(body as { choice: string }).choice}`);
        keyState = { ...keyState, choice: 'own', key: keyState.key ?? k('own') };
        return keyState;
      },
      'POST /api/ssh-key': () => {
        calls.push('shared-key');
        keyState = { ...keyState, shared: k('shared') };
        return { key: keyState.shared };
      },
      'POST /api/ssh-host-keys': () => {
        calls.push('trust');
        return { ...hostKey, trustedAt: new Date() };
      },
      'DELETE /api/terminals/t1': () => undefined,
      'DELETE /api/projects/p1': () => {
        calls.push('delete-project');
        return undefined;
      },
      'POST /api/projects': () => {
        calls.push('create-project');
        return { project: { id: 'p2' }, terminalId: 't3' };
      },
    }),
  );
});
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

const text = () => document.body.textContent ?? '';
const mount = async (props: Partial<Parameters<typeof ImportProgress>[0]> = {}) => {
  const handlers = { onDetected: vi.fn(), onRecreated: vi.fn(), onCancelled: vi.fn() };
  const view = await renderDom(
    createElement(ImportProgress, {
      source: 'import_url',
      projectId: 'p1',
      createBody: sshBody,
      ...handlers,
      ...props,
    }),
  );
  return { handlers, view };
};

describe('ImportProgress: own key waits for the forge (Ruling 21)', () => {
  it('shows the public key and the deploy-key hint, then clones on Clone now', async () => {
    statuses = [
      {
        status: 'awaiting_key',
        exitCode: null,
        terminalId: null,
        tail: '',
        sshKey: { publicKey: 'ssh-ed25519 AAAAown emberline-shop', fingerprint: 'SHA256:own' },
      },
    ];
    const { handlers } = await mount({ createBody: { ...sshBody, sshKeyChoice: 'own' } });
    await waitFor(() => expect(text()).toContain('ssh-ed25519 AAAAown emberline-shop'));
    expect(text()).toContain('Add it to alice/shop → Settings → Deploy keys, tick "Allow write access"');
    expect(text()).toContain('remove the deploy key');
    await click(getButton('Clone now'));
    await waitFor(() => expect(handlers.onDetected).toHaveBeenCalledWith(detect));
    expect(calls).toEqual(['import-clone']);
  });

  it('Cancel removes the project and says the deploy key can go too', async () => {
    statuses = [
      {
        status: 'awaiting_key',
        exitCode: null,
        terminalId: null,
        tail: '',
        sshKey: { publicKey: 'ssh-ed25519 AAAAown x', fingerprint: 'SHA256:own' },
      },
    ];
    const { handlers } = await mount({ createBody: { ...sshBody, sshKeyChoice: 'own' } });
    await waitFor(() => expect(queryButton('Cancel and remove the project')).not.toBeNull());
    await click(getButton('Cancel and remove the project'));
    await waitFor(() => expect(handlers.onCancelled).toHaveBeenCalledOnce());
    expect(calls).toEqual(['delete-project']);
  });

  it('offers to make the key again when it was deleted', async () => {
    statuses = [{ status: 'awaiting_key', exitCode: null, terminalId: null, tail: '', sshKey: null }];
    keyState = { choice: 'own', key: null, shared: null };
    await mount({ createBody: { ...sshBody, sshKeyChoice: 'own' } });
    await waitFor(() => expect(text()).toContain("This project's key was deleted"));
    await click(getButton("Create this project's key"));
    await waitFor(() => expect(text()).toContain('ssh-ed25519 AAAAown emberline-own'));
    expect(calls).toEqual(['own-key']);
  });
});

describe('ImportProgress: ssh clone failures', () => {
  it('host_key_unknown: trust after comparing, then clone again keeping the project', async () => {
    statuses = [failed({ code: 'host_key_unknown', hostKey, reason: 'git.example.com is not known.' })];
    const { handlers } = await mount();
    await waitFor(() => expect(text()).toContain('Trust this host key (SHA256:Hk3y)?'));
    expect(text()).toContain("Compare it with the fingerprint the server's admin publishes");
    // The same unknown key would meet a plain retry.
    expect(queryButton('Try again')).toBeNull();
    await click(getButton('Trust and try again'));
    await waitFor(() => expect(handlers.onDetected).toHaveBeenCalledOnce());
    expect(calls).toEqual(['trust', 'import-clone']);
  });

  it('host_key_changed: explains, offers no trust, links to the trusted hosts in a new tab', async () => {
    statuses = [failed({ code: 'host_key_changed', reason: 'The host key changed.' })];
    await mount();
    await waitFor(() => expect(text()).toContain("The server's host key is not the one Emberline knows."));
    expect(queryButton(/^Trust/)).toBeNull();
    const link = document.body.querySelector<HTMLAnchorElement>(
      'a[href="/settings?tab=ssh_key#trusted-host-keys"]',
    );
    expect(link?.target).toBe('_blank');
  });

  it('ssh_key_missing: both ways to make a key, then Try again clones again', async () => {
    statuses = [failed({ code: 'ssh_key_missing', reason: MISSING_KEY_TEXT })];
    keyState = { choice: 'shared', key: null, shared: null };
    const { handlers } = await mount();
    await waitFor(() => expect(queryButton('Create a shared key')).not.toBeNull());
    expect(text()).toContain(MISSING_KEY_TEXT);
    expect(getButton(OWN_KEY_BUTTON)).toBeTruthy();
    await click(getButton('Create a shared key'));
    await waitFor(() => expect(text()).toContain('ssh-ed25519 AAAAshared emberline-shared'));
    expect(text()).toContain('GitHub → Settings → SSH and GPG keys');
    await click(getButton('Try again'));
    await waitFor(() => expect(handlers.onDetected).toHaveBeenCalledOnce());
    expect(calls).toEqual(['shared-key', 'import-clone']);
  });

  it('ssh_key_missing: the own key way switches the project to its key', async () => {
    statuses = [failed({ code: 'ssh_key_missing', reason: MISSING_KEY_TEXT })];
    keyState = { choice: 'shared', key: null, shared: null };
    await mount();
    await waitFor(() => expect(queryButton(OWN_KEY_BUTTON)).not.toBeNull());
    await click(getButton(OWN_KEY_BUTTON));
    await waitFor(() => expect(text()).toContain('ssh-ed25519 AAAAown emberline-own'));
    expect(text()).toContain('Deploy keys');
    expect(calls).toEqual(['choice-own']);
  });

  it('auth_refused over ssh: the key in use and where to add it, then Try again keeps the project', async () => {
    statuses = [failed({ code: 'auth_refused', reason: "The server refused Emberline's SSH key." })];
    const { handlers } = await mount();
    await waitFor(() => expect(text()).toContain('ssh-ed25519 AAAAshared emberline-shared'));
    expect(text()).toContain('GitHub → Settings → SSH and GPG keys');
    await click(getButton('Try again'));
    await waitFor(() => expect(handlers.onDetected).toHaveBeenCalledOnce());
    expect(calls).toEqual(['import-clone']);
  });

  it('auth_refused over https: no key help, Try again clones afresh as before', async () => {
    statuses = [
      failed({ code: 'auth_refused', reason: "The forge refused the account's token for github.com." }),
    ];
    const { handlers } = await mount({
      createBody: { name: 'shop', source: 'import_url', repoUrl: 'https://github.com/alice/shop.git' },
    });
    await waitFor(() => expect(text()).toContain("refused the account's token"));
    expect(text()).not.toContain('ssh-ed25519');
    expect(text()).not.toContain('Deploy keys');
    await click(getButton('Try again'));
    await waitFor(() => expect(handlers.onRecreated).toHaveBeenCalledWith('p2'));
    expect(calls).toEqual(['delete-project', 'create-project']);
  });
});
