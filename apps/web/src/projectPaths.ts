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

/** How long pages wait for the server's stored choice before the local fallback (as when it fails). */
export const SERVER_CHOICE_WAIT_MS = 5_000;

/** The active project from the URL, this browser, and the server's choice; `remember` is false for a fallback after a failed server read. */
export function resolveActiveProject(
  projectIds: readonly string[],
  c: {
    fromUrl: string | null;
    stored: string | null;
    server: string | null | undefined;
    serverFailed: boolean;
  },
): { id: string | null | undefined; remember: boolean } {
  if (c.serverFailed && c.server === undefined) {
    const local = resolveActiveProjectId(projectIds, { ...c, server: null });
    return { id: local, remember: local === c.fromUrl || local === c.stored };
  }
  return { id: resolveActiveProjectId(projectIds, c), remember: true };
}

/** Whether a run of `projectId` belongs in the active project's views: none while pending, all without projects. */
export function inActiveScope(activeId: string | null | undefined, projectId: string): boolean {
  return activeId === undefined ? false : activeId === null || projectId === activeId;
}

/**
 * The scope a project-scoped page gets: the active project's id, null for all projects (there are
 * none, or the list could not be loaded), undefined while the active project is still being resolved.
 */
export function pageScope(
  resolvedId: string | null | undefined,
  projectsLoadFailed: boolean,
): string | null | undefined {
  return resolvedId === undefined && projectsLoadFailed ? null : resolvedId;
}
