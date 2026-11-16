import type { ProjectCheckpoint, WorkspaceDemoTarget } from '@emberline/protocol';
import { ArrowLeftRight, Clock, Hammer, Play, RotateCcwClock } from 'lucide-react';
import { useLocation } from 'wouter';
import { PersonaBadge } from '../PersonaBadge';
import { Switch } from '../ui/Switch';
import { DemoFreshness } from './projectStatusHelpers';

export function WorktreesSectionView({
  targets,
  visibleTargets,
  activeTargetId,
  completedWorktreesCount,
  hideCompletedWorktrees,
  onToggleHideCompleted,
  syncingRunId,
  buildingTargetId,
  onOpenDemo,
  onBuildAndPlay,
  onSyncToMain,
}: {
  targets: WorkspaceDemoTarget[];
  visibleTargets: WorkspaceDemoTarget[];
  activeTargetId: string;
  completedWorktreesCount: number;
  hideCompletedWorktrees: boolean;
  onToggleHideCompleted: (next: boolean) => void;
  syncingRunId: string | undefined;
  buildingTargetId: string | undefined;
  onOpenDemo: (target: WorkspaceDemoTarget) => void;
  onBuildAndPlay: (target: WorkspaceDemoTarget, autoOpen?: boolean) => void;
  onSyncToMain: (runId: string) => void;
}) {
  const [, navigate] = useLocation();

  return (
    <div className="worktrees-view">
      <div className="worktrees-toolbar">
        <span className="muted">
          Showing {visibleTargets.length} of {targets.length} workspace targets.
        </span>
        {completedWorktreesCount > 0 && (
          <Switch
            checked={hideCompletedWorktrees}
            onChange={onToggleHideCompleted}
            label={`Hide completed (${completedWorktreesCount})`}
          />
        )}
      </div>

      <div className="worktrees-grid">
        {visibleTargets.map((target) => {
          const isSelected = target.id === activeTargetId;
          const isSyncing = syncingRunId === target.id;
          const isBuilding = buildingTargetId === target.id;

          return (
            <div key={target.id} className={`worktree-card${isSelected ? ' worktree-card-selected' : ''}`}>
              <div>
                <div className="worktree-card-top">
                  <div className="worktree-card-badges">
                    <span className="badge badge-soft mono">
                      {target.kind === 'main' ? 'MAIN' : (target.ticketKey ?? 'WORKTREE')}
                    </span>
                    {target.persona && <PersonaBadge persona={target.persona} />}
                  </div>
                  <span className="mono muted">{target.fileCount} files</span>
                </div>

                <div className="worktree-card-title">{target.label}</div>
                <div className="mono muted worktree-card-path">{target.workspacePath}</div>

                {(target.detectedStack || (target.detectedLayers && target.detectedLayers.length > 0)) && (
                  <div className="worktree-card-layers">
                    {target.detectedStack && <span className="badge mono">{target.detectedStack}</span>}
                    {target.detectedLayers?.map((layer) => (
                      <span key={layer} className="badge badge-soft">
                        {layer}
                      </span>
                    ))}
                  </div>
                )}

                {target.demoEntryRelPath ? (
                  <div className="worktree-card-state-ok">
                    Bundle ready: <span className="mono">{target.demoEntryRelPath}</span>
                  </div>
                ) : target.hasBuildScript ? (
                  <div className="worktree-card-state-warn">
                    Build ready (<span className="mono">{target.buildCommand ?? 'build'}</span>)
                  </div>
                ) : null}

                <div className="demo-freshness-row">
                  <DemoFreshness target={target} />
                </div>

                {target.topFiles.length > 0 && (
                  <div className="mono muted worktree-card-files">
                    {target.topFiles.slice(0, 8).join(' · ')}
                    {target.topFiles.length > 8 ? ` +${target.topFiles.length - 8} more` : ''}
                  </div>
                )}
              </div>

              <div className="actions">
                {(target.demoUrl || target.hasBuildScript) && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={isBuilding}
                    onClick={() => onOpenDemo(target)}
                  >
                    {isBuilding ? (
                      'Building…'
                    ) : target.demoUrl ? (
                      <>
                        <Play className="icon" aria-hidden /> Open preview
                      </>
                    ) : (
                      <>
                        <Hammer className="icon" aria-hidden /> Build preview
                      </>
                    )}
                  </button>
                )}
                {target.hasBuildScript && target.demoUrl && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={isBuilding}
                    onClick={() => onBuildAndPlay(target, false)}
                  >
                    {isBuilding ? (
                      'Building…'
                    ) : (
                      <>
                        <Hammer className="icon" aria-hidden /> Rebuild
                      </>
                    )}
                  </button>
                )}
                {target.kind === 'worktree' && target.exists && target.branch && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={isSyncing}
                    onClick={() => onSyncToMain(target.id)}
                  >
                    {isSyncing ? (
                      'Syncing…'
                    ) : (
                      <>
                        <ArrowLeftRight className="icon" aria-hidden /> Sync to main
                      </>
                    )}
                  </button>
                )}
                {target.kind === 'worktree' && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => navigate(`/runs/${target.id}/review`)}
                  >
                    Open review
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CheckpointsSectionView({
  checkpoints,
  rollingBackSha,
  onRollback,
}: {
  checkpoints: ProjectCheckpoint[];
  rollingBackSha: string | undefined;
  onRollback: (sha: string) => void;
}) {
  return (
    <div className="checkpoints-view">
      <div className="checkpoints-head">
        <span>
          <Clock className="icon" aria-hidden /> Checkpoints ({checkpoints.length})
        </span>
      </div>
      {checkpoints.length === 0 ? (
        <p className="muted">No commits recorded yet in main workspace.</p>
      ) : (
        <div className="checkpoints-list">
          {checkpoints.map((cp, index) => (
            <div key={cp.sha} className="checkpoint-row">
              <div className="checkpoint-main">
                <span className="badge mono">{cp.shortSha}</span>
                {index === 0 && <span className="badge badge-soft mono">HEAD</span>}
                <span className="checkpoint-subject">{cp.subject}</span>
              </div>
              <div className="checkpoint-actions">
                <span className="mono muted">{new Date(cp.createdAt).toLocaleString()}</span>
                {index > 0 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={rollingBackSha === cp.sha}
                    onClick={() => onRollback(cp.sha)}
                  >
                    {rollingBackSha === cp.sha ? (
                      'Rolling back…'
                    ) : (
                      <>
                        <RotateCcwClock className="icon" aria-hidden /> Roll back
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
