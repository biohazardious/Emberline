import { Fragment, type ReactNode, useState } from 'react';

/**
 * A page scoped to the active project mounts once that project is known: while it is still being
 * resolved (`scope` undefined) the page waits here, so it neither shows nor polls every project.
 * - While the active project is resolved again, it stays mounted with the scope it had, so what
 *   the person entered on it is kept, unless that project is gone from `projectIds` (deleted): then
 *   it waits again and never asks for that project.
 * - Another scope is another page: it starts afresh, so nothing typed for one project is left on
 *   another's.
 */
export function ScopedPage({
  scope,
  projectIds,
  pendingClassName,
  children,
}: {
  scope: string | null | undefined;
  /** The projects as last read; undefined while they could not be read. */
  projectIds: readonly string[] | undefined;
  pendingClassName: string;
  children: (activeProjectId: string | null) => ReactNode;
}) {
  const [held, setHeld] = useState(scope);
  if (scope !== undefined && scope !== held) setHeld(scope);
  const stillThere = held === null || (held !== undefined && projectIds?.includes(held) === true);
  const shown = scope !== undefined ? scope : stillThere ? held : undefined;
  if (shown === undefined) return <div className={pendingClassName} aria-busy="true" />;
  return <Fragment key={shown ?? ''}>{children(shown)}</Fragment>;
}
