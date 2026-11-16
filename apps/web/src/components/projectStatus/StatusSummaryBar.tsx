import type {
  Project,
  ProjectCheckpoint,
  ProjectStatusSummary,
  Ticket,
  WorkspaceDemoTarget,
} from '@emberline/protocol';
import { ArrowLeftRight, X } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { blockingMessage } from '../../reviewComments';
import { PersonaBadge } from '../PersonaBadge';
import { Disclosure } from '../ui/Disclosure';
import { MoreMenu, type MoreMenuItem } from '../ui/MoreMenu';
import { DemoFreshness, type StatusBannerMessage, type StudioTab } from './projectStatusHelpers';

export function StatusSummaryBar({
  project,
  summary,
  mainTarget,
  activeTarget,
  visibleTargetsCount,
  checkpoints,
  activeOrRecentTickets,
  startable,
  startingPipeline,
  activeTab,
  onSelectTab,
  onOpenDemoTab,
  onRunPipeline,
  blockedSync,
  onConfirmBlockedSync,
  onClearBlockedSync,
  missingSync,
  onConfirmMissingSync,
  onClearMissingSync,
  banner,
  onClearBanner,
}: {
  project: Project;
  summary: ProjectStatusSummary;
  mainTarget: WorkspaceDemoTarget | undefined;
  activeTarget: WorkspaceDemoTarget;
  visibleTargetsCount: number;
  checkpoints: ProjectCheckpoint[];
  activeOrRecentTickets: Ticket[];
  startable: number;
  startingPipeline: boolean;
  activeTab: StudioTab;
  onSelectTab: (tab: StudioTab) => void;
  onOpenDemoTab: (target: WorkspaceDemoTarget) => void;
  onRunPipeline: () => void;
  blockedSync: { runId: string; count: number } | undefined;
  onConfirmBlockedSync: (runId: string) => void;
  onClearBlockedSync: () => void;
  missingSync: { ticketId: string } | undefined;
  onConfirmMissingSync: (ticketId: string) => void;
  onClearMissingSync: () => void;
  banner: StatusBannerMessage | undefined;
  onClearBanner: () => void;
}) {
  const [, navigate] = useLocation();
  const { ticketCounts, targets } = summary;
  const branchLabel = mainTarget?.branch ?? project.defaultBranch ?? 'main';
  const latestCheckpoint = checkpoints[0];

  const moreItems: MoreMenuItem[] = [
    ...(ticketCounts.ready > 0 || ticketCounts.backlog > 0
      ? [
          {
            id: 'run-pipeline',
            label: startingPipeline ? 'Starting…' : `Run pipeline (${startable})`,
            description: 'Start ready tickets in dependency order',
            disabled: startingPipeline,
            onSelect: onRunPipeline,
          },
        ]
      : []),
    {
      id: 'open-code',
      label: 'Open code',
      onSelect: () => navigate(`/projects/${project.id}/code`),
    },
    {
      id: 'download-archive',
      label: 'Download archive',
      href: `/api/projects/${project.id}/export.tar.gz`,
    },
    {
      id: 'open-board',
      label: 'Open board',
      onSelect: () => navigate(`/projects/${project.id}/board`),
    },
  ];

  return (
    <>
      <div className="project-status-bar">
        <div className="project-status-summary">
          <span className="pill pill-live project-status-pill">
            <span className="dot" />
            <span className="pill-text">{project.name}</span>
          </span>
          <span className="badge badge-soft mono">{branchLabel}</span>
          <span className="muted mono">
            {latestCheckpoint ? `Synced ${latestCheckpoint.shortSha}` : 'No commits yet'}
          </span>
          {mainTarget && (
            <>
              <span className="project-status-sep" aria-hidden="true">
                ·
              </span>
              <DemoFreshness target={mainTarget} />
            </>
          )}
          <span className="project-status-sep" aria-hidden="true">
            ·
          </span>
          <span className="muted">
            {ticketCounts.done}/{ticketCounts.total} done
          </span>
          {summary.autoChainActive && <span className="badge badge-soft mono">Auto-pipeline active</span>}
        </div>

        <div className="project-status-toolbar">
          <div className="segmented segmented-scroll" role="tablist" aria-label="Project workspace views">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'factory'}
              className={activeTab === 'factory' ? 'active' : ''}
              onClick={() => onSelectTab('factory')}
            >
              Request
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'demo'}
              className={activeTab === 'demo' ? 'active' : ''}
              onClick={() => onOpenDemoTab(activeTarget)}
            >
              Preview
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'browser'}
              className={activeTab === 'browser' ? 'active' : ''}
              onClick={() => onSelectTab('browser')}
            >
              Browser
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'worktrees'}
              className={activeTab === 'worktrees' ? 'active' : ''}
              onClick={() => onSelectTab('worktrees')}
            >
              Worktrees ({visibleTargetsCount}/{targets.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'checkpoints'}
              className={activeTab === 'checkpoints' ? 'active' : ''}
              onClick={() => onSelectTab('checkpoints')}
            >
              Checkpoints ({checkpoints.length})
            </button>
          </div>

          <MoreMenu items={moreItems} ariaLabel="Project workspace actions" />
        </div>
      </div>

      <Disclosure label="Sync details">
        <div className="project-sync-details">
          <div className="project-sync-progress-track">
            <div
              className="project-sync-progress-fill"
              ref={(el) => {
                if (el) el.style.width = `${summary.completionPercent}%`;
              }}
            />
          </div>

          <div className="project-sync-counts">
            <div className="project-sync-badges">
              <span className="badge">Backlog: {ticketCounts.backlog}</span>
              <span className="badge">Ready: {ticketCounts.ready}</span>
              <span className={ticketCounts.in_progress > 0 ? 'badge badge-soft' : 'badge'}>
                In progress: {ticketCounts.in_progress}
              </span>
              <span className={ticketCounts.review > 0 ? 'badge badge-soft' : 'badge'}>
                Review: {ticketCounts.review}
              </span>
              <span className={`badge${ticketCounts.done > 0 ? ' project-sync-badge-done' : ''}`}>
                Done: {ticketCounts.done}
              </span>
            </div>

            {activeOrRecentTickets.length > 0 && (
              <div className="project-sync-pipeline">
                <span className="mono muted">Pipeline:</span>
                {activeOrRecentTickets.map((t, idx) => {
                  const stateClass =
                    t.status === 'done'
                      ? 'project-sync-step-done'
                      : t.status === 'in_progress'
                        ? 'project-sync-step-active'
                        : t.status === 'review'
                          ? 'project-sync-step-review'
                          : 'project-sync-step-idle';
                  return (
                    <span key={t.id} className="project-sync-step">
                      {idx > 0 && <span className="muted">→</span>}
                      <span className={`mono project-sync-step-key ${stateClass}`}>
                        {t.key} ({t.status.replace('_', ' ')})
                      </span>
                      <PersonaBadge persona={t.persona} />
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          <div className="project-sync-meta-row">
            <span className="badge mono">
              {summary.hostBindHint} <ArrowLeftRight className="icon" aria-hidden /> {summary.workspaceRoot}
            </span>
            {mainTarget && (
              <>
                <span className="mono muted">{mainTarget.workspacePath}</span>
                <span className="muted">{mainTarget.fileCount} files</span>
                {mainTarget.detectedStack && <span className="badge mono">{mainTarget.detectedStack}</span>}
                {mainTarget.detectedLayers?.map((layer) => (
                  <span key={layer} className="badge badge-soft">
                    {layer}
                  </span>
                ))}
              </>
            )}
          </div>
        </div>
      </Disclosure>

      {blockedSync && (
        <div className="banner banner-warn panel-blocked-sync" role="alert">
          <span>{blockingMessage(blockedSync.count)}. Nothing was merged.</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onConfirmBlockedSync(blockedSync.runId)}
          >
            Merge anyway
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClearBlockedSync}>
            Cancel
          </button>
        </div>
      )}

      {missingSync && (
        <div className="banner banner-warn panel-blocked-sync" role="alert">
          <span>The run&apos;s worktree is gone and its work isn&apos;t in main. Nothing was merged.</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onConfirmMissingSync(missingSync.ticketId)}
          >
            Move to Done without merging
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClearMissingSync}>
            Cancel
          </button>
        </div>
      )}

      {banner && (
        <div
          className={`banner project-status-banner ${
            banner.kind === 'ok'
              ? 'banner-ok'
              : banner.kind === 'info'
                ? 'banner-info sync-resolution-banner'
                : 'banner-error'
          }`}
          role={banner.kind === 'err' ? 'alert' : 'status'}
        >
          <span>{banner.text}</span>
          <span className="project-status-banner-actions">
            {banner.href && banner.linkLabel && (
              <Link href={banner.href} className="btn btn-sm">
                {banner.linkLabel}
              </Link>
            )}
            <button type="button" className="btn btn-sm btn-ghost" onClick={onClearBanner} aria-label="Close">
              <X className="icon" aria-hidden />
            </button>
          </span>
        </div>
      )}
    </>
  );
}
