import { useCallback, useEffect, useState } from 'react';
import { Info, Database, Copy, RefreshCw } from 'lucide-react';
import { LlmProvidersPanel } from './LlmProvidersPanel';
import { Card } from '../common/Card';
import { Button } from '../common/Button';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { useToast } from '../common/Toast';
import styles from './ConfigPanel.module.css';

export function ConfigPanel() {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const toast = useToast();

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const c = await window.api.config.get();
      setConfig(c);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const handleBackup = async () => {
    setBackingUp(true);
    try {
      const result = await window.api.db.backup();
      if (result.ok) {
        setBackupPath(result.path);
        toast.show('success', `数据库备份成功: ${result.path}`);
      } else {
        toast.show('error', '数据库备份失败');
      }
    } catch (err) {
      toast.show('error', '备份失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setBackingUp(false);
    }
  };

  const copyBackupPath = async () => {
    if (!backupPath) return;
    try {
      await navigator.clipboard.writeText(backupPath);
      toast.show('success', '备份路径已复制');
    } catch (err) {
      toast.show('error', '复制路径失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  if (loading) return <LoadingSpinner size={28} />;

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>系统配置管理</h2>
      {loadError && (
        <div className={styles.errorState} role="alert">
          <div>
            <strong>系统配置加载失败</strong>
            <span>{loadError}</span>
          </div>
          <Button size="sm" onClick={() => void loadConfig()}>
            <RefreshCw size={13} />
            重试
          </Button>
        </div>
      )}
      <LlmProvidersPanel />
      <Card className={styles.section}>
        <div className={styles.sectionHeader}>
          <Database size={16} />
          <h3>数据库管理</h3>
        </div>
        <div className={styles.backupRow}>
          <span className={styles.backupHint}>创建当前数据库的独立备份文件，供故障恢复使用。</span>
          <Button variant="primary" size="sm" onClick={handleBackup} loading={backingUp}>
            <Database size={13} />
            备份数据库
          </Button>
        </div>
        {backupPath && (
          <div className={styles.backupResult} role="status">
            <div>
              <span className={styles.backupResultLabel}>最近备份文件</span>
              <code title={backupPath}>{backupPath}</code>
            </div>
            <Button size="sm" onClick={() => void copyBackupPath()}>
              <Copy size={13} />
              复制路径
            </Button>
          </div>
        )}
      </Card>
      <Card className={styles.section}>
        <div className={styles.sectionHeader}>
          <Info size={16} />
          <h3>系统信息</h3>
        </div>
        {config && <ConfigGrid config={config} />}
        {!config && !loadError && <div className={styles.noConfig}>暂无可显示的配置</div>}
      </Card>
    </div>
  );
}

const GROUP_LABELS: Record<string, string> = {
  app: '应用',
  deepseek: 'DeepSeek',
  ratelimit: '限流',
  cache: '缓存',
  silent_wait: '静默等待',
  monitor: '监控',
  feige: '飞鸽',
  vision: '视觉',
  security: '安全',
  intent: '意图识别',
  conversion: '商品推荐',
  human_collab: '人工协作',
};

const FIELD_LABELS: Record<string, string> = {
  name: '应用名称',
  version: '版本',
  data_dir: '数据目录',
  max_shops: '最大店铺数',
  api_url: 'API 地址',
  model: '模型',
  temperature: '温度',
  max_tokens: '最大 Tokens',
  timeout_ms: '超时(ms)',
  context_rounds: '上下文轮次',
  fallback_response: '兜底回复',
  enabled: '启用',
  web_url: '网页版地址',
  install_paths: '安装路径',
  poll_interval_ms: '扫描间隔(ms)',
  metrics_flush_interval_ms: '指标刷新(ms)',
  dedup_window_ms: '去重窗口(ms)',
  feishu_webhook: '飞书 Webhook',
  api_key_env_var: 'API Key 环境变量',
  audit_all_replies: '审计全部回复',
  per_shop_per_minute: '店铺/分钟',
  complexity_threshold: '复杂度阈值',
  confidence_threshold: '置信度阈值',
  history_weight: '历史权重',
  max_recommendations: '最大推荐数',
  cross_sell_threshold: '交叉销售阈值',
  recommendation_cooldown_ms: '推荐冷却(ms)',
  session_analyze_interval_ms: '分析间隔(ms)',
  session_timeout_ms: '会话超时(ms)',
  retention_days: '保留天数',
  queue_poll_interval_ms: '队列轮询(ms)',
  max_wait_ms: '最大等待(ms)',
  default_max_chats: '默认最大会话',
  
};

function ConfigGrid({ config }: { config: Record<string, unknown> }) {
  const groups = Object.entries(config).filter(([, v]) => v && typeof v === 'object');
  return (
    <div className={styles.groups}>
      {groups.map(([key, val]) => (
        <ConfigGroup key={key} groupKey={key} data={val as Record<string, unknown>} />
      ))}
    </div>
  );
}

function ConfigGroup({ groupKey, data }: { groupKey: string; data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => {
    if (v && typeof v === 'object') return false;
    return true;
  });

  return (
    <div className={styles.group}>
      <div className={styles.groupTitle}>{GROUP_LABELS[groupKey] ?? groupKey}</div>
      <div className={styles.groupItems}>
        {entries.map(([field, value]) => (
          <div key={field} className={styles.item}>
            <span className={styles.itemKey}>{FIELD_LABELS[field] ?? field}</span>
            <span className={styles.itemValue}>{formatValue(value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (v === null || v === undefined) return '-';
  if (Array.isArray(v)) return v.join(', ') || '无';
  return String(v);
}
