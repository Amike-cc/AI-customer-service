import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import styles from './Modal.module.css';

interface ModalProps {
  open: boolean;
  onClose: (action?: string) => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  closeOnOverlay?: boolean;
  closeOnEscape?: boolean;
}

/**
 * 统一 DOM 模态窗口。打开时会暂时隐藏 Electron WebContentsView，确保弹窗
 * 不会被店铺网页的 GPU 层遮挡，并负责焦点陷阱、焦点恢复与 Escape 行为。
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 560,
  closeOnOverlay = false,
  closeOnEscape = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    const focusable = dialog?.querySelectorAll<HTMLElement>(focusableSelector) ?? [];
    (focusable[0] ?? dialog)?.focus();

    void window.api?.view?.hideForModal?.();

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeOnEscape) {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
      if (items.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      previouslyFocused?.focus();
      void window.api?.view?.restoreAfterModal?.();
    };
  }, [open, closeOnEscape]);

  if (!open) return null;

  return createPortal(
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (closeOnOverlay && e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        style={{ width: `${width}px` }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : '对话框'}
        tabIndex={-1}
      >
        {title && (
          <div className={styles.header}>
            <h3 className={styles.title} id={titleId}>{title}</h3>
            <button type="button" className={styles.closeBtn} onClick={() => onCloseRef.current()} aria-label="关闭">
              <X size={18} />
            </button>
          </div>
        )}
        <div className={styles.body}>{children}</div>
        {footer && (
          <div className={styles.footer}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
