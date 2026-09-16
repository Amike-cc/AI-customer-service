import { type InputHTMLAttributes, forwardRef } from 'react';
import styles from './Input.module.css';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ icon, className, ...rest }, ref) => {
    return (
      <div className={styles.wrapper}>
        {icon && <span className={styles.icon}>{icon}</span>}
        <input ref={ref} className={[styles.input, icon && styles.withIcon, className].filter(Boolean).join(' ')} {...rest} />
      </div>
    );
  },
);
Input.displayName = 'Input';
