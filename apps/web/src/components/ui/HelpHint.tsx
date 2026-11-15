import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

export interface HelpHintProps {
  topic: string;
  children?: ReactNode;
  className?: string;
}

export function HelpHint({ topic, children, className }: HelpHintProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const ariaLabel = `About ${topic}`;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent | MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen((prev) => !prev);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  return (
    <span className={`ui-help-hint${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn ui-help-trigger"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span aria-hidden="true">?</span>
      </button>
      {open && (
        <div id={popoverId} role="dialog" aria-label={ariaLabel} className="ui-help-popover">
          {children}
        </div>
      )}
    </span>
  );
}
