import { useCallback, useEffect, useRef, useState } from 'react';
import type { AlertEntry } from '../types/api';

const MAX_ALERTS = 200;

export function useAlerts() {
  const [alerts, setAlerts] = useState<AlertEntry[]>([]);
  const mountedRef = useRef(true);

  const loadHistory = useCallback(async () => {
    try {
      const list = await window.api.alert.list();
      if (mountedRef.current) {
        setAlerts(list);
      }
    } catch {
      // 静默
    }
  }, []);

  const acknowledge = useCallback(async (name: string) => {
    const result = await window.api.alert.acknowledge(name);
    if (!result.ok) {
      throw new Error('确认告警失败');
    }
    if (mountedRef.current) {
      setAlerts((prev) => prev.filter((alert) => alert.name !== name));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadHistory();

    const unsubStream = window.api.alert.onStream((alert) => {
      if (!mountedRef.current) return;
      setAlerts((prev) => {
        const next = [alert, ...prev];
        while (next.length > MAX_ALERTS) next.pop();
        return next;
      });
    });

    const unsubRecovered = window.api.alert.onRecovered(() => {
      void loadHistory();
    });

    return () => {
      mountedRef.current = false;
      unsubStream();
      unsubRecovered();
    };
  }, [loadHistory]);

  return { alerts, loadHistory, acknowledge };
}
