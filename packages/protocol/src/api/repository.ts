import { z } from 'zod';
import { CommitIdentity } from './commit-identity.js';
import { GitBranchName } from './common.js';
import { ForgeProvider } from './forge.js';

/**
 * Where Keep main pushed pushes main: the default branch itself, or an integration branch that is
 * Emberline's own (the person merges it into the default branch on the forge).
 */
export const MainPushTarget = z.enum(['default_branch', 'integration_branch']);
export type MainPushTarget = z.infer<typeof MainPushTarget>;

/** The integration branch a project pushes to unless it names another. */
export const DEFAULT_INTEGRATION_BRANCH = 'emberline/integration';

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
  /** projects.defaultBranch: what Push main and Keep main pushed publish, and what is compared with origin. */
  defaultBranch: z.string(),
  /** False: the default branch has no commit yet. */
  hasCommits: z.boolean(),
  /** The commit the default branch names now: what Push main would publish. Null before the first commit. */
  mainTip: z.object({ sha: z.string(), shortSha: z.string(), subject: z.string() }).nullable(),
  /** origin without user info, query or fragment (an ssh URL keeps its user): never a token. */
  originUrl: z.string().nullable(),
  /** origin as configured has a user name, token, query or fragment in it (not returned). */
  originHasCredentials: z.boolean(),
  /**
   * originUrl shows `***` where origin may hold a password (an address git could read either way):
   * it names no address Connect could take, so the web does not offer it there.
   */
  originMasked: z.boolean(),
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
  /** Where Keep main pushed pushes main (the Push main button always pushes the default branch). */
  pushTarget: MainPushTarget,
  /** The integration branch's name (used when pushTarget is `integration_branch`). */
  integrationBranch: z.string(),
  /** The branch the factory works on: the default branch unless a working branch is set. */
  workingBranch: z.string(),
  /** The remote branch Keep pushed pushes to: the working branch, else defaultBranch or integrationBranch. */
  keepPushedBranch: z.string(),
  /**
   * The last automatic push's failure (redacted), a push to keepPushedBranch; cleared by any
   * successful push and when the push target changes.
   */
  lastMainPushError: z.string().nullable(),
  /** This project's own commit identity; null: the factory's (Settings → Factory) is used. */
  commitIdentity: CommitIdentity.nullable(),
  /** The factory's commit identity, what a project without its own uses. */
  factoryCommitIdentity: CommitIdentity,
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

export const UpdateRepositoryBody = z
  .object({
    keepMainPushed: z.boolean(),
    pushTarget: MainPushTarget,
    integrationBranch: GitBranchName,
    /** null: use the factory's identity again. */
    commitIdentity: CommitIdentity.nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'nothing to update');
export type UpdateRepositoryBody = z.infer<typeof UpdateRepositoryBody>;
