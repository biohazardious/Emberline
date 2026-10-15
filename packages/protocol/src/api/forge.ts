/** API contracts: forge integration (GitHub / GitLab / Gitea PR & MR). */
import { z } from 'zod';
import { GitBranchName } from './common.js';

export const ForgeProvider = z.enum(['github', 'gitlab', 'gitea']);
export type ForgeProvider = z.infer<typeof ForgeProvider>;

export const ForgeProviderPreference = z.enum(['auto', 'github', 'gitlab', 'gitea']);
export type ForgeProviderPreference = z.infer<typeof ForgeProviderPreference>;

export const ForgeSettings = z.object({
  provider: ForgeProviderPreference,
  /** Optional custom API base URL for self-hosted GitLab / Gitea / GitHub Enterprise. */
  apiUrl: z.string().nullable(),
  /** True when a Personal Access Token is stored in core (token itself is masked on GET). */
  tokenConfigured: z.boolean(),
});
export type ForgeSettings = z.infer<typeof ForgeSettings>;

export const UpdateForgeSettingsBody = z
  .object({
    provider: ForgeProviderPreference,
    apiUrl: z.string().trim().max(1000).nullable(),
    /** Pass null or empty string to clear, or a new PAT to replace. */
    token: z.string().trim().max(500).nullable(),
  })
  .partial();
export type UpdateForgeSettingsBody = z.input<typeof UpdateForgeSettingsBody>;

export const ForgeCiStatus = z.enum(['pending', 'success', 'failure', 'unknown']);
export type ForgeCiStatus = z.infer<typeof ForgeCiStatus>;

export const ForgePullRequest = z.object({
  provider: ForgeProvider,
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  headBranch: z.string(),
  baseBranch: z.string(),
  ciStatus: ForgeCiStatus,
});
export type ForgePullRequest = z.infer<typeof ForgePullRequest>;

export const RunForgeStatus = z.object({
  provider: ForgeProvider.nullable(),
  repoPath: z.string().nullable(),
  repoWebUrl: z.string().nullable(),
  branch: z.string().nullable(),
  baseBranch: z.string(),
  compareUrl: z.string().nullable(),
  tokenConfigured: z.boolean(),
  pullRequest: ForgePullRequest.nullable(),
});
export type RunForgeStatus = z.infer<typeof RunForgeStatus>;

export const CreatePullRequestBody = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().max(30_000).optional(),
  baseBranch: GitBranchName.optional(),
  draft: z.boolean().default(false),
  /** Push the run branch to `origin` before creating the PR/MR. */
  pushFirst: z.boolean().default(true),
});
export type CreatePullRequestBody = z.infer<typeof CreatePullRequestBody>;
