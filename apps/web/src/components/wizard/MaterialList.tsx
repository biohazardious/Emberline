import { File as FileIcon, FileText, Image as ImageIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { materialDetail, ThumbnailUrls, type WizardMaterial } from './materials';

/** Object URLs for the thumbnails, revoked when a file leaves the list and on unmount. */
export function useThumbnailUrls(materials: readonly WizardMaterial[]): ReadonlyMap<string, string> {
  const registry = useMemo(
    () => new ThumbnailUrls({ create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) }),
    [],
  );
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => setUrls(registry.sync(materials)), [registry, materials]);
  useEffect(() => () => registry.revokeAll(), [registry]);
  return urls;
}

export function MaterialList({
  materials,
  paths,
  onRemove,
}: {
  materials: readonly WizardMaterial[];
  /** Where each file is committed (Summary, from the preview). */
  paths?: readonly (string | undefined)[];
  onRemove?: (id: string) => void;
}) {
  const thumbnails = useThumbnailUrls(materials);
  if (materials.length === 0) return null;
  return (
    <ul className="wizard-materials">
      {materials.map((m, i) => {
        const url = thumbnails.get(m.id);
        const Icon = m.kind === 'pdf' ? FileText : m.kind === 'image' ? ImageIcon : FileIcon;
        return (
          <li key={m.id} className="wizard-material">
            {url ? (
              <img className="wizard-material-thumb" src={url} alt="" />
            ) : (
              <span className="wizard-material-icon" aria-hidden>
                <Icon className="icon" />
              </span>
            )}
            <span className="wizard-material-text">
              <span className="wizard-material-name">{m.name}</span>
              <span className="muted small">
                {materialDetail(m)}
                {paths?.[i] && (
                  <>
                    {' · '}
                    <span className="mono">{paths[i]}</span>
                  </>
                )}
              </span>
            </span>
            {onRemove && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label={`Remove ${m.name}`}
                onClick={() => onRemove(m.id)}
              >
                Remove
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
