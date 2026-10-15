import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Resolve workspace packages to source so tests never depend on a prior build.
    alias: [
      { find: /^@emberline\/protocol$/, replacement: r('./packages/protocol/src/index.ts') },
      { find: /^@emberline\/adapter-sdk$/, replacement: r('./packages/adapter-sdk/src/index.ts') },
      { find: /^@emberline\/adapter-claude$/, replacement: r('./packages/adapter-claude/src/index.ts') },
      { find: /^@emberline\/ptyd\/client$/, replacement: r('./apps/ptyd/src/client.ts') },
      { find: /^@emberline\/ptyd\/server$/, replacement: r('./apps/ptyd/src/server.ts') },
    ],
  },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    // apps/web only has DOM-free helper tests; components are checked in the browser.
    exclude: ['**/node_modules/**', '**/dist/**', 'workspaces/**'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 15_000,
    // Core runs workspace commands in the runner; unit tests run them in-process instead.
    setupFiles: [r('./apps/core/src/test-setup.ts')],
  },
});
