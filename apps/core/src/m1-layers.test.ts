import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// Probe files do not exist on disk, so the type-aware parser and rules are switched off; the layer rules are untouched.
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfig: [
    {
      languageOptions: { parserOptions: { projectService: false } },
      rules: {
        '@typescript-eslint/no-floating-promises': 'off',
        '@typescript-eslint/no-misused-promises': 'off',
        '@typescript-eslint/await-thenable': 'off',
      },
    },
  ],
});
const LAYER_MESSAGE = 'Crosses a package layer boundary';

async function lint(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, filePath) });
  return result?.messages ?? [];
}

async function importErrors(filePath: string, code: string): Promise<string[]> {
  const messages = await lint(filePath, code);
  return messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}

function workspaceDirs(): { dir: string; name: string }[] {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(path.join(repoRoot, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = `${group}/${entry.name}`;
        const manifest = JSON.parse(readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8')) as {
          name: string;
        };
        return { dir, name: manifest.name };
      }),
  );
}

describe('AC-1.3 package layer boundaries', () => {
  it('rejects a value import of core from protocol', async () => {
    const errors = await importErrors(
      'packages/protocol/src/x.ts',
      "import { x } from '@emberline/core';\nexport { x };\n",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(LAYER_MESSAGE);
  });

  it('rejects a type-only import across a layer', async () => {
    const errors = await importErrors(
      'packages/protocol/src/x.ts',
      "import type { x } from '@emberline/core';\nexport type X = typeof x;\n",
    );
    expect(errors.join()).toContain(LAYER_MESSAGE);
  });

  it('rejects a sub-path import across a layer', async () => {
    const errors = await importErrors(
      'packages/protocol/src/x.ts',
      "import { x } from '@emberline/core/foo';\nexport { x };\n",
    );
    expect(errors.join()).toContain(LAYER_MESSAGE);
  });

  it('allows hook to import protocol but not adapter-sdk', async () => {
    expect(
      await importErrors(
        'packages/hook/src/x.ts',
        "import { x } from '@emberline/protocol';\nexport { x };\n",
      ),
    ).toEqual([]);
    const errors = await importErrors(
      'packages/hook/src/x.ts',
      "import { x } from '@emberline/adapter-sdk';\nexport { x };\n",
    );
    expect(errors.join()).toContain(LAYER_MESSAGE);
  });

  it('lets core reach ptyd only through its client', async () => {
    const server = await importErrors(
      'apps/core/src/x.ts',
      "import { x } from '@emberline/ptyd/server';\nexport { x };\n",
    );
    expect(server.join()).toContain(LAYER_MESSAGE);
    expect(
      await importErrors(
        'apps/core/src/x.ts',
        "import { x } from '@emberline/ptyd/client';\nexport { x };\n",
      ),
    ).toEqual([]);
  });

  it('exempts test files from the layer rules', async () => {
    expect(
      await importErrors(
        'packages/protocol/src/x.test.ts',
        "import { x } from '@emberline/core';\nexport { x };\n",
      ),
    ).toEqual([]);
  });

  it('gives every workspace package a layer entry', async () => {
    const unguarded: string[] = [];
    for (const { dir, name } of workspaceDirs()) {
      const errors = await importErrors(
        `${dir}/src/x.ts`,
        "import { x } from '@emberline/core';\nexport { x };\n",
      );
      const guarded = errors.some((message) => message.includes(LAYER_MESSAGE));
      if (!guarded) unguarded.push(name);
    }
    expect(unguarded, `missing LAYERS entry in eslint.config.js for: ${unguarded.join(', ')}`).toEqual([]);
  });
});

describe('AC-1.4 apps/web runs in the browser', () => {
  it('rejects node: built-ins in apps/web/src', async () => {
    const errors = await importErrors(
      'apps/web/src/x.ts',
      "import { readFileSync } from 'node:fs';\nexport { readFileSync };\n",
    );
    expect(errors.join()).toContain('Node built-ins are not available');
  });

  it('allows node: built-ins elsewhere', async () => {
    expect(
      await importErrors(
        'apps/core/src/x.ts',
        "import { readFileSync } from 'node:fs';\nexport { readFileSync };\n",
      ),
    ).toEqual([]);
  });

  it('exempts web test files', async () => {
    expect(
      await importErrors(
        'apps/web/src/x.test.ts',
        "import { readFileSync } from 'node:fs';\nexport { readFileSync };\n",
      ),
    ).toEqual([]);
  });
});
