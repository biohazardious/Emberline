import type { ReactNode } from 'react';

/**
 * A page scoped to the active project mounts once that project is known: while it is still being
 * resolved (`scope` undefined) the page waits here, so it neither shows nor polls every project.
 */
export function ScopedPage({
  scope,
  pendingClassName,
  children,
}: {
  scope: string | null | undefined;
  pendingClassName: string;
  children: (activeProjectId: string | null) => ReactNode;
}) {
  if (scope === undefined) return <div className={pendingClassName} aria-busy="true" />;
  return <>{children(scope)}</>;
}
