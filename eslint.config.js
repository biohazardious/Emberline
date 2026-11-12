import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Package layering (PROJECT.md §3): contracts sit at the bottom and import no workspace package,
 * and nothing imports an app except core, which reaches ptyd only through its client.
 * Each entry names the workspace imports a layer's production sources may NOT use.
 */
const WORKSPACE = [
  '@emberline/protocol',
  '@emberline/adapter-sdk',
  '@emberline/adapter-claude',
  '@emberline/hook',
  '@emberline/core',
  '@emberline/web',
  '@emberline/ptyd',
];
const allowOnly = (...allowed) => WORKSPACE.filter((name) => !allowed.includes(name));
const LAYERS = [
  { files: ['packages/protocol/src/**/*.ts'], forbidden: allowOnly() },
  { files: ['packages/adapter-sdk/src/**/*.ts'], forbidden: allowOnly() },
  {
    files: ['packages/adapter-claude/src/**/*.ts'],
    forbidden: allowOnly('@emberline/protocol', '@emberline/adapter-sdk'),
  },
  { files: ['packages/hook/src/**/*.ts'], forbidden: allowOnly('@emberline/protocol') },
  { files: ['apps/ptyd/src/**/*.ts'], forbidden: allowOnly('@emberline/protocol') },
  { files: ['apps/web/src/**/*.{ts,tsx}'], forbidden: allowOnly('@emberline/protocol'), browser: true },
  {
    files: ['apps/core/src/**/*.ts'],
    forbidden: ['@emberline/core', '@emberline/web', '@emberline/hook', '@emberline/ptyd/server'],
  },
];
const layerRules = LAYERS.map(({ files, forbidden, browser }) => ({
  files,
  ignores: ['**/*.test.{ts,tsx}', '**/test-*.ts', '**/test-setup.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: forbidden.flatMap((name) => [name, `${name}/*`]),
            message: 'Crosses a package layer boundary; see PROJECT.md §3.',
          },
          ...(browser
            ? [
                {
                  group: ['node:*'],
                  message: 'apps/web runs in the browser; Node built-ins are not available.',
                },
              ]
            : []),
        ],
      },
    ],
  },
}));

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'workspaces/**',
      '.wolf/**',
      '.claude/**',
      '.codex/**',
      '.opencode/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Type-aware rules for source files: unhandled promises crashed core before (B4).
    files: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  ...layerRules,
);
