import {
  type CreateForgeAccountBody,
  FORGE_DEFAULT_SERVER_URL,
  type ForgeAccount,
  type ForgeProvider,
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
