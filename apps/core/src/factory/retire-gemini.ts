/**
 * Gemini CLI is no longer a provider. At every start this step rewrites what an older core stored
 * under its name (enabled providers, the default agent, route steps, the model catalog, quota
 * windows) and posts one Inbox notice naming the routes that moved. It works on the stored JSON as
 * plain strings: `gemini` is not an `AgentId` any more, so nothing here may index a map by it.
 */
import { PERSONA_CATALOG } from '@emberline/adapter-claude';
import {
  AgentId,
  AgentModelId,
  type AgentPersona,
  coerceModelForProvider,
  PROVIDER_RUNTIME,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import { type Db, getSetting, setSetting } from '../db/index.js';
import { quotaWindows, runs } from '../db/schema.js';
import { publishCatalog } from '../models/catalog.js';
import { NoticeService, providerName } from '../notices/service.js';
import { DEFAULT_PERSONA_MODELS } from './settings.js';

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
}

const personaLabel = (persona: string, index: number) =>
  `${PERSONA_CATALOG[persona as AgentPersona]?.label ?? persona}${index > 0 ? ` (fallback ${index})` : ''}`;

/** The model a Gemini step runs on Antigravity: the same id when Antigravity has it, else its pick for the persona. */
const antigravityModel = (model: unknown, persona: string) =>
  coerceModelForProvider(
    ANTIGRAVITY,
    AgentModelId.safeParse(model).data ?? 'auto',
    persona in PERSONA_CATALOG ? (persona as AgentPersona) : undefined,
  );

/** The credential an Antigravity step runs with once read (settings.ts coerces the same way). */
const antigravityCredential = (credential: unknown) =>
  (PROVIDER_RUNTIME.antigravity.credentials as readonly unknown[]).includes(credential)
    ? credential
    : PROVIDER_RUNTIME.antigravity.credentials[0];

/** Rewrites one stored chain; null when it names no Gemini step. */
function retireChain(
  chain: StoredStep[],
  persona: string,
  antigravity: boolean,
  geminiRan: boolean,
): { chain: StoredStep[]; lines: string[] } | null {
  if (!chain.some((step) => step?.agent === GEMINI)) return null;
  const out: StoredStep[] = [];
  const lines: string[] = [];
  chain.forEach((step, i) => {
    if (step?.agent !== GEMINI) {
      out.push(step);
      return;
    }
    // A step on a provider that was not enabled never ran; it goes without a word.
    if (!geminiRan) return;
    const label = personaLabel(persona, i);
    if (!antigravity) {
      lines.push(`${label} → next in its chain`);
      return;
    }
    const moved = { agent: ANTIGRAVITY, model: antigravityModel(step.model, persona), credential: 'login' };
    // Against the steps already there and the ones already moved (two Gemini steps may meet).
    const repeats = [...chain, ...out].some(
      (other) =>
        other?.agent === ANTIGRAVITY &&
        antigravityModel(other.model, persona) === moved.model &&
        antigravityCredential(other.credential) === moved.credential,
    );
    if (repeats) {
      lines.push(`${label} → next in its chain`);
      return;
    }
    out.push(moved);
    lines.push(`${label} → Antigravity ${moved.model}`);
  });
  return { chain: out, lines };
}

/**
 * Idempotent: a second run finds nothing to rewrite. The notice is posted once (the notice service
 * keeps the flag), only when settings changed or old Gemini runs exist, so a fresh install sees none.
 */
export function retireGemini(
  db: Db,
  opts: { now: Date; notices?: Pick<NoticeService, 'geminiRemoved' | 'geminiRemovedNoticeShown'> },
): RetireGeminiResult {
  const notices = opts.notices ?? new NoticeService(db);
  removeCatalogAndQuota(db);

  const raw = getSetting<StoredSettings>(db, FACTORY_SETTINGS_KEY);
  const { settings, lines } = raw ? rewriteSettings(raw) : { settings: null, lines: [] };
  if (settings) setSetting(db, FACTORY_SETTINGS_KEY, settings);
  const changed = settings !== null;

  const hadRuns =
    db.select({ id: runs.id }).from(runs).where(eq(runs.agent, GEMINI)).limit(1).get() !== undefined;
  if ((changed || hadRuns) && !notices.geminiRemovedNoticeShown()) notices.geminiRemoved(lines, opts.now);
  return { changed, lines, hadRuns };
}

/** The catalog's Gemini entry and Gemini's quota windows: nothing reads them any more. */
function removeCatalogAndQuota(db: Db): void {
  const catalog = getSetting<Record<string, unknown>>(db, CATALOG_KEY);
  if (catalog && GEMINI in catalog) {
    const { [GEMINI]: _gemini, ...rest } = catalog;
    setSetting(db, CATALOG_KEY, rest);
  }
  db.delete(quotaWindows).where(eq(quotaWindows.agent, GEMINI)).run();
  // Before any model is coerced: a model Antigravity's last list read has counts as its own.
  publishCatalog(db);
}

/** The settings with Gemini gone, or null when they never named it. */
function rewriteSettings(raw: StoredSettings): { settings: StoredSettings | null; lines: string[] } {
  const next: StoredSettings = { ...raw };
  const lines: string[] = [];
  let changed = false;

  // Without a stored list the providers were detected from keys and logins (Gemini among them), so a
  // Gemini route may well have run; Antigravity is never detected, only enabled by hand.
  const storedList = Array.isArray(raw.enabledProviders) ? (raw.enabledProviders as unknown[]) : null;
  const geminiRan = storedList === null || storedList.includes(GEMINI);
  const antigravity = storedList?.includes(ANTIGRAVITY) ?? false;
  if (storedList?.includes(GEMINI)) {
    next.enabledProviders = storedList.filter((id) => id !== GEMINI);
    changed = true;
  }
  const enabledNow = (next.enabledProviders as unknown[] | undefined) ?? [];

  if (raw.defaultAgent === GEMINI) {
    const firstKnown = enabledNow.find((id) => AgentId.safeParse(id).success) as AgentId | undefined;
    next.defaultAgent = antigravity ? ANTIGRAVITY : (firstKnown ?? 'claude');
    changed = true;
    lines.push(`Default agent → ${providerName(next.defaultAgent as AgentId)}`);
  }

  const routes = raw.personaRoutes && typeof raw.personaRoutes === 'object' ? raw.personaRoutes : {};
  const nextRoutes: Record<string, unknown> = { ...routes };
  for (const [persona, chain] of Object.entries(routes)) {
    if (!Array.isArray(chain)) continue;
    const retired = retireChain(chain as StoredStep[], persona, antigravity, geminiRan);
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
    const model = models[persona] ?? DEFAULT_PERSONA_MODELS[persona as AgentPersona] ?? 'auto';
    const moved = antigravity && geminiRan ? antigravityModel(model, persona) : null;
    if (moved) {
      nextAgents[persona] = ANTIGRAVITY;
      nextModels[persona] = moved;
    } else {
      delete nextAgents[persona];
      delete nextModels[persona];
    }
    if (!geminiRan || Array.isArray(routes[persona])) continue;
    lines.push(`${personaLabel(persona, 0)} → ${moved ? `Antigravity ${moved}` : 'next in its chain'}`);
  }
  if (raw.personaAgents) next.personaAgents = nextAgents;
  if (raw.personaModels) next.personaModels = nextModels;

  return { settings: changed ? next : null, lines };
}
