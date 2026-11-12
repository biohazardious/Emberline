import type { RepositoryStatus, UpdateRepositoryBody } from '@emberline/protocol';
import { type FormEvent, useEffect, useState } from 'react';
import { keepPushedText } from '../repository';

type Save = (key: string, patch: UpdateRepositoryBody) => void;

/** Project settings → Repository: where Keep main pushed pushes main. */
export function PushTargetFields({ s, busy, onSave }: { s: RepositoryStatus; busy: boolean; onSave: Save }) {
  const [branch, setBranch] = useState(s.integrationBranch);
  useEffect(() => setBranch(s.integrationBranch), [s.integrationBranch]);
  const saveBranch = (e: FormEvent) => {
    e.preventDefault();
    onSave('push-target', { pushTarget: 'integration_branch', integrationBranch: branch.trim() });
  };
  return (
    <fieldset className="repo-form" style={{ border: 'none', padding: 0, margin: 0 }}>
      <legend className="muted small">Keep main pushed pushes to</legend>
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
      <form className="form" onSubmit={saveBranch} style={{ marginLeft: 22, maxWidth: 420 }}>
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
        The default branch (<span className="mono">{s.defaultBranch}</span>)
      </label>
      <p className="muted small">{keepPushedText(s)}</p>
    </fieldset>
  );
}
