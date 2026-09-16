import { useState, useEffect, useCallback, useRef } from 'react';
import { Brain, Zap, TrendingUp, ThumbsUp, ThumbsDown, Search } from 'lucide-react';
import type { ShopListItem, LearnedPatternEntry, LearningRunEntry, LearningStats } from '../../types/api';
import { Card } from '../common/Card';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { Select } from '../common/Select';
import { Badge } from '../common/Badge';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { useToast } from '../common/Toast';
import { formatRelative } from '../../utils/format';
import styles from './LearningPanel.module.css';

interface LearningPanelProps {
  shops: ShopListItem[];
}

export function LearningPanel({ shops }: LearningPanelProps) {
  const [shopId, setShopId] = useState('');
  const [patterns, setPatterns] = useState<LearnedPatternEntry[]>([]);
  const [runs, setRuns] = useState<LearningRunEntry[]>([]);
  const [stats, setStats] = useState<LearningStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showTriggerConfirm, setShowTriggerConfirm] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const requestIdRef = useRef(0);
  const toast = useToast();

  const loadData = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!shopId) {
      setPatterns([]);
      setRuns([]);
      setStats(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [p, r, s] = await Promise.all([
        window.api.learning.patterns(shopId),
        window.api.learning.runs(shopId, 20),
        window.api.learning.stats(shopId),
      ]);
      if (requestId === requestIdRef.current) {
        setPatterns(p);
        setRuns(r);
        setStats(s);
      }
    } catch (err) {
      if (requestId === requestIdRef.current) {
        toast.show('error', '加载学习数据失败: ' + (err instanceof Error ? err.message : String(err)));
        setPatterns([]);
        setRuns([]);
        setStats(null);
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [shopId, toast]);

  useEffect(() => {
    if (shops.length === 0) {
      setShopId('');
    } else if (!shops.some((shop) => shop.shopId === shopId)) {
      setShopId(shops[0].shopId);
    }
  }, [shops, shopId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleTrigger = async () => {
    setTriggering(true);
    try {
      const result = await window.api.learning.trigger(shopId || undefined);
      // 主进程失败时返回 {ok:false, error}（不 reject），必须检查避免误报成功与 undefined 展示
      if (!result.ok) {
        toast.show('error', (result as { error?: string }).error ?? '学习触发失败');
        return;
      }
      toast.show('success', `学习完成：收集 ${result.collectedCount} 条，提取 ${result.extractedCount} 条，验证 ${result.validatedCount} 条`);
      await loadData();
      setShowTriggerConfirm(false);
    } catch (err) {
      toast.show('error', '学习触发失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setTriggering(false);
    }
  };

  const filtered = patterns.filter((p) => {
    if (statusFilter && p.status !== statusFilter) return false;
    if (search) {
      const lower = search.toLowerCase();
      return p.questionPattern.toLowerCase().includes(lower) || p.answerTemplate.toLowerCase().includes(lower);
    }
    return true;
  });

  const shopOptions = shops.map((s) => ({ value: s.shopId, label: s.shopName }));

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>学习系统</h2>
        <div className={styles.controls}>
          <Select
            aria-label="选择学习数据店铺"
            value={shopId}
            onChange={(e) => setShopId(e.target.value)}
            options={shopOptions}
            disabled={shops.length === 0}
          />
          <Button variant="primary" onClick={() => setShowTriggerConfirm(true)} disabled={triggering || !shopId}>
            <Zap size={14} />
            {triggering ? '学习中...' : '手动学习'}
          </Button>
        </div>
      </div>

      {loading ? (
        <LoadingSpinner size={28} />
      ) : (
        <>
          {stats && <StatsCards stats={stats} />}

          <Card className={styles.section}>
            <div className={styles.sectionHeader}>
              <Brain size={16} />
              <h3>学习模式</h3>
              <span className={styles.count}>{filtered.length} / {patterns.length} 条</span>
            </div>
            <div className={styles.toolbar}>
              <Input
                aria-label="搜索学习模式"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索模式..."
                icon={<Search size={14} />}
              />
              <Select
                aria-label="筛选学习模式状态"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                options={[
                  { value: '', label: '全部状态' },
                  { value: 'active', label: '活跃' },
                  { value: 'deprecated', label: '已弃用' },
                ]}
              />
            </div>
            {filtered.length === 0 ? (
              <EmptyState
                title={(search || statusFilter) && patterns.length > 0 ? '没有匹配的学习模式' : '暂无学习模式'}
                message={(search || statusFilter) && patterns.length > 0 ? '请调整搜索关键词或状态筛选。' : '触发手动学习或等待自动学习运行后生成'}
              />
            ) : (
              <div className={styles.patternList}>
                {filtered.map((p) => (
                  <PatternCard key={p.id} pattern={p} />
                ))}
              </div>
            )}
          </Card>

          <Card className={styles.section}>
            <div className={styles.sectionHeader}>
              <TrendingUp size={16} />
              <h3>运行历史</h3>
            </div>
            {runs.length === 0 ? (
              <EmptyState title="暂无运行记录" message="学习系统尚未运行" />
            ) : (
              <div className={styles.runsTableWrap}>
                <table className={styles.runsTable}>
                  <caption className={styles.srOnly}>当前店铺最近 20 次学习运行记录</caption>
                  <thead>
                    <tr>
                      <th scope="col">时间</th>
                      <th scope="col">店铺</th>
                      <th scope="col">收集</th>
                      <th scope="col">提取</th>
                      <th scope="col">验证</th>
                      <th scope="col">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr key={run.id}>
                        <td>{formatRelative(run.startedAt)}</td>
                        <td>{run.shopId || '全局'}</td>
                        <td>{run.collectedCount}</td>
                        <td>{run.extractedCount}</td>
                        <td>{run.validatedCount}</td>
                        <td>
                          <Badge color={run.status === 'completed' ? 'success' : run.status === 'failed' ? 'danger' : 'info'}>
                            {run.status === 'completed' ? '完成' : run.status === 'failed' ? '失败' : '运行中'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {showTriggerConfirm && (
        <ConfirmDialog
          open={showTriggerConfirm}
          title="确认触发学习"
          message="将立即运行学习管道，分析最近的对话数据以提取新模式。是否继续？"
          confirmLabel="开始学习"
          onConfirm={handleTrigger}
          onCancel={() => setShowTriggerConfirm(false)}
        />
      )}
    </div>
  );
}

function StatsCards({ stats }: { stats: LearningStats }) {
  const items = [
    { icon: <Brain size={18} />, label: '总模式数', value: stats.totalPatterns },
    { icon: <Zap size={18} />, label: '活跃模式', value: stats.activePatterns },
    { icon: <TrendingUp size={18} />, label: '总匹配次数', value: stats.totalMatches },
    { icon: <ThumbsUp size={18} />, label: '正向反馈', value: stats.positiveFeedback },
    { icon: <ThumbsDown size={18} />, label: '负向反馈', value: stats.negativeFeedback },
    { icon: <TrendingUp size={18} />, label: '平均质量', value: `${(stats.avgQuality * 100).toFixed(1)}%` },
  ];

  return (
    <div className={styles.statsGrid}>
      {items.map((item) => (
        <Card key={item.label} className={styles.statCard}>
          <div className={styles.statIcon}>{item.icon}</div>
          <div className={styles.statValue}>{item.value}</div>
          <div className={styles.statLabel}>{item.label}</div>
        </Card>
      ))}
    </div>
  );
}

function PatternCard({ pattern }: { pattern: LearnedPatternEntry }) {
  return (
    <div className={styles.patternCard}>
      <div className={styles.patternHeader}>
        <span className={styles.patternQuestion}>{pattern.questionPattern}</span>
        <Badge color={pattern.status === 'active' ? 'success' : 'default'}>
          {pattern.status === 'active' ? '活跃' : '已弃用'}
        </Badge>
      </div>
      <div className={styles.patternAnswer}>{pattern.answerTemplate}</div>
      <div className={styles.patternMeta}>
        <span>匹配 {pattern.matchCount} 次</span>
        <span>质量 {(pattern.avgQuality * 100).toFixed(0)}%</span>
        <span>{formatRelative(pattern.updatedAt)}</span>
      </div>
    </div>
  );
}
