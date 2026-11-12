import type { GitFileChange, GitFileDiff } from '@emberline/protocol';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../api';
import { isEditableShortcutTarget } from '../../reviewShortcuts';
import { MonacoDiff } from '../MonacoDiff';
import { detectLanguage } from '../review/useReviewExtras';

const noop = () => {};

/**
 * A list of changed files and the diff of the selected one, read on demand. Shared by the Commits
 * tab and Compare. `j` and `k` move through the files unless a field has the keyboard.
 */
export function GitDiffView({
  files,
  loadFile,
}: {
  files: GitFileChange[];
  loadFile: (path: string) => Promise<GitFileDiff>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The Review page keeps no stored preference, only side by side as its starting view.
  const sideBySide = true;

  const current = files.find((f) => f.path === selected)?.path ?? files[0]?.path ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'j' && e.key !== 'k') return;
      if (e.ctrlKey || e.metaKey || e.altKey || isEditableShortcutTarget(e.target)) return;
      const at = files.findIndex((f) => f.path === current);
      const next = files[Math.min(files.length - 1, Math.max(0, at + (e.key === 'j' ? 1 : -1)))];
      if (next) setSelected(next.path);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [files, current]);

  useEffect(() => {
    if (current === null) return;
    let stale = false;
    setError(null);
    loadFile(current).then(
      (d) => {
        if (!stale) setDiff(d);
      },
      (e: unknown) => {
        if (!stale) setError(errorMessage(e));
      },
    );
    return () => {
      stale = true;
    };
  }, [current, loadFile]);

  if (files.length === 0) return <p className="muted">No files changed.</p>;
  const shown = diff !== null && diff.path === current ? diff : null;

  return (
    <div className="git-diff">
      <ul className="git-files" aria-label="Changed files">
        {files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              className={`git-file${f.path === current ? ' active' : ''}`}
              aria-current={f.path === current ? 'true' : undefined}
              onClick={() => setSelected(f.path)}
            >
              <span className="git-file-path">{f.path}</span>
              <span className="git-add">+{f.additions}</span>
              <span className="git-del">−{f.deletions}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="git-diff-pane">
        {error !== null ? (
          <p className="muted">Could not load this file: {error}</p>
        ) : shown === null ? (
          <p className="muted">Loading…</p>
        ) : shown.binary ? (
          <p className="muted">Binary file</p>
        ) : shown.truncated ? (
          <p className="muted">Too large to show (over 1 MiB)</p>
        ) : (
          <MonacoDiff
            filePath={shown.path}
            language={detectLanguage(shown.path)}
            original={shown.original}
            modified={shown.modified}
            renderSideBySide={sideBySide}
            comments={[]}
            onLineClick={noop}
            onFocusComment={noop}
            draftLine={null}
          />
        )}
      </div>
    </div>
  );
}
