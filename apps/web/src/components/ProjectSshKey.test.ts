// @vitest-environment happy-dom
import type { Project, ProjectSshKeyResponse, SshKeyPublic } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type * as ApiModule from '../api';
import { apiRoutes, cleanup, click, getButton, queryButton, renderDom, waitFor } from '../domRender';
import { OWN_KEY_LABEL, SHARED_KEY_LABEL } from '../sshKeys';
import { ProjectSshKey } from './ProjectSshKey';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('../clipboard', () => ({ copyText: vi.fn(async () => true) }));

const k = (name: string): SshKeyPublic => ({
  publicKey: `ssh-ed25519 AAAA${name} emberline-${name}`,
  fingerprint: `SHA256:${name}`,
  createdAt: '2026-11-10T09:00:00.000Z' as unknown as Date,
  algorithm: 'ed25519',
});
const project = { id: 'p1', slug: 'shop', name: 'Shop' } as Project;
const base = '/api/projects/p1/ssh-key';

let state: ProjectSshKeyResponse;
let calls: unknown[];

beforeEach(() => {
  state = { choice: 'shared', key: null, shared: k('shared') };
  calls = [];
  vi.mocked(api).mockImplementation(
    apiRoutes({
      [`GET ${base}`]: () => state,
      [`POST ${base}`]: () => {
        calls.push('generate');
        state = { ...state, key: k(state.key ? 'own2' : 'own') };
        return state;
      },
      [`DELETE ${base}`]: () => {
        calls.push('delete');
        state = { ...state, key: null };
        return undefined;
      },
      'PUT /api/projects/p1/ssh-key-choice': (body) => {
        calls.push(body);
        const { choice } = body as { choice: 'shared' | 'own' };
        state = { ...state, choice, key: choice === 'own' && !state.key ? k('own') : state.key };
        return state;
      },
    }),
  );
});
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
  vi.restoreAllMocks();
});

const text = () => document.body.textContent ?? '';
const radio = (label: string) =>
  [...document.body.querySelectorAll<HTMLInputElement>('input[type=radio]')].find((r) =>
    r.closest('label')?.textContent?.includes(label),
  )!;
const mount = () =>
  renderDom(createElement(ProjectSshKey, { project, originUrl: 'git@github.com:alice/shop.git' }));

describe('Project settings → Repository → SSH key', () => {
  it('shows the shared key chosen, with its fingerprint', async () => {
    await mount();
    await waitFor(() => expect(radio(SHARED_KEY_LABEL).checked).toBe(true));
    expect(text()).toContain("Emberline's shared key (SHA256:shared)");
    expect(radio(OWN_KEY_LABEL).checked).toBe(false);
    expect(text()).not.toContain('Deploy keys');
  });

  it('choosing the own key makes one and shows it with the deploy-key hint', async () => {
    await mount();
    await waitFor(() => expect(radio(OWN_KEY_LABEL)).toBeDefined());
    await click(radio(OWN_KEY_LABEL));
    await waitFor(() => expect(text()).toContain('ssh-ed25519 AAAAown emberline-own'));
    expect(calls).toEqual([{ choice: 'own' }]);
    expect(radio(OWN_KEY_LABEL).checked).toBe(true);
    expect(text()).toContain('Add it to alice/shop → Settings → Deploy keys, tick "Allow write access"');
  });

  it('switching back to the shared key keeps the project key', async () => {
    state = { choice: 'own', key: k('own'), shared: k('shared') };
    await mount();
    await waitFor(() => expect(radio(OWN_KEY_LABEL).checked).toBe(true));
    await click(radio(SHARED_KEY_LABEL));
    await waitFor(() => expect(radio(SHARED_KEY_LABEL).checked).toBe(true));
    expect(calls).toEqual([{ choice: 'shared' }]);
    expect(text()).toContain('ssh-ed25519 AAAAown emberline-own');
    expect(text()).toContain('kept');
  });

  it('asks before New key', async () => {
    state = { choice: 'own', key: k('own'), shared: null };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await mount();
    await waitFor(() => expect(text()).toContain('AAAAown'));
    await click(getButton('New key'));
    expect(calls).toEqual([]);
    expect(confirm.mock.calls[0]![0]).toContain('Deploy keys');
    confirm.mockReturnValue(true);
    await click(getButton('New key'));
    await waitFor(() => expect(text()).toContain('AAAAown2'));
    expect(calls).toEqual(['generate']);
  });

  it('asks before Delete, reminds about the forge, and keeps the choice own (Ruling 19)', async () => {
    state = { choice: 'own', key: k('own'), shared: k('shared') };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await mount();
    await waitFor(() => expect(text()).toContain('AAAAown'));
    await click(getButton('Delete'));
    expect(calls).toEqual([]);
    expect(confirm.mock.calls[0]![0]).toContain('remove it from the repository');
    confirm.mockReturnValue(true);
    await click(getButton('Delete'));
    await waitFor(() => expect(text()).toContain('This project has no key'));
    expect(calls).toEqual(['delete']);
    expect(radio(OWN_KEY_LABEL).checked).toBe(true);
    await click(getButton('Create a key'));
    await waitFor(() => expect(text()).toContain('AAAAown'));
    expect(calls).toEqual(['delete', 'generate']);
  });

  it('says where to make the shared key when there is none', async () => {
    state = { choice: 'shared', key: null, shared: null };
    await mount();
    await waitFor(() => expect(text()).toContain('none yet'));
    expect(document.body.querySelector('a')?.getAttribute('href')).toBe('/settings?tab=ssh_key#ssh-key');
    expect(queryButton('Delete')).toBeNull();
  });
});
