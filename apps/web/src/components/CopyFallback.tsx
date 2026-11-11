/** Shown when copying failed: the text in a selectable box so it can be copied by hand. */
export function CopyFallback({
  text,
  onClose,
  what = 'path',
}: {
  text: string;
  onClose: () => void;
  /** What the text is, in the prompt and the field's label ("path", "public key"). */
  what?: string;
}) {
  return (
    <div className="copy-fallback" role="status">
      <span className="muted small">Copying is blocked here. Select and copy the {what}:</span>
      <input
        className="input mono"
        readOnly
        value={text}
        aria-label={`${what[0]!.toUpperCase()}${what.slice(1)} to copy`}
        onFocus={(e) => e.currentTarget.select()}
        autoFocus
      />
      <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
