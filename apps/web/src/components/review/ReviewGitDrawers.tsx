import type { RunForgeStatus, RunPreviewStatus } from '@emberline/protocol';
import type { FormEvent } from 'react';
import { Link } from 'wouter';
import { FORGE_ACCOUNTS_HREF } from '../../forgeAccounts';

interface Props {
  previewStatus: RunPreviewStatus | null;
  previewDrawerOpen: boolean;
  previewCmd: string;
  onPreviewCmdChange: (next: string) => void;
  previewPort: string;
  onPreviewPortChange: (next: string) => void;
  previewBusy: boolean;
  onStartPreview: (e: FormEvent) => void;
  prDrawerOpen: boolean;
  prTitle: string;
  onPrTitleChange: (next: string) => void;
  prBody: string;
  onPrBodyChange: (next: string) => void;
  prDraft: boolean;
  onPrDraftChange: (next: boolean) => void;
  prCreating: boolean;
  forgeStatus: RunForgeStatus | null;
  onCreatePr: (e: FormEvent) => void;
}

export function ReviewGitDrawers({
  previewStatus,
  previewDrawerOpen,
  previewCmd,
  onPreviewCmdChange,
  previewPort,
  onPreviewPortChange,
  previewBusy,
  onStartPreview,
  prDrawerOpen,
  prTitle,
  onPrTitleChange,
  prBody,
  onPrBodyChange,
  prDraft,
  onPrDraftChange,
  prCreating,
  forgeStatus,
  onCreatePr,
}: Props) {
  return (
    <>
      {previewStatus?.note && previewStatus.status !== 'stopped' && (
        <p className="muted small" role="status">
          {previewStatus.note}
        </p>
      )}

      {previewStatus?.error && (previewStatus.status === 'failed' || previewStatus.status === 'exited') && (
        <div
          className="review-actions-bar"
          role="status"
          style={{ flexDirection: 'column', alignItems: 'stretch' }}
        >
          <span>
            Preview {previewStatus.status}: {previewStatus.error}
          </span>
          {previewStatus.logs && (
            <details>
              <summary>Container output (untrusted)</summary>
              <pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: '16rem', overflow: 'auto' }}>
                {previewStatus.logs}
              </pre>
            </details>
          )}
        </div>
      )}

      {previewDrawerOpen && previewStatus?.kind === 'compose' && (
        <form className="review-actions-bar" onSubmit={onStartPreview}>
          <div className="review-commit-form" style={{ flex: 1 }}>
            <span className="mono" style={{ flex: 1 }}>
              {previewStatus.detectedCommand} in the Docker engine
            </span>
            <button type="submit" className="btn btn-sm btn-primary" disabled={previewBusy}>
              {previewBusy ? 'Starting…' : 'Start Preview'}
            </button>
          </div>
        </form>
      )}

      {previewDrawerOpen && previewStatus?.kind !== 'compose' && (
        <form className="review-actions-bar" onSubmit={onStartPreview}>
          <div className="review-commit-form" style={{ flex: 1 }}>
            <input
              type="text"
              className="input mono"
              value={previewCmd}
              onChange={(e) => onPreviewCmdChange(e.target.value)}
              placeholder="Dev server command (e.g. pnpm dev or npm run dev)"
              required
            />
            <input
              type="number"
              className="input mono"
              value={previewPort}
              onChange={(e) => onPreviewPortChange(e.target.value)}
              placeholder="Port (auto)"
              style={{ maxWidth: '170px' }}
            />
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={previewBusy || !previewCmd.trim()}
            >
              {previewBusy ? 'Starting…' : 'Start Preview Server'}
            </button>
          </div>
        </form>
      )}

      {prDrawerOpen && (
        <form className="review-actions-bar" onSubmit={onCreatePr}>
          <div className="review-commit-form" style={{ flex: 1 }}>
            <input
              type="text"
              className="input"
              value={prTitle}
              onChange={(e) => onPrTitleChange(e.target.value)}
              placeholder="Pull request title…"
              required
            />
            <input
              type="text"
              className="input"
              value={prBody}
              onChange={(e) => onPrBodyChange(e.target.value)}
              placeholder="Optional description / summary…"
            />
            <label className="review-checkbox-label">
              <input type="checkbox" checked={prDraft} onChange={(e) => onPrDraftChange(e.target.checked)} />
              Draft
            </label>
            <button type="submit" className="btn btn-sm btn-primary" disabled={prCreating || !prTitle.trim()}>
              {prCreating
                ? 'Creating PR…'
                : `Push & Create ${forgeStatus?.provider === 'gitlab' ? 'MR' : 'PR'}`}
            </button>
          </div>
          {!forgeStatus?.tokenConfigured && (
            <span className="muted small">
              Add a forge account for this repository&apos;s server in{' '}
              <Link href={FORGE_ACCOUNTS_HREF}>Settings → Forge accounts</Link> (or use Compare ↗).
            </span>
          )}
        </form>
      )}
    </>
  );
}
