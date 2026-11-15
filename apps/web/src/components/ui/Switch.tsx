import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useId } from 'react';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  disabled?: boolean;
  busy?: boolean;
  id?: string;
  className?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  ariaLabel,
  ariaLabelledBy,
  disabled = false,
  busy = false,
  id,
  className,
}: SwitchProps) {
  const autoId = useId();
  const switchId = id ?? autoId;
  const labelId = `${switchId}-label`;
  const isDisabled = disabled || busy;

  const toggle = () => {
    if (!isDisabled) onChange(!checked);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      toggle();
    }
  };

  const button = (
    <button
      id={switchId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={busy || undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy ?? (label ? labelId : undefined)}
      disabled={isDisabled}
      className={`ui-switch${checked ? ' ui-switch-checked' : ''}${busy ? ' ui-switch-busy' : ''}${
        !label && className ? ` ${className}` : ''
      }`}
      onClick={toggle}
      onKeyDown={handleKeyDown}
    >
      <span className="ui-switch-thumb" aria-hidden="true" />
    </button>
  );

  if (!label) return button;

  return (
    <div className={`ui-switch-field${className ? ` ${className}` : ''}`}>
      {button}
      <label id={labelId} htmlFor={switchId} className="ui-switch-label">
        {label}
      </label>
    </div>
  );
}
