import { memo, useEffect, useRef } from 'react';
import type { ConversationMessage } from '../../types/api';
import { formatDate } from '../../utils/format';
import { EmptyState } from '../common/EmptyState';
import styles from './MessageThread.module.css';

interface MessageThreadProps {
  messages: ConversationMessage[];
}

export const MessageThread = memo(function MessageThread({ messages }: MessageThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0) {
    return <EmptyState message="该会话暂无消息" />;
  }

  return (
    <div className={styles.thread}>
      {messages.map((m) => (
        <div key={m.id} className={[styles.bubble, styles[m.role]].filter(Boolean).join(' ')}>
          <div className={styles.content}>{m.content}</div>
          <div className={styles.meta}>
            {formatDate(m.createdAt)}
            {m.tokenCount ? ` · ${m.tokenCount} tokens` : ''}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
});
