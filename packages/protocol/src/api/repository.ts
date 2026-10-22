import { z } from 'zod';
import { ForgeProvider } from './forge.js';

export const RepositoryMainState = z.enum([
  'no_remote',
  'unpublished',
  'up_to_date',
  'ahead',
  'behind',
  'diverged',
  'unknown',
]);
export type RepositoryMainState = z.infer<typeof RepositoryMainState>;

export const RepositoryStatus = z.object({
  /** False: the project folder is not a git repository (nothing else applies). */
  isGitRepo: z.boolean(),
  /** The branch checked out in the main workspace (what runs merge into); null when detached. */
  branch: z.string().nullable(),
  /** False: the branch has no commit yet. */
  hasCommits: z.boolean(),
  originUrl: z.string().nullable(),
  /** `host[:port]` for http(s) remotes, the host name for ssh. */
  originHost: z.string().nullable(),
  /** ssh remotes use the runner's own keys; only http(s) remotes get account credentials (in core). */
  transport: z.enum(['https', 'http', 'ssh']).nullable(),
  account: z
    .object({
      id: z.string(),
      provider: ForgeProvider,
      serverUrl: z.string(),
      username: z.string().nullable(),
    })
    .nullable(),
  /** origin is the repository connected for the project (projects.repoUrl); only then are refresh and push allowed. */
  connected: z.boolean(),
  /** `unknown` with checkedAt null: origin has not been read since it was set (Refresh reads it). */
  mainState: RepositoryMainState,
  /** Commits main has that origin lacks, and the other way round; null when not compared. */
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  /** Why origin could not be read (redacted); set with mainState `unknown`. */
  remoteError: z.string().nullable(),
  /** When origin was last read (ISO time): status itself reads no network. */
  checkedAt: z.string().nullable(),
  keepMainPushed: z.boolean(),
  /** The last automatic push's failure (redacted); cleared by any successful push. */
  lastMainPushError: z.string().nullable(),
});
export type RepositoryStatus = z.infer<typeof RepositoryStatus>;

export const ConnectRepositoryBody = z.object({
  url: z.string().trim().min(1).max(1000),
  replace: z.boolean().default(false),
});
export type ConnectRepositoryBody = z.input<typeof ConnectRepositoryBody>;

export const CreateRepositoryBody = z.object({
  accountId: z.string().min(1).max(200),
  /** The user's login, or an organisation/group (`ForgeOwner.id`). */
  owner: z.string().trim().min(1).max(200),
  name: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,100}$/, 'use letters, digits, ".", "-" or "_"'),
  private: z.boolean().default(true),
  description: z.string().trim().max(350).optional(),
  /** Replace an existing origin (the person confirmed). */
  replace: z.boolean().default(false),
});
export type CreateRepositoryBody = z.input<typeof CreateRepositoryBody>;

export const UpdateRepositoryBody = z.object({ keepMainPushed: z.boolean() });
export type UpdateRepositoryBody = z.infer<typeof UpdateRepositoryBody>;
