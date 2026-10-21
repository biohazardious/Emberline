import { useCallback, useState } from 'react';
import { readAllProjects, type ScopedView, writeAllProjects } from '../projectScope';

/** The view's "All projects" toggle, remembered in this browser. */
export function useAllProjects(view: ScopedView): [boolean, (on: boolean) => void] {
  const [all, setAll] = useState(() => readAllProjects(view));
  const set = useCallback(
    (on: boolean) => {
      setAll(on);
      writeAllProjects(view, on);
    },
    [view],
  );
  return [all, set];
}
