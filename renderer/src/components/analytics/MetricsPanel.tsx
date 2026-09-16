import { useState, useEffect, useCallback, useRef } from 'react';
import { Activity, Zap, MessageSquare, Shield, AlertTriangle, Clock, BarChart3 } from 'lucide-react';
import type { ShopListItem, MetricsSummary, MetricsHistory } from '../../types/api';
import { Card } from '../common/Card';
import { Select } from '../common/Select';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { useToast } from '../common/Toast';
import styles from './MetricsPanel.module.css';

const TIME_RANGES = [
  { value: '3600000', label: '近 1 小时' },
  { value: '86400000', label: '近 24 小时' },
  { value: '604800000', label: '近 7 天' },
];

const METRIC_LABELS: Record<string, string> = {
  api_call_total: 'API 调用',
  token_consumed_total: 'Token 消耗',
  message_received_total: '收到消息',
  reply_sent_total: '发送回复',
  reply_failed_total: '回复失败',
  rate_limit_rejected_total: '限流拒绝',
  sensitive_block_total: '敏感词拦截',
  state_transition_total: '状态转换',
  reply_truncated_total: '回复截断',
};

interface MetricsPanelProps {
  shops: ShopListItem[];
}

export function MetricsPanel({ shops }: MetricsPanelProps) {
  const [shopId, setShopId] = useState('');
  const [rangeMs, setRangeMs] = useState('86400000');
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [history, setHistory] = useState<MetricsHistory | null>(null);
  const [historyMetric, setHistoryMetric] = useState('api_call_total');
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const requestIdRef = useRef(0);

  const loadData = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const untilMs = Date.now();
      const sinceMs = untilMs - Number(rangeMs);
      const scopedShopId = shopId || undefined;
      const [s, h] = await Promise.all([
        window.api.metrics.summary(sinceMs, scopedShopId),
        window.api.metrics.history(historyMetric, sinceMs, untilMs, scopedShopId),
      ]);

      // 竞态守卫：快速切换店铺/指标时丢弃过期响应，
      // 避免旧请求到达时误报"数据范围不一致"并清空已正确加载的数据
      if (requestIdRef.current !== requestId) return;
      setSummary(s);
      setHistory(h);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      toast.show('error', '加载运营指标失败: ' + (err instanceof Error ? err.message : String(err)));
      setSummary(null);
      setHistory(null);
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [rangeMs, shopId, historyMetric, toast]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const shopOptions = [{ value: '', label: '全部店铺' }, ...shops.map((s) => ({ value: s.shopId, label: s.shopName }))];

  const metricOptions = Object.entries(METRIC_LABELS).map(([value, label]) => ({ value, label }));
  const scopeLabel = shops.find((shop) => shop.shopId === shopId)?.shopName ?? '全部店铺';
  const rangeLabel = TIME_RANGES.find((range) => range.value === rangeMs)?.label ?? '';

  const maxBucket = history?.buckets?.reduce((m, b) => Math.max(m, b.total), 0) ?? 0;

  return (
    <div className={styles.container} aria-busy={loading}>
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <h2 className={styles.title}>运营指标</h2>
          <p className={styles.scope} aria-live="polite">
            数据范围：{scopeLabel} · {rangeLabel}
          </p>
        </div>
        <div className={styles.controls}>
          <Select
            aria-label="指标店铺范围"
            value={shopId}
            onChange={(e) => setShopId(e.target.value)}
            options={shopOptions}
          />
          <Select
            aria-label="指标时间范围"
            value={rangeMs}
            onChange={(e) => setRangeMs(e.target.value)}
            options={TIME_RANGES}
          />
        </div>
      </div>

      {loading ? (
        <LoadingSpinner size={28} />
      ) : summary ? (
        <>
          <div className={styles.summaryGrid}>
            <MetricCard icon={<Zap size={16} />} label="API 调用" value={summary.apiCalls} color="var(--accent)" />
            <MetricCard icon={<BarChart3 size={16} />} label="Token 输入" value={summary.tokensInput} color="var(--info)" />
            <MetricCard icon={<BarChart3 size={16} />} label="Token 输出" value={summary.tokensOutput} color="var(--success)" />
            <MetricCard icon={<MessageSquare size={16} />} label="收到消息" value={summary.messagesReceived} color="var(--warning)" />
            <MetricCard icon={<MessageSquare size={16} />} label="发送回复" value={summary.repliesSent} color="var(--success)" />
            <MetricCard icon={<AlertTriangle size={16} />} label="回复失败" value={summary.replyFailed} color="var(--danger)" />
            <MetricCard icon={<Shield size={16} />} label="敏感词拦截" value={summary.sensitiveBlocked} color="var(--danger)" />
            <MetricCard icon={<Activity size={16} />} label="状态转换" value={summary.stateTransitions} color="var(--info)" />
            <MetricCard icon={<Clock size={16} />} label="限流拒绝" value={summary.rateLimitRejected} color="var(--warning)" />
            <MetricCard icon={<Clock size={16} />} label="平均延迟" value={`${summary.avgApiLatency}ms`} color="var(--text-secondary)" />
          </div>

          <Card className={styles.chartSection}>
            <div className={styles.chartHeader}>
              <h3>趋势图</h3>
              <Select
                aria-label="趋势指标"
                value={historyMetric}
                onChange={(e) => setHistoryMetric(e.target.value)}
                options={metricOptions}
              />
            </div>
            {history && history.buckets.length > 0 ? (
              <div className={styles.barChart}>
                {history.buckets.map((bucket, i) => {
                  const height = maxBucket > 0 ? (bucket.total / maxBucket) * 100 : 0;
                  return (
                    <div key={i} className={styles.barWrapper}>
                      <div className={styles.barValue}>{bucket.total}</div>
                      <div
                        className={styles.bar}
                        style={{ height: `${Math.max(height, 2)}%` }}
                        title={`${bucket.total} (${bucket.count}次)`}
                      />
                      <div className={styles.barLabel}>
                        {new Date(bucket.bucketStart).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className={styles.noData}>暂无趋势数据</div>
            )}
          </Card>
        </>
      ) : (
        <div className={styles.noData}>暂无数据</div>
      )}
    </div>
  );
}

function MetricCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string | number; color: string }) {
  return (
    <Card className={styles.metricCard}>
      <div className={styles.metricIcon} style={{ color }}>{icon}</div>
      <div className={styles.metricValue} style={{ color }}>{value}</div>
      <div className={styles.metricLabel}>{label}</div>
    </Card>
  );
}
