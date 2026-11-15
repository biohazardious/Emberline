import {
  type AgentId,
  DEFAULT_COMMIT_IDENTITY,
  DEFAULT_MCP_SERVERS,
  DEFAULT_SKILL_PLUGINS,
  type FactorySettings,
  type McpServerEntry,
  type PersonaRouteMap,
  type QuotaPolicy,
  type Route,
  type SkillPluginEntry,
  type ThemeMode,
  type UpdateFactorySettingsBody,
} from '@emberline/protocol';
import { clampQuotaGb } from '../../buildOutputs';
import { PERSONA_LIST } from '../PersonaBadge';
import { type ApiKeyDraft, type AutopilotDraft, clampParallel } from './settingsMeta';

export interface ProviderDraft {
  defaultAgent: AgentId;
  enabledProviders: AgentId[];
  antigravityAck: boolean;
  personaRoutes: PersonaRouteMap | null;
  quotaPolicy: QuotaPolicy;
  apiKeys: ApiKeyDraft;
}

export interface McpDraft {
  mcpServers: McpServerEntry[];
  skillPlugins: SkillPluginEntry[];
}

export function autopilotDraftFrom(
  settings?: Partial<FactorySettings>,
  fallbackTheme: ThemeMode = 'dark',
): AutopilotDraft {
  return {
    themePref: settings?.theme ?? fallbackTheme,
    autoPickupReady: settings?.autoPickupReady ?? true,
    autoPickupBacklog: settings?.autoPickupBacklog ?? false,
    autoSyncToMain: settings?.autoSyncToMain ?? true,
    autoResolveAdditiveConflicts: settings?.autoResolveAdditiveConflicts ?? true,
    serializeOverlappingTickets: settings?.serializeOverlappingTickets ?? true,
    selfHealingBuildGate: settings?.selfHealingBuildGate ?? true,
    antiSlopGate: settings?.antiSlopGate ?? true,
    secretGuardGate: settings?.secretGuardGate ?? true,
    requireCompletionSignal: settings?.requireCompletionSignal ?? true,
    crossProviderCritic: settings?.crossProviderCritic ?? false,
    autoMoveToDone: settings?.autoMoveToDone ?? true,
    maxTicketDepth: settings?.maxTicketDepth ?? 3,
    maxAutoRunsPerDay: settings?.maxAutoRunsPerProjectPerDay ?? 40,
    maxParallelTickets: String(settings?.maxParallelTicketsPerProject ?? 2),
    buildOutputsQuotaGb: String(settings?.buildOutputsQuotaGb ?? 5),
    commitName: settings?.commitIdentity?.name ?? DEFAULT_COMMIT_IDENTITY.name,
    commitEmail: settings?.commitIdentity?.email ?? DEFAULT_COMMIT_IDENTITY.email,
  };
}

function clonePersonaRoutes(routes: PersonaRouteMap | null | undefined): PersonaRouteMap | null {
  if (!routes) return null;
  return {
    product_owner: routes.product_owner.map((r) => ({ ...r })),
    architect: routes.architect.map((r) => ({ ...r })),
    ui_ux: routes.ui_ux.map((r) => ({ ...r })),
    coder: routes.coder.map((r) => ({ ...r })),
    dba: routes.dba.map((r) => ({ ...r })),
    qa: routes.qa.map((r) => ({ ...r })),
    security: routes.security.map((r) => ({ ...r })),
  };
}

export function providerDraftFrom(settings?: Partial<FactorySettings>): ProviderDraft {
  return {
    defaultAgent: settings?.defaultAgent ?? 'claude',
    enabledProviders: settings?.enabledProviders?.length ? [...settings.enabledProviders] : ['claude'],
    antigravityAck: settings?.antigravityTermsAcknowledged ?? false,
    personaRoutes: clonePersonaRoutes(settings?.personaRoutes),
    quotaPolicy: settings?.quotaPolicy ? { ...settings.quotaPolicy } : { newRuns: 'wait', inFlight: 'wait' },
    apiKeys: { anthropic: '', openai: '', gemini: '' },
  };
}

export function mcpDraftFrom(settings?: Partial<FactorySettings>): McpDraft {
  const servers = settings?.mcpServers?.length ? settings.mcpServers : DEFAULT_MCP_SERVERS;
  const skills = settings?.skillPlugins?.length ? settings.skillPlugins : DEFAULT_SKILL_PLUGINS;
  return {
    mcpServers: servers.map((s) => ({
      ...s,
      args: [...s.args],
      env: { ...s.env },
      personas: [...s.personas],
    })),
    skillPlugins: skills.map((s) => ({
      ...s,
      personas: [...s.personas],
    })),
  };
}

export function isAutopilotDirty(draft: AutopilotDraft, settings: FactorySettings | undefined): boolean {
  if (!settings) return false;
  const saved = autopilotDraftFrom(settings);
  return (
    draft.themePref !== saved.themePref ||
    draft.autoPickupReady !== saved.autoPickupReady ||
    draft.autoPickupBacklog !== saved.autoPickupBacklog ||
    draft.autoSyncToMain !== saved.autoSyncToMain ||
    draft.autoResolveAdditiveConflicts !== saved.autoResolveAdditiveConflicts ||
    draft.serializeOverlappingTickets !== saved.serializeOverlappingTickets ||
    draft.selfHealingBuildGate !== saved.selfHealingBuildGate ||
    draft.antiSlopGate !== saved.antiSlopGate ||
    draft.secretGuardGate !== saved.secretGuardGate ||
    draft.requireCompletionSignal !== saved.requireCompletionSignal ||
    draft.crossProviderCritic !== saved.crossProviderCritic ||
    draft.autoMoveToDone !== saved.autoMoveToDone ||
    draft.maxTicketDepth !== saved.maxTicketDepth ||
    draft.maxAutoRunsPerDay !== saved.maxAutoRunsPerDay ||
    clampParallel(draft.maxParallelTickets) !== clampParallel(saved.maxParallelTickets) ||
    clampQuotaGb(draft.buildOutputsQuotaGb) !== clampQuotaGb(saved.buildOutputsQuotaGb) ||
    draft.commitName.trim() !== saved.commitName.trim() ||
    draft.commitEmail.trim() !== saved.commitEmail.trim()
  );
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const item of setA) {
    if (!setB.has(item)) return false;
  }
  return true;
}

function sameRouteChain(a: readonly Route[], b: readonly Route[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const stepA = a[i];
    const stepB = b[i];
    if (!stepA || !stepB) return false;
    if (stepA.agent !== stepB.agent || stepA.model !== stepB.model || stepA.credential !== stepB.credential) {
      return false;
    }
  }
  return true;
}

function samePersonaRoutes(a: PersonaRouteMap | null, b: PersonaRouteMap | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  for (const meta of PERSONA_LIST) {
    if (!sameRouteChain(a[meta.id] ?? [], b[meta.id] ?? [])) return false;
  }
  return true;
}

export function isProviderDraftDirty(draft: ProviderDraft, settings: FactorySettings | undefined): boolean {
  if (!settings) return false;
  if (
    draft.apiKeys.anthropic.trim() !== '' ||
    draft.apiKeys.openai.trim() !== '' ||
    draft.apiKeys.gemini.trim() !== ''
  ) {
    return true;
  }
  const saved = providerDraftFrom(settings);
  if (draft.defaultAgent !== saved.defaultAgent) return true;
  if (draft.antigravityAck !== saved.antigravityAck) return true;
  if (!sameStringSet(draft.enabledProviders, saved.enabledProviders)) return true;
  if (
    draft.quotaPolicy.newRuns !== saved.quotaPolicy.newRuns ||
    draft.quotaPolicy.inFlight !== saved.quotaPolicy.inFlight
  ) {
    return true;
  }
  if (!samePersonaRoutes(draft.personaRoutes, saved.personaRoutes)) return true;
  return false;
}

function sameStringRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function sameMcpServers(a: readonly McpServerEntry[], b: readonly McpServerEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.description !== y.description ||
      x.icon !== y.icon ||
      x.transport !== y.transport ||
      x.command !== y.command ||
      x.url !== y.url ||
      x.enabled !== y.enabled ||
      x.builtIn !== y.builtIn ||
      x.args.length !== y.args.length ||
      x.args.some((arg, idx) => arg !== y.args[idx]) ||
      !sameStringRecord(x.env, y.env) ||
      !sameStringSet(x.personas, y.personas)
    ) {
      return false;
    }
  }
  return true;
}

function sameSkillPlugins(a: readonly SkillPluginEntry[], b: readonly SkillPluginEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.description !== y.description ||
      x.icon !== y.icon ||
      x.category !== y.category ||
      x.instructions !== y.instructions ||
      x.enabled !== y.enabled ||
      x.builtIn !== y.builtIn ||
      !sameStringSet(x.personas, y.personas)
    ) {
      return false;
    }
  }
  return true;
}

export function isMcpDraftDirty(draft: McpDraft, settings: FactorySettings | undefined): boolean;
export function isMcpDraftDirty(
  mcpServers: readonly McpServerEntry[],
  skillPlugins: readonly SkillPluginEntry[],
  settings: FactorySettings | undefined,
): boolean;
export function isMcpDraftDirty(
  first: McpDraft | readonly McpServerEntry[],
  second: (FactorySettings | undefined) | readonly SkillPluginEntry[],
  third?: FactorySettings | undefined,
): boolean {
  const isArrayOverload = Array.isArray(first);
  const settings = isArrayOverload ? third : (second as FactorySettings | undefined);
  if (!settings) return false;
  const mcpServers = isArrayOverload ? (first as readonly McpServerEntry[]) : (first as McpDraft).mcpServers;
  const skillPlugins = isArrayOverload
    ? (second as readonly SkillPluginEntry[])
    : (first as McpDraft).skillPlugins;
  const saved = mcpDraftFrom(settings);
  return !sameMcpServers(mcpServers, saved.mcpServers) || !sameSkillPlugins(skillPlugins, saved.skillPlugins);
}

export function buildSettingsPatch(
  autopilot: AutopilotDraft,
  provider: ProviderDraft,
  mcp: McpDraft,
): UpdateFactorySettingsBody {
  const payload: UpdateFactorySettingsBody = {
    theme: autopilot.themePref,
    autoPickupReady: autopilot.autoPickupReady,
    autoPickupBacklog: autopilot.autoPickupBacklog,
    autoSyncToMain: autopilot.autoSyncToMain,
    autoResolveAdditiveConflicts: autopilot.autoResolveAdditiveConflicts,
    serializeOverlappingTickets: autopilot.serializeOverlappingTickets,
    selfHealingBuildGate: autopilot.selfHealingBuildGate,
    antiSlopGate: autopilot.antiSlopGate,
    secretGuardGate: autopilot.secretGuardGate,
    requireCompletionSignal: autopilot.requireCompletionSignal,
    crossProviderCritic: autopilot.crossProviderCritic,
    autoMoveToDone: autopilot.autoMoveToDone,
    maxTicketDepth: autopilot.maxTicketDepth,
    maxAutoRunsPerProjectPerDay: autopilot.maxAutoRunsPerDay,
    maxParallelTicketsPerProject: clampParallel(autopilot.maxParallelTickets),
    buildOutputsQuotaGb: clampQuotaGb(autopilot.buildOutputsQuotaGb),
    commitIdentity: { name: autopilot.commitName.trim(), email: autopilot.commitEmail.trim() },
    defaultAgent: provider.defaultAgent,
    enabledProviders: provider.enabledProviders,
    antigravityTermsAcknowledged: provider.antigravityAck,
    personaRoutes: provider.personaRoutes ?? undefined,
    quotaPolicy: provider.quotaPolicy,
    mcpServers: mcp.mcpServers,
    skillPlugins: mcp.skillPlugins,
  };
  if (provider.apiKeys.anthropic.trim()) payload.anthropicApiKey = provider.apiKeys.anthropic.trim();
  if (provider.apiKeys.openai.trim()) payload.openaiApiKey = provider.apiKeys.openai.trim();
  if (provider.apiKeys.gemini.trim()) payload.geminiApiKey = provider.apiKeys.gemini.trim();
  return payload;
}
