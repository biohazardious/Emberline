import type { Rollup } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { chunkSizeGuard, oversizedChunks } from './chunkSizeGuard';

const MONACO = '/workspace/node_modules/.pnpm/monaco-editor@0.52.2/node_modules/monaco-editor/esm/vs';
const chunk = (fileName: string, kb: number, moduleIds: string[]) =>
  ({ type: 'chunk', fileName, code: 'x'.repeat(kb * 1000), moduleIds }) as unknown as Rollup.OutputChunk;
const bundleOf = (...chunks: Rollup.OutputChunk[]) =>
  Object.fromEntries(chunks.map((c) => [c.fileName, c])) as Rollup.OutputBundle;

describe('chunkSizeGuard', () => {
  const bundle = bundleOf(
    chunk('assets/index.js', 501, ['/workspace/apps/web/src/main.tsx', '\0vite/preload-helper.js']),
    chunk('assets/vendor.js', 499, ['/workspace/node_modules/react-dom/index.js']),
    chunk('assets/editor.main.js', 3300, [`${MONACO}/editor/editor.main.js`, '\0vite/preload-helper.js']),
    // App code that ended up beside Monaco keeps the limit.
    chunk('assets/mixed.js', 900, [`${MONACO}/base/common/strings.js`, '/workspace/apps/web/src/monaco.ts']),
  );

  it('flags every chunk over 500 kB except one made of Monaco only', () => {
    expect(oversizedChunks(bundle)).toEqual([
      { fileName: 'assets/index.js', kb: 501 },
      { fileName: 'assets/mixed.js', kb: 900 },
    ]);
  });

  it('warns in the build for each of them', () => {
    const warn = vi.fn();
    const plugin = chunkSizeGuard();
    const hook = plugin.generateBundle as (this: unknown, o: unknown, b: Rollup.OutputBundle) => void;
    hook.call({ warn }, {}, bundle);
    expect(warn.mock.calls.map(([message]) => message as string)).toEqual([
      'assets/index.js is 501.00 kB after minification, over the 500 kB limit: load it lazily or give its libraries a chunk of their own (manualChunks).',
      'assets/mixed.js is 900.00 kB after minification, over the 500 kB limit: load it lazily or give its libraries a chunk of their own (manualChunks).',
    ]);
  });
});
