/** Shown when copying failed: the text in a selectable box so it can be copied by hand. */
export function CopyFallback({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="copy-fallback" role="status">
      <span className="muted small">Copying is blocked here. Select and copy the path:</span>
      <input
        className="input mono"
        readOnly
        value={text}
        aria-label="Path to copy"
        onFocus={(e) => e.currentTarget.select()}
        autoFocus
      />
      <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
