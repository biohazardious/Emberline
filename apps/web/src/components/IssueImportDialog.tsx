import type { Ticket } from '@emberline/protocol';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { IssueImportTab } from './issueImport/IssueImportTab';
import { IssueSyncTab } from './issueImport/IssueSyncTab';
import './board/board-ux.css';

type Tab = 'import' | 'sync';

export { IssueImportTab, IssueSyncTab };

export function IssueImportDialog({
  projectId,
  projectName,
  onClose,
  onImported,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  /** Called with the tickets an import created, so the board shows them at once. */
  onImported?: (tickets: Ticket[]) => void;
}) {
  const [tab, setTab] = useState<Tab>('import');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer drawer-wide issue-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="issue-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <div className="issue-dialog-head-main">
            <h2 id="issue-dialog-title" className="issue-dialog-title">
              Import issues
            </h2>
            <span className="badge badge-soft">{projectName}</span>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X className="icon" aria-hidden />
          </button>
        </header>
        <div className="segmented" role="tablist" aria-label="Issue import">
          {(['import', 'sync'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'active' : ''}
              onClick={() => setTab(t)}
            >
              {t === 'import' ? 'Import' : 'Sync'}
            </button>
          ))}
        </div>
        {tab === 'import' ? (
          <IssueImportTab projectId={projectId} onImported={onImported} />
        ) : (
          <IssueSyncTab projectId={projectId} />
        )}
      </aside>
    </div>
  );
}
