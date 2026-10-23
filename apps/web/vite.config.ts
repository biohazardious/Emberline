import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { chunkSizeGuard } from './src/build/chunkSizeGuard';
import { eagerSharedChunks } from './src/build/eagerChunks';

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
        // What the first page loads of the shared libraries and the protocol schemas, in chunks of
        // their own beside the app's; what only lazy pages import stays with them.
        manualChunks: eagerSharedChunks(),
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
