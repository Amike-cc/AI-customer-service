import styles from './Badge.module.css';

type BadgeColor = 'success' | 'warning' | 'danger' | 'info' | 'default';

interface BadgeProps {
  color?: BadgeColor;
  children: React.ReactNode;
  pulse?: boolean;
}

export function Badge({ color = 'default', children, pulse = false }: BadgeProps) {
  const cls = [styles.badge, styles[color], pulse && styles.pulse].filter(Boolean).join(' ');
  return <span className={cls}>{children}</span>;
}
