import { type ReactNode, useState } from 'react';

/**
 * A page scoped to the active project mounts once that project is known: while it is still being
 * resolved (`scope` undefined) the page waits here, so it neither shows nor polls every project.
 * Once mounted, it stays mounted with the last known scope while the active project is resolved
 * again (the active project was deleted, the project list loaded after it failed), so what the
 * person entered on it is kept.
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
  const [held, setHeld] = useState(scope);
  if (scope !== undefined && scope !== held) setHeld(scope);
  const shown = scope === undefined ? held : scope;
  if (shown === undefined) return <div className={pendingClassName} aria-busy="true" />;
  return <>{children(shown)}</>;
}
