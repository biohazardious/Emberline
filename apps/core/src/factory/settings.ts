/** Factory settings, provider keys and auth detection, persona to agent/model/MCP routing. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AgentId,
  AgentModelId,
  type AgentPersona,
  coerceModelForProvider,
  type Credential,
  DEFAULT_MCP_SERVERS,
  DEFAULT_SKILL_PLUGINS,
  FactorySettings,
  MAX_ROUTES,
  type McpServerEntry,
  PROVIDER_RUNTIME,
  type QuotaPolicy,
  type Route,
  sameRoute,
  selectProviderModelByRank,
  type SkillPluginEntry,
  UpdateFactorySettingsBody,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';

// --- F7 & F10: Unified Factory Settings & Multi-Provider Routing ------------

const FACTORY_SETTINGS_KEY = 'factory.settings';
const FACTORY_KEYS_KEY = 'factory.providerKeys';

interface StoredProviderKeys {
  anthropicApiKey?: string | null;
  openaiApiKey?: string | null;
  geminiApiKey?: string | null;
}

type StoredRoute = { agent?: string; model?: string; credential?: string };

/** What `factory.settings` holds: the 0.2 chains, plus the 0.1.x per-persona fields until they are rewritten. */
type StoredFactorySettings = Partial<Omit<FactorySettings, 'personaRoutes' | 'quotaPolicy'>> & {
  personaRoutes?: Partial<Record<AgentPersona, StoredRoute[]>>;
  quotaPolicy?: Partial<QuotaPolicy>;
  quotaAutoDowngrade?: boolean;
};

/** Which stored API keys each agent may see; aider talks to any vendor, copilot uses none of them. */
const PROVIDER_KEY_ACCESS: Record<AgentId, readonly ('anthropic' | 'openai' | 'gemini')[]> = {
  claude: ['anthropic'],
  codex: ['openai'],
  gemini: ['gemini'],
  antigravity: ['gemini'],
  aider: ['anthropic', 'openai', 'gemini'],
  copilot: [],
};

const DEFAULT_PERSONA_MODELS: Record<AgentPersona, AgentModelId> = {
  product_owner: 'fable',
  architect: 'fable',
  ui_ux: 'opus',
  coder: 'opus',
  dba: 'opus',
  qa: 'sonnet',
  security: 'opus',
};

const ALL_PERSONA_KEYS: readonly AgentPersona[] = [
  'product_owner',
  'architect',
  'ui_ux',
  'coder',
  'dba',
  'qa',
  'security',
];

/** Keeps a chain usable: enabled providers only, valid model and credential, no duplicates, at most MAX_ROUTES. */
function normalizeChain(
  chain: readonly StoredRoute[],
  persona: AgentPersona,
  enabled: ReadonlySet<string>,
  fallback: Route,
): Route[] {
  const out: Route[] = [];
  for (const step of chain) {
    const agent = AgentId.safeParse(step.agent);
    if (!agent.success || !enabled.has(agent.data)) continue;
    const model = coerceModelForProvider(agent.data, AgentModelId.safeParse(step.model).data ?? 'auto', persona);
    const allowed = PROVIDER_RUNTIME[agent.data].credentials;
    const credential = allowed.includes(step.credential as Credential) ? (step.credential as Credential) : allowed[0]!;
    const route: Route = { agent: agent.data, model, credential };
    if (!out.some((r) => sameRoute(r, route))) out.push(route);
    if (out.length === MAX_ROUTES) break;
  }
  return out.length > 0 ? out : [fallback];
}

/** Whether today's runs of `agent` get a stored key (then a migrated route keeps using it). */
function keyStoredFor(agent: AgentId, keys: StoredProviderKeys): boolean {
  const access = PROVIDER_KEY_ACCESS[agent];
  return (
    (access.includes('anthropic') && Boolean(keys.anthropicApiKey)) ||
    (access.includes('openai') && Boolean(keys.openaiApiKey)) ||
    (access.includes('gemini') && Boolean(keys.geminiApiKey))
  );
}

/** The credential today's runs of `agent` use: the stored key when it has one, else the CLI login. */
function defaultCredential(agent: AgentId, keys: StoredProviderKeys): Credential {
  const allowed = PROVIDER_RUNTIME[agent].credentials;
  return allowed.includes('api_key') && keyStoredFor(agent, keys) ? 'api_key' : allowed[0]!;
}

/** 0.1.x stored one agent + model per persona (and a Claude auto-downgrade switch). */
function legacyChain(
  persona: AgentPersona,
  raw: StoredFactorySettings,
  keys: StoredProviderKeys,
  defaultAgent: AgentId,
): StoredRoute[] {
  const agent = raw.personaAgents?.[persona] ?? defaultAgent;
  const model = raw.personaModels?.[persona] ?? DEFAULT_PERSONA_MODELS[persona];
  const credential: Credential = PROVIDER_RUNTIME[agent] ? defaultCredential(agent, keys) : 'login';
  const chain: StoredRoute[] = [{ agent, model, credential }];
  if ((raw.quotaAutoDowngrade ?? true) && agent === 'claude' && (model === 'fable' || model === 'opus')) {
    chain.push({ agent, model: selectProviderModelByRank('claude', 3), credential });
  }
  return chain;
}

function hasNonEmptyAntigravitySecrets(home: string): boolean {
  try {
    const oauthTokenPath = path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    if (existsSync(oauthTokenPath)) {
      const tokenRaw = readFileSync(oauthTokenPath, 'utf8').trim();
      if (tokenRaw.length > 10) {
        return true;
      }
    }
    const secretsPath = path.join(home, '.config', 'antigravity', 'plugin-secrets.json');
    if (existsSync(secretsPath)) {
      const raw = readFileSync(secretsPath, 'utf8').trim();
      if (raw.length > 4) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
          return true;
        }
      }
    }
    const jetskiPath = path.join(home, '.gemini', 'antigravity-cli', 'jetski_state.pbtxt');
    if (existsSync(jetskiPath)) {
      const pbtxt = readFileSync(jetskiPath, 'utf8');
      if (/oauth_token|refresh_token|access_token/i.test(pbtxt)) {
        return true;
      }
    }
  } catch {
    // ignore read errors
  }
  return false;
}

function hasValidGeminiOAuth(home: string): boolean {
  try {
    if (
      existsSync(path.join(home, '.gemini', 'oauth_creds.json')) ||
      existsSync(path.join(home, '.gemini', 'gemini-credentials.json')) ||
      existsSync(path.join(home, '.config', 'gcloud', 'application_default_credentials.json'))
    ) {
      return true;
    }
    const accountsPath = path.join(home, '.gemini', 'google_accounts.json');
    if (existsSync(accountsPath)) {
      const parsed = JSON.parse(readFileSync(accountsPath, 'utf8')) as { active?: string | null };
      if (typeof parsed?.active === 'string' && parsed.active.trim().length > 0) {
        return true;
      }
    }
  } catch {
    // ignore read errors
  }
  return false;
}

function hasClaudeAccount(home: string): boolean {
  try {
    const config = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8')) as { oauthAccount?: unknown };
    return Boolean(config.oauthAccount);
  } catch {
    return false;
  }
}

function detectRunnerProviderAuth(params: {
  anthropicKeyConfigured: boolean;
  openaiKeyConfigured: boolean;
  geminiKeyConfigured: boolean;
}) {
  // The runner's home, mounted read-only into core at the same path.
  const home = process.env.EMBERLINE_RUNNER_HOME ?? '/home/node';
  // ~/.claude.json appears as soon as Claude Code starts once, signed in or not: only a credentials
  // file or a recorded account means a login.
  const claudeOAuth = existsSync(path.join(home, '.claude', '.credentials.json')) || hasClaudeAccount(home);
  const geminiOAuth = hasValidGeminiOAuth(home);
  const antigravityOAuth = hasNonEmptyAntigravitySecrets(home) || geminiOAuth;
  const codexOAuth = existsSync(path.join(home, '.codex', 'auth.json'));
  const copilotOAuth =
    existsSync(path.join(home, '.copilot')) ||
    existsSync(path.join(home, '.config', 'github-copilot')) ||
    existsSync(path.join(home, '.config', 'gh', 'hosts.yml'));

  return {
    claude: claudeOAuth
      ? {
          authenticated: true,
          method: 'oauth_cli' as const,
          label: '✓ Claude OAuth Active',
          cliInstalled: true,
          loginCommandHint: 'claude login',
        }
      : params.anthropicKeyConfigured
        ? {
            authenticated: true,
            method: 'api_key' as const,
            label: '✓ Anthropic API Key',
            cliInstalled: true,
            loginCommandHint: 'claude login',
          }
        : {
            authenticated: false,
            method: 'none' as const,
            label: 'OAuth Login or API Key',
            cliInstalled: true,
            loginCommandHint: 'claude login',
          },
    antigravity: antigravityOAuth
      ? {
          authenticated: true,
          method: 'oauth_cli' as const,
          label: '✓ Google Account OAuth',
          cliInstalled: true,
          loginCommandHint: 'agy',
        }
      : params.geminiKeyConfigured
        ? {
            authenticated: true,
            method: 'api_key' as const,
            label: '✓ Gemini API Key',
            cliInstalled: true,
            loginCommandHint: 'agy',
          }
        : {
            authenticated: false,
            method: 'none' as const,
            label: 'Google OAuth (No Key Needed)',
            cliInstalled: true,
            loginCommandHint: 'agy',
          },
    gemini: geminiOAuth
      ? {
          authenticated: true,
          method: 'oauth_cli' as const,
          label: '✓ Google Account OAuth',
          cliInstalled: true,
          loginCommandHint: 'gemini',
        }
      : params.geminiKeyConfigured
        ? {
            authenticated: true,
            method: 'api_key' as const,
            label: '✓ Gemini API Key',
            cliInstalled: true,
            loginCommandHint: 'gemini',
          }
        : {
            authenticated: false,
            method: 'none' as const,
            label: 'API Key Recommended (or use Antigravity)',
            cliInstalled: true,
            loginCommandHint: 'gemini',
          },
    codex: codexOAuth
      ? {
          authenticated: true,
          method: 'oauth_cli' as const,
          label: '✓ ChatGPT / Codex OAuth',
          cliInstalled: true,
          loginCommandHint: 'codex login',
        }
      : params.openaiKeyConfigured
        ? {
            authenticated: true,
            method: 'api_key' as const,
            label: '✓ OpenAI API Key',
            cliInstalled: true,
            loginCommandHint: 'codex login',
          }
        : {
            authenticated: false,
            method: 'none' as const,
            label: 'ChatGPT OAuth or API Key',
            cliInstalled: true,
            loginCommandHint: 'codex login',
          },
    copilot: copilotOAuth
      ? {
          authenticated: true,
          method: 'oauth_cli' as const,
          label: '✓ GitHub OAuth Active',
          cliInstalled: true,
          loginCommandHint: 'copilot login',
        }
      : {
          authenticated: false,
          method: 'none' as const,
          label: 'GitHub OAuth Login',
          cliInstalled: true,
          loginCommandHint: 'copilot login',
        },
    aider:
      params.anthropicKeyConfigured || params.openaiKeyConfigured || params.geminiKeyConfigured
        ? {
            authenticated: true,
            method: 'api_key' as const,
            label: '✓ Uses Provider API Keys',
            cliInstalled: true,
            loginCommandHint: 'aider',
          }
        : {
            authenticated: false,
            method: 'none' as const,
            label: 'API Key Recommended',
            cliInstalled: true,
            loginCommandHint: 'aider',
          },
  };
}

function quotaPolicyOf(raw: StoredFactorySettings): QuotaPolicy {
  return { newRuns: raw.quotaPolicy?.newRuns ?? 'wait', inFlight: raw.quotaPolicy?.inFlight ?? 'wait' };
}

/** The quota policy alone: one settings row, none of the provider auth detection `getFactorySettings` does. */
export function getQuotaPolicy(db: Db): QuotaPolicy {
  const row = db.select().from(settings).where(eq(settings.key, FACTORY_SETTINGS_KEY)).get();
  return quotaPolicyOf((row?.value ?? {}) as StoredFactorySettings);
}

export function getFactorySettings(db: Db): FactorySettings {
  const row = db.select().from(settings).where(eq(settings.key, FACTORY_SETTINGS_KEY)).get();
  const keysRow = db.select().from(settings).where(eq(settings.key, FACTORY_KEYS_KEY)).get();
  const raw = (row?.value ?? {}) as StoredFactorySettings;
  const keys = (keysRow?.value ?? {}) as StoredProviderKeys;

  const anthropicKeyConfigured = Boolean(keys.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
  const openaiKeyConfigured = Boolean(keys.openaiApiKey || process.env.OPENAI_API_KEY);
  const geminiKeyConfigured = Boolean(
    keys.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  );
  const providerAuth = detectRunnerProviderAuth({
    anthropicKeyConfigured,
    openaiKeyConfigured,
    geminiKeyConfigured,
  });

  // Derive active/enabled providers: Claude is always available by default via Host CLI Auth / API key.
  const enabledSet = new Set<AgentId>(
    Array.isArray(raw.enabledProviders) && raw.enabledProviders.length > 0
      ? raw.enabledProviders
      : ['claude'],
  );
  if (enabledSet.size === 0) enabledSet.add('claude');
  if (!Array.isArray(raw.enabledProviders)) {
    if (openaiKeyConfigured || providerAuth.codex.authenticated) enabledSet.add('codex');
    if (geminiKeyConfigured || providerAuth.gemini.authenticated) enabledSet.add('gemini');
  }
  const enabledProviders = Array.from(enabledSet);

  const defaultAgent: AgentId =
    raw.defaultAgent && enabledSet.has(raw.defaultAgent)
      ? raw.defaultAgent
      : (enabledProviders[0] ?? 'claude');

  const personaRoutes = {} as Record<AgentPersona, Route[]>;
  const normalizedAgents = {} as Record<AgentPersona, AgentId>;
  const normalizedModels = {} as Record<AgentPersona, AgentModelId>;
  for (const p of ALL_PERSONA_KEYS) {
    const fallback: Route = {
      agent: defaultAgent,
      model: coerceModelForProvider(defaultAgent, DEFAULT_PERSONA_MODELS[p], p),
      credential: defaultCredential(defaultAgent, keys),
    };
    const stored = raw.personaRoutes?.[p] ?? legacyChain(p, raw, keys, defaultAgent);
    personaRoutes[p] = normalizeChain(stored, p, enabledSet, fallback);
    normalizedAgents[p] = personaRoutes[p][0]!.agent;
    normalizedModels[p] = personaRoutes[p][0]!.model;
  }

  const storedMcpList = Array.isArray(raw.mcpServers) ? raw.mcpServers : [];
  const storedMcpMap = new Map(storedMcpList.map((m) => [m.id, m]));
  const mergedMcpServers: McpServerEntry[] = DEFAULT_MCP_SERVERS.map((def) => {
    const saved = storedMcpMap.get(def.id);
    if (!saved) return def;
    storedMcpMap.delete(def.id);
    return {
      ...def,
      ...saved,
      builtIn: true,
    };
  });
  for (const custom of storedMcpMap.values()) {
    mergedMcpServers.push(custom);
  }

  const storedSkillList = Array.isArray(raw.skillPlugins) ? raw.skillPlugins : [];
  const storedSkillMap = new Map(storedSkillList.map((s) => [s.id, s]));
  const mergedSkillPlugins: SkillPluginEntry[] = DEFAULT_SKILL_PLUGINS.map((def) => {
    const saved = storedSkillMap.get(def.id);
    if (!saved) return def;
    storedSkillMap.delete(def.id);
    return {
      ...def,
      ...saved,
      builtIn: true,
    };
  });
  for (const custom of storedSkillMap.values()) {
    mergedSkillPlugins.push(custom);
  }

  return FactorySettings.parse({
    theme: raw.theme ?? 'dark',
    defaultAgent,
    enabledProviders,
    personaAgents: normalizedAgents,
    personaModels: normalizedModels,
    personaRoutes,
    quotaPolicy: quotaPolicyOf(raw),
    autoPickupReady: raw.autoPickupReady ?? true,
    autoPickupBacklog: raw.autoPickupBacklog ?? false,
    autoSyncToMain: raw.autoSyncToMain ?? true,
    selfHealingBuildGate: raw.selfHealingBuildGate ?? true,
    antiSlopGate: raw.antiSlopGate ?? true,
    secretGuardGate: raw.secretGuardGate ?? true,
    crossProviderCritic: raw.crossProviderCritic ?? false,
    autoMoveToDone: raw.autoMoveToDone ?? true,
    maxTicketDepth: raw.maxTicketDepth ?? 3,
    maxAutoRunsPerProjectPerDay: raw.maxAutoRunsPerProjectPerDay ?? 40,
    maxParallelTicketsPerProject: raw.maxParallelTicketsPerProject ?? 2,
    mcpServers: mergedMcpServers,
    skillPlugins: mergedSkillPlugins,
    anthropicKeyConfigured,
    openaiKeyConfigured,
    geminiKeyConfigured,
    providerAuth,
  });
}

export function updateFactorySettings(db: Db, input: UpdateFactorySettingsBody): FactorySettings {
  const body = UpdateFactorySettingsBody.parse(input);
  const current = getFactorySettings(db);

  const enabledSet = new Set<AgentId>(body.enabledProviders ?? current.enabledProviders ?? ['claude']);
  if (body.openaiApiKey && body.openaiApiKey.trim().length > 0) {
    enabledSet.add('codex');
  }
  if (body.geminiApiKey && body.geminiApiKey.trim().length > 0) {
    enabledSet.add('gemini');
  }
  if (body.anthropicApiKey && body.anthropicApiKey.trim().length > 0) {
    enabledSet.add('claude');
  }
  if (enabledSet.size === 0) {
    enabledSet.add('claude');
  }
  const enabledProviders = Array.from(enabledSet);

  const nextDefaultAgent: AgentId =
    body.defaultAgent && enabledSet.has(body.defaultAgent)
      ? body.defaultAgent
      : enabledSet.has(current.defaultAgent)
        ? current.defaultAgent
        : (enabledProviders[0] ?? 'claude');

  const nextRoutes = { ...current.personaRoutes };
  for (const p of ALL_PERSONA_KEYS) {
    const chain = body.personaRoutes?.[p] ?? nextRoutes[p];
    const legacyAgent = body.personaAgents?.[p];
    const legacyModel = body.personaModels?.[p];
    nextRoutes[p] =
      !body.personaRoutes?.[p] && (legacyAgent || legacyModel)
        ? [{ ...chain[0]!, agent: legacyAgent ?? chain[0]!.agent, model: legacyModel ?? chain[0]!.model }, ...chain.slice(1)]
        : chain;
  }

  const nextValue = {
    theme: body.theme ?? current.theme,
    defaultAgent: nextDefaultAgent,
    enabledProviders,
    personaRoutes: nextRoutes,
    quotaPolicy: { ...current.quotaPolicy, ...(body.quotaPolicy ?? {}) },
    autoPickupReady: body.autoPickupReady ?? current.autoPickupReady,
    autoPickupBacklog: body.autoPickupBacklog ?? current.autoPickupBacklog,
    autoSyncToMain: body.autoSyncToMain ?? current.autoSyncToMain,
    selfHealingBuildGate: body.selfHealingBuildGate ?? current.selfHealingBuildGate,
    antiSlopGate: body.antiSlopGate ?? current.antiSlopGate,
    secretGuardGate: body.secretGuardGate ?? current.secretGuardGate,
    crossProviderCritic: body.crossProviderCritic ?? current.crossProviderCritic,
    autoMoveToDone: body.autoMoveToDone ?? current.autoMoveToDone,
    maxTicketDepth: body.maxTicketDepth ?? current.maxTicketDepth,
    maxAutoRunsPerProjectPerDay: body.maxAutoRunsPerProjectPerDay ?? current.maxAutoRunsPerProjectPerDay,
    maxParallelTicketsPerProject: body.maxParallelTicketsPerProject ?? current.maxParallelTicketsPerProject,
    mcpServers: body.mcpServers ?? current.mcpServers,
    skillPlugins: body.skillPlugins ?? current.skillPlugins,
  };

  db.insert(settings)
    .values({ key: FACTORY_SETTINGS_KEY, value: nextValue })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: nextValue },
    })
    .run();

  if (
    body.anthropicApiKey !== undefined ||
    body.openaiApiKey !== undefined ||
    body.geminiApiKey !== undefined
  ) {
    const keysRow = db.select().from(settings).where(eq(settings.key, FACTORY_KEYS_KEY)).get();
    const prevKeys = (keysRow?.value ?? {}) as StoredProviderKeys;
    const nextKeys: StoredProviderKeys = {
      anthropicApiKey:
        body.anthropicApiKey === undefined ? prevKeys.anthropicApiKey : body.anthropicApiKey || null,
      openaiApiKey:
        body.openaiApiKey === undefined ? prevKeys.openaiApiKey : body.openaiApiKey || null,
      geminiApiKey:
        body.geminiApiKey === undefined ? prevKeys.geminiApiKey : body.geminiApiKey || null,
    };
    db.insert(settings)
      .values({ key: FACTORY_KEYS_KEY, value: nextKeys })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: nextKeys },
      })
      .run();
  }

  return getFactorySettings(db);
}

/** The chain a new run follows: an explicit/tagged route first, then the persona's chain. */
export function resolveRunRoutes(db: Db, persona: AgentPersona, preferred?: { agent?: string; model?: string }): Route[] {
  const cfg = getFactorySettings(db);
  const chain = cfg.personaRoutes[persona];
  const enabled = new Set<string>(cfg.enabledProviders);
  const keys = (db.select().from(settings).where(eq(settings.key, FACTORY_KEYS_KEY)).get()?.value ?? {}) as StoredProviderKeys;
  const tagged = AgentId.safeParse(preferred?.agent);
  const preferredModel = AgentModelId.safeParse(preferred?.model).data;
  // A tagged or hand-picked agent leads even when its provider is not enabled (as before 0.2.0);
  // a bare model keeps the persona's first route and only swaps the model.
  let head: Route | undefined;
  if (tagged.success) {
    // `Model: auto` (or no model) never reaches the CLI: a same-agent chain step's model, else
    // the persona's model mapped onto the tagged agent.
    const explicitModel = preferredModel ?? (preferred?.model as AgentModelId | undefined);
    const sameAgent = chain.find((r) => r.agent === tagged.data && r.model !== 'auto');
    const personaModel = chain[0] && chain[0].model !== 'auto' ? chain[0].model : DEFAULT_PERSONA_MODELS[persona];
    head = {
      agent: tagged.data,
      model:
        explicitModel && explicitModel !== 'auto'
          ? explicitModel
          : (sameAgent?.model ?? coerceModelForProvider(tagged.data, personaModel, persona)),
      credential: chain.find((r) => r.agent === tagged.data)?.credential ?? defaultCredential(tagged.data, keys),
    };
  } else if (preferredModel && preferredModel !== 'auto' && chain[0]) {
    head = { ...chain[0], model: coerceModelForProvider(chain[0].agent, preferredModel, persona) };
  }
  const rest = normalizeChain(chain, persona, enabled, chain[0]!);
  const out: Route[] = head ? [head] : [];
  for (const route of rest) {
    if (!out.some((r) => sameRoute(r, route))) out.push(route);
  }
  return out.slice(0, MAX_ROUTES);
}

/** The credential a run of `agent` gets without a configured route: the stored key when there is one, else the login. */
export function defaultCredentialFor(db: Db, agent: AgentId): Credential {
  const keys = (db.select().from(settings).where(eq(settings.key, FACTORY_KEYS_KEY)).get()?.value ?? {}) as StoredProviderKeys;
  return defaultCredential(agent, keys);
}

/** An API-key route is only usable while its provider's key is stored; login and credits routes always are. */
export function routeUsable(db: Db, route: Route): boolean {
  if (route.credential !== 'api_key') return true;
  const keys = (db.select().from(settings).where(eq(settings.key, FACTORY_KEYS_KEY)).get()?.value ?? {}) as StoredProviderKeys;
  return keyStoredFor(route.agent, keys);
}

/** S14: only the keys the launched agent needs go into its PTY environment, not every stored key. */
export function getProviderEnvFromSettings(
  db: Db,
  agent: string,
  credential: Credential = 'api_key',
): Record<string, string> {
  if (credential !== 'api_key') return {};
  const keysRow = db.select().from(settings).where(eq(settings.key, FACTORY_KEYS_KEY)).get();
  const keys = (keysRow?.value ?? {}) as StoredProviderKeys;
  const access: readonly string[] = PROVIDER_KEY_ACCESS[agent as AgentId] ?? [];
  const env: Record<string, string> = {};
  if (keys.anthropicApiKey && access.includes('anthropic')) env.ANTHROPIC_API_KEY = keys.anthropicApiKey;
  if (keys.openaiApiKey && access.includes('openai')) env.OPENAI_API_KEY = keys.openaiApiKey;
  if (keys.geminiApiKey && access.includes('gemini')) {
    env.GEMINI_API_KEY = keys.geminiApiKey;
    env.GOOGLE_API_KEY = keys.geminiApiKey;
  }
  return env;
}

export function resolveAgentForPersona(
  db: Db,
  persona: AgentPersona,
  explicitAgent?: AgentId,
): AgentId {
  const cfg = getFactorySettings(db);
  if (explicitAgent && cfg.enabledProviders.includes(explicitAgent)) return explicitAgent;
  const personaAgent = cfg.personaAgents[persona];
  if (personaAgent && cfg.enabledProviders.includes(personaAgent)) return personaAgent;
  return cfg.defaultAgent ?? 'claude';
}

export function resolveModelForPersona(
  db: Db,
  persona: AgentPersona,
  explicitModel?: AgentModelId,
  explicitAgent?: AgentId,
): AgentModelId {
  const cfg = getFactorySettings(db);
  const agent = resolveAgentForPersona(db, persona, explicitAgent);
  const rawCandidate =
    explicitModel && explicitModel !== 'auto'
      ? explicitModel
      : (cfg.personaModels?.[persona] ?? DEFAULT_PERSONA_MODELS[persona] ?? 'opus');
  const candidate = coerceModelForProvider(agent, rawCandidate, persona);
  return candidate;
}

export function resolveMcpServersForPersona(
  db: Db,
  persona: AgentPersona,
): {
  playwrightEnabled: boolean;
  customMcpServers: Record<
    string,
    { command?: string; args?: string[]; env?: Record<string, string>; url?: string; type?: 'stdio' | 'sse' | 'http' }
  >;
} {
  const cfg = getFactorySettings(db);
  let playwrightEnabled = true;
  const customMcpServers: Record<
    string,
    { command?: string; args?: string[]; env?: Record<string, string>; url?: string; type?: 'stdio' | 'sse' | 'http' }
  > = {};

  for (const srv of cfg.mcpServers ?? []) {
    const matchesPersona = srv.personas.length === 0 || srv.personas.includes(persona);
    if (srv.id === 'playwright') {
      playwrightEnabled = Boolean(srv.enabled && matchesPersona);
      continue;
    }
    if (!srv.enabled || !matchesPersona) continue;
    if (srv.transport === 'stdio' && srv.command.trim()) {
      customMcpServers[srv.id] = {
        command: srv.command.trim(),
        args: srv.args,
        ...(Object.keys(srv.env).length > 0 ? { env: srv.env } : {}),
      };
    } else if ((srv.transport === 'sse' || srv.transport === 'http') && srv.url?.trim()) {
      customMcpServers[srv.id] = {
        type: srv.transport,
        url: srv.url.trim(),
      };
    }
  }

  return { playwrightEnabled, customMcpServers };
}

export function resolveSkillPluginPromptForPersona(db: Db, persona: AgentPersona): string {
  const cfg = getFactorySettings(db);
  const activeSkills = (cfg.skillPlugins ?? []).filter(
    (s) => s.enabled && (s.personas.length === 0 || s.personas.includes(persona)),
  );
  if (activeSkills.length === 0) return '';
  return [
    '[ACTIVE FACTORY SKILL & RULE PLUGINS]:',
    ...activeSkills.map((s) => `- [${s.name}]: ${s.instructions.trim()}`),
  ].join('\n');
}
