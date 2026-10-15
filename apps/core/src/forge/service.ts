import { existsSync } from 'node:fs';
import {
  type CreatePullRequestBody,
  CreatePullRequestBody as CreatePullRequestBodySchema,
  type ForgeCiStatus,
  type ForgeProvider,
  type ForgeProviderPreference,
  type ForgePullRequest,
  type ForgeSettings,
  type RunForgeStatus,
  type UpdateForgeSettingsBody,
  UpdateForgeSettingsBody as UpdateForgeSettingsBodySchema,
} from '@emberline/protocol';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { projects, runEvents, runs, settings } from '../db/schema.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { git } from '../runs/git.js';
import type { RunService } from '../runs/service.js';

const SETTINGS_KEY = 'forge.config';

interface StoredForgeConfig {
  provider: ForgeProviderPreference;
  apiUrl: string | null;
  token: string | null;
}

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
      host = parsed.host;
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

function hostOf(url: string | null | undefined): string | null {
  if (!url?.trim()) return null;
  const trimmed = url.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return new URL(trimmed).host.toLowerCase();
  } catch {
    return null;
  }
  // SCP-style SSH: git@host:owner/repo.git
  return /^(?:[^@/]+@)?([^:/]+):/.exec(trimmed)?.[1]?.toLowerCase() ?? null;
}

/**
 * The remote URL comes from the worktree's git config, which the agent can rewrite. The token is
 * only sent to the public GitHub API, the API URL the user configured, the host of the repo URL
 * the project was cloned from, or hosts listed in EMBERLINE_FORGE_ALLOWED_HOSTS.
 */
export function assertTrustedForgeApi(
  remote: ParsedForgeRemote,
  trust: { apiUrl: string | null; projectRepoUrl: string | null },
): void {
  const apiHost = hostOf(remote.apiBaseUrl);
  const configuredHost = hostOf(trust.apiUrl);
  const repoHost = hostOf(trust.projectRepoUrl);
  const extra = (process.env.EMBERLINE_FORGE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const trusted = new Set<string>(['api.github.com', ...extra]);
  if (configuredHost) trusted.add(configuredHost);
  if (repoHost) trusted.add(repoHost);
  if (!apiHost || !trusted.has(apiHost)) {
    throw conflict(
      `forge API host ${apiHost ?? remote.apiBaseUrl} is not trusted for your token; set the Forge API URL in settings`,
    );
  }
  // Plain HTTP is only acceptable when the user configured that exact API URL themselves.
  if (remote.apiBaseUrl.startsWith('http://') && apiHost !== configuredHost) {
    throw conflict('refusing to send the forge token over plain HTTP; set an https Forge API URL in settings');
  }
}

export class ForgeService {
  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
  ) {}

  private readStored(): StoredForgeConfig {
    const row = this.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
    const envProvider = process.env.EMBERLINE_FORGE_PROVIDER?.trim();
    const defaultProvider: ForgeProviderPreference =
      envProvider === 'github' || envProvider === 'gitlab' || envProvider === 'gitea' ? envProvider : 'auto';
    const defaults: StoredForgeConfig = {
      provider: defaultProvider,
      apiUrl: process.env.EMBERLINE_FORGE_API_URL?.trim() || null,
      token: process.env.EMBERLINE_FORGE_TOKEN?.trim() || null,
    };
    if (!row || typeof row.value !== 'object' || row.value === null) return defaults;
    const raw = row.value as Partial<StoredForgeConfig>;
    return {
      provider:
        raw.provider === 'github' || raw.provider === 'gitlab' || raw.provider === 'gitea' || raw.provider === 'auto'
          ? raw.provider
          : defaults.provider,
      apiUrl: raw.apiUrl !== undefined ? raw.apiUrl : defaults.apiUrl,
      token: raw.token !== undefined ? raw.token : defaults.token,
    };
  }

  getSettings(): ForgeSettings {
    const stored = this.readStored();
    return {
      provider: stored.provider,
      apiUrl: stored.apiUrl,
      tokenConfigured: Boolean(stored.token),
    };
  }

  updateSettings(rawBody: unknown): ForgeSettings {
    const parsed = UpdateForgeSettingsBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const current = this.readStored();
    const body: UpdateForgeSettingsBody = parsed.data;
    const next: StoredForgeConfig = {
      provider: body.provider ?? current.provider,
      apiUrl: body.apiUrl !== undefined ? (body.apiUrl?.trim() || null) : current.apiUrl,
      token: body.token !== undefined ? (body.token?.trim() || null) : current.token,
    };
    this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value: next })
      .onConflictDoUpdate({ target: settings.key, set: { value: next } })
      .run();
    return {
      provider: next.provider,
      apiUrl: next.apiUrl,
      tokenConfigured: Boolean(next.token),
    };
  }

  private async detectRemoteUrl(worktreePath: string, projectPath: string, fallbackRepoUrl: string | null): Promise<string | null> {
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
        p.ciStatus === 'pending' || p.ciStatus === 'success' || p.ciStatus === 'failure' ? p.ciStatus : 'unknown',
    };
  }

  async getRunForgeStatus(runId: string): Promise<RunForgeStatus> {
    const run = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) throw notFound('no such run');
    const project = this.db.select().from(projects).where(eq(projects.id, run.projectId)).get();
    const baseBranch = project?.defaultBranch ?? 'main';
    const stored = this.readStored();
    const remoteUrl = await this.detectRemoteUrl(run.worktreePath, project?.path ?? '', project?.repoUrl ?? null);
    const parsed = remoteUrl
      ? parseForgeRemote(remoteUrl, stored.provider, stored.apiUrl, baseBranch, run.branch)
      : null;

    let pullRequest = this.recordedPullRequest(runId);
    const trusted = (remote: ParsedForgeRemote) => {
      try {
        assertTrustedForgeApi(remote, { apiUrl: stored.apiUrl, projectRepoUrl: project?.repoUrl ?? null });
        return true;
      } catch {
        return false;
      }
    };
    if (pullRequest && parsed && stored.token && trusted(parsed)) {
      const refreshed = await this.refreshPullRequest(parsed, stored.token, pullRequest).catch(() => null);
      if (refreshed) pullRequest = refreshed;
    }

    return {
      provider: parsed?.provider ?? null,
      repoPath: parsed?.repoPath ?? null,
      repoWebUrl: parsed?.repoWebUrl ?? null,
      branch: run.branch,
      baseBranch,
      compareUrl: parsed?.compareUrl ?? null,
      tokenConfigured: Boolean(stored.token),
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
    const stored = this.readStored();
    if (!stored.token) {
      throw conflict('Forge Personal Access Token is not configured. Add a token in Forge Settings first.');
    }

    const remoteUrl = await this.detectRemoteUrl(run.worktreePath, project?.path ?? '', project?.repoUrl ?? null);
    if (!remoteUrl) {
      throw conflict('git remote "origin" is not configured for this repository');
    }
    const parsed = parseForgeRemote(remoteUrl, stored.provider, stored.apiUrl, baseBranch, run.branch);
    if (!parsed) {
      throw conflict(`unable to parse forge remote URL: ${remoteUrl}`);
    }
    assertTrustedForgeApi(parsed, { apiUrl: stored.apiUrl, projectRepoUrl: project?.repoUrl ?? null });

    if (body.pushFirst) {
      try {
        await this.runs.push(runId);
      } catch {
        // If origin is an HTTPS forge URL without local git credential helper, push may fail or already be pushed;
        // still attempt PR creation in case the branch was already pushed.
      }
    }

    const title = body.title?.trim() || run.title || `Changes from ${run.branch}`;
    const prBody = body.body ?? `Automated pull request created from Emberline run \`${run.id}\` (\`${run.branch}\`).`;

    const pr = await this.createPrOnForge(parsed, stored.token, {
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

    this.db
      .update(runs)
      .set({ lastEvent: 'pr_created' })
      .where(eq(runs.id, runId))
      .run();

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
      const res = await fetch(`${remote.apiBaseUrl}/repos/${remote.repoPath}/pulls`, {
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
        throw new HttpError(res.status, 'forge_error', `GitHub PR creation failed (${res.status}): ${text.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        number: number;
        title?: string;
        html_url?: string;
        state?: string;
        merged?: boolean;
        draft?: boolean;
        head?: { sha?: string };
      };
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
      const glTitle = input.draft && !input.title.toLowerCase().startsWith('draft:') ? `Draft: ${input.title}` : input.title;
      const res = await fetch(`${remote.apiBaseUrl}/projects/${projectId}/merge_requests`, {
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
        throw new HttpError(res.status, 'forge_error', `GitLab MR creation failed (${res.status}): ${text.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        iid: number;
        title?: string;
        web_url?: string;
        state?: string;
        draft?: boolean;
        head_pipeline?: { status?: string } | null;
      };
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
    const res = await fetch(`${remote.apiBaseUrl}/repos/${remote.repoPath}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Emberline-Core',
      },
      body: JSON.stringify({
        title: input.draft && !input.title.toLowerCase().startsWith('wip:') ? `WIP: ${input.title}` : input.title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(res.status, 'forge_error', `Gitea PR creation failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      number: number;
      title?: string;
      html_url?: string;
      state?: string;
      merged?: boolean;
      draft?: boolean;
    };
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
      const res = await fetch(`${remote.apiBaseUrl}/repos/${remote.repoPath}/pulls/${pr.number}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Emberline-Core',
        },
      });
      if (!res.ok) return pr;
      const data = (await res.json()) as {
        title?: string;
        html_url?: string;
        state?: string;
        merged?: boolean;
        draft?: boolean;
        head?: { sha?: string };
      };
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
      const res = await fetch(`${remote.apiBaseUrl}/projects/${projectId}/merge_requests/${pr.number}`, {
        headers: { 'PRIVATE-TOKEN': token, 'User-Agent': 'Emberline-Core' },
      });
      if (!res.ok) return pr;
      const data = (await res.json()) as {
        title?: string;
        web_url?: string;
        state?: string;
        draft?: boolean;
        head_pipeline?: { status?: string } | null;
      };
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

  private async fetchGithubCiStatus(remote: ParsedForgeRemote, token: string, sha: string): Promise<ForgeCiStatus> {
    const res = await fetch(`${remote.apiBaseUrl}/repos/${remote.repoPath}/commits/${sha}/status`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Emberline-Core',
      },
    });
    if (!res.ok) return 'unknown';
    const data = (await res.json()) as { state?: string };
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
  if (status === 'running' || status === 'pending' || status === 'created' || status === 'preparing') return 'pending';
  return 'unknown';
}
