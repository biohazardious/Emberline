import { ChevronRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

export interface DisclosureProps {
  label?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
  className?: string;
}

export function Disclosure({
  label = 'Details',
  defaultOpen = false,
  open,
  onOpenChange,
  children,
  className,
}: DisclosureProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = open !== undefined ? open : uncontrolledOpen;
  const panelId = useId();

  const handleToggle = () => {
    const next = !isOpen;
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div className={`ui-disclosure${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="ui-disclosure-trigger"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={handleToggle}
      >
        <ChevronRight
          className={`icon ui-disclosure-chevron${isOpen ? ' ui-disclosure-chevron-open' : ''}`}
          aria-hidden="true"
        />
        <span>{label}</span>
      </button>
      {isOpen && (
        <div id={panelId} className="ui-disclosure-panel">
          {children}
        </div>
      )}
    </div>
  );
}
