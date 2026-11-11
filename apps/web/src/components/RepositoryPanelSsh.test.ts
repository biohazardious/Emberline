// @vitest-environment happy-dom
import type { HostKeyDetails, Project, RepositoryStatus } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from '../api';
import type * as ApiModule from '../api';
import { apiRoutes, cleanup, click, getButton, queryButton, renderDom, waitFor } from '../domRender';
import { RepositoryPanel } from './RepositoryPanel';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

const project = { id: 'p1', slug: 'shop', name: 'Shop' } as Project;
const base = '/api/projects/p1/repository';
const status = {
  isGitRepo: true,
  branch: 'main',
  defaultBranch: 'main',
  hasCommits: true,
  originUrl: 'git@git.example.com:alice/shop.git',
  connected: true,
  mainState: 'in_sync',
  ahead: 0,
  keepMainPushed: false,
  originHasCredentials: false,
  originMasked: false,
} as unknown as RepositoryStatus;
const hostKey: HostKeyDetails = {
  host: 'git.example.com',
  port: 22,
  keyType: 'ssh-ed25519',
  key: 'AAAAhost',
  fingerprint: 'SHA256:Hk3y',
};

let refreshes: number;
let trusted: unknown[];
let failWith: ApiRequestError | null;

beforeEach(() => {
  refreshes = 0;
  trusted = [];
  failWith = null;
  vi.mocked(api).mockImplementation(
    apiRoutes({
      [`GET ${base}`]: () => status,
      'GET /api/forge/accounts': () => ({ accounts: [], legacyTokenUnmatched: false }),
      'GET /api/projects/p1/ssh-key': () => ({ choice: 'shared', key: null, shared: null }),
      [`POST ${base}/refresh`]: () => {
        refreshes += 1;
        if (failWith) {
          const e = failWith;
          failWith = null;
          throw e;
        }
        return status;
      },
      'POST /api/ssh-host-keys': (body) => {
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

describe('Repository panel and ssh problems', () => {
  it('shows the SSH key choice beside the origin', async () => {
    await renderDom(createElement(RepositoryPanel, { project }));
    await waitFor(() => expect(text()).toContain("Emberline's shared key"));
    expect(text()).toContain("This project's own key");
  });

  it('offers to trust an unknown host key, then runs the operation again', async () => {
    failWith = new ApiRequestError(409, 'host_key_unknown', 'git.example.com is not known.', { hostKey });
    await renderDom(createElement(RepositoryPanel, { project }));
    await waitFor(() => expect(queryButton('Refresh')).not.toBeNull());
    await click(getButton('Refresh'));
    await waitFor(() => expect(text()).toContain('Trust this host key (SHA256:Hk3y)?'));
    await click(getButton('Trust and try again'));
    await waitFor(() => expect(refreshes).toBe(2));
    expect(trusted).toEqual([hostKey]);
    await waitFor(() => expect(text()).not.toContain('Trust this host key'));
  });

  it('explains a changed host key and offers no trust', async () => {
    failWith = new ApiRequestError(409, 'host_key_changed', 'The host key of git.example.com changed.');
    await renderDom(createElement(RepositoryPanel, { project }));
    await waitFor(() => expect(queryButton('Refresh')).not.toBeNull());
    await click(getButton('Refresh'));
    await waitFor(() => expect(text()).toContain("The server's host key is not the one Emberline knows."));
    expect(queryButton(/Trust/)).toBeNull();
  });
});
