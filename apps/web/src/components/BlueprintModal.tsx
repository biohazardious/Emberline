import type { Project, ProjectBlueprintResponse, Run } from '@emberline/protocol';
import { Check, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { PersonaBadge } from './PersonaBadge';

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
      // Save current content first so the agent sees the latest draft in its worktree
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
          <div>
            <p className="eyebrow">{project.name} · Living Specification</p>
            <h2 id="blueprint-modal-title" style={{ margin: 0, fontSize: '1.05rem' }}>
              Project Blueprint (<code className="mono">PROJECT.md</code>)
            </h2>
          </div>
          {blueprintPath && <span className="badge badge-soft mono hide-sm">{blueprintPath}</span>}
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X className="icon" aria-hidden />
          </button>
        </header>

        <p className="muted small" style={{ margin: 0 }}>
          Every specialized agent persona reads <code className="mono">PROJECT.md</code> as the living source of truth. Edit it directly or dispatch the <PersonaBadge persona="product_owner" showFull /> agent to enrich it.
        </p>

        {loading ? (
          <div className="empty" aria-busy="true">
            Loading PROJECT.md…
          </div>
        ) : (
          <textarea
            id="blueprint-editor"
            className="input mono"
            rows={18}
            style={{ fontSize: '0.84rem', lineHeight: 1.5 }}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setSavedNotice(false);
            }}
          />
        )}

        {savedNotice && (
          <p className="small" style={{ color: 'var(--ok, var(--ok))', margin: 0 }}>
            <Check className="icon" aria-hidden /> Saved PROJECT.md and synced CLAUDE.md in workspace.
          </p>
        )}
        {error && <p className="form-error">{error}</p>}

        <footer className="drawer-foot">
          <button
            type="button"
            className="btn btn-sm"
            disabled={!!busy || loading}
            onClick={() => void askProductOwner()}
            title="Save PROJECT.md and launch a Product Owner agent run to refine requirements and milestones"
          >
            {busy === 'refine' ? (
              'Dispatching PO Agent…'
            ) : (
              <>
                <Sparkles className="icon" aria-hidden /> Ask Product Owner Agent to Refine
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
