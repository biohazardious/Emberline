import type { GitBranch, GitCompare, GitFileDiff, GitPageStatus } from '@emberline/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { trapTab } from '../../focusTrap';
import { remoteStateText, splitBranches } from '../../gitPage';
import { SectionState } from '../SectionState';
import { GitDiffView } from './GitDiffView';
import { GitProblemBanner, type Problem, problemOf } from './GitStatusStrip';

const KIND_LABEL: Record<GitBranch['kind'], string> = {
  working: 'working',
  main: 'main',
  person: 'yours',
  run: 'run',
  backup: 'backup',
};

/** Only merged branches go, never the working branch, main, or a run branch a live run still uses. */
function canDelete(b: GitBranch, workingBranch: string): boolean {
  if (b.kind === 'working' || b.kind === 'main' || b.name === workingBranch) return false;
  if (b.liveRuns.length > 0) return false;
  return b.mergedIntoMain || b.mergedIntoWorking;
}

interface Pair {
  base: string;
  head: string;
}

/** The delete confirmation: stays open on a failure, with the server's message and the blocking runs. */
function DeleteDialog({
  branch,
  hasOrigin,
  onConfirm,
  onClose,
}: {
  branch: GitBranch;
  hasOrigin: boolean;
  onConfirm: (alsoOnOrigin: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [remote, setRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Mount-only: a parent re-render must not move the focus. `onClose` is read through a ref.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      } else trapTab(dialogRef.current, e);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, []);

  const confirm = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await onConfirm(remote);
    } catch (e) {
      setProblem(problemOf(e));
      setBusy(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        ref={dialogRef}
        className="drawer request-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-delete-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id="git-delete-title" className="issue-dialog-title">
            Delete {branch.name}?
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X className="icon" aria-hidden />
          </button>
        </header>
        <p className="small">
          <span className="mono">{branch.name}</span> is fully merged, so its commits stay in the history.
        </p>
        {hasOrigin && (
          <label className="review-checkbox-label small">
            <input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} />
            Also delete on origin
          </label>
        )}
        {problem && <GitProblemBanner problem={problem} />}
        <div className="request-dialog-actions">
          <button type="button" className="btn danger" disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </aside>
    </div>
  );
}

/** The result of one comparison: its counts and the changed files. */
function ComparePanel({ projectId, pair, onClose }: { projectId: string; pair: Pair; onClose: () => void }) {
  const base = `/api/projects/${projectId}/git/compare`;
  const query = `base=${encodeURIComponent(pair.base)}&head=${encodeURIComponent(pair.head)}`;
  const compare = useQuery({
    queryKey: ['git', projectId, 'compare', pair.base, pair.head],
    queryFn: () => api<GitCompare>(`${base}?${query}`),
  });
  const loadFile = useCallback(
    (path: string) => api<GitFileDiff>(`${base}/file?${query}&path=${encodeURIComponent(path)}`),
    [base, query],
  );
  return (
    <section className="panel git-compare" aria-label="Comparison">
      <div className="git-compare-head">
        <strong>
          <span className="mono">{pair.head}</span> compared with <span className="mono">{pair.base}</span>
        </strong>
        {compare.data && (
          <span className="muted small">
            {compare.data.ahead} ahead, {compare.data.behind} behind, {compare.data.files.length}{' '}
            {compare.data.files.length === 1 ? 'file' : 'files'} changed
          </span>
        )}
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
          Close comparison
        </button>
      </div>
      {compare.data === undefined ? (
        <SectionState
          loading={compare.isPending}
          error={compare.error ?? undefined}
          onRetry={() => void compare.refetch()}
          loadingText="Comparing…"
          errorPrefix="Could not compare these"
        />
      ) : (
        <GitDiffView files={compare.data.files} loadFile={loadFile} />
      )}
    </section>
  );
}

/** Compare with…: a branch chosen from the select is the base this row is compared against. */
function CompareSelect({
  name,
  options,
  onPick,
}: {
  name: string;
  options: string[];
  onPick: (base: string) => void;
}) {
  return (
    <select
      className="input mono git-compare-select"
      aria-label={`Compare ${name} with…`}
      value=""
      onChange={(e) => e.target.value && onPick(e.target.value)}
    >
      <option value="">Compare with…</option>
      {options
        .filter((o) => o !== name)
        .map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
    </select>
  );
}

/** The Branches tab: every branch with its counts, the actions on it, backups and new branches. */
export function GitBranchesTab({ projectId, status }: { projectId: string; status: GitPageStatus }) {
  const client = useQueryClient();
  const base = `/api/projects/${projectId}/git`;
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [pair, setPair] = useState<Pair | null>(null);
  const [deleting, setDeleting] = useState<GitBranch | null>(null);
  const [name, setName] = useState('');
  const [from, setFrom] = useState<'main' | 'working'>('main');

  const branches = useQuery({
    queryKey: ['git', projectId, 'branches'],
    queryFn: () => api<GitBranch[]>(`${base}/branches`),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['git', projectId] });
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      await refresh();
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (branches.data === undefined)
    return (
      <SectionState
        loading={branches.isPending}
        error={branches.error ?? undefined}
        onRetry={() => void branches.refetch()}
        loadingText="Reading the branches…"
        errorPrefix="Could not load the branches"
      />
    );

  const { shown, runBranches } = splitBranches(branches.data);
  const rows = shown.filter((b) => b.kind !== 'backup');
  const compareOptions = rows.map((b) => b.name);
  const vs = (b: GitBranch) => (b.vsMain ? `${b.vsMain.ahead} ahead, ${b.vsMain.behind} behind` : '—');

  const row = (b: GitBranch) => {
    const isWorking = b.kind === 'working' || b.name === status.workingBranch;
    return (
      <tr key={b.name}>
        <td className="mono">
          {b.name}
          {b.liveRuns.length > 0 && <span className="muted small"> (a run is using it)</span>}
        </td>
        <td>
          <span className={`chip chip-${b.kind}`}>{KIND_LABEL[b.kind]}</span>
        </td>
        <td className="small">{vs(b)}</td>
        <td className="small">
          {b.vsOrigin
            ? remoteStateText(b.vsOrigin.state, b.vsOrigin.ahead, b.vsOrigin.behind)
            : status.hasOrigin
              ? '—'
              : 'No origin'}
        </td>
        <td className="git-branch-actions">
          <CompareSelect
            name={b.name}
            options={compareOptions}
            onPick={(other) => setPair({ base: other, head: b.name })}
          />
          {!isWorking && b.kind !== 'run' && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void act(() => api(`${base}/working-branch`, 'POST', { branch: b.name }))}
            >
              Make this the working branch
            </button>
          )}
          {canDelete(b, status.workingBranch) && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDeleting(b)}>
              Delete
            </button>
          )}
        </td>
      </tr>
    );
  };

  const create = () =>
    void act(async () => {
      await api(`${base}/branches`, 'POST', { name: name.trim(), from });
      setName('');
    });

  return (
    <div className="git-branches">
      <form
        className="git-new-branch"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <input
          className="input mono"
          aria-label="New branch name"
          placeholder="New branch name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label>
          <input type="radio" name="from" checked={from === 'main'} onChange={() => setFrom('main')} /> From
          main
        </label>
        <label>
          <input type="radio" name="from" checked={from === 'working'} onChange={() => setFrom('working')} />{' '}
          From the working branch
        </label>
        <button type="submit" className="btn btn-sm" disabled={busy || !name.trim()}>
          New branch
        </button>
      </form>

      {problem && <GitProblemBanner problem={problem} />}

      <table className="git-branch-table">
        <thead>
          <tr>
            <th>Branch</th>
            <th>Kind</th>
            <th>Against {status.defaultBranch}</th>
            <th>Origin</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row)}
          {runBranches.length > 0 && (
            <tr>
              <td colSpan={5}>
                <button
                  type="button"
                  className="link-btn git-run-toggle"
                  aria-expanded={showRuns}
                  onClick={() => setShowRuns((v) => !v)}
                >
                  {showRuns ? (
                    <ChevronDown className="icon" aria-hidden />
                  ) : (
                    <ChevronRight className="icon" aria-hidden />
                  )}
                  {runBranches.length} run {runBranches.length === 1 ? 'branch' : 'branches'}
                </button>
              </td>
            </tr>
          )}
          {showRuns && runBranches.map(row)}
        </tbody>
      </table>

      {status.backups.length > 0 && (
        <section aria-label="Backups">
          <h3>Backups (kept by Match origin)</h3>
          <ul className="git-backups">
            {status.backups.map((b) => (
              <li key={b}>
                <span className="mono">{b}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setPair({ base: status.workingBranch, head: b })}
                >
                  Compare
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {pair && <ComparePanel projectId={projectId} pair={pair} onClose={() => setPair(null)} />}

      {deleting && (
        <DeleteDialog
          branch={deleting}
          hasOrigin={status.hasOrigin}
          onClose={() => setDeleting(null)}
          onConfirm={async (remote) => {
            await api(
              `${base}/branches/${encodeURIComponent(deleting.name)}${remote ? '?remote=1' : ''}`,
              'DELETE',
            );
            setDeleting(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}
