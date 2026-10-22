import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import {
  type CreatePullRequestBody,
  CreatePullRequestBody as CreatePullRequestBodySchema,
  type ForgeCiStatus,
  type ForgeProvider,
  type ForgeProviderPreference,
  type ForgePullRequest,
  type RunForgeStatus,
} from '@emberline/protocol';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { projects, runEvents, runs } from '../db/schema.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { git } from '../runs/git.js';
import type { RunService } from '../runs/service.js';
import { ForgeAccountsService } from './accounts.js';
import { type ForgeAccountRecord, accountForRemote, credentialAccountForRemote } from './account-store.js';
import { remoteUrlForDisplay, sameForgeServer } from './hosts.js';
import { type FetchLike, type ForgeTarget, forgeFetch, IssuesClient, readJson } from './issues.js';

export interface ParsedForgeRemote {
  provider: ForgeProvider;
  host: string;
  protocol: 'http' | 'https';
  repoPath: string;
  repoWebUrl: string;
  apiBaseUrl: string;
  compareUrl: string | null;
}

/**
 * Parses a git remote URL (HTTPS, HTTP, SCP-like SSH `git@host:owner/repo.git`, or `ssh://...`)
 * into provider metadata, web URLs, and REST API base URL.
 */
export function parseForgeRemote(
  remoteUrl: string,
  providerPreference: ForgeProviderPreference = 'auto',
  customApiUrl: string | null = null,
  baseBranch = 'main',
  headBranch: string | null = null,
): ParsedForgeRemote | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  let host = '';
  let rawPath = '';
  let protocol: 'http' | 'https' = 'https';

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('ssh://')) {
    try {
      const parsed = new URL(trimmed);
      // An ssh port (Gitea's 2222) never serves the web UI or the API: keep only the hostname.
      host = parsed.protocol === 'ssh:' ? parsed.hostname : parsed.host;
      rawPath = parsed.pathname;
      if (parsed.protocol === 'http:') protocol = 'http';
    } catch {
      return null;
    }
  } else {
    // SCP-style SSH: git@github.com:owner/repo.git
    const scpMatch = /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(trimmed);
    if (!scpMatch) return null;
    host = scpMatch[1]!;
    rawPath = scpMatch[2]!;
  }

  const repoPath = rawPath
    .replace(/^\/+/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (!host || !repoPath || !repoPath.includes('/')) return null;

  const lowerHost = host.toLowerCase();
  const provider: ForgeProvider =
    providerPreference !== 'auto'
      ? providerPreference
      : lowerHost.includes('gitlab')
        ? 'gitlab'
        : lowerHost.includes('gitea') || lowerHost.includes('forgejo') || lowerHost.includes('codeberg')
          ? 'gitea'
          : 'github';

  const originWeb = `${protocol}://${host}`;
  const repoWebUrl = `${originWeb}/${repoPath}`;

  let apiBaseUrl: string;
  if (customApiUrl?.trim()) {
    apiBaseUrl = customApiUrl.trim().replace(/\/+$/, '');
  } else if (provider === 'github') {
    apiBaseUrl = lowerHost === 'github.com' ? 'https://api.github.com' : `${originWeb}/api/v3`;
  } else if (provider === 'gitlab') {
    apiBaseUrl = `${originWeb}/api/v4`;
  } else {
    apiBaseUrl = `${originWeb}/api/v1`;
  }

  let compareUrl: string | null = null;
  if (headBranch && headBranch !== baseBranch) {
    const encBase = encodeURIComponent(baseBranch);
    const encHead = encodeURIComponent(headBranch);
    if (provider === 'gitlab') {
      compareUrl = `${repoWebUrl}/-/merge_requests/new?merge_request[source_branch]=${encHead}&merge_request[target_branch]=${encBase}`;
    } else if (provider === 'github') {
      compareUrl = `${repoWebUrl}/compare/${encBase}...${encHead}?expand=1`;
    } else {
      compareUrl = `${repoWebUrl}/compare/${encBase}...${encHead}`;
    }
  }

  return {
    provider,
    host,
    protocol,
    repoPath,
    repoWebUrl,
    apiBaseUrl,
    compareUrl,
  };
}

export function noAccountMessage(host: string): string {
  return `Add a forge account for ${host} in Settings → Forge accounts.`;
}

/** A server under a sub-path (`https://host/gitea`) has it in every remote's path: it is not part of the repository's. */
function repoPathUnder(serverUrl: string, repoPath: string, remoteUrl?: string): string {
  const prefix = new URL(serverUrl).pathname.replace(/^\/+|\/+$/g, '');
  if (!prefix || !repoPath.startsWith(`${prefix}/`)) return repoPath;
  // An ssh address carries no web sub-path: an owner named like it is the owner.
  if (remoteUrl !== undefined && !/^https?:\/\//i.test(remoteUrl.trim())) return repoPath;
  return repoPath.slice(prefix.length + 1);
}

/** The remote as seen through an account: provider and API from the account, web URLs on its server. */
function viaAccount(
  remoteUrl: string,
  account: ForgeAccountRecord,
  baseBranch: string,
  headBranch: string | null,
): ParsedForgeRemote | null {
  const parsed = parseForgeRemote(remoteUrl);
  if (!parsed) return null;
  const via = parseForgeRemote(
    `${account.serverUrl}/${repoPathUnder(account.serverUrl, parsed.repoPath, remoteUrl)}.git`,
    account.provider,
    account.apiUrl,
    baseBranch,
    headBranch,
  );
  // The web URLs keep the server's sub-path; the API addresses the repository without it.
  return via && { ...via, repoPath: repoPathUnder(account.serverUrl, via.repoPath) };
}

export interface ForgeServiceOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: FetchLike;
}

interface ForgeServiceEvents {
  /** A pull request was opened for a run (recorded as its `pr_created` event). */
  pullRequest: [runId: string, pr: ForgePullRequest];
}

export class ForgeService extends EventEmitter<ForgeServiceEvents> {
  private readonly fetch: FetchLike;
  /** Issue reads and write-back, sharing this service's fetch. */
  readonly issues: IssuesClient;
  /** Forge accounts (one per server host), sharing this service's fetch. */
  readonly accounts: ForgeAccountsService;

  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    options: ForgeServiceOptions = {},
  ) {
    super();
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.issues = new IssuesClient({ fetch: this.fetch });
    this.accounts = new ForgeAccountsService(db, this.fetch);
  }

  /**
   * Account and remote for a REST call: the account of the remote's host (the token goes only to
   * that account's API); 409 when the remote does not parse or no account has its host.
   */
  private target(
    remoteUrl: string,
    baseBranch: string,
    headBranch: string | null,
  ): { account: ForgeAccountRecord; remote: ParsedForgeRemote } {
    const parsed = parseForgeRemote(remoteUrl);
    if (!parsed) throw conflict(`unable to parse forge remote URL: ${remoteUrlForDisplay(remoteUrl).url}`);
    const account = credentialAccountForRemote(this.db, remoteUrl);
    if (!account) throw conflict(noAccountMessage(parsed.host), 'forge_account_missing');
    return { account, remote: viaAccount(remoteUrl, account, baseBranch, headBranch)! };
  }

  private async detectRemoteUrl(
    worktreePath: string,
    projectPath: string,
    fallbackRepoUrl: string | null,
  ): Promise<string | null> {
    for (const dir of [worktreePath, projectPath]) {
      if (!dir || !existsSync(dir)) continue;
      try {
        const out = await git(dir, ['remote', 'get-url', 'origin']);
        if (out) return out;
      } catch {
        // try next
      }
    }
    return fallbackRepoUrl;
  }

  /**
   * The forge repo and token for a project, for issue calls. The remote is `origin` of the main
   * workspace, falling back to the project's repo URL. Throws 409 with a hint when the token or the
   * remote is missing, or no forge account has the remote's host.
   */
  async projectRemote(projectId: string): Promise<ForgeTarget> {
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw notFound('no such project');
    const remoteUrl = await this.detectRemoteUrl('', project.path, project.repoUrl);
    if (!remoteUrl) {
      throw conflict(
        'git remote "origin" is not configured for this project; add a remote or set its repository URL',
      );
    }
    const { account, remote } = this.target(remoteUrl, project.defaultBranch, null);
    // The agent can rewrite origin: it must still name the repository the project was set up with.
    if (project.repoUrl?.trim()) {
      const declared = parseForgeRemote(project.repoUrl);
      if (!declared)
        throw conflict(
          `unable to parse the project's repository URL: ${remoteUrlForDisplay(project.repoUrl).url}`,
        );
      if (
        !sameForgeServer(project.repoUrl, remoteUrl) ||
        repoPathUnder(account.serverUrl, declared.repoPath, project.repoUrl).toLowerCase() !==
          remote.repoPath.toLowerCase()
      ) {
        throw conflict('origin points at a different repository than the project');
      }
    }
    return { remote, token: account.token };
  }

  private recordedPullRequest(runId: string): ForgePullRequest | null {
    const events = this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(desc(runEvents.id))
      .all();
    const prEvent = events.find((e) => e.type === 'pr_created');
    if (!prEvent || typeof prEvent.payload !== 'object' || prEvent.payload === null) return null;
    const p = prEvent.payload as Partial<ForgePullRequest>;
    if (typeof p.number !== 'number' || typeof p.url !== 'string' || typeof p.title !== 'string') return null;
    return {
      provider: p.provider === 'gitlab' || p.provider === 'gitea' ? p.provider : 'github',
      number: p.number,
      title: p.title,
      url: p.url,
      state: p.state === 'merged' || p.state === 'closed' ? p.state : 'open',
      draft: Boolean(p.draft),
      headBranch: typeof p.headBranch === 'string' ? p.headBranch : '',
      baseBranch: typeof p.baseBranch === 'string' ? p.baseBranch : 'main',
      ciStatus:
        p.ciStatus === 'pending' || p.ciStatus === 'success' || p.ciStatus === 'failure'
          ? p.ciStatus
          : 'unknown',
    };
  }

  async getRunForgeStatus(runId: string): Promise<RunForgeStatus> {
    const run = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) throw notFound('no such run');
    const project = this.db.select().from(projects).where(eq(projects.id, run.projectId)).get();
    const baseBranch = project?.defaultBranch ?? 'main';
    const remoteUrl = await this.detectRemoteUrl(
      run.worktreePath,
      project?.path ?? '',
      project?.repoUrl ?? null,
    );
    const account = remoteUrl ? accountForRemote(this.db, remoteUrl) : null;
    const parsed = remoteUrl
      ? account
        ? viaAccount(remoteUrl, account, baseBranch, run.branch)
        : parseForgeRemote(remoteUrl, 'auto', null, baseBranch, run.branch)
      : null;

    let pullRequest = this.recordedPullRequest(runId);
    if (pullRequest && parsed && account) {
      const refreshed = await this.refreshPullRequest(parsed, account.token, pullRequest).catch(() => null);
      if (refreshed) pullRequest = refreshed;
    }

    return {
      provider: parsed?.provider ?? null,
      repoPath: parsed?.repoPath ?? null,
      repoWebUrl: parsed?.repoWebUrl ?? null,
      branch: run.branch,
      baseBranch,
      compareUrl: parsed?.compareUrl ?? null,
      tokenConfigured: Boolean(account),
      pullRequest,
    };
  }

  async createPullRequest(runId: string, rawBody: unknown): Promise<RunForgeStatus> {
    const parsedBody = CreatePullRequestBodySchema.safeParse(rawBody ?? {});
    if (!parsedBody.success) {
      throw badRequest(parsedBody.error.issues.map((i) => i.message).join('; '));
    }
    const body: CreatePullRequestBody = parsedBody.data;
    const run = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) throw notFound('no such run');
    if (!run.branch) throw conflict('run does not have an isolated git branch');

    const project = this.db.select().from(projects).where(eq(projects.id, run.projectId)).get();
    const baseBranch = body.baseBranch?.trim() || project?.defaultBranch || 'main';

    const remoteUrl = await this.detectRemoteUrl(
      run.worktreePath,
      project?.path ?? '',
      project?.repoUrl ?? null,
    );
    if (!remoteUrl) {
      throw conflict('git remote "origin" is not configured for this repository');
    }
    const { account, remote: parsed } = this.target(remoteUrl, baseBranch, run.branch);

    if (body.pushFirst) {
      try {
        await this.runs.push(runId);
      } catch {
        // If origin is an HTTPS forge URL without local git credential helper, push may fail or already be pushed;
        // still attempt PR creation in case the branch was already pushed.
      }
    }

    const title = body.title?.trim() || run.title || `Changes from ${run.branch}`;
    const prBody =
      body.body ?? `Automated pull request created from Emberline run \`${run.id}\` (\`${run.branch}\`).`;

    const pr = await this.createPrOnForge(parsed, account.token, {
      title,
      body: prBody,
      headBranch: run.branch,
      baseBranch,
      draft: body.draft,
    });

    this.db
      .insert(runEvents)
      .values({
        runId,
        ts: new Date(),
        source: 'user',
        type: 'pr_created',
        payload: pr,
      })
      .run();

    this.db.update(runs).set({ lastEvent: 'pr_created' }).where(eq(runs.id, runId)).run();
    // Listeners (the issue write-back) must never fail the request that created the PR.
    try {
      this.emit('pullRequest', runId, pr);
    } catch {
      // ignore
    }

    return {
      provider: parsed.provider,
      repoPath: parsed.repoPath,
      repoWebUrl: parsed.repoWebUrl,
      branch: run.branch,
      baseBranch,
      compareUrl: parsed.compareUrl,
      tokenConfigured: true,
      pullRequest: pr,
    };
  }

  private async createPrOnForge(
    remote: ParsedForgeRemote,
    token: string,
    input: { title: string; body: string; headBranch: string; baseBranch: string; draft: boolean },
  ): Promise<ForgePullRequest> {
    if (remote.provider === 'github') {
      const res = await forgeFetch(this.fetch, `${remote.apiBaseUrl}/repos/${remote.repoPath}/pulls`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Emberline-Core',
        },
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.headBranch,
          base: input.baseBranch,
          draft: input.draft,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new HttpError(
          res.status,
          'forge_error',
          `GitHub PR creation failed (${res.status}): ${text.slice(0, 300)}`,
        );
      }
      const data = await readJson<{
        number: number;
        title?: string;
        html_url?: string;
        state?: string;
        merged?: boolean;
        draft?: boolean;
        head?: { sha?: string };
      }>(res);
      const ciStatus = data.head?.sha
        ? await this.fetchGithubCiStatus(remote, token, data.head.sha).catch((): ForgeCiStatus => 'unknown')
        : 'unknown';
      return {
        provider: 'github',
        number: data.number,
        title: data.title ?? input.title,
        url: data.html_url ?? `${remote.repoWebUrl}/pull/${data.number}`,
        state: data.merged ? 'merged' : data.state === 'closed' ? 'closed' : 'open',
        draft: Boolean(data.draft ?? input.draft),
        headBranch: input.headBranch,
        baseBranch: input.baseBranch,
        ciStatus,
      };
    }

    if (remote.provider === 'gitlab') {
      const projectId = encodeURIComponent(remote.repoPath);
      const glTitle =
        input.draft && !input.title.toLowerCase().startsWith('draft:')
          ? `Draft: ${input.title}`
          : input.title;
      const res = await forgeFetch(this.fetch, `${remote.apiBaseUrl}/projects/${projectId}/merge_requests`, {
        method: 'POST',
        headers: {
          'PRIVATE-TOKEN': token,
          'Content-Type': 'application/json',
          'User-Agent': 'Emberline-Core',
        },
        body: JSON.stringify({
          source_branch: input.headBranch,
          target_branch: input.baseBranch,
          title: glTitle,
          description: input.body,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new HttpError(
          res.status,
          'forge_error',
          `GitLab MR creation failed (${res.status}): ${text.slice(0, 300)}`,
        );
      }
      const data = await readJson<{
        iid: number;
        title?: string;
        web_url?: string;
        state?: string;
        draft?: boolean;
        head_pipeline?: { status?: string } | null;
      }>(res);
      return {
        provider: 'gitlab',
        number: data.iid,
        title: data.title ?? glTitle,
        url: data.web_url ?? `${remote.repoWebUrl}/-/merge_requests/${data.iid}`,
        state: data.state === 'merged' ? 'merged' : data.state === 'closed' ? 'closed' : 'open',
        draft: Boolean(data.draft ?? input.draft),
        headBranch: input.headBranch,
        baseBranch: input.baseBranch,
        ciStatus: mapGitlabPipelineStatus(data.head_pipeline?.status),
      };
    }

    // Gitea / Forgejo
    const res = await forgeFetch(this.fetch, `${remote.apiBaseUrl}/repos/${remote.repoPath}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Emberline-Core',
      },
      body: JSON.stringify({
        title:
          input.draft && !input.title.toLowerCase().startsWith('wip:') ? `WIP: ${input.title}` : input.title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(
        res.status,
        'forge_error',
        `Gitea PR creation failed (${res.status}): ${text.slice(0, 300)}`,
      );
    }
    const data = await readJson<{
      number: number;
      title?: string;
      html_url?: string;
      state?: string;
      merged?: boolean;
      draft?: boolean;
    }>(res);
    return {
      provider: 'gitea',
      number: data.number,
      title: data.title ?? input.title,
      url: data.html_url ?? `${remote.repoWebUrl}/pulls/${data.number}`,
      state: data.merged ? 'merged' : data.state === 'closed' ? 'closed' : 'open',
      draft: Boolean(data.draft ?? input.draft),
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      ciStatus: 'unknown',
    };
  }

  private async refreshPullRequest(
    remote: ParsedForgeRemote,
    token: string,
    pr: ForgePullRequest,
  ): Promise<ForgePullRequest> {
    if (remote.provider === 'github') {
      const res = await forgeFetch(
        this.fetch,
        `${remote.apiBaseUrl}/repos/${remote.repoPath}/pulls/${pr.number}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'Emberline-Core',
          },
        },
      );
      if (!res.ok) return pr;
      const data = await readJson<{
        title?: string;
        html_url?: string;
        state?: string;
        merged?: boolean;
        draft?: boolean;
        head?: { sha?: string };
      }>(res);
      const ciStatus = data.head?.sha
        ? await this.fetchGithubCiStatus(remote, token, data.head.sha).catch((): ForgeCiStatus => pr.ciStatus)
        : pr.ciStatus;
      return {
        ...pr,
        title: data.title ?? pr.title,
        url: data.html_url ?? pr.url,
        state: data.merged ? 'merged' : data.state === 'closed' ? 'closed' : 'open',
        draft: Boolean(data.draft ?? pr.draft),
        ciStatus,
      };
    }

    if (remote.provider === 'gitlab') {
      const projectId = encodeURIComponent(remote.repoPath);
      const res = await forgeFetch(
        this.fetch,
        `${remote.apiBaseUrl}/projects/${projectId}/merge_requests/${pr.number}`,
        {
          headers: { 'PRIVATE-TOKEN': token, 'User-Agent': 'Emberline-Core' },
        },
      );
      if (!res.ok) return pr;
      const data = await readJson<{
        title?: string;
        web_url?: string;
        state?: string;
        draft?: boolean;
        head_pipeline?: { status?: string } | null;
      }>(res);
      return {
        ...pr,
        title: data.title ?? pr.title,
        url: data.web_url ?? pr.url,
        state: data.state === 'merged' ? 'merged' : data.state === 'closed' ? 'closed' : 'open',
        draft: Boolean(data.draft ?? pr.draft),
        ciStatus: mapGitlabPipelineStatus(data.head_pipeline?.status),
      };
    }

    return pr;
  }

  private async fetchGithubCiStatus(
    remote: ParsedForgeRemote,
    token: string,
    sha: string,
  ): Promise<ForgeCiStatus> {
    const res = await forgeFetch(
      this.fetch,
      `${remote.apiBaseUrl}/repos/${remote.repoPath}/commits/${sha}/status`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Emberline-Core',
        },
      },
    );
    if (!res.ok) return 'unknown';
    const data = await readJson<{ state?: string }>(res);
    if (data.state === 'success') return 'success';
    if (data.state === 'failure' || data.state === 'error') return 'failure';
    if (data.state === 'pending') return 'pending';
    return 'unknown';
  }
}

function mapGitlabPipelineStatus(status?: string): ForgeCiStatus {
  if (!status) return 'unknown';
  if (status === 'success') return 'success';
  if (status === 'failed' || status === 'canceled') return 'failure';
  if (status === 'running' || status === 'pending' || status === 'created' || status === 'preparing')
    return 'pending';
  return 'unknown';
}
