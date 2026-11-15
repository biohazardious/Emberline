export interface SaveBarProps {
  dirty: boolean;
  saving?: boolean;
  onDiscard: () => void;
  saveLabel?: string;
  discardLabel?: string;
  message?: string;
  className?: string;
}

export function SaveBar({
  dirty,
  saving = false,
  onDiscard,
  saveLabel = 'Save',
  discardLabel = 'Discard',
  message = 'Unsaved changes',
  className,
}: SaveBarProps) {
  if (!dirty && !saving) return null;

  return (
    <div className={`ui-save-bar${className ? ` ${className}` : ''}`} role="status" aria-live="polite">
      <span className="ui-save-bar-msg">{message}</span>
      <div className="ui-save-bar-actions">
        <button type="button" className="btn btn-sm" disabled={saving} onClick={onDiscard}>
          {discardLabel}
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={saving}>
          {saving ? 'Saving…' : saveLabel}
        </button>
      </div>
    </div>
  );
}
