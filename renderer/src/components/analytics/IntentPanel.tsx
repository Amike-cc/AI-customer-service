import { useCallback, useEffect, useRef, useState } from 'react';
import { Brain, RefreshCw } from 'lucide-react';
import type { EscalationStats, IntentCategoryStat, IntentClassificationRecord, ShopListItem } from '../../types/api';
import { formatRelative } from '../../utils/format';
import { Button } from '../common/Button';
import { Card } from '../common/Card';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { Select } from '../common/Select';
import { useToast } from '../common/Toast';
import styles from './IntentPanel.module.css';

const CATEGORY_LABELS: Record<string, string> = {
  greeting: '问候',
  product_inquiry: '商品咨询',
  purchase_intent: '购买意向',
  after_sales: '售后',
  logistics: '物流',
  complaint: '投诉',
  human_request: '转人工',
  faq: '常见问题',
  chitchat: '闲聊',
  unknown: '未知',
};

const CATEGORY_COLORS: Record<string, string> = {
  greeting: 'var(--success)',
  product_inquiry: 'var(--info)',
  purchase_intent: 'var(--accent)',
  after_sales: 'var(--warning)',
  logistics: 'var(--info)',
  complaint: 'var(--danger)',
  human_request: 'var(--warning)',
  faq: 'var(--accent)',
  chitchat: 'var(--text-muted)',
  unknown: 'var(--text-secondary)',
};

const TIME_RANGES = [
  { value: '86400000', label: '近 24 小时' },
  { value: '604800000', label: '近 7 天' },
  { value: '2592000000', label: '近 30 天' },
];

const ESCALATION_STATUS_CARDS = [
  { status: 'pending', label: '待处理', valueClass: styles.statPending },
  { status: 'assigned', label: '已分配', valueClass: styles.statAssigned },
  { status: 'resolved', label: '已解决', valueClass: styles.statResolved },
];

interface IntentPanelProps {
  shops: ShopListItem[];
}

export function IntentPanel({ shops }: IntentPanelProps) {
  const [shopId, setShopId] = useState('');
  const [rangeMs, setRangeMs] = useState('86400000');
  const [recent, setRecent] = useState<IntentClassificationRecord[]>([]);
  const [stats, setStats] = useState<EscalationStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [dataStale, setDataStale] = useState(false);
  const loadRequestId = useRef(0);
  const { show: showToast } = useToast();

  const resetScopeData = useCallback(() => {
    loadRequestId.current += 1;
    setRecent([]);
    setStats(null);
    setLastUpdatedAt(null);
    setDataStale(false);
    setLoading(false);
  }, []);

  const loadData = useCallback(
    async (showInitialLoading = true): Promise<boolean> => {
      if (!shopId) return false;
      const requestId = ++loadRequestId.current;
      if (showInitialLoading) setLoading(true);

      try {
        const sinceMs = Date.now() - Number(rangeMs);
        const [recentRecords, nextStats] = await Promise.all([
          window.api.intent.recent(shopId, 100),
          window.api.intent.stats(shopId, sinceMs),
        ]);
        if (requestId !== loadRequestId.current) return false;

        setRecent((recentRecords as IntentClassificationRecord[]).filter((record) => record.createdAt >= sinceMs));
        setStats(nextStats as EscalationStats);
        setLastUpdatedAt(Date.now());
        setDataStale(false);
        return true;
      } catch (err) {
        if (requestId !== loadRequestId.current) return false;
        setDataStale(true);
        showToast('error', '加载意图分析数据失败: ' + (err instanceof Error ? err.message : String(err)));
        return false;
      } finally {
        if (requestId === loadRequestId.current && showInitialLoading) {
          setLoading(false);
        }
      }
    },
    [rangeMs, shopId, showToast],
  );

  useEffect(() => {
    const nextShopId = shops.some((shop) => shop.shopId === shopId) ? shopId : (shops[0]?.shopId ?? '');
    if (nextShopId !== shopId) {
      resetScopeData();
      setShopId(nextShopId);
    }
  }, [resetScopeData, shopId, shops]);

  useEffect(() => {
    if (shopId) void loadData();
  }, [loadData, shopId]);

  const handleShopChange = (nextShopId: string) => {
    if (nextShopId === shopId) return;
    resetScopeData();
    setShopId(nextShopId);
  };

  const handleRangeChange = (nextRangeMs: string) => {
    if (nextRangeMs === rangeMs) return;
    resetScopeData();
    setRangeMs(nextRangeMs);
  };

  const handleRefresh = async () => {
    if (!shopId || refreshing) return;
    setRefreshing(true);
    const loaded = await loadData(false);
    if (loaded) showToast('success', '意图分析数据已刷新');
    setRefreshing(false);
  };

  const categoryMaxCount = stats?.categoryStats?.reduce((max, category) => Math.max(max, category.count), 0) ?? 0;
  const escalationTotal = stats?.escalationStats?.reduce((total, entry) => total + entry.count, 0) ?? 0;
  const escalationCounts = new Map(stats?.escalationStats?.map((entry) => [entry.status, entry.count]) ?? []);
  const selectedShopName = shops.find((shop) => shop.shopId === shopId)?.shopName;
  const selectedRangeLabel = TIME_RANGES.find((range) => range.value === rangeMs)?.label ?? '所选时段';
  const lastUpdatedText = lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : null;

  return (
    <div className={styles.container} aria-busy={loading || refreshing}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h2 className={styles.title}>
            <Brain size={18} aria-hidden="true" />
            意图分析
          </h2>
          <p className={styles.subtitle}>分析买家意图分布、复杂度与升级趋势</p>
          <p
            className={[styles.dataStatus, dataStale && styles.dataStatusStale].filter(Boolean).join(' ')}
            role="status"
            aria-live="polite"
          >
            {dataStale
              ? '数据可能已过期'
              : lastUpdatedAt
                ? '数据已更新'
                : shopId
                  ? '正在获取当前筛选数据'
                  : '尚无可用店铺'}
            {lastUpdatedAt && lastUpdatedText && (
              <>
                {' · 最近更新 '}
                <time dateTime={new Date(lastUpdatedAt).toISOString()}>{lastUpdatedText}</time>
              </>
            )}
          </p>
        </div>

        <div className={styles.toolbar} role="group" aria-label="意图分析筛选与刷新">
          <Select
            className={styles.shopSelect}
            aria-label="意图分析店铺"
            value={shopId}
            onChange={(event) => handleShopChange(event.target.value)}
            options={
              shops.length > 0
                ? shops.map((shop) => ({ value: shop.shopId, label: shop.shopName }))
                : [{ value: '', label: '暂无可用店铺' }]
            }
            disabled={shops.length === 0 || loading || refreshing}
          />
          <Select
            className={styles.rangeSelect}
            aria-label="意图分析时间范围"
            value={rangeMs}
            onChange={(event) => handleRangeChange(event.target.value)}
            options={TIME_RANGES}
            disabled={!shopId || loading || refreshing}
          />
          <Button
            size="sm"
            onClick={() => void handleRefresh()}
            loading={refreshing}
            disabled={!shopId || loading}
            aria-label={selectedShopName ? `刷新${selectedShopName}的意图分析数据` : '刷新意图分析数据'}
          >
            <RefreshCw size={13} aria-hidden="true" />
            刷新数据
          </Button>
        </div>
      </header>

      {!shopId ? (
        <div className={styles.pageEmpty} role="status">
          暂无可用店铺，请先在全局设置中添加并启用店铺。
        </div>
      ) : loading ? (
        <LoadingSpinner size={28} />
      ) : (
        <>
          <div
            className={styles.statsRow}
            role="group"
            aria-label={`${selectedRangeLabel}升级工单概览`}
          >
            {ESCALATION_STATUS_CARDS.map((item) => (
              <Card key={item.status} className={styles.statCard}>
                <div className={styles.statLabel}>{item.label}</div>
                <div className={`${styles.statValue} ${item.valueClass}`}>{escalationCounts.get(item.status) ?? 0}</div>
              </Card>
            ))}
            <Card className={styles.statCard}>
              <div className={styles.statLabel}>总升级数</div>
              <div className={`${styles.statValue} ${styles.statTotal}`}>{escalationTotal}</div>
            </Card>
          </div>

          <Card className={styles.section}>
            <h3 className={styles.sectionTitle}>意图分类分布</h3>
            {stats && stats.categoryStats.length > 0 ? (
              <div
                className={styles.chartLayout}
                role="group"
                aria-label={`${selectedShopName ?? '当前店铺'}${selectedRangeLabel}意图分类分布`}
              >
                <div className={styles.donutWrap}>
                  <DonutChart stats={stats.categoryStats} />
                </div>
                <div className={styles.barChart} role="list" aria-label="意图分类数量">
                  {stats.categoryStats.map((category) => {
                    const categoryLabel = CATEGORY_LABELS[category.category] ?? category.category;
                    const width = categoryMaxCount > 0 ? (category.count / categoryMaxCount) * 100 : 0;
                    return (
                      <div key={category.category} className={styles.barRow} role="listitem">
                        <span className={styles.barLabel}>{categoryLabel}</span>
                        <div
                          className={styles.barTrack}
                          role="progressbar"
                          aria-label={`${categoryLabel}数量`}
                          aria-valuemin={0}
                          aria-valuemax={categoryMaxCount}
                          aria-valuenow={category.count}
                        >
                          <div
                            className={styles.barFill}
                            style={{
                              width: `${width}%`,
                              background: CATEGORY_COLORS[category.category] ?? 'var(--info)',
                            }}
                            aria-hidden="true"
                          />
                        </div>
                        <span className={styles.barCount}>{category.count}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className={styles.empty} role="status">
                当前店铺在{selectedRangeLabel}内暂无意图分类数据。
              </div>
            )}
          </Card>

          <Card className={styles.section}>
            <h3 className={styles.sectionTitle}>最近意图分类记录</h3>
            {recent.length > 0 ? (
              <div className={styles.tableWrap} role="region" aria-label="最近意图分类记录，可横向滚动" tabIndex={0}>
                <table className={styles.table}>
                  <caption className={styles.tableCaption}>
                    {selectedShopName ?? '当前店铺'}在{selectedRangeLabel}内最近的意图分类记录，最多 100 条
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">消息</th>
                      <th scope="col">分类</th>
                      <th scope="col">置信度</th>
                      <th scope="col">复杂度</th>
                      <th scope="col">升级</th>
                      <th scope="col">时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((record) => (
                      <tr key={record.id}>
                        <th scope="row" className={styles.msgCell} title={record.userMessage}>
                          {record.userMessage}
                        </th>
                        <td>
                          <span className={styles.categoryTag}>
                            {CATEGORY_LABELS[record.category] ?? record.category}
                          </span>
                        </td>
                        <td className={styles.numericCell}>{(record.confidence * 100).toFixed(0)}%</td>
                        <td>
                          <span className={record.complexityScore >= 0.6 ? styles.complexityHigh : styles.muted}>
                            {record.complexityLevel} ({record.complexityScore.toFixed(2)})
                          </span>
                        </td>
                        <td>
                          {record.shouldEscalate ? (
                            <span className={styles.escalateBadge}>是</span>
                          ) : (
                            <span className={styles.muted}>否</span>
                          )}
                        </td>
                        <td className={styles.muted}>{formatRelative(record.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className={styles.empty} role="status">
                当前店铺在{selectedRangeLabel}内暂无意图分类记录。
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function DonutChart({ stats }: { stats: IntentCategoryStat[] }) {
  const total = stats.reduce((sum, category) => sum + category.count, 0);
  if (total === 0) return null;

  let cumulative = 0;
  const segments = stats.map((category) => {
    const start = cumulative;
    const percentage = category.count / total;
    cumulative += percentage;
    return {
      category: category.category,
      start: start * 360,
      end: cumulative * 360,
      color: CATEGORY_COLORS[category.category] ?? 'var(--info)',
    };
  });
  const gradient = segments.map((segment) => `${segment.color} ${segment.start}deg ${segment.end}deg`).join(', ');
  const accessibleSummary = stats
    .map((category) => `${CATEGORY_LABELS[category.category] ?? category.category} ${category.count}`)
    .join('，');

  return (
    <div className={styles.donut} role="img" aria-label={`意图总数 ${total}；${accessibleSummary}`}>
      <div className={styles.donutChart} style={{ background: `conic-gradient(${gradient})` }} aria-hidden="true">
        <div className={styles.donutHole}>
          <div className={styles.donutTotal}>{total}</div>
          <div className={styles.donutLabel}>总意图</div>
        </div>
      </div>
    </div>
  );
}
