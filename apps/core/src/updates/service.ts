/**
 * Update tracking: is a newer Emberline released, and are the installed agent CLIs and the MCP
 * servers run through npx behind their registries? Checks every 12 hours when enabled, and on demand.
 * Emberline itself is only reported (core has no Docker access to replace its own containers).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type AgentId,
  type EmberlineRelease,
  PROVIDER_REGISTRY,
  UpdateConfigBody,
  type UpdateConfigView,
  type UpdateItem,
  type UpdatesResponse,
  type UpdateStatus,
} from '@emberline/protocol';
import { execCommand } from '../command-exec.js';
import { type Db, getSetting, setSetting } from '../db/index.js';
import { badRequest, notFound } from '../errors.js';
import { getFactorySettings } from '../factory/settings.js';
import { CLI_PACKAGES } from '../toolchain/service.js';
import { compareVersions, isVersion, splitPackageSpec } from './versions.js';

const CONFIG_KEY = 'updates.config';
const STATUS_KEY = 'updates.status';
/** Only this host ever receives the GitHub token. */
const GITHUB_API = 'https://api.github.com';
const NPM_REGISTRY = 'https://registry.npmjs.org';
const PYPI = 'https://pypi.org/pypi';
const CHECK_INTERVAL_MS = 12 * 60 * 60_000;
const FIRST_CHECK_DELAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SDK_LABELS: Record<string, string> = {
  platformio: 'PlatformIO',
  android: 'Android SDK + JDK 21',
  flutter: 'Flutter',
  'esp-qemu': 'ESP32 QEMU',
};

interface StoredConfig {
  autoCheck?: boolean;
  githubToken?: string | null;
}

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface UpdateServiceOptions {
  /** The running Emberline version. */
  version: string;
  /** owner/name of the GitHub repository that publishes Emberline releases. */
  repository?: string;
  toolsDir?: string;
  runnerHome?: string;
  fetch?: FetchLike;
}

export class UpdateService {
  private readonly repository: string;
  private readonly toolsDir: string;
  private readonly runnerHome: string;
  private readonly fetch: FetchLike;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<UpdateStatus> | undefined;

  constructor(
    private readonly db: Db,
    private readonly options: UpdateServiceOptions,
  ) {
    this.repository =
      options.repository ?? process.env.EMBERLINE_UPDATE_REPOSITORY ?? 'biohazardious/emberline';
    this.toolsDir = options.toolsDir ?? process.env.EMBERLINE_TOOLS_DIR ?? '/opt/ai-tools';
    this.runnerHome = options.runnerHome ?? process.env.EMBERLINE_RUNNER_HOME ?? '/home/node';
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Scheduled checks: shortly after start, then every 12 hours, skipped while turned off. */
  start(): void {
    const tick = () => {
      if (this.config().autoCheck) void this.check().catch(() => undefined);
    };
    const first = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, CHECK_INTERVAL_MS);
      this.timer.unref();
    }, FIRST_CHECK_DELAY_MS);
    first.unref();
    this.timer = first;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get(): UpdatesResponse {
    const stored = this.readSetting<UpdateStatus>(STATUS_KEY);
    const status: UpdateStatus =
      stored && stored.currentVersion === this.options.version
        ? stored
        : // Emberline was upgraded since the last check: the stored result is about another version.
          { checkedAt: null, currentVersion: this.options.version, release: null, items: [], available: 0 };
    // Installs and cache refreshes since the check show at once: only the latest versions come from the network.
    const items = status.items.map((item) => this.withLocalVersion(item));
    const available = items.filter((i) => i.state === 'update_available').length;
    return { config: this.configView(), status: { ...status, items, available } };
  }

  updateConfig(rawBody: unknown): UpdatesResponse {
    const parsed = UpdateConfigBody.safeParse(rawBody);
    if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    const body = parsed.data;
    const current = this.config();
    const next: StoredConfig = {
      autoCheck: body.autoCheck ?? current.autoCheck,
      githubToken: body.githubToken === undefined ? current.githubToken : body.githubToken || null,
    };
    this.writeSetting(CONFIG_KEY, next);
    return this.get();
  }

  /** Runs one check (concurrent callers share it) and stores the result. */
  check(): Promise<UpdateStatus> {
    this.running ??= this.runCheck().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /**
   * Deletes the npx cache entries of an MCP server's package, so its next start downloads the latest
   * version. Runs in the runner: core only has the runner's home read-only.
   */
  async refreshMcp(mcpId: string): Promise<UpdatesResponse> {
    const server = getFactorySettings(this.db).mcpServers.find((s) => s.id === mcpId);
    const spec = server ? npxPackage(server.command, server.args) : null;
    if (!server || !spec) throw notFound('no MCP server run through npx with that id');
    const dirs = this.npxCacheDirs(splitPackageSpec(spec).name).map((d) => d.dir);
    if (dirs.length > 0) {
      const result = await execCommand({ file: 'rm', args: ['-rf', '--', ...dirs], cwd: '/' });
      if (result.exitCode !== 0) throw badRequest(`could not clear the npx cache: ${result.stderr.trim()}`);
    }
    await this.check();
    return this.get();
  }

  private async runCheck(): Promise<UpdateStatus> {
    const [emberline, clis, mcps] = await Promise.all([
      this.checkEmberline(),
      this.checkClis(),
      this.checkMcps(),
    ]);
    const items = [emberline.item, ...clis, ...mcps, ...this.bundledItems()];
    const status: UpdateStatus = {
      checkedAt: new Date().toISOString(),
      currentVersion: this.options.version,
      release: emberline.release,
      items,
      available: items.filter((i) => i.state === 'update_available').length,
    };
    this.writeSetting(STATUS_KEY, status);
    return status;
  }

  private async checkEmberline(): Promise<{ item: UpdateItem; release: EmberlineRelease | null }> {
    const base: UpdateItem = {
      id: 'emberline',
      kind: 'emberline',
      name: 'Emberline',
      installed: this.options.version,
      latest: null,
      state: 'unknown',
      note: null,
      provider: null,
      mcpId: null,
    };
    const token = this.config().githubToken;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'emberline-update-check',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    try {
      const res = await this.fetch(`${GITHUB_API}/repos/${this.repository}/releases?per_page=20`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const hint =
          res.status === 404 && !token
            ? ' (a private repository needs a GitHub token)'
            : res.status === 401
              ? ' (check the GitHub token)'
              : '';
        return {
          item: { ...base, state: 'error', note: `GitHub answered ${res.status}${hint}` },
          release: null,
        };
      }
      const releases = ((await res.json()) as GithubRelease[]).filter(
        (r) => !r.draft && isVersion(r.tag_name),
      );
      const newest = releases.sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
      if (!newest)
        return { item: { ...base, state: 'unknown', note: 'No releases published yet' }, release: null };
      const latest = newest.tag_name.replace(/^v/, '');
      const newer = compareVersions(latest, this.options.version) > 0;
      return {
        item: { ...base, latest, state: newer ? 'update_available' : 'up_to_date' },
        release: newer
          ? {
              version: latest,
              url: newest.html_url,
              notes: newest.body ?? '',
              publishedAt: newest.published_at ?? null,
            }
          : null,
      };
    } catch (err) {
      return {
        item: { ...base, state: 'error', note: `Could not reach GitHub: ${(err as Error).message}` },
        release: null,
      };
    }
  }

  private async checkClis(): Promise<UpdateItem[]> {
    return Promise.all(
      (Object.keys(CLI_PACKAGES) as AgentId[]).map(async (provider): Promise<UpdateItem> => {
        const source = CLI_PACKAGES[provider];
        const base: UpdateItem = {
          id: `cli:${provider}`,
          kind: 'cli',
          name: PROVIDER_REGISTRY[provider].label,
          installed: null,
          latest: null,
          state: 'not_installed',
          note: null,
          provider,
          mcpId: null,
        };
        const installed = this.installedCliVersion(provider);
        if (installed === undefined) return base;
        const withInstalled = { ...base, installed };
        if (!source.npm && !source.pypi) {
          return {
            ...withInstalled,
            state: 'unknown',
            note: 'No public version source; use Update to fetch the latest',
          };
        }
        try {
          const latest = source.npm
            ? await this.npmLatest(source.npm)
            : await this.pypiLatest(source.pypi as string);
          return { ...withInstalled, latest, state: compareState(installed, latest) };
        } catch (err) {
          return { ...withInstalled, state: 'error', note: (err as Error).message };
        }
      }),
    );
  }

  private async checkMcps(): Promise<UpdateItem[]> {
    const servers = getFactorySettings(this.db).mcpServers.filter((s) => s.enabled);
    const items: UpdateItem[] = [];
    for (const server of servers) {
      const spec = npxPackage(server.command, server.args);
      if (!spec) continue;
      const { name, version: pinned } = splitPackageSpec(spec);
      const base: UpdateItem = {
        id: `mcp:${server.id}`,
        kind: 'mcp',
        name: `${server.name} (MCP)`,
        installed: null,
        latest: null,
        state: 'unknown',
        note: null,
        provider: null,
        mcpId: server.id,
      };
      if (pinned && isVersion(pinned)) {
        items.push({ ...base, installed: pinned, state: 'pinned', note: `Pinned to ${spec}` });
        continue;
      }
      const cached = this.cachedNpxVersion(name);
      try {
        items.push(mcpItem({ ...base, latest: await this.npmLatest(name) }, cached));
      } catch (err) {
        items.push({ ...base, installed: cached ?? null, state: 'error', note: (err as Error).message });
      }
    }
    return items;
  }

  /** A stored CLI or npx MCP item with the version installed now. */
  private withLocalVersion(item: UpdateItem): UpdateItem {
    if (!item.latest || item.state === 'error') return item;
    if (item.kind === 'cli' && item.provider) {
      const installed = this.installedCliVersion(item.provider);
      if (installed === undefined) return { ...item, installed: null, state: 'not_installed' };
      return { ...item, installed, state: compareState(installed, item.latest) };
    }
    if (item.kind === 'mcp' && item.state !== 'pinned' && item.mcpId) {
      const server = getFactorySettings(this.db).mcpServers.find((s) => s.id === item.mcpId);
      const spec = server ? npxPackage(server.command, server.args) : null;
      if (spec) return mcpItem(item, this.cachedNpxVersion(splitPackageSpec(spec).name));
    }
    return item;
  }

  private cachedNpxVersion(name: string): string | null {
    return (
      this.npxCacheDirs(name)
        .map((d) => d.version)
        .sort(compareVersions)
        .at(-1) ?? null
    );
  }

  /** SDKs pinned by the Emberline image: listed for completeness, updated with Emberline. */
  private bundledItems(): UpdateItem[] {
    const markers = path.join(this.toolsDir, 'sdk', '.installed');
    const items: UpdateItem[] = [];
    for (const id of Object.keys(SDK_LABELS)) {
      const file = path.join(markers, id);
      if (!existsSync(file)) continue;
      items.push({
        id: `sdk:${id}`,
        kind: 'bundled',
        name: SDK_LABELS[id] ?? id,
        installed: readFileSync(file, 'utf8').trim() || null,
        latest: null,
        state: 'bundled',
        note: `Pinned by Emberline ${this.options.version}; reinstall after updating Emberline to get its version`,
        provider: null,
        mcpId: null,
      });
    }
    return items;
  }

  /** The installed version of a CLI, null when installed without a readable version, undefined when absent. */
  private installedCliVersion(provider: AgentId): string | null | undefined {
    const source = CLI_PACKAGES[provider];
    if (source.npm) {
      const pkg = path.join(this.toolsDir, 'npm', 'lib', 'node_modules', source.npm, 'package.json');
      if (!existsSync(pkg)) return undefined;
      return readJsonVersion(pkg);
    }
    if (source.pypi) {
      const venv = path.join(this.toolsDir, 'pipx', 'venvs', source.pypi);
      if (!existsSync(venv)) return undefined;
      return pipxVersion(venv, source.pypi);
    }
    if (provider === 'antigravity')
      return existsSync(path.join(this.toolsDir, 'bin', 'agy')) ? null : undefined;
    return undefined;
  }

  /** npx cache entries (~/.npm/_npx/<hash>) that contain `name`, with the version found there. */
  private npxCacheDirs(name: string): { dir: string; version: string }[] {
    const root = path.join(this.runnerHome, '.npm', '_npx');
    if (!existsSync(root)) return [];
    const found: { dir: string; version: string }[] = [];
    for (const hash of readdirSync(root)) {
      if (!/^[0-9a-f]+$/.test(hash)) continue;
      const version = readJsonVersion(path.join(root, hash, 'node_modules', name, 'package.json'));
      if (version) found.push({ dir: path.join(root, hash), version });
    }
    return found;
  }

  private async npmLatest(name: string): Promise<string> {
    const res = await this.fetch(`${NPM_REGISTRY}/${name.replace('/', '%2F')}/latest`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`npm registry answered ${res.status}`);
    const version = ((await res.json()) as { version?: unknown }).version;
    if (typeof version !== 'string') throw new Error('npm registry gave no version');
    return version;
  }

  private async pypiLatest(name: string): Promise<string> {
    const res = await this.fetch(`${PYPI}/${name}/json`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`PyPI answered ${res.status}`);
    const version = ((await res.json()) as { info?: { version?: unknown } }).info?.version;
    if (typeof version !== 'string') throw new Error('PyPI gave no version');
    return version;
  }

  private config(): { autoCheck: boolean; githubToken: string | null } {
    const stored = this.readSetting<StoredConfig>(CONFIG_KEY) ?? {};
    return { autoCheck: stored.autoCheck ?? true, githubToken: stored.githubToken ?? null };
  }

  private configView(): UpdateConfigView {
    const config = this.config();
    return { autoCheck: config.autoCheck, tokenConfigured: Boolean(config.githubToken) };
  }

  private readSetting<T>(key: string): T | null {
    const value = getSetting<T>(this.db, key);
    return typeof value === 'object' && value !== null ? value : null;
  }

  private writeSetting(key: string, value: unknown): void {
    setSetting(this.db, key, value);
  }
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
  body?: string | null;
  draft?: boolean;
  published_at?: string | null;
}

function compareState(installed: string | null, latest: string): UpdateItem['state'] {
  if (!installed || !isVersion(installed)) return 'unknown';
  return compareVersions(latest, installed) > 0 ? 'update_available' : 'up_to_date';
}

/** An npx MCP item (with its latest version) given the version in the npx cache. */
function mcpItem(item: UpdateItem, cached: string | null): UpdateItem {
  const latest = item.latest as string;
  return {
    ...item,
    installed: cached,
    state: cached ? compareState(cached, latest) : 'up_to_date',
    note: cached ? null : 'Not downloaded yet; the first start fetches the latest',
  };
}

/** The package an MCP server runs with `npx [-y] <pkg> ...`, or null for other commands. */
export function npxPackage(command: string, args: readonly string[]): string | null {
  if (path.basename(command) !== 'npx') return null;
  return args.find((arg) => !arg.startsWith('-')) ?? null;
}

function readJsonVersion(file: string): string | null {
  try {
    const version = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** The version pipx installed, from the package's dist-info directory in the venv. */
function pipxVersion(venv: string, project: string): string | null {
  const lib = path.join(venv, 'lib');
  if (!existsSync(lib)) return null;
  const prefix = `${project.replace(/-/g, '_')}-`;
  for (const python of readdirSync(lib)) {
    const site = path.join(lib, python, 'site-packages');
    if (!existsSync(site)) continue;
    const info = readdirSync(site).find((entry) => entry.startsWith(prefix) && entry.endsWith('.dist-info'));
    if (info) return info.slice(prefix.length, -'.dist-info'.length);
  }
  return null;
}
