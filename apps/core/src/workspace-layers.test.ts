import path from 'node:path';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { REPO_ROOT as ROOT, workspacePackages } from './test-workspace.js';

// PROJECT.md §3.2 / AC-1.3, AC-1.4: the layering is enforced by `eslint.config.js`, and this
// suite lints probe sources against that real config so a loosened rule fails the test gate.
const LAYER_MESSAGE = 'Crosses a package layer boundary; see PROJECT.md §3.';
const BROWSER_MESSAGE = 'apps/web runs in the browser; Node built-ins are not available.';

const Manifest = z.object({ name: z.string() });

/** The workspace imports each layer's production sources may use (PROJECT.md §3.2). */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'packages/protocol': [],
  'packages/adapter-sdk': [],
  'packages/adapter-claude': ['@emberline/protocol', '@emberline/adapter-sdk'],
  'packages/adapter-codex': ['@emberline/adapter-sdk'],
  'packages/adapter-gemini': ['@emberline/adapter-sdk'],
  'packages/hook': ['@emberline/protocol'],
  'apps/ptyd': ['@emberline/protocol'],
  'apps/web': ['@emberline/protocol'],
  'apps/core': [
    '@emberline/protocol',
    '@emberline/adapter-sdk',
    '@emberline/adapter-claude',
    '@emberline/adapter-codex',
    '@emberline/adapter-gemini',
    '@emberline/ptyd',
  ],
};

const PACKAGES = workspacePackages().map(({ dir, manifest }) => ({
  dir,
  name: Manifest.parse(manifest).name,
}));

let eslint: ESLint;

beforeAll(() => {
  // Probe files do not exist on disk, so the type-aware parser and rules are switched off; every
  // other rule, including the layer rules under test, comes from the repository's config.
  eslint = new ESLint({
    cwd: ROOT,
    overrideConfig: {
      languageOptions: { parserOptions: { projectService: false } },
      rules: {
        '@typescript-eslint/no-floating-promises': 'off',
        '@typescript-eslint/no-misused-promises': 'off',
        '@typescript-eslint/await-thenable': 'off',
      },
    },
  });
});

async function restrictedImportMessages(filePath: string, source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: path.join(ROOT, filePath) });
  if (!result) throw new Error(`ESLint returned no result for ${filePath}`);
  const fatal = result.messages.find((message) => message.fatal === true);
  if (fatal) throw new Error(`${filePath} did not parse: ${fatal.message}`);
  return result.messages
    .filter((message) => message.ruleId === 'no-restricted-imports')
    .map((message) => message.message);
}

const valueImport = (specifier: string) => `import * as probe from '${specifier}';\nexport { probe };\n`;
const typeImport = (specifier: string) =>
  `import type { Probe } from '${specifier}';\nexport type P = Probe;\n`;

describe('workspace package layering (eslint.config.js LAYERS)', () => {
  it('every package directory has a layer in this matrix', () => {
    expect(PACKAGES.map((pkg) => pkg.dir).sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it('every workspace package is guarded: a protocol import of any of them crosses a layer', async () => {
    for (const { name } of PACKAGES) {
      const messages = await restrictedImportMessages('packages/protocol/src/probe.ts', valueImport(name));
      expect(messages, `${name} is missing from WORKSPACE in eslint.config.js`).toEqual([
        expect.stringContaining(LAYER_MESSAGE),
      ]);
    }
  });

  for (const layer of Object.keys(ALLOWED)) {
    const allowed = ALLOWED[layer] ?? [];
    describe(layer, () => {
      it('may import exactly its allowed packages, by value, by type and by sub-path', async () => {
        for (const { name } of PACKAGES) {
          const crossing = !allowed.includes(name);
          for (const source of [valueImport(name), typeImport(name), valueImport(`${name}/sub`)]) {
            const messages = await restrictedImportMessages(`${layer}/src/probe.ts`, source);
            expect(messages, `${layer} → ${source.split('\n')[0] ?? ''}`).toEqual(
              crossing ? [expect.stringContaining(LAYER_MESSAGE)] : [],
            );
          }
        }
      });

      it('exempts tests and test helpers', async () => {
        const forbidden = PACKAGES.find(({ name }) => !allowed.includes(name));
        if (!forbidden) throw new Error(`${layer} has no forbidden import to probe`);
        for (const file of ['src/probe.test.ts', 'src/test-probe.ts', 'src/test-setup.ts']) {
          expect(await restrictedImportMessages(`${layer}/${file}`, valueImport(forbidden.name))).toEqual([]);
        }
      });
    });
  }

  it('core reaches ptyd through its client only', async () => {
    expect(
      await restrictedImportMessages('apps/core/src/probe.ts', valueImport('@emberline/ptyd/client')),
    ).toEqual([]);
    expect(
      await restrictedImportMessages('apps/core/src/probe.ts', valueImport('@emberline/ptyd/server')),
    ).toEqual([expect.stringContaining(LAYER_MESSAGE)]);
  });

  it('apps/web may not import Node built-ins, in .ts or .tsx', async () => {
    for (const file of ['src/probe.ts', 'src/probe.tsx']) {
      expect(await restrictedImportMessages(`apps/web/${file}`, valueImport('node:fs'))).toEqual([
        expect.stringContaining(BROWSER_MESSAGE),
      ]);
    }
    expect(await restrictedImportMessages('apps/web/src/probe.test.ts', valueImport('node:fs'))).toEqual([]);
  });

  it('server-side packages may use Node built-ins', async () => {
    expect(await restrictedImportMessages('apps/core/src/probe.ts', valueImport('node:fs'))).toEqual([]);
  });
});
