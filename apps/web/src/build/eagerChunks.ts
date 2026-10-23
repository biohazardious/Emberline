/**
 * Build only (vite.config.ts): what the first page loads of a few libraries and of the protocol
 * schemas, in chunks of their own beside the app's (so none of them grows the app's chunk), and
 * nothing that only lazy pages import (an icon of the Settings page, the Board's useMutation):
 * - Only libraries the first page uses throughout: React's renderer, and zod with the protocol
 *   schemas (no lazy page has a module of them to itself).
 * - Libraries made of per-feature modules behind one entry (lucide-react's icons, react-query's
 *   hooks, wouter) are left to Rollup, which keeps a module that only lazy pages use with them.
 * - A module the entry does not reach through static imports is left to Rollup too.
 */
import type { Rollup } from 'vite';

/** npm packages read whole by the first page. */
export const FIRST_PAGE_LIBRARIES = new Set(['react', 'react-dom', 'scheduler', 'zod']);

const packageOf = (id: string) =>
  /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(id.slice(id.lastIndexOf('/node_modules/')))?.[1];

/** The modules an entry loads before any lazy import: its static imports, all the way down. */
function eagerModules(meta: Rollup.ManualChunkMeta): Set<string> {
  const eager = new Set<string>();
  const queue = [...meta.getModuleIds()].filter((id) => meta.getModuleInfo(id)?.isEntry);
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (eager.has(id)) continue;
    eager.add(id);
    queue.push(...(meta.getModuleInfo(id)?.importedIds ?? []));
  }
  return eager;
}

/** A `manualChunks` for Rollup: `vendor` and `protocol`, for what the first page loads of them. */
export function eagerSharedChunks(): (id: string, meta: Rollup.ManualChunkMeta) => string | undefined {
  // Read once per build: the module graph is complete when chunks are assigned.
  let eager: { for: Rollup.ManualChunkMeta['getModuleInfo']; ids: Set<string> } | null = null;
  return (id, meta) => {
    const pkg = packageOf(id);
    const group = id.includes('/packages/protocol/')
      ? 'protocol'
      : pkg && FIRST_PAGE_LIBRARIES.has(pkg)
        ? 'vendor'
        : undefined;
    if (!group) return undefined;
    if (eager?.for !== meta.getModuleInfo) eager = { for: meta.getModuleInfo, ids: eagerModules(meta) };
    return eager.ids.has(id) ? group : undefined;
  };
}
