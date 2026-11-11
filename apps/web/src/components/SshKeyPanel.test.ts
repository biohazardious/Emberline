// @vitest-environment happy-dom
import type { SshKeyPublic, TrustedHostKey } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type * as ApiModule from '../api';
import { copyText } from '../clipboard';
import { apiRoutes, cleanup, click, getButton, queryButton, renderDom, waitFor } from '../domRender';
import { SshKeyPanel } from './SshKeyPanel';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('../clipboard', () => ({ copyText: vi.fn(async () => true) }));

const keyA: SshKeyPublic = {
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKaaaa emberline',
  fingerprint: 'SHA256:aaaa',
  createdAt: '2026-11-10T09:00:00.000Z' as unknown as Date,
  algorithm: 'ed25519',
};
const keyB: SshKeyPublic = {
  ...keyA,
  publicKey: 'ssh-ed25519 AAAAbbbb emberline',
  fingerprint: 'SHA256:bbbb',
};
const host: TrustedHostKey = {
  host: 'git.example.com',
  port: 2222,
  keyType: 'ssh-ed25519',
  key: 'AAAAhost',
  fingerprint: 'SHA256:host',
  trustedAt: '2026-11-09T09:00:00.000Z' as unknown as Date,
};

let shared: SshKeyPublic | null;
let hosts: TrustedHostKey[];
let calls: string[];
let removed: unknown[];

beforeEach(() => {
  shared = null;
  hosts = [];
  calls = [];
  removed = [];
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/ssh-key': () => ({ key: shared }),
      'POST /api/ssh-key': () => {
        calls.push('generate');
        shared = shared ? keyB : keyA;
        return { key: shared };
      },
      'DELETE /api/ssh-key': () => {
        calls.push('delete');
        shared = null;
        return undefined;
      },
      'GET /api/ssh-host-keys': () => ({ hosts }),
      'DELETE /api/ssh-host-keys': (body) => {
        removed.push(body);
        hosts = [];
        return undefined;
      },
    }),
  );
});
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
  vi.mocked(copyText).mockClear();
  vi.restoreAllMocks();
});

const text = () => document.body.textContent ?? '';

describe('Settings → SSH key', () => {
  it('without a key says so and creates one on request', async () => {
    await renderDom(createElement(SshKeyPanel));
    await waitFor(() => expect(text()).toContain('Emberline has no SSH key yet'));
    expect(queryButton('Copy public key')).toBeNull();
    await click(getButton('Create a key'));
    await waitFor(() => expect(text()).toContain(keyA.publicKey));
    expect(calls).toEqual(['generate']);
  });

  it('shows the key with its fingerprint, date and where to add it', async () => {
    shared = keyA;
    await renderDom(createElement(SshKeyPanel));
    await waitFor(() => expect(text()).toContain(keyA.publicKey));
    expect(text()).toContain('SHA256:aaaa');
    expect(text()).toContain('ed25519 · created 10 Nov 2026');
    expect(text()).toContain('GitHub → Settings → SSH and GPG keys');
  });

  it('copies the public key', async () => {
    shared = keyA;
    await renderDom(createElement(SshKeyPanel));
    await waitFor(() => expect(text()).toContain(keyA.publicKey));
    await click(getButton('Copy public key'));
    expect(copyText).toHaveBeenCalledWith(keyA.publicKey);
    await waitFor(() => expect(text()).toContain('Copied.'));
  });

  it('asks before New key, and says to swap the key on the forge after', async () => {
    shared = keyA;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderDom(createElement(SshKeyPanel));
    await waitFor(() => expect(text()).toContain(keyA.publicKey));
    await click(getButton('New key'));
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]![0]).toContain('stops working at once');
    expect(calls).toEqual([]);
    await click(getButton('Copy public key'));
    await waitFor(() => expect(text()).toContain('Copied.'));
    confirm.mockReturnValue(true);
    await click(getButton('New key'));
    await waitFor(() => expect(text()).toContain(keyB.publicKey));
    expect(calls).toEqual(['generate']);
    expect(text()).toContain('Remove the old public key');
    // "Copied." belonged to the old key.
    expect(text()).not.toContain('Copied.');
  });

  it('asks before Delete and then shows the empty state', async () => {
    shared = keyA;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderDom(createElement(SshKeyPanel));
    await waitFor(() => expect(text()).toContain(keyA.publicKey));
    await click(getButton('Delete'));
    expect(calls).toEqual([]);
    expect(confirm.mock.calls[0]![0]).toContain('remove its public key');
    confirm.mockReturnValue(true);
    await click(getButton('Delete'));
    await waitFor(() => expect(text()).toContain('Emberline has no SSH key yet'));
    expect(calls).toEqual(['delete']);
  });

  it('lists trusted host keys and removes one after asking', async () => {
    hosts = [host];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderDom(createElement(SshKeyPanel));
    await waitFor(() => expect(text()).toContain('git.example.com:2222'));
    expect(text()).toContain('SHA256:host');
    await click(getButton('Remove'));
    expect(confirm.mock.calls[0]![0]).toContain('git.example.com:2222');
    await waitFor(() => expect(text()).toContain('No trusted host keys'));
    expect(removed).toEqual([{ host: 'git.example.com', port: 2222, keyType: 'ssh-ed25519' }]);
  });
});
