/** `/projects/<id>` plus the rest of the path, without query or hash. */
const PROJECT_PATH = /^\/projects\/([^/?#]+)(\/[^?#]*)?/;

export function projectIdFromPath(path: string): string | null {
  return PROJECT_PATH.exec(path)?.[1] ?? null;
}

export function switchProjectPath(path: string, targetId: string): string | null {
  const match = PROJECT_PATH.exec(path);
  if (!match) return null;
  return `/projects/${encodeURIComponent(targetId)}${match[2] ?? ''}`;
}

export function resolveActiveProjectId(
  projectIds: readonly string[],
  candidates: { fromUrl: string | null; stored: string | null; server: string | null | undefined },
): string | null | undefined {
  if (projectIds.length === 0) return null;
  const known = (id: string | null | undefined): id is string => Boolean(id) && projectIds.includes(id!);
  if (known(candidates.fromUrl)) return candidates.fromUrl;
  if (known(candidates.stored)) return candidates.stored;
  if (candidates.server === undefined) return undefined;
  return known(candidates.server) ? candidates.server : projectIds[0]!;
}
