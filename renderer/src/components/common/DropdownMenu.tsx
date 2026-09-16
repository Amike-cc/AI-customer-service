import {
  useState,
  useEffect,
  useRef,
  useLayoutEffect,
  useId,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './DropdownMenu.module.css';

interface DropdownMenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface DropdownMenuProps {
  trigger: ReactNode;
  items: DropdownMenuItem[];
  align?: 'left' | 'right';
  label?: string;
}

export function DropdownMenu({ trigger, items, align = 'right', label = '更多操作' }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const menuWidth = menuRef.current?.offsetWidth || 184;
    const menuHeight = menuRef.current?.offsetHeight || Math.min(items.length * 38 + 8, 360);
    let left = align === 'right' ? rect.right - menuWidth : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
    let top = rect.bottom + 4;
    if (top + menuHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - menuHeight - 4);
    }
    setMenuPos({ top, left });
  }, [open, align, items.length]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current && ref.current.contains(target)) return;
      if (menuRef.current && menuRef.current.contains(target)) return;
      if (target.closest?.('[data-dropdown-menu]')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const focusTimer = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const menuItems = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
      );
      if (menuItems.length === 0) return;
      event.preventDefault();
      const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? menuItems.length - 1
          : event.key === 'ArrowDown'
            ? (currentIndex + 1 + menuItems.length) % menuItems.length
            : (currentIndex - 1 + menuItems.length) % menuItems.length;
      menuItems[nextIndex]?.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleTriggerClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen((v) => !v);
  };

  const handleItemClick = (item: DropdownMenuItem) => {
    if (item.disabled) return;
    item.onClick();
    setOpen(false);
  };

  return (
    <div className={styles.wrapper} ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={handleTriggerClick}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            data-dropdown-menu="true"
            className={styles.menu}
            role="menu"
            aria-label={label}
            style={{
              position: 'fixed',
              top: `${menuPos.top}px`,
              left: `${menuPos.left}px`,
            }}
          >
            {items.map((item, idx) => (
              <button
                key={idx}
                className={[
                  styles.item,
                  item.danger && styles.danger,
                  item.disabled && styles.disabled,
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => handleItemClick(item)}
                disabled={item.disabled}
                role="menuitem"
              >
                {item.icon && <span className={styles.itemIcon}>{item.icon}</span>}
                <span>{item.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
