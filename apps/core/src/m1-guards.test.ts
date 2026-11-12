import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface Manifest {
  name: string;
  license: string;
  dependencies?: Record<string, string>;
}

function manifests(): { dir: string; manifest: Manifest }[] {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(path.join(repoRoot, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = `${group}/${entry.name}`;
        const manifest = JSON.parse(
          readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8'),
        ) as Manifest;
        return { dir, manifest };
      }),
  );
}

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return /\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('AC-1.5 package manifests', () => {
  const all = manifests();

  it('finds the workspace packages', () => {
    expect(all.length).toBeGreaterThanOrEqual(9);
  });

  it('protocol depends on zod only and adapter-sdk on nothing', () => {
    const byName = new Map(all.map(({ manifest }) => [manifest.name, manifest]));
    expect(Object.keys(byName.get('@emberline/protocol')?.dependencies ?? {})).toEqual(['zod']);
    expect(Object.keys(byName.get('@emberline/adapter-sdk')?.dependencies ?? {})).toEqual([]);
  });

  it('licenses the contract packages Apache-2.0 and everything else AGPL-3.0-or-later', () => {
    const apache = new Set(['@emberline/protocol', '@emberline/adapter-sdk']);
    for (const { manifest } of all) {
      const expected = apache.has(manifest.name) ? 'Apache-2.0' : 'AGPL-3.0-or-later';
      expect(manifest.license, manifest.name).toBe(expected);
    }
  });
});

describe('AC-1.9 hermetic environment', () => {
  it.each([
    'DOCKER_HOST',
    'EMBERLINE_RUN_ID',
    'EMBERLINE_HOOK_TOKEN',
    'EMBERLINE_CORE_URL',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
  ])('does not expose %s', (name) => {
    expect(process.env[name]).toBeUndefined();
  });

  it.each(['EMBERLINE_RUNNER_HOME', 'EMBERLINE_TOOLS_DIR'])('points %s at an absent path', (name) => {
    const value = process.env[name];
    expect(value).toBeTruthy();
    expect(existsSync(value ?? '')).toBe(false);
  });
});

describe('AC-1.11 no skipped tests', () => {
  it('has no skipped or todo tests in any test file', () => {
    const forbidden = /\.skip\(|\bxit\(|\bxdescribe\(|\b(?:test|it)\.todo\(/;
    const offenders = ['apps', 'packages']
      .flatMap((group) => testFiles(path.join(repoRoot, group)))
      .filter((file) => forbidden.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(repoRoot, file));
    expect(offenders, `skipped tests in: ${offenders.join(', ')}`).toEqual([]);
  });
});
