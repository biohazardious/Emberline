import type { GitPageStatus } from '@emberline/protocol';
import { GitBranch } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { SectionState } from '../components/SectionState';
import { GitBranchesTab } from '../components/git/GitBranchesTab';
import { GitCommitsTab } from '../components/git/GitCommitsTab';
import { GitReleaseTab } from '../components/git/GitReleaseTab';
import { GitStatusStrip } from '../components/git/GitStatusStrip';
import { PageHeader } from '../components/ui/PageHeader';
import { GIT_TABS, type GitTab, gitRefetchMs, tabFromHash } from '../gitPage';
import '../git-page.css';

const TAB_LABEL: Record<GitTab, string> = { commits: 'Commits', branches: 'Branches', release: 'Release' };

/** The tab named by the URL hash; changing it rewrites the hash without adding history entries. */
function useHashTab(): [GitTab, (tab: GitTab) => void] {
  const [tab, setTab] = useState<GitTab>(() => tabFromHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setTab(tabFromHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const select = useCallback((next: GitTab) => {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${next}`);
    setTab(next);
  }, []);
  return [tab, select];
}

export function GitPage({ projectId }: { projectId: string }) {
  const [tab, setTab] = useHashTab();
  const tabListRef = useRef<HTMLDivElement>(null);
  const status = useQuery({
    queryKey: ['git', projectId],
    queryFn: () => api<GitPageStatus>(`/api/projects/${projectId}/git`),
    refetchInterval: (q) => gitRefetchMs(q.state.data),
  });
  const data = status.data;

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentIndex = GIT_TABS.indexOf(tab);
    let nextIndex = -1;
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % GIT_TABS.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + GIT_TABS.length) % GIT_TABS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = GIT_TABS.length - 1;
    }
    if (nextIndex < 0) return;
    event.preventDefault();
    const nextTab = GIT_TABS[nextIndex]!;
    setTab(nextTab);
    const tabs = tabListRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[nextIndex]?.focus();
  };

  return (
    <div className="board-page git-page">
      <PageHeader title="Git" icon={<GitBranch className="icon" aria-hidden="true" />} />
      {data === undefined ? (
        <SectionState
          loading={status.isPending}
          error={status.error ?? undefined}
          onRetry={() => void status.refetch()}
          loadingText="Reading the repository…"
          errorPrefix="Could not load the Git status"
        />
      ) : (
        <>
          <GitStatusStrip projectId={projectId} status={data} onOpenRelease={() => setTab('release')} />
          {data.isGitRepo && (
            <div className="wizard-tabs">
              <div
                ref={tabListRef}
                className="wizard-tablist"
                role="tablist"
                aria-label="Git sections"
                onKeyDown={handleTabKeyDown}
              >
                {GIT_TABS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    id={`git-tab-${t}`}
                    aria-selected={tab === t}
                    aria-controls={`git-panel-${t}`}
                    tabIndex={tab === t ? 0 : -1}
                    className={`wizard-tab${tab === t ? ' active' : ''}`}
                    onClick={() => setTab(t)}
                  >
                    {TAB_LABEL[t]}
                  </button>
                ))}
              </div>
              <div
                className="git-tab-panel"
                role="tabpanel"
                id={`git-panel-${tab}`}
                aria-labelledby={`git-tab-${tab}`}
              >
                {tab === 'commits' ? (
                  <GitCommitsTab projectId={projectId} status={data} />
                ) : tab === 'branches' ? (
                  <GitBranchesTab projectId={projectId} status={data} />
                ) : (
                  <GitReleaseTab projectId={projectId} status={data} />
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
