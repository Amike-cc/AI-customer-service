import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';
import styles from './ConfirmDialog.module.css';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'danger';
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setConfirming(false);
      setError(null);
    }
  }, [open]);

  const handleConfirm = async () => {
    if (confirming) return;
    setConfirming(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!confirming) onCancel();
      }}
      title={title}
      width={420}
      closeOnEscape={!confirming}
      footer={(
        <>
          <Button variant="ghost" onClick={onCancel} disabled={confirming}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'danger' ? 'danger' : 'primary'}
            onClick={() => { void handleConfirm(); }}
            loading={confirming}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <div className={styles.content}>
        <AlertTriangle
          size={24}
          className={variant === 'danger' ? styles.iconDanger : styles.iconDefault}
        />
        <span className={styles.message}>{message}</span>
      </div>
      {error && <div className={styles.error} role="alert">操作失败：{error}</div>}
    </Modal>
  );
}
