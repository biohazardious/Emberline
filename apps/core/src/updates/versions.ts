/** Version helpers for update checks: tolerant of a leading "v" and of prerelease suffixes. */

/** The numeric parts and the prerelease suffix of `1.2.3-rc.1`, or null when it is not a version. */
function parse(version: string): { parts: number[]; pre: string } | null {
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
  if (!match?.[1]) return null;
  return { parts: match[1].split('.').map(Number), pre: match[2] ?? '' };
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal or not comparable. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  const length = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < length; i++) {
    const diff = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // A release outranks its own prereleases (1.0.0 > 1.0.0-rc.1).
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export function isVersion(value: string | null | undefined): value is string {
  return typeof value === 'string' && parse(value) !== null;
}

/** `pkg`, `pkg@1.2.3`, `@scope/pkg@^1` -> name and the version part (if any). */
export function splitPackageSpec(spec: string): { name: string; version: string | null } {
  const at = spec.lastIndexOf('@');
  if (at > 0) return { name: spec.slice(0, at), version: spec.slice(at + 1) || null };
  return { name: spec, version: null };
}
