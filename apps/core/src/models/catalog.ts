/**
 * The stored model catalog: what each CLI last reported, plus the ids a person typed in. It lives
 * in one settings row; `publishCatalog` hands the stored entries to the protocol, which merges
 * them with the built-ins.
 */
import {
  BUILTIN_MODELS,
  KNOWN_AT_RELEASE,
  MODEL_ID_RE,
  type AgentId,
  type ModelCatalog,
  type ProviderModelInfo,
  rankFromName,
  setModelCatalog,
} from '@emberline/protocol';
import { type Db, getSetting, setSetting } from '../db/index.js';

const SETTINGS_KEY = 'models.catalog';
const AGENTS = Object.keys(BUILTIN_MODELS) as AgentId[];

export type ProviderRead = { at: string; cliVersion: string | null; ok: boolean; error: string | null };
export type StoredModel = ProviderModelInfo & { firstSeen: string; lastSeen: string };
export type StoredCatalog = Record<AgentId, { models: StoredModel[]; read: ProviderRead | null }>;

export type DiscoveryResult = {
  models: { id: string; label: string; description?: string; group?: string }[];
  source: 'cli' | 'picker';
  cliVersion: string | null;
};

/** The stored catalog with a slot for every provider, so callers never check for a missing one. */
export function readCatalog(db: Db): StoredCatalog {
  const stored = getSetting<Partial<StoredCatalog>>(db, SETTINGS_KEY) ?? {};
  return Object.fromEntries(
    AGENTS.map((a) => [a, { models: stored[a]?.models ?? [], read: stored[a]?.read ?? null }]),
  ) as StoredCatalog;
}

function save(db: Db, catalog: StoredCatalog): void {
  setSetting(db, SETTINGS_KEY, catalog);
  publishCatalog(db);
}

/**
 * Whether `agent`'s own list was ever read: a successful read, or the entries one left behind (a
 * later read may have failed). Until then its runs launch as they did before discovery.
 */
export function providerListRead(db: Db, agent: AgentId): boolean {
  const entry = readCatalog(db)[agent];
  if (!entry) return false;
  return entry.read?.ok === true || entry.models.some((m) => m.source !== 'manual');
}

/** Gives the protocol the stored entries; the built-ins are merged on its side. */
export function publishCatalog(db: Db): void {
  const stored = readCatalog(db);
  setModelCatalog(
    Object.fromEntries(
      AGENTS.map((a) => [a, stored[a].models.map(({ firstSeen: _f, lastSeen: _l, ...m }) => m)]),
    ) as ModelCatalog,
  );
}

function newEntry(
  id: string,
  label: string,
  description: string,
  source: ProviderModelInfo['source'],
  at: string,
): StoredModel {
  return {
    id,
    label,
    shortLabel: id,
    ...rankFromName(id, label),
    badge: source === 'manual' ? '' : 'discovered',
    capabilities: [],
    description,
    source,
    missingSince: null,
    firstSeen: at,
    lastSeen: at,
  };
}

/**
 * Folds one successful discovery into the stored catalog. Ids the CLI no longer lists stay, marked
 * missing, so a run that names one still resolves. `added` holds only ids that are new since this
 * release: not shipped, not listed at release time, not seen before.
 */
export function mergeDiscovery(
  db: Db,
  agent: AgentId,
  result: DiscoveryResult,
  now: Date,
): { added: ProviderModelInfo[] } {
  const at = now.toISOString();
  const catalog = readCatalog(db);
  const entry = catalog[agent];
  const known = new Set([
    ...BUILTIN_MODELS[agent].map((m) => m.id),
    ...KNOWN_AT_RELEASE[agent],
    ...entry.models.map((m) => m.id),
  ]);
  const byId = new Map(entry.models.map((m) => [m.id, m]));
  const listed = new Set<string>();
  const added: ProviderModelInfo[] = [];

  for (const found of result.models) {
    if (!MODEL_ID_RE.test(found.id) || listed.has(found.id)) continue;
    listed.add(found.id);
    const existing = byId.get(found.id);
    if (existing) {
      // A manual entry stays manual: the person added it, discovery only confirms it exists.
      byId.set(found.id, { ...existing, lastSeen: at, missingSince: null });
      continue;
    }
    const created = newEntry(found.id, found.label || found.id, found.description ?? '', result.source, at);
    byId.set(found.id, created);
    if (!known.has(found.id)) added.push(created);
  }
  for (const [id, m] of byId) {
    if (!listed.has(id) && m.source !== 'manual' && !m.missingSince) byId.set(id, { ...m, missingSince: at });
  }

  entry.models = [...byId.values()];
  entry.read = { at, cliVersion: result.cliVersion, ok: true, error: null };
  save(db, catalog);
  return { added };
}

/** Records a failed read; `firstFailure` is true when the read before it was fine or never happened. */
export function recordReadFailure(
  db: Db,
  agent: AgentId,
  cliVersion: string | null,
  error: string,
  now: Date,
): { firstFailure: boolean } {
  const catalog = readCatalog(db);
  const firstFailure = catalog[agent].read?.ok !== false;
  catalog[agent].read = { at: now.toISOString(), cliVersion, ok: false, error };
  save(db, catalog);
  return { firstFailure };
}

export function addManualModel(db: Db, agent: AgentId, id: string, label?: string): void {
  if (!MODEL_ID_RE.test(id)) throw new Error(`Invalid model id: ${id}`);
  const catalog = readCatalog(db);
  const models = catalog[agent].models;
  const at = new Date().toISOString();
  const i = models.findIndex((m) => m.id === id);
  if (i >= 0) {
    // Typing in an id the CLI already reported makes it the person's own.
    models[i] = { ...models[i]!, source: 'manual', ...(label ? { label } : {}) };
  } else {
    models.push(newEntry(id, label || id, '', 'manual', at));
  }
  save(db, catalog);
}

export function removeManualModel(db: Db, agent: AgentId, id: string): void {
  const catalog = readCatalog(db);
  const models = catalog[agent].models;
  catalog[agent].models = models.filter((m) => !(m.id === id && m.source === 'manual'));
  save(db, catalog);
}
