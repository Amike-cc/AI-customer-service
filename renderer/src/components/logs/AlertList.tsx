import { memo, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import type { AlertEntry } from '../../types/api';
import { ALERT_LEVELS } from '../../utils/constants';
import { formatDate, truncate } from '../../utils/format';
import { EmptyState } from '../common/EmptyState';
import { Select } from '../common/Select';
import { useToast } from '../common/Toast';
import styles from './AlertList.module.css';

interface AlertListProps {
  alerts: AlertEntry[];
  onAcknowledge: (name: string) => Promise<void>;
}

export const AlertList = memo(function AlertList({ alerts, onAcknowledge }: AlertListProps) {
  const [levelFilter, setLevelFilter] = useState('all');

  const filtered = useMemo(() => {
    if (levelFilter === 'all') return alerts;
    return alerts.filter((a) => a.level === levelFilter);
  }, [alerts, levelFilter]);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h3>告警 ({alerts.length})</h3>
        <Select
          aria-label="筛选告警级别"
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          options={[
            { value: 'all', label: '全部' },
            { value: 'critical', label: '严重' },
            { value: 'warn', label: '警告' },
            { value: 'info', label: '信息' },
          ]}
        />
      </div>
      <div className={styles.list}>
        {filtered.length === 0 ? (
          <EmptyState title="暂无告警" description="系统运行正常" />
        ) : (
          filtered.map((alert) => (
            <AlertCard key={`${alert.name}-${alert.timestamp}`} alert={alert} onAcknowledge={onAcknowledge} />
          ))
        )}
      </div>
    </div>
  );
});

const AlertCard = memo(function AlertCard({ alert, onAcknowledge }: { alert: AlertEntry; onAcknowledge: (n: string) => Promise<void> }) {
  const cfg = ALERT_LEVELS[alert.level] ?? ALERT_LEVELS.info;
  const [acknowledging, setAcknowledging] = useState(false);
  const toast = useToast();

  const acknowledge = async () => {
    setAcknowledging(true);
    try {
      await onAcknowledge(alert.name);
    } catch (err) {
      toast.show('error', '确认告警失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setAcknowledging(false);
    }
  };

  return (
    <div className={styles.card} style={{ borderLeftColor: cfg.color }}>
      <div className={styles.cardTitle}>{alert.title}</div>
      <div className={styles.cardMessage}>{alert.message}</div>
      <div className={styles.cardMeta}>
        {truncate(alert.name, 30)} · {formatDate(alert.timestamp)}
        {alert.shopId ? ` · ${alert.shopId}` : ''}
      </div>
      <button type="button" className={styles.ackBtn} onClick={() => void acknowledge()} disabled={acknowledging} aria-busy={acknowledging}>
        <Check size={12} />
        {acknowledging ? '处理中' : '确认'}
      </button>
    </div>
  );
});
