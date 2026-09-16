import { useEffect, useRef, useState } from 'react';
import { Target, TrendingUp, Lightbulb } from 'lucide-react';
import { Card } from '../common/Card';
import { Button } from '../common/Button';
import { Badge } from '../common/Badge';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import { useToast } from '../common/Toast';
import type {
  AccuracyStats,
  AccuracyTrendPoint,
  OptimizationSuggestion,
} from '../../types/api';
import styles from './KnowledgeBase.module.css';

const PERIOD_OPTIONS: Array<{ value: 'day' | 'week' | 'month'; label: string }> = [
  { value: 'day', label: '今日' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
];

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

interface AccuracyPanelProps {
  shopId: string;
}

export function AccuracyPanel({ shopId }: AccuracyPanelProps) {
  const [stats, setStats] = useState<AccuracyStats | null>(null);
  const [trend, setTrend] = useState<AccuracyTrendPoint[]>([]);
  const [suggestions, setSuggestions] = useState<OptimizationSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day');
  const [expandedExamples, setExpandedExamples] = useState<number | null>(null);
  const toast = useToast();
  const requestIdRef = useRef(0);

  useEffect(() => {
    void loadStats();
  }, [shopId, period]);

  useEffect(() => {
    void loadTrendAndSuggestions();
  }, [shopId]);

  const loadStats = async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const s = await window.api.kb.getAccuracyStats(shopId, period);
      // 竞态守卫：快速切换店铺/周期时丢弃过期响应，避免旧数据覆盖新数据
      if (requestIdRef.current !== requestId) return;
      setStats(s);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      toast.show('error', '加载准确率失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  };

  const loadTrendAndSuggestions = async () => {
    const requestId = ++requestIdRef.current;
    try {
      const [t, sug] = await Promise.all([
        window.api.kb.getAccuracyTrend(shopId, 7),
        window.api.kb.getOptimizationSuggestions(shopId),
      ]);
      if (requestIdRef.current !== requestId) return;
      setTrend(t);
      setSuggestions(sug);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      toast.show('error', '加载趋势与建议失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  if (loading) return <LoadingSpinner size={28} />;

  return (
    <div className={styles.panelSection}>
      <div className={styles.toolbar}>
        <div className={styles.btnGroup}>
          {PERIOD_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant={period === opt.value ? 'primary' : 'default'}
              onClick={() => setPeriod(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {stats && (
        <Card className={styles.statCard}>
          <div className={styles.statIcon}>
            <Target size={16} />
            <span>准确率概览</span>
            {stats.meetsTarget ? (
              <Badge color="success">达标</Badge>
            ) : (
              <Badge color="danger">未达标</Badge>
            )}
          </div>
          <div className={styles.statGrid} style={{ marginTop: 8 }}>
            <div className={styles.statMini}>
              <div className={styles.statMiniLabel}>准确率（目标 {stats.target}%）</div>
              <div className={styles.accuracyBig}>{stats.accuracy}%</div>
            </div>
            <div className={styles.statMini}>
              <div className={styles.statMiniLabel}>总回复数</div>
              <div className={styles.statMiniValue}>{stats.totalReplies}</div>
            </div>
            <div className={styles.statMini}>
              <div className={styles.statMiniLabel}>规则命中</div>
              <div className={styles.statMiniValue}>{stats.ruleMatched}</div>
            </div>
            <div className={styles.statMini}>
              <div className={styles.statMiniLabel}>AI 回复</div>
              <div className={styles.statMiniValue}>{stats.aiReplies}</div>
            </div>
            <div className={styles.statMini}>
              <div className={styles.statMiniLabel}>👍 好评</div>
              <div className={styles.statMiniValue}>{stats.thumbsUp}</div>
            </div>
            <div className={styles.statMini}>
              <div className={styles.statMiniLabel}>👎 差评</div>
              <div className={styles.statMiniValue}>{stats.thumbsDown}</div>
            </div>
            <div className={styles.statMini}>
              <div className={styles.statMiniLabel}>无反馈</div>
              <div className={styles.statMiniValue}>{stats.noFeedback}</div>
            </div>
          </div>
        </Card>
      )}

      <Card className={styles.statCard}>
        <div className={styles.statIcon}>
          <TrendingUp size={16} />
          <span>近 7 天趋势</span>
        </div>
        {trend.length === 0 ? (
          <div className={styles.panelInfo} style={{ marginTop: 8 }}>
            暂无趋势数据
          </div>
        ) : (
          <div className={styles.trendChart} style={{ marginTop: 8 }}>
            {trend.map((point) => {
              const heightPct = Math.max(point.accuracy, 4);
              const isLow = point.accuracy < 95 && point.totalReplies >= 10;
              return (
                <div key={point.timestamp} className={styles.trendBar} title={`准确率: ${point.accuracy}% · 回复: ${point.totalReplies} · 差评: ${point.thumbsDown}`}>
                  <div
                    className={styles.trendBarFill + (isLow ? ' ' + styles.trendBarFillLow : '')}
                    style={{ height: `${heightPct}%` }}
                  />
                  <div className={styles.trendBarLabel}>{formatDate(point.timestamp)}</div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card className={styles.statCard}>
        <div className={styles.statIcon}>
          <Lightbulb size={16} />
          <span>优化建议</span>
          {suggestions.length > 0 && (
            <Badge color="warning">{suggestions.length} 条建议</Badge>
          )}
        </div>
        {suggestions.length === 0 ? (
          <EmptyState title="暂无优化建议" description="当前无负反馈或负反馈较少，继续加油" />
        ) : (
          <div className={styles.suggestionList} style={{ marginTop: 8 }}>
            {suggestions.map((sug, idx) => (
              <div key={idx} className={styles.suggestionItem}>
                <div className={styles.suggestionHeader}>
                  {sug.type === 'new_faq' ? (
                    <Badge color="info">新增 FAQ</Badge>
                  ) : sug.type === 'update_rule' ? (
                    <Badge color="warning">更新规则</Badge>
                  ) : (
                    <Badge color="danger">审查 Prompt</Badge>
                  )}
                  {sug.priority === 'high' ? (
                    <Badge color="danger">高优先级</Badge>
                  ) : sug.priority === 'medium' ? (
                    <Badge color="warning">中优先级</Badge>
                  ) : (
                    <Badge color="default">低优先级</Badge>
                  )}
                </div>
                <div className={styles.suggestionDesc}>{sug.description}</div>
                {sug.examples.length > 0 && (
                  <>
                    <button
                      className={styles.editBtn}
                      onClick={() => setExpandedExamples(expandedExamples === idx ? null : idx)}
                    >
                      {expandedExamples === idx ? '收起示例' : `查看示例 (${sug.examples.length})`}
                    </button>
                    {expandedExamples === idx && (
                      <div className={styles.suggestionExamples}>
                        {sug.examples.map((ex, i) => (
                          <div key={i}>· {ex}</div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
