import type { RepositoryStatus, UpdateRepositoryBody } from '@emberline/protocol';
import { type FormEvent, useEffect, useState } from 'react';
import { identityText } from '../repository';
import { SettingRow } from './ui/SettingRow';

type Save = (key: string, patch: UpdateRepositoryBody) => void;

/** Project settings → Repository: the project's own commit identity, or the factory's. */
export function CommitIdentityFields({
  s,
  busy,
  onSave,
}: {
  s: RepositoryStatus;
  busy: boolean;
  onSave: Save;
}) {
  const shown = s.commitIdentity ?? s.factoryCommitIdentity;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(shown.name);
  const [email, setEmail] = useState(shown.email);
  useEffect(() => {
    setName(shown.name);
    setEmail(shown.email);
  }, [shown.name, shown.email]);
  const save = (e: FormEvent) => {
    e.preventDefault();
    onSave('identity', { commitIdentity: { name: name.trim(), email: email.trim() } });
  };
  return (
    <>
      <SettingRow
        label="Commit identity"
        summary={
          <>
            <span className="mono">{identityText(shown)}</span> ({s.commitIdentity ? 'project' : 'factory'})
          </>
        }
        control={
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-expanded={editing}
            aria-label="Edit commit identity"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? 'Close' : 'Edit'}
          </button>
        }
      />
      {editing && (
        <div className="repo-inline-editor">
          <p className="muted small">
            Merges and agent commits use <span className="mono">{identityText(shown)}</span>
            {s.commitIdentity ? '.' : ' (factory default from Settings).'}
          </p>
          <form className="repo-form-constrained" onSubmit={save}>
            <label className="field">
              Name
              <input
                className="input"
                value={name}
                maxLength={100}
                autoComplete="off"
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="field">
              Email
              <input
                className="input mono"
                type="email"
                value={email}
                maxLength={254}
                autoComplete="off"
                disabled={busy}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <div className="repo-actions">
              <button type="submit" className="btn btn-sm" disabled={busy || !name.trim() || !email.trim()}>
                Use for this project
              </button>
              {s.commitIdentity && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy}
                  onClick={() => onSave('identity', { commitIdentity: null })}
                >
                  Use the factory&apos;s
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </>
  );
}
