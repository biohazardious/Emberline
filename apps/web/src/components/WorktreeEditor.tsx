import type {
  Project,
  ValidateWorktreeConfigResponse,
  WorktreeConfigStatusResponse,
} from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useThemeMode } from '../hooks/useThemeMode';
import { monacoTheme } from '../monaco';
import {
  WORKTREE_EDIT_HINT,
  WORKTREE_SAVE_LABEL,
  WORKTREE_VALIDATE_DELAY_MS,
  refreshWorktreeConfigViews,
  worktreeEditorStart,
  worktreeSaveEnabled,
  worktreeSaveFailure,
} from '../projectSettings';
import { MonacoEditor } from './MonacoEditor';

/** Edits .emberline/worktree.yml: validated as you type, saved as one commit on main and approved. */
export function WorktreeEditor({
  project,
  status,
  onClose,
}: {
  project: Project;
  status: WorktreeConfigStatusResponse | undefined;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const themeMode = useThemeMode();
  const statusUrl = `/api/projects/${project.id}/worktree-config`;
  const [start, setStart] = useState(() => worktreeEditorStart(status));
  const [content, setContent] = useState(start.content);
  const [errors, setErrors] = useState<string[]>([]);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [validating, setValidating] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof worktreeSaveFailure> | null>(null);

  useEffect(() => {
    let stale = false;
    setValidating(true);
    const timer = setTimeout(() => {
      api<ValidateWorktreeConfigResponse>(`${statusUrl}/validate`, 'POST', { content }).then(
        (res) => {
          if (stale) return;
          setErrors(res.errors);
          setCheckError(null);
          setValidating(false);
        },
        (err: unknown) => {
          if (stale) return;
          setCheckError(errorMessage(err));
          setValidating(false);
        },
      );
    }, WORKTREE_VALIDATE_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [content, statusUrl]);

  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const saved = await api<WorktreeConfigStatusResponse>(statusUrl, 'PUT', {
        content,
        baseSha256: start.baseSha256,
      });
      queryClient.setQueryData(['api', statusUrl], saved);
      await refreshWorktreeConfigViews(queryClient, project.id);
      onClose();
    } catch (err) {
      setFailure(worktreeSaveFailure(err));
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    setBusy(true);
    try {
      const fresh = await api<WorktreeConfigStatusResponse>(statusUrl);
      queryClient.setQueryData(['api', statusUrl], fresh);
      const next = worktreeEditorStart(fresh);
      setStart(next);
      setContent(next.content);
      setFailure(null);
    } catch (err) {
      setFailure(worktreeSaveFailure(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="worktree-review">
      <div className="worktree-editor">
        <MonacoEditor
          language="yaml"
          filePath={`worktree-${project.id}-${start.baseSha256 ?? 'new'}`}
          theme={monacoTheme(themeMode)}
          value={content}
          readOnly={busy}
          onChange={setContent}
        />
      </div>
      {errors.length > 0 && (
        <ul className="worktree-review-errors" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {checkError !== null && (
        <p className="banner banner-error" role="alert">
          Could not check the file: {checkError}
        </p>
      )}
      {failure && (
        <div className="banner banner-error" role="alert">
          <p>{failure.message}</p>
          {failure.errors.length > 0 && (
            <ul>
              {failure.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {failure.reload && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void reload()}>
              Reload
            </button>
          )}
        </div>
      )}
      <p className="muted small">{WORKTREE_EDIT_HINT}</p>
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={
            !worktreeSaveEnabled({ errors: checkError === null ? errors : [checkError], validating, busy })
          }
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : WORKTREE_SAVE_LABEL}
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
