import { isWorktreeYmlPath } from '@emberline/protocol';
import { Download, Package, Trash2 } from 'lucide-react';
import { ico } from '../SectionState';
import {
  CE_CENTER,
  describeFileType,
  type ExplorerCtx,
  formatBytes,
  getFileDownloadUrl,
  type OpenTab,
} from './fileTypes';

export function BinaryFileInspector({ ctx, tab }: { ctx: ExplorerCtx; tab: OpenTab }) {
  const { pid, tid, del } = ctx;
  const descriptor = describeFileType(tab.path);
  const inlineUrl = getFileDownloadUrl(pid, tid, tab.path, true);
  const fileName = tab.path.split('/').pop() ?? tab.path;

  return (
    <div style={{ ...CE_CENTER, padding: '28px' }}>
      <div
        className="panel"
        style={{
          maxWidth: '580px',
          width: '100%',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: '14px',
          background: 'var(--surface-2)',
          border: '1px solid var(--border-strong)',
        }}
      >
        <div style={{ fontSize: '2.6rem', lineHeight: 1 }}>{ico(descriptor.icon ?? Package)}</div>
        <div>
          <h3 style={{ margin: '0 0 4px 0', fontSize: '1.05rem' }}>{fileName}</h3>
          <div className="muted mono small">{tab.path}</div>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
          <span className="badge badge-soft">{descriptor.label}</span>
          <span className="badge mono">{formatBytes(tab.sizeBytes)}</span>
        </div>

        {descriptor.previewKind === 'image' && (
          <div
            style={{
              padding: '12px',
              background: 'var(--surface)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              maxWidth: '100%',
            }}
          >
            <img
              src={inlineUrl}
              alt={tab.path}
              style={{
                maxWidth: '100%',
                maxHeight: '280px',
                objectFit: 'contain',
                display: 'block',
              }}
            />
          </div>
        )}

        {descriptor.previewKind === 'audio' && (
          <audio controls src={inlineUrl} style={{ width: '100%', maxWidth: '420px' }} />
        )}

        {descriptor.previewKind === 'video' && (
          <video
            controls
            src={inlineUrl}
            style={{ maxWidth: '100%', maxHeight: '300px', borderRadius: '6px' }}
          />
        )}

        <p className="muted small" style={{ margin: 0, maxWidth: '460px' }}>
          This file is a binary, package, or media artifact and cannot be displayed or edited as plain text in
          the code editor. You can download it directly to your device below.
        </p>

        <div
          style={{
            display: 'flex',
            gap: '10px',
            flexWrap: 'wrap',
            justifyContent: 'center',
            marginTop: '4px',
          }}
        >
          <a
            href={getFileDownloadUrl(pid, tid, tab.path)}
            download={fileName}
            className="btn btn-primary"
            style={{ textDecoration: 'none', padding: '8px 16px' }}
          >
            {ico(Download)} Download {tab.path.split('/').pop()} ({formatBytes(tab.sizeBytes)})
          </a>
          {!isWorktreeYmlPath(tab.path) && (
            <button type="button" className="btn btn-ghost" onClick={() => void del(tab.path)}>
              {ico(Trash2)} Delete File
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
