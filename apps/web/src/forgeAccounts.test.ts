// @vitest-environment happy-dom
import {
  FORGE_SCOPE_HINTS,
  type ForgeAccountsResponse,
  type NotificationSettingsView,
} from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { ForgeAccountsSection } from './components/settings/ForgeAccountsSection';
import { apiRoutes, cleanup, click, getButton, queryButton, renderDom, typeInto, waitFor } from './domRender';
import {
  accountHost,
  accountUserLine,
  asSentence,
  createAccountBody,
  feedbackAfterToggle,
  feedbackFor,
  isPlainHttpServer,
  replaceTokenBody,
  serverAfterProviderChange,
} from './forgeAccounts';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
  vi.restoreAllMocks();
});

describe('serverAfterProviderChange', () => {
  it('swaps defaults, keeps what the person typed', () => {
    expect(serverAfterProviderChange('github', 'gitlab', 'https://github.com')).toBe('https://gitlab.com');
    expect(serverAfterProviderChange('gitlab', 'gitea', 'https://gitlab.com')).toBe('');
    expect(serverAfterProviderChange('gitea', 'github', '')).toBe('https://github.com');
    expect(serverAfterProviderChange('github', 'gitea', 'https://git.example.com')).toBe(
      'https://git.example.com',
    );
  });
});

describe('createAccountBody', () => {
  const form = {
    provider: 'gitea' as const,
    serverUrl: ' https://git.example.com ',
    token: ' tok ',
    allowHttp: false,
  };
  it('trims and builds the body', () => {
    expect(createAccountBody(form)).toEqual({
      body: { provider: 'gitea', serverUrl: 'https://git.example.com', token: 'tok', allowHttp: false },
    });
  });
  it('says what is missing', () => {
    expect(createAccountBody({ ...form, serverUrl: ' ' })).toEqual({
      error: "Enter the server's web address.",
    });
    expect(createAccountBody({ ...form, token: '' })).toEqual({ error: 'Paste a token.' });
    expect(createAccountBody({ ...form, serverUrl: 'http://gitea.lan:3000' })).toEqual({
      error: 'Confirm sending the token over plain http://.',
    });
    expect(
      'body' in createAccountBody({ ...form, serverUrl: 'http://gitea.lan:3000', allowHttp: true }),
    ).toBe(true);
  });
});

describe('account lines', () => {
  it('host and user', () => {
    expect(isPlainHttpServer('HTTP://x')).toBe(true);
    expect(accountHost({ serverUrl: 'https://example.com/gitea' })).toBe('example.com/gitea');
    expect(accountUserLine({ username: 'octo', source: 'settings' })).toBe('Signed in as octo');
    expect(accountUserLine({ username: null, source: 'settings' })).toBe('Not checked yet');
    expect(accountUserLine({ username: 'octo', source: 'environment' })).toBe(
      'Signed in as octo · from environment',
    );
  });
});

describe('replaceTokenBody', () => {
  it('trims, and refuses a blank token', () => {
    expect(replaceTokenBody(' new ')).toEqual({ body: { token: 'new' } });
    expect(replaceTokenBody('  ')).toEqual({ error: 'Paste the new token.' });
  });
});

describe('asSentence', () => {
  it('capitalises and ends with a full stop', () => {
    expect(asSentence('the forge did not answer within 30 seconds')).toBe(
      'The forge did not answer within 30 seconds.',
    );
    expect(asSentence('Already fine.')).toBe('Already fine.');
  });
});

describe('feedback helpers', () => {
  it('splits a result into the alert and the status region of its scope', () => {
    expect(feedbackFor({ scope: 'a', ok: true, text: 'x' }, 'a')).toEqual({ alert: '', status: 'x' });
    expect(feedbackFor({ scope: 'a', ok: false, text: 'y' }, 'a')).toEqual({ alert: 'y', status: '' });
    expect(feedbackFor({ scope: 'b', ok: false, text: 'y' }, 'a')).toEqual({ alert: '', status: '' });
    expect(feedbackFor(null, 'a')).toEqual({ alert: '', status: '' });
  });
  it('clears only the toggled row feedback', () => {
    expect(feedbackAfterToggle({ scope: 'a1', ok: true, text: 'x' }, 'a1')).toBeNull();
    expect(feedbackAfterToggle({ scope: 'add', ok: false, text: 'y' }, 'a1')).toEqual({
      scope: 'add',
      ok: false,
      text: 'y',
    });
  });
});

describe('ForgeAccountsSection (Forges and webhooks)', () => {
  it('opens Add account on click, adds and removes a forge account, and tests/removes a webhook', async () => {
    let accounts: ForgeAccountsResponse['accounts'] = [
      {
        id: 'a1',
        provider: 'github',
        serverUrl: 'https://github.com',
        apiUrl: 'https://api.github.com',
        username: 'octo',
        tokenConfigured: true,
        scopesHint: FORGE_SCOPE_HINTS.github,
        source: 'settings',
      },
    ];
    let notif: NotificationSettingsView = {
      enabled: true,
      provider: 'ntfy',
      url: 'https://ntfy.sh/emberline',
      tokenConfigured: false,
      onRateLimited: true,
      onQuotaResumed: true,
      onWaitingInput: true,
      onRunFinished: false,
      onGitEvents: true,
    };
    const deletedAccountIds: string[] = [];
    let testedWebhook = 0;

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/forge/accounts': () => ({ accounts, legacyTokenUnmatched: false }),
        'POST /api/forge/accounts': (body) => {
          const b = body as { provider: 'gitlab'; serverUrl: string };
          const created = {
            id: 'a2',
            provider: b.provider,
            serverUrl: b.serverUrl,
            apiUrl: `${b.serverUrl}/api/v4`,
            username: 'gl-user',
            tokenConfigured: true,
            scopesHint: FORGE_SCOPE_HINTS.gitlab,
            source: 'settings' as const,
          };
          accounts = [...accounts, created];
          return created;
        },
        'DELETE /api/forge/accounts/a1': () => {
          deletedAccountIds.push('a1');
          accounts = accounts.filter((a) => a.id !== 'a1');
          return undefined;
        },
        'GET /api/notifications': () => notif,
        'POST /api/notifications/test': () => {
          testedWebhook += 1;
          return { ok: true, status: 200, error: null };
        },
        'PATCH /api/notifications': (body) => {
          notif = { ...notif, ...(body as Partial<NotificationSettingsView>) };
          return notif;
        },
      }),
    );

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = await renderDom(createElement(ForgeAccountsSection));
    await waitFor(() => expect(view.container.textContent).toContain('Signed in as octo'));

    // Add account form is closed by default
    expect(view.container.querySelector('input[placeholder="Kept in core only"]')).toBeNull();

    // Open Add account form and submit
    await click(getButton('Add account', view.container));
    const tokenInput = view.container.querySelector<HTMLInputElement>(
      'input[placeholder="Kept in core only"]',
    )!;
    expect(tokenInput).toBeTruthy();
    await typeInto(tokenInput, 'ghp_secret123');
    const submitBtns = [...view.container.querySelectorAll<HTMLButtonElement>('button[type="submit"]')];
    await click(submitBtns[0]!);
    await waitFor(() => expect(view.container.textContent).toContain('Signed in as gl-user'));

    // Test webhook from the row
    await click(getButton('Test', view.container));
    await waitFor(() => expect(testedWebhook).toBe(1));
    expect(view.container.textContent).toContain('Test notification delivered');

    // Remove forge account (danger styled + confirmed)
    const removeButtons = [...view.container.querySelectorAll<HTMLButtonElement>('button.danger')].filter(
      (b) => b.textContent?.trim() === 'Remove',
    );
    expect(removeButtons.length).toBeGreaterThanOrEqual(2);
    await click(removeButtons[0]!);
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(deletedAccountIds).toEqual(['a1']));

    // Remove webhook and re-add via Add webhook
    const removeWebhookBtn = [...view.container.querySelectorAll<HTMLButtonElement>('button.danger')].find(
      (b) => b.textContent?.trim() === 'Remove' && b.closest('[aria-labelledby="notifications-title"]'),
    )!;
    await click(removeWebhookBtn);
    await waitFor(() => expect(view.container.textContent).toContain('Webhook removed.'));
    expect(queryButton('Add webhook', view.container)).toBeTruthy();
  });
});
