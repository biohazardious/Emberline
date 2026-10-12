import type { PermissionMode } from '@emberline/protocol';

export const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask', hint: 'Claude asks before edits and commands' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'File edits auto-approved; commands still ask' },
  { value: 'plan', label: 'Plan only', hint: 'Read-only planning, no changes' },
  { value: 'bypassPermissions', label: 'Unattended', hint: 'No prompts at all, only inside the isolated runner' },
];

export const modeHint = (mode: PermissionMode) => MODES.find((m) => m.value === mode)?.hint ?? '';

/** Segmented radio group for Claude Code's `--permission-mode`. */
export function PermissionModePicker({
  value,
  onChange,
}: {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Permission mode">
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          role="radio"
          aria-checked={value === m.value}
          className={value === m.value ? 'active' : ''}
          title={m.hint}
          onClick={() => onChange(m.value)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
