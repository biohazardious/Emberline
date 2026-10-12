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
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/web/**'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 15_000,
  },
});
