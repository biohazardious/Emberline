import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { chunkSizeGuard } from './src/build/chunkSizeGuard';

/** npm packages the app's own chunk loads on every page. */
const SHARED_LIBRARIES = new Set([
  'react',
  'react-dom',
  'scheduler',
  '@tanstack/react-query',
  '@tanstack/query-core',
  'wouter',
  'regexparam',
  'use-sync-external-store',
  'lucide-react',
  'zod',
]);

export default defineConfig({
  plugins: [react(), chunkSizeGuard()],
  resolve: {
    conditions: ['@emberline/source', 'module', 'browser', 'development|production'],
  },
  build: {
    // Vite's own warning only above Monaco's editor chunk (about 3.3 MB, loaded lazily); every other
    // chunk keeps the 500 kB limit through chunkSizeGuard.
    chunkSizeWarningLimit: 4_000,
    rollupOptions: {
      // A dependency's comment Rollup cannot place (zod's `@__PURE__` notes) is dropped either way:
      // not worth a notice in every build. Any other warning, and any in our own code, still shows.
      onwarn(warning, warn) {
        if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('/node_modules/')) return;
        warn(warning);
      },
      output: {
        // The libraries every page loads, and the protocol schemas, in chunks of their own beside
        // the app's: none of them grows the app's chunk. Those only lazy pages use (xterm, Monaco)
        // stay with those pages.
        manualChunks(id) {
          if (id.includes('/packages/protocol/')) return 'protocol';
          const pkg = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(
            id.slice(id.lastIndexOf('/node_modules/')),
          )?.[1];
          return pkg && SHARED_LIBRARIES.has(pkg) ? 'vendor' : undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // In compose.dev.yaml this is http://core:7420.
      '/api': { target: process.env.EMBERLINE_CORE_URL ?? 'http://127.0.0.1:7420', ws: true },
    },
  },
});
