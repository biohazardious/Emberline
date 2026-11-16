import type { FactorySettings, GarbageCollectRunsResponse, Project, Run } from '@emberline/protocol';
import type { QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { keptWorktreesSummary } from '../../gcSummary';
import { inActiveScope } from '../../projectPaths';
import { toastError, toastInfo } from '../../toast';

const THEME_STORAGE_KEY = 'emberline.theme';

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value !== null) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // ignore storage errors
  }
}

export function useShellTheme(
  factorySettings: FactorySettings | undefined,
  queryClient: QueryClient,
): [theme: 'dark' | 'light', applyTheme: (next: 'dark' | 'light') => void] {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = readStorage(THEME_STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'dark';
  });
  const serverTheme = useRef<'dark' | 'light' | undefined>(undefined);

  const applyTheme = useCallback(
    (next: 'dark' | 'light') => {
      setTheme(next);
      serverTheme.current = next;
      document.documentElement.dataset.theme = next;
      writeStorage(THEME_STORAGE_KEY, next);
      api<FactorySettings>('/api/factory/settings', 'PATCH', { theme: next })
        .then((saved) => queryClient.setQueryData(['api', '/api/factory/settings'], saved))
        .catch((e: unknown) => toastError(`Could not save the theme: ${errorMessage(e)}`));
    },
    [queryClient],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const remote = factorySettings?.theme;
    if ((remote !== 'light' && remote !== 'dark') || remote === serverTheme.current) return;
    serverTheme.current = remote;
    setTheme(remote);
    writeStorage(THEME_STORAGE_KEY, remote);
  }, [factorySettings]);

  return [theme, applyTheme];
}

export function useScopedActiveRuns(
  runs: Run[] | undefined,
  projectsLoaded: boolean,
  activeProjectId: string | null | undefined,
): Run[] {
  return useMemo(() => {
    const list = (runs ?? []).filter(
      (r) =>
        !r.endedAt &&
        r.state !== 'done' &&
        r.state !== 'failed' &&
        inActiveScope(projectsLoaded ? activeProjectId : undefined, r.projectId),
    );
    const rank = (s: string) => (s === 'waiting_input' ? 0 : s === 'working' || s === 'starting' ? 1 : 2);
    return list.sort((a, b) => rank(a.state) - rank(b.state));
  }, [runs, projectsLoaded, activeProjectId]);
}

export async function cleanupProjectWorktrees(activeProject: Project | undefined): Promise<void> {
  if (!activeProject) return;
  try {
    const res = await api<GarbageCollectRunsResponse>(
      `/api/projects/${activeProject.id}/cleanup-worktrees`,
      'POST',
    );
    const kept = keptWorktreesSummary(res);
    if (kept && res.prunedWorktrees === 0) toastInfo(kept);
    else toastInfo(kept ? `Finished worktrees cleaned up. ${kept}` : 'Finished worktrees cleaned up.');
  } catch (e) {
    toastError(`Cleanup failed: ${errorMessage(e)}`);
  }
}

export function useShellShortcuts({
  mobileNavOpen,
  setMobileNavOpen,
  setCmdOpen,
  onOpenNextAttention,
  location,
}: {
  mobileNavOpen: boolean;
  setMobileNavOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  setCmdOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  onOpenNextAttention: () => void;
  location: string;
}): void {
  const nextRef = useRef(onOpenNextAttention);
  nextRef.current = onOpenNextAttention;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((open) => !open);
      } else if (e.altKey && e.code === 'KeyN') {
        e.preventDefault();
        nextRef.current();
      } else if (e.key === 'Escape' && mobileNavOpen) {
        setMobileNavOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileNavOpen, setCmdOpen, setMobileNavOpen]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location, setMobileNavOpen]);
}
