import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import type { LogEntry } from '../../types/api';
import { LOG_LEVELS } from '../../utils/constants';
import { formatTime } from '../../utils/format';
import { EmptyState } from '../common/EmptyState';
import styles from './LogViewer.module.css';

interface LogViewerProps {
  logs: LogEntry[];
  autoScroll: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
}

const ROW_HEIGHT = 22;
const BUFFER = 10;
const VIRTUAL_THRESHOLD = 200;

export const LogViewer = memo(function LogViewer({ logs, autoScroll, hasMore, onLoadMore }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  useEffect(() => {
    if (autoScroll && !showJumpButton) {
      scrollToBottom();
    }
  }, [logs, autoScroll, showJumpButton, scrollToBottom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = () => {
      setScrollTop(el.scrollTop);
      const isBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      setShowJumpButton(!isBottom);
    };
    el.addEventListener('scroll', handler);
    setViewportHeight(el.clientHeight);
    const ro = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight);
    });
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', handler);
      ro.disconnect();
    };
  }, []);

  const useVirtual = logs.length >= VIRTUAL_THRESHOLD;

  let visibleLogs: LogEntry[];
  let offsetY = 0;
  let totalHeight = 0;

  if (useVirtual) {
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER);
    const endIndex = Math.min(
      logs.length,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + BUFFER,
    );
    visibleLogs = logs.slice(startIdx, endIndex);
    offsetY = startIdx * ROW_HEIGHT;
    totalHeight = logs.length * ROW_HEIGHT;
  } else {
    visibleLogs = logs;
  }

  if (logs.length === 0) {
    return (
      <div className={styles.viewer}>
        <EmptyState title="暂无日志" description="等待系统日志输出" />
      </div>
    );
  }

  return (
    <div className={styles.viewer}>
      <div className={styles.scrollArea} ref={containerRef} role="log" aria-label="实时系统日志" aria-live="polite">
        {hasMore && (
          <button type="button" className={styles.loadMoreBtn} onClick={onLoadMore}>
            加载更多日志...
          </button>
        )}
        {useVirtual ? (
          <div className={styles.virtualSpacer} style={{ height: totalHeight }}>
            <div className={styles.virtualInner} style={{ transform: `translateY(${offsetY}px)` }}>
              {visibleLogs.map((entry, i) => (
                <LogRow key={rowKey(offsetY, i)} entry={entry} />
              ))}
            </div>
          </div>
        ) : (
          visibleLogs.map((entry, i) => <LogRow key={i} entry={entry} />)
        )}
      </div>
      {showJumpButton && (
        <button type="button" className={styles.jumpBtn} onClick={() => { scrollToBottom(); setShowJumpButton(false); }}>
          <ArrowDownToLine size={14} />
          跳转最新
        </button>
      )}
    </div>
  );
});

function rowKey(offsetY: number, i: number): number {
  return offsetY / ROW_HEIGHT + i;
}

const LogRow = memo(function LogRow({ entry }: { entry: LogEntry }) {
  const level = (entry.level || '').replace('warning', 'warn');
  const levelCfg = LOG_LEVELS[level] ?? { label: level.toUpperCase(), color: 'var(--text-muted)' };
  const metaStr =
    entry.meta && Object.keys(entry.meta).length > 0
      ? JSON.stringify(entry.meta)
      : '';
  const fullText = entry.message + (metaStr ? ' ' + metaStr : '');
  return (
    <div className={styles.entry} title={fullText}>
      <span className={styles.time}>{formatTime(entry.timestamp)}</span>
      <span className={styles.level} style={{ color: levelCfg.color }}>
        {levelCfg.label}
      </span>
      <span className={styles.message}>
        {entry.message}
        {metaStr && <span className={styles.meta}> {metaStr}</span>}
      </span>
    </div>
  );
});
