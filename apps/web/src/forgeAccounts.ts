import {
  type CreateForgeAccountBody,
  FORGE_DEFAULT_SERVER_URL,
  type ForgeAccount,
  type ForgeProvider,
  type UpdateForgeAccountBody,
} from '@emberline/protocol';

export const PROVIDER_LABEL: Record<ForgeProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gitea: 'Gitea / Forgejo',
};
export const FORGE_ACCOUNTS_HREF = '/settings?tab=notifications#forge-accounts';

export const isPlainHttpServer = (url: string) => /^http:\/\//i.test(url.trim());

export function serverAfterProviderChange(
  previous: ForgeProvider,
  next: ForgeProvider,
  current: string,
): string {
  const typed = current.trim();
  return typed === '' || typed === FORGE_DEFAULT_SERVER_URL[previous]
    ? FORGE_DEFAULT_SERVER_URL[next]
    : current;
}

export interface AccountForm {
  provider: ForgeProvider;
  serverUrl: string;
  token: string;
  allowHttp: boolean;
}

export function createAccountBody(form: AccountForm): { body: CreateForgeAccountBody } | { error: string } {
  const serverUrl = form.serverUrl.trim();
  const token = form.token.trim();
  if (!serverUrl) return { error: "Enter the server's web address." };
  if (!token) return { error: 'Paste a token.' };
  if (isPlainHttpServer(serverUrl) && !form.allowHttp)
    return { error: 'Confirm sending the token over plain http://.' };
  return { body: { provider: form.provider, serverUrl, token, allowHttp: form.allowHttp } };
}

export function accountHost(a: Pick<ForgeAccount, 'serverUrl'>): string {
  return a.serverUrl.replace(/^https?:\/\//i, '');
}

export function accountUserLine(a: Pick<ForgeAccount, 'username' | 'source'>): string {
  const user = a.username ? `Signed in as ${a.username}` : 'Not checked yet';
  return a.source === 'environment' ? `${user} · from environment` : user;
}

/** The PATCH body for a new token; a blank token is never sent (core would keep the old one silently). */
export function replaceTokenBody(token: string): { body: UpdateForgeAccountBody } | { error: string } {
  const trimmed = token.trim();
  return trimmed ? { body: { token: trimmed } } : { error: 'Paste the new token.' };
}

/** A core message as a sentence: first letter capital, ends with a full stop. */
export function asSentence(message: string): string {
  const text = message.trim();
  if (!text) return text;
  const capital = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
