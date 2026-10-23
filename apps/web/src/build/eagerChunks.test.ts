import type { Rollup } from 'vite';
import { describe, expect, it } from 'vitest';
import { eagerSharedChunks } from './eagerChunks';

const NM = '/w/node_modules/.pnpm/x/node_modules';
/**
 * entry → app → react, an icon, react-query, a protocol schema; app ⇢ (lazy) settings → another
 * icon, zod, a schema.
 */
const graph: Record<string, { isEntry?: boolean; importedIds: string[] }> = {
  '/w/src/main.tsx': { isEntry: true, importedIds: ['/w/src/App.tsx'] },
  '/w/src/App.tsx': {
    importedIds: [
      `${NM}/react/index.js`,
      `${NM}/lucide-react/icons/house.js`,
      `${NM}/@tanstack/react-query/index.js`,
      '/w/packages/protocol/src/run.ts',
    ],
  },
  '/w/src/pages/SettingsPage.tsx': {
    importedIds: [
      `${NM}/lucide-react/icons/cog.js`,
      `${NM}/zod/index.js`,
      '/w/packages/protocol/src/settings.ts',
    ],
  },
  [`${NM}/react/index.js`]: { importedIds: [] },
  [`${NM}/lucide-react/icons/house.js`]: { importedIds: [] },
  [`${NM}/@tanstack/react-query/index.js`]: { importedIds: [] },
  [`${NM}/lucide-react/icons/cog.js`]: { importedIds: [] },
  [`${NM}/zod/index.js`]: { importedIds: [] },
  '/w/packages/protocol/src/run.ts': { importedIds: [] },
  '/w/packages/protocol/src/settings.ts': { importedIds: [] },
};
const meta = {
  getModuleIds: () => Object.keys(graph)[Symbol.iterator](),
  getModuleInfo: (id: string) => {
    const m = graph[id];
    return m ? { isEntry: m.isEntry ?? false, importedIds: m.importedIds } : null;
  },
} as unknown as Rollup.ManualChunkMeta;

describe('eagerSharedChunks', () => {
  it('groups only what the first page loads of its libraries; what lazy pages alone import stays with them', () => {
    const chunkOf = eagerSharedChunks();
    expect(
      Object.fromEntries(Object.keys(graph).map((id) => [id.replace(NM, ''), chunkOf(id, meta) ?? null])),
    ).toEqual({
      '/w/src/main.tsx': null,
      '/w/src/App.tsx': null,
      '/w/src/pages/SettingsPage.tsx': null,
      '/react/index.js': 'vendor',
      // Per-feature modules behind one entry: left to Rollup even when the first page uses them.
      '/lucide-react/icons/house.js': null,
      '/@tanstack/react-query/index.js': null,
      '/lucide-react/icons/cog.js': null,
      '/zod/index.js': null,
      '/w/packages/protocol/src/run.ts': 'protocol',
      '/w/packages/protocol/src/settings.ts': null,
    });
  });
});
