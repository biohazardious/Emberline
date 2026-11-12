// Which dependencies may run install scripts. pnpm 10 runs none unless allowed; this gate keeps the
// allowed set from growing unnoticed and makes every other package with a build script a reviewed decision.

/** Packages whose install scripts run: native addons core and ptyd need, and esbuild's binary. */
export const ALLOWED_BUILDS: readonly string[] = ['better-sqlite3', 'esbuild', 'node-pty'];

/**
 * Packages with install scripts that were reviewed and must stay unbuilt. ssh2 only builds an optional
 * crypto binding and cpu-features is its optional helper; both work without it (pure-JS fallback).
 */
export const REVIEWED_IGNORED_BUILDS: readonly string[] = ['cpu-features', 'ssh2'];

/**
 * Settings that would let build scripts run outside `pnpm.onlyBuiltDependencies`, in any spelling pnpm
 * reads: camelCase or kebab-case (`-` or `_`), a quoted key, and the .npmrc list form
 * (`only-built-dependencies[]=pkg`).
 */
const BYPASS_SETTINGS = [
  /^\s*["']?(dangerously[-_]?allow[-_]?all[-_]?builds|only[-_]?built[-_]?dependencies([-_]?file)?|never[-_]?built[-_]?dependencies)["']?\s*(\[\s*\])?\s*[:=]/im,
  /^\s*["']?strict[-_]?dep[-_]?builds["']?\s*[:=]\s*["']?false/im,
];

export interface PnpmBuildConfig {
  onlyBuiltDependencies: string[];
  ignoredBuiltDependencies: string[];
}

function stringList(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error(`package.json: pnpm.${key} must be an array of package names`);
  }
  return value;
}

export function readBuildConfig(packageJson: string): PnpmBuildConfig {
  const manifest: unknown = JSON.parse(packageJson);
  const pnpm =
    typeof manifest === 'object' && manifest !== null && 'pnpm' in manifest ? manifest.pnpm : undefined;
  const settings: Record<string, unknown> = typeof pnpm === 'object' && pnpm !== null ? { ...pnpm } : {};
  if (settings.neverBuiltDependencies !== undefined || settings.onlyBuiltDependenciesFile !== undefined) {
    throw new Error(
      'package.json: use pnpm.onlyBuiltDependencies only (no neverBuilt/onlyBuiltDependenciesFile)',
    );
  }
  return {
    onlyBuiltDependencies: stringList(settings.onlyBuiltDependencies, 'onlyBuiltDependencies'),
    ignoredBuiltDependencies: stringList(settings.ignoredBuiltDependencies, 'ignoredBuiltDependencies'),
  };
}

/**
 * The packages `pnpm ignored-builds` lists under "Automatically ignored builds": they have an install
 * script nobody reviewed. Output without that heading throws, so a changed format fails closed.
 */
export function parseIgnoredBuilds(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => /^Automatically ignored builds/i.test(line.trim()));
  if (start === -1) throw new Error('pnpm ignored-builds: unrecognised output');
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    const name = line.trim();
    if (name !== 'None') names.push(name);
  }
  return names;
}

/** Problems with the build-script policy; empty when it holds. */
export function evaluateBuilds(
  config: PnpmBuildConfig,
  unreviewed: string[],
  otherConfigFiles: { path: string; text: string }[],
): string[] {
  const problems: string[] = [];
  for (const name of config.onlyBuiltDependencies.filter((name) => !ALLOWED_BUILDS.includes(name))) {
    problems.push(
      `pnpm.onlyBuiltDependencies adds "${name}": only ${ALLOWED_BUILDS.join(', ')} may run install scripts`,
    );
  }
  for (const name of config.ignoredBuiltDependencies.filter(
    (name) => !REVIEWED_IGNORED_BUILDS.includes(name),
  )) {
    problems.push(
      `pnpm.ignoredBuiltDependencies adds "${name}": a new package with an install script needs a review`,
    );
  }
  for (const name of unreviewed) {
    problems.push(`"${name}" has an install script that is neither allowed nor reviewed`);
  }
  for (const { path, text } of otherConfigFiles) {
    const setting = BYPASS_SETTINGS.find((pattern) => pattern.test(text));
    if (setting)
      problems.push(`${path} sets ${setting.source}: build-script policy lives in package.json only`);
  }
  return problems;
}
