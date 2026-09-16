import { useEffect, useState } from 'react';
import styles from './StatusBar.module.css';

interface StatusBarProps {
  message: string;
  shopName?: string;
  platformLabel?: string;
  loginStatus?: 'logged_in' | 'logging_in' | 'logged_out' | string;
}

export function StatusBar({ message, shopName, platformLabel, loginStatus = 'logged_in' }: StatusBarProps) {
  const [clock, setClock] = useState({ display: '', iso: '' });
  const connectionLabel = loginStatus === 'logged_out' ? '未登录' : loginStatus === 'logging_in' ? '登录中' : '连接正常';
  const connectionClass = loginStatus === 'logged_out'
    ? styles.statusDotOffline
    : loginStatus === 'logging_in'
      ? styles.statusDotPending
      : styles.statusDot;

  useEffect(() => {
    const update = () => {
      const now = new Date();
      setClock({
        display: now.toLocaleTimeString('zh-CN', { hour12: false }),
        iso: now.toISOString(),
      });
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <footer className={styles.statusbar} aria-label="应用状态栏">
      <div className={styles.left} role="status" aria-live="polite" aria-atomic="true">
        {shopName ? (
          <>
            <span className={connectionClass} />
            <span className={styles.label}>{connectionLabel}</span>
            <span className={styles.divider}>|</span>
            <span className={styles.message}>
              {platformLabel ? platformLabel + ' · ' : ''}
              {shopName}
            </span>
          </>
        ) : (
          <>
            <span className={styles.label}>当前状态</span>
            <span className={styles.message}>{message}</span>
          </>
        )}
      </div>
      <span className={styles.designMeta}>界面设计稿 · 示例数据</span>
      <time
        className={styles.time}
        dateTime={clock.iso || undefined}
        aria-label={clock.display ? `当前时间 ${clock.display}` : '正在读取当前时间'}
      >
        {clock.display}
      </time>
    </footer>
  );
}
