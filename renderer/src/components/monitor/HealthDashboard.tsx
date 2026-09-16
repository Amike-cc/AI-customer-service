import { useEffect, useState, useCallback, useRef } from 'react';
import { Activity, Heart, AlertTriangle, CheckCircle, XCircle, Clock, MessageSquare, Reply, RefreshCw } from 'lucide-react';
import type { ShopListItem } from '../../types/api';
import { Card } from '../common/Card';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { useToast } from '../common/Toast';
import styles from './HealthDashboard.module.css';

interface HealthDashboardProps {
  shops: ShopListItem[];
}

interface MetricsSummary {
  messagesReceived: number;
  repliesSent: number;
  replyFailed: number;
  rateLimitRejected: number;
  apiCalls: number;
  avgApiLatency: number;
}

const STATE_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  Healthy: { label: '健康', color: 'var(--success)', icon: <CheckCircle size={14} /> },
  Degrading: { label: '降级', color: 'var(--warning)', icon: <AlertTriangle size={14} /> },
  VisualMode: { label: '视觉模式', color: 'var(--info)', icon: <Activity size={14} /> },
  SilentWait: { label: '静默等待', color: 'var(--accent)', icon: <Clock size={14} /> },
  ManualMode: { label: '人工模式', color: 'var(--accent)', icon: <Activity size={14} /> },
  Error: { label: '错误', color: 'var(--danger)', icon: <XCircle size={14} /> },
  Stopped: { label: '已停止', color: 'var(--text-muted)', icon: <XCircle size={14} /> },
  LoggedOut: { label: '待登录', color: 'var(--warning)', icon: <AlertTriangle size={14} /> },
  LoggingIn: { label: '登录中', color: 'var(--info)', icon: <Clock size={14} /> },
};

export function HealthDashboard({ shops }: HealthDashboardProps) {
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const toast = useToast();
  const errorShownRef = useRef(false);

  const loadMetrics = useCallback(async () => {
    setRefreshing(true);
    try {
      const summary = await window.api.metrics.summary(Date.now() - 3600000);
      setMetrics(summary as MetricsSummary);
      setLoadError(null);
      setLastUpdatedAt(Date.now());
      errorShownRef.current = false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLoadError(message);
      // 健康面板 15 秒轮询，仅首次失败弹 toast，避免反复打扰
      if (!errorShownRef.current) {
        toast.show('error', '加载健康指标失败: ' + message);
        errorShownRef.current = true;
      }
      console.error('[HealthDashboard] 加载健康指标失败:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadMetrics();
    const timer = setInterval(() => void loadMetrics(), 15000);
    return () => clearInterval(timer);
  }, [loadMetrics]);

  const healthyCount = shops.filter((s) => s.state === 'Healthy' && s.loginStatus === 'logged_in').length;
  const errorCount = shops.filter((s) => s.state === 'Error' || (s.loginStatus === 'logged_out' && s.state !== null && s.state !== 'Stopped')).length;
  const stoppedCount = shops.filter((s) => s.state === null || s.state === 'Stopped').length;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          <Heart size={18} />
          健康监控
        </h2>
        <div className={styles.headerMeta}>
          <span aria-live="polite">{lastUpdatedAt ? `最后更新 ${new Date(lastUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '尚未更新'}</span>
          <button type="button" className={styles.refreshBtn} onClick={loadMetrics} aria-label="刷新健康数据" aria-busy={refreshing} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? styles.spinning : undefined} />
          </button>
        </div>
      </div>

      {loadError && (
        <div className={styles.errorBanner} role="alert">
          指标刷新失败，当前仍显示上一次数据：{loadError}
        </div>
      )}

      {loading ? (
        <LoadingSpinner size={28} />
      ) : (
        <>
          <div className={styles.overview}>
            <Card className={styles.statCard}>
              <div className={styles.statLabel}>总店铺</div>
              <div className={styles.statValue}>{shops.length}</div>
            </Card>
            <Card className={styles.statCard}>
                <div className={`${styles.statLabel} ${styles.successText}`}>健康</div>
                <div className={`${styles.statValue} ${styles.successText}`}>{healthyCount}</div>
            </Card>
            <Card className={styles.statCard}>
                <div className={`${styles.statLabel} ${styles.dangerText}`}>异常</div>
                <div className={`${styles.statValue} ${styles.dangerText}`}>{errorCount}</div>
            </Card>
            <Card className={styles.statCard}>
              <div className={styles.statLabel}>已停止</div>
              <div className={styles.statValue}>{stoppedCount}</div>
            </Card>
          </div>

          {metrics && (
            <div className={styles.overview}>
              <Card className={styles.statCard}>
                <div className={styles.statLabel}><MessageSquare size={12} /> 接收消息</div>
                <div className={styles.statValue}>{metrics.messagesReceived}</div>
              </Card>
              <Card className={styles.statCard}>
                <div className={styles.statLabel}><Reply size={12} /> 发送回复</div>
                <div className={styles.statValue}>{metrics.repliesSent}</div>
              </Card>
              <Card className={styles.statCard}>
                <div className={styles.statLabel}>API 调用</div>
                <div className={styles.statValue}>{metrics.apiCalls}</div>
              </Card>
              <Card className={styles.statCard}>
                <div className={styles.statLabel}>平均延迟</div>
                <div className={styles.statValue}>{Number.isFinite(metrics.avgApiLatency) ? `${metrics.avgApiLatency.toFixed(0)}ms` : '暂无'}</div>
              </Card>
            </div>
          )}

          <Card className={styles.section}>
            <div className={styles.sectionTitle}>店铺状态详情</div>
            {shops.length > 0 ? (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption className={styles.srOnly}>全部店铺当前运行状态</caption>
                  <thead>
                    <tr>
                      <th scope="col">店铺</th>
                      <th scope="col">状态</th>
                      <th scope="col">未读</th>
                      <th scope="col">自动回复</th>
                      <th scope="col">登录状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shops.map((s) => {
                      const effectiveState = s.loginStatus === 'logged_out'
                        ? 'LoggedOut'
                        : s.loginStatus === 'logging_in'
                          ? 'LoggingIn'
                          : (s.state ?? 'Stopped');
                      const cfg = STATE_CONFIG[effectiveState] ?? STATE_CONFIG.Stopped;
                      return (
                        <tr key={s.shopId}>
                          <td className={styles.nameCell}>{s.shopName}</td>
                          <td>
                            <span className={styles.stateTag} style={{ color: cfg.color }}>
                              {cfg.icon}
                              {cfg.label}
                            </span>
                          </td>
                          <td>
                            {(s.stateRecord as { unreadCount?: number } | null)?.unreadCount ? (
                              <span className={styles.unreadBadge}>{(s.stateRecord as { unreadCount?: number }).unreadCount}</span>
                            ) : (
                              <span className={styles.muted}>0</span>
                            )}
                          </td>
                          <td>
                            {s.autoReply ? (
                              <span className={styles.successText}>开启</span>
                            ) : (
                              <span className={styles.muted}>关闭</span>
                            )}
                          </td>
                          <td>
                            <span className={styles.muted}>
                              {s.loginStatus === 'logged_in' ? '已登录' : s.loginStatus === 'logging_in' ? '登录中' : '未登录'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className={styles.empty}>暂无店铺</div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
