// @vitest-environment happy-dom
import type { ImportStatusResponse, Project } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from '../api';
import type * as ApiModule from '../api';
import { apiRoutes, cleanup, click, getButton, renderDom, settle, waitFor } from '../domRender';
import { ImportRecovery, UnfinishedImportNote } from './ImportRecovery';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('../clipboard', () => ({ copyText: vi.fn(async () => true) }));

const project = {
  id: 'p1',
  name: 'Shop',
  slug: 'shop',
  importSource: 'url',
  repoUrl: 'git@github.com:alice/shop.git',
  importUnfinished: true,
} as Project;
const awaiting: ImportStatusResponse = {
  status: 'awaiting_key',
  exitCode: null,
  terminalId: null,
  tail: '',
  sshKey: { publicKey: 'ssh-ed25519 AAAAown emberline-shop', fingerprint: 'SHA256:own' },
};
const ready: ImportStatusResponse = { status: 'ready', exitCode: 0, terminalId: 't2', tail: '' };

let status: ImportStatusResponse;
let calls: string[];

beforeEach(() => {
  status = awaiting;
  calls = [];
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/projects/p1/import-status': () => status,
      'GET /api/projects/p1/ssh-key': () => ({ choice: 'own', key: null, shared: null }),
      'POST /api/projects/p1/import-clone': () => {
        calls.push('import-clone');
        status = ready;
        return { terminalId: 't2' };
      },
      'GET /api/projects/p1/detect': () => ({ detected: { appType: 'web' } }),
      'DELETE /api/projects/p1': () => {
        calls.push('delete-project');
        return undefined;
      },
    }),
  );
});
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

const text = () => document.body.textContent ?? '';

describe('ImportRecovery (Project settings → Repository)', () => {
  it('shows a project waiting for its key with Copy, the deploy-key hint and Clone now', async () => {
    await renderDom(createElement(ImportRecovery, { project }), { path: '/projects/p1/settings' });
    await waitFor(() => expect(text()).toContain('ssh-ed25519 AAAAown emberline-shop'));
    expect(text()).toContain('The import is not finished');
    expect(text()).toContain('Add it to alice/shop → Settings → Deploy keys, tick "Allow write access"');
    expect(getButton('Copy')).toBeTruthy();
    await click(getButton('Clone now'));
    await waitFor(() => expect(text()).toContain('The repository is cloned.'));
    expect(calls).toEqual(['import-clone']);
  });

  it('offers to remove the project, asks first, then leaves its settings', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      await renderDom(createElement(ImportRecovery, { project }), { path: '/projects/p1/settings' });
      await waitFor(() => expect(text()).toContain('Cancel and remove the project'));
      await click(getButton('Cancel and remove the project'));
      expect(confirm).toHaveBeenCalledOnce();
      expect(confirm.mock.calls[0]?.[0]).toContain('Remove Shop');
      await settle(30);
      expect(calls).toEqual([]);
      expect(window.location.pathname).toBe('/projects/p1/settings');
      confirm.mockReturnValue(true);
      await click(getButton('Cancel and remove the project'));
      await waitFor(() => expect(calls).toEqual(['delete-project']));
      await waitFor(() => expect(window.location.pathname).toBe('/'));
    } finally {
      confirm.mockRestore();
    }
  });

  it('a failed clone that left files: the project stays, and the folder is explained', async () => {
    status = { status: 'failed', exitCode: 128, terminalId: 't1', tail: 'fatal' };
    const base = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path: string, method = 'GET', body?: unknown) => {
      if (path === '/api/projects/p1/ssh-key') return { choice: 'shared', key: null, shared: null } as never;
      if (path === '/api/projects' && method === 'POST') calls.push('create-project');
      if (path === '/api/projects/p1/import-clone') {
        calls.push('import-clone');
        throw new ApiRequestError(
          409,
          'directory_exists',
          'directory already exists and is not empty: /workspaces/shop',
        );
      }
      return base(path, method, body) as never;
    });
    await renderDom(createElement(ImportRecovery, { project }), { path: '/projects/p1/settings' });
    await waitFor(() => expect(getButton('Try again')).toBeTruthy());
    await click(getButton('Try again'));
    await waitFor(() => expect(text()).toContain("left files in the project's folder"));
    await settle(30);
    expect(calls).toEqual(['import-clone']);
    expect(window.location.pathname).toBe('/projects/p1/settings');
  });

  it('shows a failed ssh clone with Try again', async () => {
    status = { status: 'failed', exitCode: 128, terminalId: 't1', tail: 'fatal' };
    await renderDom(createElement(ImportRecovery, { project }));
    await waitFor(() => expect(getButton('Try again')).toBeTruthy());
    await click(getButton('Try again'));
    await waitFor(() => expect(text()).toContain('The repository is cloned.'));
    expect(calls).toEqual(['import-clone']);
  });

  it('is not there for a finished import, an https failure or a project not imported from an address', async () => {
    status = ready;
    await renderDom(createElement(ImportRecovery, { project }));
    await settle(30);
    expect(text()).toBe('');
    await cleanup();

    status = { status: 'failed', exitCode: 128, terminalId: 't1', tail: '' };
    await renderDom(
      createElement(ImportRecovery, {
        project: { ...project, repoUrl: 'https://github.com/alice/shop.git' },
      }),
    );
    await settle(30);
    expect(text()).toBe('');
    await cleanup();

    vi.mocked(api).mockClear();
    await renderDom(createElement(ImportRecovery, { project: { ...project, importSource: 'folder' } }));
    await settle(30);
    expect(text()).toBe('');
    expect(vi.mocked(api)).not.toHaveBeenCalled();
  });
});

describe('a finished import is never asked for its status (Ruling 24)', () => {
  it('sends no import-status request for a project core calls finished, and one for an unfinished one', async () => {
    const asked: string[] = [];
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects/p1/import-status': () => {
          asked.push('p1');
          return ready;
        },
        'GET /api/projects/p2/import-status': () => {
          asked.push('p2');
          return awaiting;
        },
        'GET /api/projects/p2/ssh-key': () => ({ choice: 'own', key: null, shared: null }),
      }),
    );
    const finished = { ...project, importUnfinished: false };
    await renderDom(createElement(ImportRecovery, { project: finished }));
    await renderDom(createElement(UnfinishedImportNote, { project: finished }));
    await settle(30);
    expect(asked).toEqual([]);

    await renderDom(createElement(UnfinishedImportNote, { project: { ...project, id: 'p2' } }));
    await waitFor(() => expect(asked).toEqual(['p2']));
  });
});

describe("UnfinishedImportNote (the project's main page)", () => {
  it('points to Project settings → Repository while the key is awaited', async () => {
    await renderDom(createElement(UnfinishedImportNote, { project }));
    await waitFor(() => expect(text()).toContain('waits for its SSH key'));
    const link = document.body.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/projects/p1/settings');
    expect(link?.textContent).toContain('Project settings → Repository');
  });

  it('is not there once the import is finished', async () => {
    status = ready;
    await renderDom(createElement(UnfinishedImportNote, { project }));
    await settle(30);
    expect(text()).toBe('');
  });
});
