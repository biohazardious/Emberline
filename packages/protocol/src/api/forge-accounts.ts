import { z } from 'zod';
import { ForgeProvider } from './forge.js';

/** What each provider's token needs, in one sentence (Settings form hint and the account list). */
export const FORGE_SCOPE_HINTS: Record<ForgeProvider, string> = {
  github:
    'Classic token: repo. Fine-grained token: Contents, Pull requests and Issues read/write, and Administration write to create repositories.',
  gitlab: 'Scope: api.',
  gitea: 'Scopes: write:repository, write:issue, and write:user to create repositories under your user.',
};
/** The server field's starting value per provider (Gitea has no public default). */
export const FORGE_DEFAULT_SERVER_URL: Record<ForgeProvider, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
  gitea: '',
};

export const ForgeAccount = z.object({
  id: z.string(),
  provider: ForgeProvider,
  /** Web origin, optionally with a sub-path: `https://github.com`, `https://example.com/gitea`. */
  serverUrl: z.string(),
  apiUrl: z.string(),
  /** Filled by a successful create or check; null until then (a migrated account). */
  username: z.string().nullable(),
  tokenConfigured: z.boolean(),
  scopesHint: z.string(),
  /** `environment`: from EMBERLINE_FORGE_TOKEN, read-only here. */
  source: z.enum(['settings', 'environment']),
});
export type ForgeAccount = z.infer<typeof ForgeAccount>;

export const ForgeAccountsResponse = z.object({ accounts: z.array(ForgeAccount) });
export type ForgeAccountsResponse = z.infer<typeof ForgeAccountsResponse>;

export const CreateForgeAccountBody = z.object({
  provider: ForgeProvider,
  serverUrl: z.string().trim().min(1).max(500),
  token: z.string().trim().min(1).max(500),
  /** The person confirmed sending the token over plain http:// to this server. */
  allowHttp: z.boolean().default(false),
});
export type CreateForgeAccountBody = z.input<typeof CreateForgeAccountBody>;

/** Only the token can change (blank keeps it); a new server or provider is a new account. */
export const UpdateForgeAccountBody = z.object({ token: z.string().trim().max(500).optional() });
export type UpdateForgeAccountBody = z.input<typeof UpdateForgeAccountBody>;
