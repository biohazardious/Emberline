import type { GitPageStatus } from '@emberline/protocol';
import { GitBranch } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { SectionState } from '../components/SectionState';
import { GitCommitsTab } from '../components/git/GitCommitsTab';
import { GitStatusStrip } from '../components/git/GitStatusStrip';
import { GIT_TABS, type GitTab, gitRefetchMs, tabFromHash } from '../gitPage';

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
  const status = useQuery({
    queryKey: ['git', projectId],
    queryFn: () => api<GitPageStatus>(`/api/projects/${projectId}/git`),
    refetchInterval: (q) => gitRefetchMs(q.state.data),
  });
  const data = status.data;

  return (
    <div className="board-page git-page">
      <div className="board-head">
        <div className="board-title">
          <GitBranch className="icon" aria-hidden />
          <h1>Git</h1>
        </div>
      </div>
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
              <div className="wizard-tablist" role="tablist" aria-label="Git sections">
                {GIT_TABS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    id={`git-tab-${t}`}
                    aria-selected={tab === t}
                    aria-controls={`git-panel-${t}`}
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
                ) : (
                  /* Tasks 12 and 13 fill these tabs. */
                  <p className="muted">{TAB_LABEL[tab]} is coming.</p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
