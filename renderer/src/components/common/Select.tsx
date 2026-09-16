import { type SelectHTMLAttributes, forwardRef } from 'react';
import styles from './Select.module.css';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: Array<{ value: string; label: string }>;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ options, className, ...rest }, ref) => {
    const opts = options ?? [];
    return (
      <select ref={ref} className={[styles.select, className].filter(Boolean).join(' ')} {...rest}>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  },
);
Select.displayName = 'Select';
