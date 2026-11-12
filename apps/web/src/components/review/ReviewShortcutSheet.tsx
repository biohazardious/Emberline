import { Keyboard, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { trapTab } from '../../focusTrap';
import { REVIEW_SHORTCUTS } from '../../reviewShortcuts';

interface Props {
  open: boolean;
  onClose: () => void;
}

const GROUPS = ['Navigation', 'Review', 'General'] as const;

export function ReviewShortcutSheet({ open, onClose }: Props) {
  const sheetRef = useRef<HTMLElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeBtnRef.current?.focus();
    return () => opener?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        trapTab(sheetRef.current, e);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div className="drawer-backdrop review-shortcut-backdrop" onClick={onClose}>
      <aside
        ref={sheetRef}
        className="drawer review-shortcut-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-shortcuts-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id="review-shortcuts-title" className="issue-dialog-title review-shortcut-title">
            <Keyboard className="icon" aria-hidden /> Review Keyboard Shortcuts
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            className="icon-btn"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
          >
            <X className="icon" aria-hidden />
          </button>
        </header>

        <p className="muted small">
          Navigate large diffs, triage inline feedback, and manage merge-blocking comments without leaving the
          keyboard.
        </p>

        <div className="review-shortcut-groups">
          {GROUPS.map((group) => {
            const items = REVIEW_SHORTCUTS.filter((s) => s.group === group);
            return (
              <section key={group} className="review-shortcut-section" aria-labelledby={`sc-group-${group}`}>
                <h3 id={`sc-group-${group}`} className="eyebrow">
                  {group}
                </h3>
                <dl className="review-shortcut-list">
                  {items.map((item) => (
                    <div key={item.label} className="review-shortcut-row">
                      <dt className="review-shortcut-keys">
                        {item.keys.map((key, idx) => (
                          <span key={key} className="review-shortcut-key-seq">
                            {idx > 0 && <span className="muted small">/</span>}
                            <kbd className="kbd">{key}</kbd>
                          </span>
                        ))}
                      </dt>
                      <dd className="review-shortcut-desc">
                        <strong>{item.label}</strong>
                        <span className="muted small">{item.description}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
