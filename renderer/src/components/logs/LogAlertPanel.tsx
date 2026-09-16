import { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useLogs } from '../../hooks/useLogs';
import { useAlerts } from '../../hooks/useAlerts';
import { LogViewer } from './LogViewer';
import { AlertList } from './AlertList';
import { Select } from '../common/Select';
import { Button } from '../common/Button';
import { SearchInput } from '../common/SearchInput';
import styles from './LogAlertPanel.module.css';

export function LogAlertPanel() {
  const { logs, hasMore, loadMore, clear } = useLogs();
  const { alerts, acknowledge } = useAlerts();
  const [levelFilter, setLevelFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);

  const filteredLogs = useMemo(() => {
    let result = logs;
    if (levelFilter !== 'all') {
      result = result.filter((l) => {
        const level = l.level.replace('warning', 'warn');
        return level === levelFilter;
      });
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (l) =>
          l.message.toLowerCase().includes(q) ||
          JSON.stringify(l.meta ?? '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [logs, levelFilter, search]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>实时日志与告警</h2>
        <div className={styles.toolbar}>
          <Select
            aria-label="筛选日志级别"
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            options={[
              { value: 'all', label: '全部级别' },
              { value: 'error', label: '错误' },
              { value: 'warn', label: '警告' },
              { value: 'info', label: '信息' },
              { value: 'debug', label: '调试' },
            ]}
          />
          <SearchInput placeholder="搜索日志..." onSearch={setSearch} />
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            自动滚动
          </label>
          <Button size="sm" onClick={clear} title="仅清空当前界面，后续新日志仍会继续显示">
            <Trash2 size={13} />
            清空当前视图
          </Button>
        </div>
      </div>
      <div className={styles.layout}>
        <LogViewer logs={filteredLogs} autoScroll={autoScroll} hasMore={hasMore} onLoadMore={loadMore} />
        <AlertList alerts={alerts} onAcknowledge={acknowledge} />
      </div>
    </div>
  );
}
