import type { WorkspaceDemoTarget } from '@emberline/protocol';
import { Globe, Hammer, Play } from 'lucide-react';
import { DemoFreshness } from './projectStatusHelpers';

export function DemoStateBar({
  mainTarget,
  bestPlayableTarget,
  buildingTargetId,
  onOpenDemo,
  onOpenBrowser,
}: {
  mainTarget: WorkspaceDemoTarget | undefined;
  bestPlayableTarget: WorkspaceDemoTarget | undefined;
  buildingTargetId: string | undefined;
  onOpenDemo: (target: WorkspaceDemoTarget) => void;
  onOpenBrowser: () => void;
}) {
  if (!mainTarget) return null;

  const target = bestPlayableTarget ?? mainTarget;
  const isBuilding = buildingTargetId === target.id;
  const hasDemoAction = Boolean(target.demoUrl || target.hasBuildScript);

  return (
    <div className="demo-state-bar">
      <div className="demo-state-info">
        {mainTarget.demoEntryRelPath ? (
          <span className="demo-state-ready">
            Preview ready (<span className="mono">{mainTarget.demoEntryRelPath}</span>)
          </span>
        ) : mainTarget.buildCommand ? (
          <span className="muted mono">Build: {mainTarget.buildCommand}</span>
        ) : (
          <span className="muted">No preview bundle yet</span>
        )}
        <DemoFreshness target={mainTarget} />
      </div>

      <div className="actions">
        {hasDemoAction ? (
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
        ) : (
          <button type="button" className="btn btn-sm" onClick={onOpenBrowser}>
            <Globe className="icon" aria-hidden /> Open browser
          </button>
        )}
      </div>
    </div>
  );
}
