import type { RepositoryStatus, UpdateRepositoryBody } from '@emberline/protocol';
import { type FormEvent, useEffect, useState } from 'react';
import { hasWorkingBranch, keepPushedText } from '../repository';
import { SettingRow } from './ui/SettingRow';
import { Switch } from './ui/Switch';

type Save = (key: string, patch: UpdateRepositoryBody) => void;

/** Project settings → Repository: where Keep pushed sends the factory's merges. */
export function PushTargetFields({ s, busy, onSave }: { s: RepositoryStatus; busy: boolean; onSave: Save }) {
  const [editing, setEditing] = useState(false);
  const [branch, setBranch] = useState(s.integrationBranch);
  useEffect(() => setBranch(s.integrationBranch), [s.integrationBranch]);
  const saveBranch = (e: FormEvent) => {
    e.preventDefault();
    onSave('push-target', { pushTarget: 'integration_branch', integrationBranch: branch.trim() });
  };
  // When a working branch is active, the Working branch row shows the push summary and Keep pushed switch.
  if (hasWorkingBranch(s)) return null;
  return (
    <>
      <SettingRow
        label="Push target"
        summary={
          <>
            <span className="mono">{s.keepPushedBranch}</span> (
            {s.pushTarget === 'integration_branch' ? 'integration branch' : 'default branch'})
          </>
        }
        control={
          <>
            <Switch
              checked={s.keepMainPushed}
              disabled={busy}
              label="Keep pushed"
              onChange={(checked) => onSave('keep', { keepMainPushed: checked })}
            />
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-expanded={editing}
              aria-label="Edit push target"
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? 'Close' : 'Edit'}
            </button>
          </>
        }
      />
      {editing && (
        <fieldset className="repo-inline-editor repo-fieldset">
          <legend className="muted small">Keep pushed pushes to</legend>
          <label className="review-checkbox-label">
            <input
              type="radio"
              name="repo-push-target"
              checked={s.pushTarget === 'integration_branch'}
              disabled={busy}
              onChange={() => onSave('push-target', { pushTarget: 'integration_branch' })}
            />
            An integration branch
          </label>
          <form className="repo-branch-form" onSubmit={saveBranch}>
            <input
              className="input mono"
              aria-label="Integration branch"
              value={branch}
              maxLength={200}
              disabled={busy}
              onChange={(e) => setBranch(e.target.value)}
            />
            {branch.trim() !== s.integrationBranch && (
              <button type="submit" className="btn btn-sm" disabled={busy || !branch.trim()}>
                Save branch
              </button>
            )}
          </form>
          <label className="review-checkbox-label">
            <input
              type="radio"
              name="repo-push-target"
              checked={s.pushTarget === 'default_branch'}
              disabled={busy}
              onChange={() => onSave('push-target', { pushTarget: 'default_branch' })}
            />
            <span>
              The default branch (<span className="mono">{s.defaultBranch}</span>)
            </span>
          </label>
          <p className="muted small">{keepPushedText(s)}</p>
        </fieldset>
      )}
    </>
  );
}
