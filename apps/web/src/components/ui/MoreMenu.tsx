import { MoreHorizontal } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

export interface MoreMenuItem {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  onSelect?: () => void;
  href?: string;
  target?: string;
  rel?: string;
  danger?: boolean;
  disabled?: boolean;
}

export interface MoreMenuProps {
  items: readonly MoreMenuItem[];
  label?: ReactNode;
  ariaLabel?: string;
  align?: 'left' | 'right';
  className?: string;
}

export function MoreMenu({ items, label = 'More', ariaLabel, align = 'right', className }: MoreMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const enabledIndices = items
    .map((item, index) => (item.disabled ? -1 : index))
    .filter((index) => index >= 0);

  const focusItem = (index: number) => {
    setActiveIndex(index);
    const elements = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    elements?.[index]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const elements = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (elements) {
      const firstIdx = [...elements].findIndex((el) => !el.hasAttribute('disabled'));
      const targetIdx = firstIdx >= 0 ? firstIdx : 0;
      setActiveIndex(targetIdx);
      elements[targetIdx]?.focus();
    }

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

  const closeAndRestoreFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
    }
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    }
    if (enabledIndices.length === 0) return;

    const currentPos = enabledIndices.indexOf(activeIndex);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const nextPos = currentPos < 0 ? 0 : (currentPos + 1) % enabledIndices.length;
      const nextIndex = enabledIndices[nextPos]!;
      focusItem(nextIndex);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const prevPos = currentPos <= 0 ? enabledIndices.length - 1 : (currentPos - 1) % enabledIndices.length;
      const prevIndex = enabledIndices[prevPos]!;
      focusItem(prevIndex);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(enabledIndices[0]!);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(enabledIndices[enabledIndices.length - 1]!);
    }
  };

  const selectItem = (item: MoreMenuItem) => {
    if (item.disabled) return;
    item.onSelect?.();
    closeAndRestoreFocus();
  };

  return (
    <div className={`ui-more${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn-sm ui-more-trigger${open ? ' active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={handleTriggerKeyDown}
      >
        <MoreHorizontal className="icon" aria-hidden="true" />
        <span>{label}</span>
      </button>
      {open && (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          aria-label={ariaLabel ?? (typeof label === 'string' ? label : 'More actions')}
          className={`ui-more-menu${align === 'left' ? ' ui-more-menu-left' : ''}`}
          onKeyDown={handleMenuKeyDown}
        >
          {items.map((item, index) => {
            const content = (
              <>
                {item.icon && (
                  <span className="ui-more-item-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                )}
                <span className="ui-more-item-body">
                  <span className="ui-more-item-label">{item.label}</span>
                  {item.description && <span className="ui-more-item-desc muted">{item.description}</span>}
                </span>
              </>
            );
            const itemClass = `ui-more-item${item.danger ? ' danger' : ''}${
              item.disabled ? ' disabled' : ''
            }`;

            if (item.href && !item.disabled) {
              return (
                <a
                  key={item.id ?? index}
                  role="menuitem"
                  href={item.href}
                  target={item.target}
                  rel={item.rel}
                  tabIndex={activeIndex === index ? 0 : -1}
                  className={itemClass}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => selectItem(item)}
                >
                  {content}
                </a>
              );
            }

            return (
              <button
                key={item.id ?? index}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                tabIndex={activeIndex === index ? 0 : -1}
                className={itemClass}
                onFocus={() => setActiveIndex(index)}
                onClick={() => selectItem(item)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectItem(item);
                  }
                }}
              >
                {content}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
