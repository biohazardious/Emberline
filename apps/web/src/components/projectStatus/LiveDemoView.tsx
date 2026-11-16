import type { Project, WorkspaceDemoTarget } from '@emberline/protocol';
import {
  Bug,
  ExternalLink,
  FileCode,
  Globe,
  Hammer,
  Maximize2,
  Minimize2,
  RotateCw,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import type { FormEvent, RefObject } from 'react';
import { useLocation } from 'wouter';
import { DEMO_IFRAME_SANDBOX } from '../../sandbox';
import { PreviewAndBuildView } from '../PreviewAndBuildView';
import { Disclosure } from '../ui/Disclosure';
import { DemoFreshness, type DemoRuntimeError } from './projectStatusHelpers';

export function LiveDemoView({
  project,
  targets,
  activeTarget,
  engineAvailable,
  fullscreen,
  onToggleFullscreen,
  onCloseDemo,
  iframeNonce,
  onBumpIframeNonce,
  onSelectTarget,
  buildingTargetId,
  onBuildAndPlay,
  onOpenBrowser,
  demoFrameRef,
  demoErrors,
  onClearDemoErrors,
  onFixDemoError,
  quickTweakPrompt,
  onQuickTweakPromptChange,
  submittingTweak,
  onSubmitQuickTweak,
  lastBuildOutput,
  onClearBuildOutput,
}: {
  project: Project;
  targets: WorkspaceDemoTarget[];
  activeTarget: WorkspaceDemoTarget;
  engineAvailable: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onCloseDemo: () => void;
  iframeNonce: number;
  onBumpIframeNonce: () => void;
  onSelectTarget: (targetId: string) => void;
  buildingTargetId: string | undefined;
  onBuildAndPlay: (target: WorkspaceDemoTarget, autoOpen?: boolean) => void;
  onOpenBrowser: () => void;
  demoFrameRef: RefObject<HTMLIFrameElement | null>;
  demoErrors: DemoRuntimeError[];
  onClearDemoErrors: () => void;
  onFixDemoError: (errItem: DemoRuntimeError) => void;
  quickTweakPrompt: string;
  onQuickTweakPromptChange: (next: string) => void;
  submittingTweak: boolean;
  onSubmitQuickTweak: (e: FormEvent) => void;
  lastBuildOutput: string;
  onClearBuildOutput: () => void;
}) {
  const [, navigate] = useLocation();

  return (
    <PreviewAndBuildView
      project={project}
      target={activeTarget}
      engineAvailable={engineAvailable}
      freshness={<DemoFreshness target={activeTarget} />}
      targetSelect={
        <select
          className="input preview-target-select"
          aria-label="Preview target"
          value={activeTarget.id}
          onChange={(e) => onSelectTarget(e.target.value)}
        >
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      }
    >
      <div>
        {activeTarget.demoUrl ? (
          <div className={fullscreen ? 'live-demo-shell-fullscreen' : 'live-demo-shell'}>
            <div className="live-demo-head">
              <div className="live-demo-title-group">
                <span className="live-demo-live-label">Live preview</span>
                <select
                  className="input live-demo-target-select"
                  aria-label="Static preview target"
                  value={activeTarget.id}
                  onChange={(e) => {
                    onSelectTarget(e.target.value);
                    onBumpIframeNonce();
                  }}
                >
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}{' '}
                      {t.demoEntryRelPath ? `(${t.demoEntryRelPath})` : `(${t.detectedStack ?? 'no bundle'})`}
                    </option>
                  ))}
                </select>
                <span className="mono muted small">{activeTarget.demoEntryRelPath}</span>
                <DemoFreshness target={activeTarget} />
              </div>

              <div className="actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    onClearDemoErrors();
                    onBumpIframeNonce();
                  }}
                >
                  <RotateCw className="icon" aria-hidden /> Reload
                </button>
                <button type="button" className="btn btn-sm" onClick={onToggleFullscreen}>
                  {fullscreen ? (
                    <>
                      <Minimize2 className="icon" aria-hidden /> Exit fullscreen
                    </>
                  ) : (
                    <>
                      <Maximize2 className="icon" aria-hidden /> Fullscreen
                    </>
                  )}
                </button>
                <a href={activeTarget.demoUrl} target="_blank" rel="noreferrer" className="btn btn-sm">
                  <ExternalLink className="icon" aria-hidden /> Open tab
                </a>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onCloseDemo}>
                  <X className="icon" aria-hidden /> Close
                </button>
              </div>
            </div>

            {demoErrors.length > 0 && (
              <div className="banner banner-error live-demo-error-banner" role="alert">
                <div className="live-demo-error-body">
                  <strong>
                    <Bug className="icon" aria-hidden /> Runtime error ({demoErrors[0]!.timestamp}):
                  </strong>
                  <div className="mono live-demo-error-msg">{demoErrors[0]!.message}</div>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={submittingTweak}
                    onClick={() => onFixDemoError(demoErrors[0]!)}
                  >
                    <Wrench className="icon" aria-hidden /> Fix error
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={onClearDemoErrors}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            <div className="live-demo-tweak-bar">
              <Disclosure label="Quick tweak">
                <form className="live-demo-tweak-form" onSubmit={onSubmitQuickTweak}>
                  <input
                    type="text"
                    className="input live-demo-tweak-input"
                    aria-label="Quick tweak prompt"
                    value={quickTweakPrompt}
                    onChange={(e) => onQuickTweakPromptChange(e.target.value)}
                    placeholder="Describe a quick UI or logic tweak…"
                  />
                  <button
                    type="submit"
                    className="btn btn-sm"
                    disabled={submittingTweak || !quickTweakPrompt.trim()}
                  >
                    {submittingTweak ? (
                      'Sending…'
                    ) : (
                      <>
                        <Sparkles className="icon" aria-hidden /> Apply tweak
                      </>
                    )}
                  </button>
                </form>
              </Disclosure>
            </div>

            <iframe
              ref={demoFrameRef}
              key={`${activeTarget.id}-${iframeNonce}`}
              src={`${activeTarget.demoUrl}?v=${iframeNonce}`}
              sandbox={DEMO_IFRAME_SANDBOX}
              title={`Live Preview - ${activeTarget.label}`}
              className="live-demo-iframe"
            />
          </div>
        ) : (
          <div className="build-console-card">
            <div className="build-console-head">
              <div className="live-demo-title-group">
                <span className="build-console-title">
                  <Wrench className="icon" aria-hidden /> Build and verify
                </span>
                <select
                  className="input live-demo-target-select"
                  aria-label="Build target"
                  value={activeTarget.id}
                  onChange={(e) => onSelectTarget(e.target.value)}
                >
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label} ({t.detectedStack ?? `${t.fileCount} files`})
                    </option>
                  ))}
                </select>
                <DemoFreshness target={activeTarget} />
              </div>

              <div className="actions">
                {activeTarget.hasBuildScript && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={buildingTargetId === activeTarget.id}
                    onClick={() => onBuildAndPlay(activeTarget, true)}
                  >
                    {buildingTargetId === activeTarget.id ? (
                      'Building…'
                    ) : (
                      <>
                        <Hammer className="icon" aria-hidden /> Run build
                      </>
                    )}
                  </button>
                )}
                <button type="button" className="btn btn-sm" onClick={onOpenBrowser}>
                  <Globe className="icon" aria-hidden /> Open browser
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => navigate(`/projects/${project.id}/code`)}
                >
                  <FileCode className="icon" aria-hidden /> Open code
                </button>
              </div>
            </div>

            <div className="build-console-stack-bar">
              <span className="muted">Stack:</span>
              <span className="badge mono">{activeTarget.detectedStack ?? 'Custom'}</span>
              {activeTarget.buildCommand && (
                <>
                  <span className="muted">Command:</span>
                  <span className="badge badge-soft mono">{activeTarget.buildCommand}</span>
                </>
              )}
              {activeTarget.detectedLayers && activeTarget.detectedLayers.length > 0 && (
                <>
                  <span className="muted">Layers:</span>
                  {activeTarget.detectedLayers.map((layer) => (
                    <span key={layer} className="badge">
                      {layer}
                    </span>
                  ))}
                </>
              )}
            </div>

            <p className="muted">
              Run the build check to compile or verify this workspace target, or open the browser to inspect a
              running web server.
            </p>

            <Disclosure label="Build logs">
              <div className="build-console-log-wrap">
                {lastBuildOutput ? (
                  <>
                    <div className="build-console-log-head">
                      <span className="mono muted">Last build output</span>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={onClearBuildOutput}>
                        Clear log
                      </button>
                    </div>
                    <pre className="mono build-console-pre">{lastBuildOutput}</pre>
                  </>
                ) : (
                  <p className="muted">No build output recorded in this session yet.</p>
                )}
              </div>
            </Disclosure>
          </div>
        )}
      </div>
    </PreviewAndBuildView>
  );
}
