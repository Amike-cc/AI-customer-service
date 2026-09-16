import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogEntry } from '../types/api';

const MAX_LOGS = 500;
const PAGE_SIZE = 200;

export function useLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [totalLogs, setTotalLogs] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const mountedRef = useRef(true);

  const loadHistory = useCallback(async (offset = 0) => {
    try {
      const result = await window.api.log.history(PAGE_SIZE, offset);
      if (mountedRef.current) {
        if (offset === 0) {
          setLogs(result.entries);
        } else {
          // 主进程返回从新到旧的分页，追加在尾部保持时间序（最新在末尾）
          setLogs((prev) => [...prev, ...result.entries]);
        }
        setTotalLogs(result.total);
        setHasMore(offset + PAGE_SIZE < result.total);
      }
    } catch {
      // 静默
    }
  }, []);

  const loadMore = useCallback(() => {
    void loadHistory(logs.length);
  }, [loadHistory, logs.length]);

  const clear = useCallback(() => {
    setLogs([]);
    setTotalLogs(0);
    setHasMore(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadHistory(0);

    // 仅注册订阅，忽略结果与拒绝（log:subscribe 无业务返回值，IPC 异常不应产生 unhandled rejection）
    void window.api.log.subscribe().catch(() => {
      // 静默
    });

    const unsub = window.api.log.onStream((entry) => {
      if (!mountedRef.current) return;
      setLogs((prev) => {
        const next = [...prev, entry];
        while (next.length > MAX_LOGS) next.shift();
        return next;
      });
    });

    return () => {
      mountedRef.current = false;
      unsub();
    };
  }, [loadHistory]);

  return { logs, totalLogs, hasMore, loadMore, loadHistory, clear };
}
