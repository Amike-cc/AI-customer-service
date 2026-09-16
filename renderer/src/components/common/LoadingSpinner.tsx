import { Loader2 } from 'lucide-react';
import styles from './LoadingSpinner.module.css';

interface LoadingSpinnerProps {
  size?: number;
  className?: string;
  label?: string;
}

export function LoadingSpinner({ size = 20, className, label = '正在加载' }: LoadingSpinnerProps) {
  return (
    <span className={styles.wrapper} role="status" aria-label={label}>
      <Loader2 size={size} className={[styles.spinner, className].filter(Boolean).join(' ')} aria-hidden="true" />
    </span>
  );
}
