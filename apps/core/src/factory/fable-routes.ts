/**
 * Until this release a Claude route on Fable launched `--model opus`, so Fable never ran. From now
 * on it runs as Fable; one Inbox notice after the upgrade names the routes that change, so the
 * person can move them back to Opus.
 */
import { PERSONA_CATALOG } from '@emberline/adapter-claude';
import { modelLabel } from '@emberline/protocol';
import { projects, runs } from '../db/schema.js';
import type { Db } from '../db/index.js';
import type { NoticeService } from '../notices/service.js';
import { storedRoadmapItems } from './roadmap.js';
import { getFactorySettings } from './settings.js';

const onFable = (agent: string | undefined, model: string | undefined) =>
  (agent ?? 'claude') === 'claude' && model === 'fable';

/** The persona routes and open roadmap items that name Claude Fable, as the notice lists them. */
export async function routesOnFable(
  db: Db,
  readItems: typeof storedRoadmapItems = storedRoadmapItems,
): Promise<string[]> {
  const fable = modelLabel('claude', 'fable');
  const found: string[] = [];
  const routes = getFactorySettings(db).personaRoutes;
  for (const [persona, chain] of Object.entries(routes) as [keyof typeof routes, typeof routes.coder][]) {
    const label = PERSONA_CATALOG[persona]?.label ?? persona;
    chain.forEach((route, i) => {
      if (onFable(route.agent, route.model))
        found.push(`${label}${i > 0 ? ` (fallback ${i})` : ''} → ${fable}`);
    });
  }
  for (const project of db.select({ name: projects.name, path: projects.path }).from(projects).all()) {
    for (const item of await readItems(project.path)) {
      if (item.status === 'done' || !onFable(item.preferredAgent, item.preferredModel)) continue;
      found.push(`Roadmap: ${item.title ?? 'untitled item'} (${project.name})`);
    }
  }
  return found;
}

/**
 * Shows the notice once (the notice service keeps the flag); once it had its chance no roadmap is
 * read again. A fresh install has run nothing on Opus, so it only sets the flag.
 */
export async function noticeFableRoutes(
  db: Db,
  notices: Pick<NoticeService, 'fableNowFable' | 'fableNoticeShown'>,
  readItems: typeof storedRoadmapItems = storedRoadmapItems,
): Promise<void> {
  if (notices.fableNoticeShown()) return;
  const ranBefore = db.select({ id: runs.id }).from(runs).limit(1).get() !== undefined;
  notices.fableNowFable(ranBefore ? await routesOnFable(db, readItems) : []);
}
