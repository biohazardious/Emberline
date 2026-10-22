import { describe, expect, it } from 'vitest';
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
