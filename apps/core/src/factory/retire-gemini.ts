/**
 * Gemini CLI is no longer a provider. At every start this step rewrites what an older core stored
 * under its name (enabled providers, the default agent, route steps, the model catalog, quota
 * windows), ends the Gemini runs nothing can carry on, and posts one Inbox notice naming the routes
 * that fell back. It works on the stored JSON as plain strings: `gemini` is not an `AgentId` any
 * more, so nothing here may index a map by it.
 */
import { PERSONA_CATALOG } from '@emberline/adapter-claude';
import { AgentId, type AgentPersona } from '@emberline/protocol';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { type Db, getSetting, setSetting } from '../db/index.js';
import { quotaWindows, runs } from '../db/schema.js';
import { publishCatalog } from '../models/catalog.js';
import { NoticeService, providerName } from '../notices/service.js';
import { applyRunEvent } from '../runs/lifecycle.js';
import { AGENT_REMOVED } from '../runs/service.js';
import { ACTIVE_RUN_STATES } from '../tickets/columns.js';
import { getFactorySettings } from './settings.js';

const GEMINI = 'gemini';
const ANTIGRAVITY = 'antigravity';
const FACTORY_SETTINGS_KEY = 'factory.settings';
const CATALOG_KEY = 'models.catalog';

type StoredStep = { agent?: string; model?: string; credential?: string };
type StoredSettings = {
  enabledProviders?: unknown;
  defaultAgent?: unknown;
  personaRoutes?: Record<string, unknown>;
  personaAgents?: Record<string, unknown>;
  personaModels?: Record<string, unknown>;
  [key: string]: unknown;
};

export interface RetireGeminiResult {
  /** The stored factory settings were rewritten. */
  changed: boolean;
  /** One line per route step that named Gemini, as the notice lists them. */
  lines: string[];
  /** Runs on Gemini exist; they stay listed. */
  hadRuns: boolean;
  /** Open runs on an agent this core does not know that were ended now. */
  endedRuns: string[];
}

const personaLabel = (persona: string, index: number) =>
  `${PERSONA_CATALOG[persona as AgentPersona]?.label ?? persona}${index > 0 ? ` (fallback ${index})` : ''}`;

/**
 * Rewrites one stored chain; null when it names no Gemini step. A Gemini step is dropped and the
 * chain's next step (or, for an emptied chain, the default agent) takes over. It is never moved to
 * Antigravity: Emberline does not add Antigravity to a chain for the person (README, Provider terms).
 */
function retireChain(
  chain: StoredStep[],
  persona: string,
  geminiRan: boolean,
): { chain: StoredStep[]; lines: string[] } | null {
  if (!chain.some((step) => step?.agent === GEMINI)) return null;
  const lines: string[] = [];
  chain.forEach((step, i) => {
    // A step on a provider that was not enabled never ran; it goes without a word.
    if (step?.agent === GEMINI && geminiRan) lines.push(`${personaLabel(persona, i)} → next in its chain`);
  });
  return { chain: chain.filter((step) => step?.agent !== GEMINI), lines };
}

/**
 * Idempotent: a second run finds nothing to rewrite. The notice is posted once (the notice service
 * keeps the flag), only when settings changed or old Gemini runs exist, so a fresh install sees none.
 * Every write is one transaction, so a start cut short leaves either all of it or none of it, and
 * the next start tells what it did.
 */
export function retireGemini(
  db: Db,
  opts: { now: Date; notices?: Pick<NoticeService, 'geminiRemoved' | 'geminiRemovedNoticeShown'> },
): RetireGeminiResult {
  const notices = opts.notices ?? new NoticeService(db);
  return db.transaction(() => {
    removeCatalogAndQuota(db);

    const raw = getSetting<StoredSettings>(db, FACTORY_SETTINGS_KEY);
    const rewrite = raw ? rewriteSettings(raw) : { settings: null, lines: [], defaultMoved: null };
    const { settings } = rewrite;
    if (settings) setSetting(db, FACTORY_SETTINGS_KEY, settings);
    const changed = settings !== null;
    // Named as the settings read it back, which is what runs get (an agent not enabled is not it).
    const lines = [...rewrite.lines];
    if (rewrite.defaultMoved) {
      const agent = getFactorySettings(db).defaultAgent;
      lines.unshift(
        agent === ANTIGRAVITY && rewrite.defaultMoved === 'only_antigravity'
          ? 'Default agent → Antigravity (the only provider left on)'
          : `Default agent → ${providerName(agent)}`,
      );
    }

    const endedRuns = endRemovedAgentRuns(db, opts.now);
    const hadRuns =
      db.select({ id: runs.id }).from(runs).where(eq(runs.agent, GEMINI)).limit(1).get() !== undefined;
    if ((changed || hadRuns) && !notices.geminiRemovedNoticeShown()) notices.geminiRemoved(lines, opts.now);
    return { changed, lines, hadRuns, endedRuns };
  });
}

/**
 * Open runs on an agent this core does not have (Gemini CLI) can never start, resume or be moved
 * by the scheduler, yet a queued or waiting one held one of its project's ticket slots for ever,
 * and a queued one could not even be handed off. They end here as failed, with the reason on the
 * run, and not as stopped: a stopped run cannot be handed off, and the hand-off is how its work
 * goes on. The upgrade replaced the runner, so no terminal of theirs is left to close.
 */
function endRemovedAgentRuns(db: Db, now: Date): string[] {
  const open = db
    .select({ id: runs.id, endedAt: runs.endedAt })
    .from(runs)
    .where(and(notInArray(runs.agent, [...AgentId.options]), inArray(runs.state, [...ACTIVE_RUN_STATES])))
    .all();
  for (const run of open) {
    applyRunEvent(db, run.id, {
      source: 'system',
      type: 'agent_removed',
      state: 'failed',
      payload: { message: AGENT_REMOVED },
      patch: { endedAt: run.endedAt ?? now, ptydSessionId: null, autoRetryAt: null },
    });
  }
  return open.map((run) => run.id);
}

/** The catalog's Gemini entry and Gemini's quota windows: nothing reads them any more. */
function removeCatalogAndQuota(db: Db): void {
  const catalog = getSetting<Record<string, unknown>>(db, CATALOG_KEY);
  if (catalog && GEMINI in catalog) {
    const { [GEMINI]: _gemini, ...rest } = catalog;
    setSetting(db, CATALOG_KEY, rest);
  }
  db.delete(quotaWindows).where(eq(quotaWindows.agent, GEMINI)).run();
  publishCatalog(db);
}

/**
 * The settings with Gemini gone, or null when they never named it. `defaultMoved`: the default agent
 * was Gemini (stored, or read as the first enabled provider) and is something else now;
 * `only_antigravity` when Antigravity is all that is left on.
 */
function rewriteSettings(raw: StoredSettings): {
  settings: StoredSettings | null;
  lines: string[];
  defaultMoved: 'moved' | 'only_antigravity' | null;
} {
  const next: StoredSettings = { ...raw };
  const lines: string[] = [];
  let changed = false;

  // Without a stored list the providers were detected from keys and logins (Gemini among them), so a
  // Gemini route may well have run.
  const storedList = Array.isArray(raw.enabledProviders) ? (raw.enabledProviders as unknown[]) : null;
  const geminiRan = storedList === null || storedList.includes(GEMINI);
  if (storedList?.includes(GEMINI)) {
    next.enabledProviders = storedList.filter((id) => id !== GEMINI);
    changed = true;
  }
  const enabledNow = (next.enabledProviders as unknown[] | undefined) ?? [];

  // The default the settings read gave: the stored one when it is enabled, else the first enabled
  // provider. Gemini first in the list with no (or no enabled) stored default was the default too.
  const readDefault =
    storedList && storedList.length > 0
      ? storedList.includes(raw.defaultAgent)
        ? raw.defaultAgent
        : storedList[0]
      : raw.defaultAgent;
  let defaultMoved: 'moved' | 'only_antigravity' | null = null;
  if (raw.defaultAgent === GEMINI || readDefault === GEMINI) {
    // Not Antigravity while another provider is on, for the same reason no step moves there. When
    // Antigravity is the only one left, it is the default: the person enabled it, and the settings
    // read would pick it anyway (Claude is not enabled for them).
    const known = enabledNow.filter((id): id is AgentId => AgentId.safeParse(id).success);
    const firstOther = known.find((id) => id !== ANTIGRAVITY);
    const onlyAntigravity = !firstOther && known.includes(ANTIGRAVITY);
    next.defaultAgent = firstOther ?? (onlyAntigravity ? ANTIGRAVITY : 'claude');
    changed = true;
    defaultMoved = onlyAntigravity ? 'only_antigravity' : 'moved';
  }

  const routes = raw.personaRoutes && typeof raw.personaRoutes === 'object' ? raw.personaRoutes : {};
  const nextRoutes: Record<string, unknown> = { ...routes };
  for (const [persona, chain] of Object.entries(routes)) {
    if (!Array.isArray(chain)) continue;
    const retired = retireChain(chain as StoredStep[], persona, geminiRan);
    if (!retired) continue;
    nextRoutes[persona] = retired.chain;
    lines.push(...retired.lines);
    changed = true;
  }
  if (raw.personaRoutes) next.personaRoutes = nextRoutes;

  // 0.1.x stored one agent and model per persona; they count only where no chain is stored.
  const agents = raw.personaAgents && typeof raw.personaAgents === 'object' ? raw.personaAgents : {};
  const models = raw.personaModels && typeof raw.personaModels === 'object' ? raw.personaModels : {};
  const nextAgents: Record<string, unknown> = { ...agents };
  const nextModels: Record<string, unknown> = { ...models };
  for (const [persona, agent] of Object.entries(agents)) {
    if (agent !== GEMINI) continue;
    changed = true;
    delete nextAgents[persona];
    delete nextModels[persona];
    if (geminiRan && !Array.isArray(routes[persona]))
      lines.push(`${personaLabel(persona, 0)} → next in its chain`);
  }
  if (raw.personaAgents) next.personaAgents = nextAgents;
  if (raw.personaModels) next.personaModels = nextModels;

  return { settings: changed ? next : null, lines, defaultMoved };
}
