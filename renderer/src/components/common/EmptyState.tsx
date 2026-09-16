import { type ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import styles from './EmptyState.module.css';

interface EmptyStateProps {
  message?: string;
  title?: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ message, title, description, icon, action }: EmptyStateProps) {
  const resolvedDescription = description ?? (title ? message : undefined);
  const standaloneMessage = !title && !description ? message : undefined;

  return (
    <div className={styles.empty}>
      <div className={styles.iconWrap}>
        {icon ?? <Inbox size={36} className={styles.icon} />}
      </div>
      {title && <span className={styles.title}>{title}</span>}
      {resolvedDescription && (
        <span className={styles.description}>{resolvedDescription}</span>
      )}
      {standaloneMessage && <span className={styles.text}>{standaloneMessage}</span>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
