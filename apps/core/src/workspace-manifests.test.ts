import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// PROJECT.md §6 M1 guards that are not lint rules: package manifests (AC-1.5), the ban on
// skipped tests (AC-1.11) and the hermetic test environment from test-setup.ts (AC-1.9).
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const Manifest = z.object({
  name: z.string(),
  license: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
});
type Manifest = z.infer<typeof Manifest>;

function packageDirs(): string[] {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(path.join(ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}`),
  );
}

function manifest(dir: string): Manifest {
  return Manifest.parse(JSON.parse(readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8')));
}

function testFiles(dir: string): string[] {
  const src = path.join(dir, 'src');
  return readdirSync(path.join(ROOT, src), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.test\.tsx?$/.test(file))
    .map((file) => path.join(src, file));
}

const APACHE_PACKAGES = ['packages/protocol', 'packages/adapter-sdk'];

describe('package manifests (AC-1.5)', () => {
  it('protocol depends on zod only', () => {
    expect(Object.keys(manifest('packages/protocol').dependencies ?? {})).toEqual(['zod']);
  });

  it('adapter-sdk depends on nothing', () => {
    expect(manifest('packages/adapter-sdk').dependencies ?? {}).toEqual({});
  });

  it('protocol and adapter-sdk are Apache-2.0, every other package AGPL-3.0-or-later', () => {
    for (const dir of packageDirs()) {
      const expected = APACHE_PACKAGES.includes(dir) ? 'Apache-2.0' : 'AGPL-3.0-or-later';
      expect(manifest(dir).license, dir).toBe(expected);
    }
  });

  it('the workspace root is AGPL-3.0-or-later', () => {
    expect(manifest('.').license).toBe('AGPL-3.0-or-later');
  });
});

describe('no skipped tests (AC-1.11)', () => {
  // `skipIf`/`runIf` stay allowed: they skip only when a host capability is absent.
  const BANNED = [/\.skip\(/, /\.todo\(/, /\bxit\(/, /\bxdescribe\(/, /\.only\(/];

  it('no test file skips, defers or focuses a test unconditionally', () => {
    const offenders = packageDirs()
      .flatMap(testFiles)
      .flatMap((file) =>
        readFileSync(path.join(ROOT, file), 'utf8')
          .split('\n')
          .flatMap((line, index) =>
            BANNED.some((pattern) => pattern.test(line)) ? [`${file}:${index + 1}: ${line.trim()}`] : [],
          ),
      );
    expect(offenders).toEqual([]);
  });
});

describe('hermetic test environment (AC-1.9)', () => {
  it("strips the host runner's Docker engine, run identity and provider keys", () => {
    for (const name of [
      'DOCKER_HOST',
      'DOCKER_TLS_VERIFY',
      'DOCKER_CERT_PATH',
      'DOCKER_CONTEXT',
      'EMBERLINE_COMPOSE_PROJECT',
      'EMBERLINE_RUN_ID',
      'EMBERLINE_HOOK_TOKEN',
      'EMBERLINE_CORE_URL',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
    ]) {
      expect(process.env[name], name).toBeUndefined();
    }
  });

  it('points the runner home and tools volume at paths that do not exist', () => {
    for (const name of ['EMBERLINE_RUNNER_HOME', 'EMBERLINE_TOOLS_DIR']) {
      const value = process.env[name];
      expect(value, name).toMatch(/emberline-test-absent-\d+/);
      expect(() => readdirSync(value ?? '')).toThrow(/ENOENT/);
    }
  });
});
