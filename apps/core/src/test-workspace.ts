import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

/** The repository root (this file lives in apps/core/src). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const WorkspaceFile = z.object({ packages: z.array(z.string()).min(1) });

export interface WorkspacePackage {
  /** Repository-relative, forward slashes (`apps/core`). */
  readonly dir: string;
  /** The parsed package.json, unvalidated: each suite checks the fields it relies on. */
  readonly manifest: unknown;
}

/**
 * The workspace packages as pnpm sees them: the `packages` globs of pnpm-workspace.yaml, and of the
 * directories they match only those holding a package.json. A directory under apps/ or packages/
 * that is not a package (the `out/` tree `pnpm deploy --legacy` leaves in the Docker build, an
 * editor's scratch dir) is ignored instead of failing every suite that reads manifests. Only the
 * `dir/*` and literal-path forms are understood (plus `!` exclusions); any other glob throws, so a
 * widened pnpm-workspace.yaml is noticed here rather than silently matching nothing.
 */
export function workspacePackages(root: string = REPO_ROOT): WorkspacePackage[] {
  const { packages } = WorkspaceFile.parse(
    parse(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')),
  );
  const exclude = new Set(
    packages.filter((glob) => glob.startsWith('!')).map((glob) => normalise(glob.slice(1))),
  );
  const dirs = packages
    .filter((glob) => !glob.startsWith('!'))
    .flatMap((glob) => expand(root, normalise(glob)))
    .filter((dir) => !exclude.has(dir) && existsSync(path.join(root, dir, 'package.json')));
  return [...new Set(dirs)].sort().map((dir) => ({
    dir,
    manifest: JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8')) as unknown,
  }));
}

function normalise(glob: string): string {
  return glob.replace(/^\.\//, '').replace(/\/+$/, '');
}

function expand(root: string, glob: string): string[] {
  const parent = glob.endsWith('/*') ? glob.slice(0, -2) : null;
  const literal = parent ?? glob;
  if (/[*?[\]{}!]/.test(literal)) {
    throw new Error(`pnpm-workspace.yaml glob "${glob}" is not understood by test-workspace.ts`);
  }
  if (parent === null) return [glob];
  if (!existsSync(path.join(root, parent))) return [];
  return readdirSync(path.join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);
}
