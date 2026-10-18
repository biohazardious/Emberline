import type { Project } from '@emberline/protocol';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { projectDeleteChoices } from '../projectDelete';

export interface ProjectDeleted {
  ok: boolean;
  deletedProjectId: string;
  nextActiveProjectId: string | null;
}

/**
 * Inline confirm for removing a project: "Remove from Emberline" keeps the folder, only
 * "Remove and delete files" deletes it. Escape or Cancel closes it.
 */
export function ProjectDeleteConfirm({
  project,
  onDeleted,
  onCancel,
}: {
  project: Pick<Project, 'id' | 'name' | 'path' | 'importSource'>;
  onDeleted: (res: ProjectDeleted) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { keep, purge } = projectDeleteChoices(project);
  const [busy, setBusy] = useState<'keep' | 'purge' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const remove = async (which: 'keep' | 'purge') => {
    setBusy(which);
    setError(null);
    try {
      const res = await api<ProjectDeleted>((which === 'keep' ? keep : purge).url, 'DELETE');
      await onDeleted(res);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  return (
    <div
      className="banner banner-warn project-delete-confirm"
      role="group"
      aria-label={`Remove project ${project.name}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <p>
        <strong>Remove “{project.name}”?</strong>
      </p>
      <p className="small">{keep.description}</p>
      <p className="small">
        <strong>{purge.label}:</strong> {purge.description}
      </p>
      {error && (
        <p className="form-error small" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button ref={cancelRef} type="button" className="btn btn-sm" disabled={busy !== null} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void remove('keep')}>
          {busy === 'keep' ? 'Removing…' : keep.label}
        </button>
        <button type="button" className="btn btn-sm danger" disabled={busy !== null} onClick={() => void remove('purge')}>
          {busy === 'purge' ? 'Deleting…' : purge.label}
        </button>
      </div>
    </div>
  );
}
