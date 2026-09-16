import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import styles from './Button.module.css';

type Variant = 'default' | 'primary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'default', size = 'md', loading = false, disabled, children, className, type = 'button', ...rest }, ref) => {
    const cls = [styles.btn, styles[variant], styles[size], loading && styles.loading, className]
      .filter(Boolean)
      .join(' ');
    return (
      <button ref={ref} type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
        {loading && <Loader2 size={size === 'sm' ? 12 : 14} className={styles.spinner} />}
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';
