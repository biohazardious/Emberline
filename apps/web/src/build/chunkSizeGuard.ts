/**
 * Build only (vite.config.ts): the 500 kB warning for every chunk but Monaco's editor. Monaco is one
 * module graph of about 3 MB, loaded only when an editor opens; its modules import each other in
 * cycles, so it cannot be split below the limit. Every other chunk keeps the limit.
 */
import type { Plugin, Rollup } from 'vite';

/** kB (1000 bytes) of minified code, the size Vite prints for each chunk. */
export const CHUNK_SIZE_LIMIT_KB = 500;

export const isMonacoModule = (id: string) => id.includes('/node_modules/monaco-editor/');

/** The chunks of `bundle` over `limitKb`, apart from those made of Monaco's modules only. */
export function oversizedChunks(
  bundle: Rollup.OutputBundle,
  limitKb = CHUNK_SIZE_LIMIT_KB,
): { fileName: string; kb: number }[] {
  const found: { fileName: string; kb: number }[] = [];
  for (const file of Object.values(bundle)) {
    if (file.type !== 'chunk') continue;
    const kb = Buffer.byteLength(file.code) / 1000;
    if (kb <= limitKb) continue;
    // Virtual modules (`\0vite/preload-helper`) come with any chunk; the rest must all be Monaco's.
    const modules = file.moduleIds.filter((id) => !id.startsWith('\0'));
    if (modules.length > 0 && modules.every(isMonacoModule)) continue;
    found.push({ fileName: file.fileName, kb });
  }
  return found;
}

export function chunkSizeGuard(limitKb = CHUNK_SIZE_LIMIT_KB): Plugin {
  return {
    name: 'emberline:chunk-size-guard',
    apply: 'build',
    // After Vite's own generateBundle work (preload rewrites): sizes within 1 kB of what Vite prints.
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const { fileName, kb } of oversizedChunks(bundle, limitKb)) {
        this.warn(
          `${fileName} is ${kb.toFixed(2)} kB after minification, over the ${limitKb} kB limit: load it lazily or give its libraries a chunk of their own (manualChunks).`,
        );
      }
    },
  };
}
