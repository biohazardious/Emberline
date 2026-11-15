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
import { EventEmitter } from 'node:events';
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

/**
 * `change` fires each time the catalog is published: a read in the background, a refresh, or an id
 * added or removed. The events socket tells the browsers, which fetch the list again.
 */
export const catalogEvents = new EventEmitter<{ change: [] }>();
// One listener per open events socket.
catalogEvents.setMaxListeners(0);

/** Gives the protocol the stored entries; the built-ins are merged on its side. */
export function publishCatalog(db: Db): void {
  const stored = readCatalog(db);
  setModelCatalog(
    Object.fromEntries(
      AGENTS.map((a) => [a, stored[a].models.map(({ firstSeen: _f, lastSeen: _l, ...m }) => m)]),
    ) as ModelCatalog,
  );
  catalogEvents.emit('change');
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
 *
 * An id the CLI lists is the CLI's entry: its label and description follow the CLI's (Claude's
 * alias rows move to new versions under the same id), and an id a person had typed in becomes
 * the CLI's once the CLI lists it, so only ids no CLI lists are the person's to remove.
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
      byId.set(found.id, {
        ...existing,
        label: found.label || found.id,
        description: found.description ?? '',
        source: result.source,
        badge: 'discovered',
        lastSeen: at,
        missingSince: null,
      });
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

/** The id is already one of the provider's models: shipped with Emberline or listed by its CLI. */
export class ModelAlreadyListedError extends Error {
  constructor(readonly id: string) {
    super(`${id} is already in the list.`);
    this.name = 'ModelAlreadyListedError';
  }
}

/**
 * Adds an id the person typed in; typing it again changes its label. An id Emberline ships or the
 * CLI lists is refused: it is in the list already, and it stays the CLI's.
 */
export function addManualModel(db: Db, agent: AgentId, id: string, label?: string, now = new Date()): void {
  if (!MODEL_ID_RE.test(id)) throw new Error(`Invalid model id: ${id}`);
  const catalog = readCatalog(db);
  const models = catalog[agent].models;
  const i = models.findIndex((m) => m.id === id);
  if (BUILTIN_MODELS[agent].some((m) => m.id === id) || (i >= 0 && models[i]!.source !== 'manual')) {
    throw new ModelAlreadyListedError(id);
  }
  if (i >= 0) {
    if (label) models[i] = { ...models[i]!, label };
  } else {
    models.push(newEntry(id, label || id, '', 'manual', now.toISOString()));
  }
  save(db, catalog);
}

/** Removes an id the person added; an id the CLI lists is not theirs to remove and stays. */
export function removeManualModel(db: Db, agent: AgentId, id: string): void {
  const catalog = readCatalog(db);
  const models = catalog[agent].models;
  catalog[agent].models = models.filter((m) => !(m.id === id && m.source === 'manual'));
  save(db, catalog);
}
