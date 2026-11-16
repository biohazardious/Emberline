import type { Project, ProjectBlueprintResponse, Run } from '@emberline/protocol';
import { Check, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import '../pages/dashboard-ux.css';

export function BlueprintModal({
  project,
  open,
  onClose,
  onSaved,
  onRunStarted,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  onRunStarted?: (run: Run) => void;
}) {
  const [content, setContent] = useState('');
  const [blueprintPath, setBlueprintPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<'save' | 'refine'>();
  const [error, setError] = useState<string>();
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(undefined);
    setSavedNotice(false);
    void api<ProjectBlueprintResponse>(`/api/projects/${project.id}/blueprint`)
      .then((res) => {
        setBlueprintPath(res.path);
        if (res.exists && res.content.trim()) {
          setContent(res.content);
        } else {
          setContent(`# ${project.name} — Project Blueprint (\`PROJECT.md\`)

## 1. Product Vision & Overview
${project.description || `${project.name} managed by Emberline AI Coding Factory.`}

## 2. Technology Stack
- **Language:** ${project.techStack?.language || 'TBD'}
- **Frontend:** ${project.techStack?.frontend || 'TBD'}
- **Backend:** ${project.techStack?.backend || 'TBD'}
- **Database:** ${project.techStack?.database || 'TBD'}

## 3. Architecture & Engineering Rules
- Keep module boundaries explicit and cohesive.
- Validate inputs and include automated tests with every feature.

## 4. Milestones
- [ ] M1 — Core Architecture & Skeleton
- [ ] M2 — Primary Feature Implementation
- [ ] M3 — QA & Production Polish
`);
        }
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [open, project]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const save = async () => {
    setBusy('save');
    setError(undefined);
    setSavedNotice(false);
    try {
      const res = await api<ProjectBlueprintResponse>(`/api/projects/${project.id}/blueprint`, 'PUT', {
        content,
      });
      setContent(res.content);
      setBlueprintPath(res.path);
      setSavedNotice(true);
      onSaved?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  const askProductOwner = async () => {
    setBusy('refine');
    setError(undefined);
    try {
      await api<ProjectBlueprintResponse>(`/api/projects/${project.id}/blueprint`, 'PUT', {
        content,
      });
      const run = await api<Run>('/api/runs', 'POST', {
        projectId: project.id,
        persona: 'product_owner',
        permissionMode: 'auto',
        prompt:
          'Read PROJECT.md and inspect the repository structure. Expand and refine PROJECT.md with detailed user stories, architecture boundaries, and testable milestone checklists.',
      });
      onSaved?.();
      onClose();
      onRunStarted?.(run);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer drawer-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="blueprint-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id="blueprint-modal-title" className="blueprint-modal-title">
            PROJECT.md
          </h2>
          {blueprintPath && <span className="badge badge-soft mono hide-sm">{blueprintPath}</span>}
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X className="icon" aria-hidden />
          </button>
        </header>

        <p className="muted blueprint-modal-sub">
          Shared specification read by every agent run in {project.name}.
        </p>

        {loading ? (
          <div className="empty" aria-busy="true">
            Loading PROJECT.md…
          </div>
        ) : (
          <textarea
            id="blueprint-editor"
            className="input mono blueprint-editor"
            rows={18}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setSavedNotice(false);
            }}
          />
        )}

        {savedNotice && (
          <p className="blueprint-saved-notice" role="status">
            <Check className="icon" aria-hidden /> Saved PROJECT.md and synced CLAUDE.md in workspace.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <footer className="drawer-foot">
          <button
            type="button"
            className="btn btn-sm"
            disabled={!!busy || loading}
            onClick={() => void askProductOwner()}
          >
            {busy === 'refine' ? (
              'Starting…'
            ) : (
              <>
                <Sparkles className="icon" aria-hidden /> Refine with agent
              </>
            )}
          </button>
          <div className="actions">
            <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
              Close
            </button>
            <button
              id="blueprint-save"
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!!busy || loading}
              onClick={() => void save()}
            >
              {busy === 'save' ? 'Saving…' : 'Save PROJECT.md'}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}
