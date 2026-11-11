// @vitest-environment happy-dom
import type { HostKeyDetails } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from '../api';
import type * as ApiModule from '../api';
import { apiRoutes, cleanup, click, getButton, renderDom, waitFor } from '../domRender';
import { HostKeyChangedNote, HostKeyTrust } from './HostKeyTrust';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

const hostKey: HostKeyDetails = {
  host: 'git.example.com',
  port: 2222,
  keyType: 'ssh-ed25519',
  key: 'AAAAC3NzaC1lZDI1NTE5AAAAIhost',
  fingerprint: 'SHA256:Hk3y',
};

let trusted: unknown[];
let refuse: boolean;

beforeEach(() => {
  trusted = [];
  refuse = false;
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'POST /api/ssh-host-keys': (body) => {
        if (refuse)
          throw new ApiRequestError(409, 'host_key_changed', 'git.example.com:2222 has another key.');
        trusted.push(body);
        return { ...hostKey, trustedAt: new Date() };
      },
    }),
  );
});
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

const text = () => document.body.textContent ?? '';

describe('HostKeyTrust', () => {
  it('asks with the fingerprint and the note to compare it', async () => {
    await renderDom(createElement(HostKeyTrust, { hostKey, onTrusted: () => undefined }));
    expect(text()).toContain('Trust this host key (SHA256:Hk3y)?');
    expect(text()).toContain('git.example.com:2222');
    expect(text()).toContain('ssh-ed25519');
    expect(text()).toContain("Compare it with the fingerprint the server's admin publishes");
  });

  it('trusts exactly the offered key, then hands over', async () => {
    const onTrusted = vi.fn();
    await renderDom(createElement(HostKeyTrust, { hostKey, onTrusted, trustLabel: 'Trust and try again' }));
    await click(getButton('Trust and try again'));
    await waitFor(() => expect(onTrusted).toHaveBeenCalledOnce());
    expect(trusted).toEqual([hostKey]);
  });

  it('shows a refusal and does not hand over', async () => {
    refuse = true;
    const onTrusted = vi.fn();
    await renderDom(createElement(HostKeyTrust, { hostKey, onTrusted }));
    await click(getButton('Trust this host key'));
    await waitFor(() => expect(text()).toContain('has another key'));
    expect(onTrusted).not.toHaveBeenCalled();
  });
});

describe('HostKeyChangedNote', () => {
  it('explains, offers no trust and links to the trusted hosts', async () => {
    await renderDom(createElement(HostKeyChangedNote, { hostKey }));
    expect(text()).toContain('is not the one Emberline knows for git.example.com:2222');
    expect(text()).toContain('SHA256:Hk3y');
    expect(document.body.querySelector('button')).toBeNull();
    const link = document.body.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/settings?tab=ssh_key#trusted-host-keys');
  });

  it('copes without the offered key', async () => {
    await renderDom(createElement(HostKeyChangedNote, { hostKey: null }));
    expect(text()).toContain("The server's host key is not the one Emberline knows.");
  });
});
