import { Fragment, memo, useCallback, useEffect, useRef, useState } from 'react';
import { FileText, RefreshCw, ChevronDown, ChevronRight, ThumbsUp, ThumbsDown } from 'lucide-react';
import type { ShopListItem, AuditLogEntry } from '../../types/api';
import { Select } from '../common/Select';
import { Button } from '../common/Button';
import { SearchInput } from '../common/SearchInput';
import { EmptyState } from '../common/EmptyState';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { useToast } from '../common/Toast';
import { formatDate, truncate } from '../../utils/format';
import styles from './AuditLogViewer.module.css';

interface AuditLogViewerProps {
  shops: ShopListItem[];
}

export const AuditLogViewer = memo(function AuditLogViewer({ shops }: AuditLogViewerProps) {
  const [shopId, setShopId] = useState('');
  const [records, setRecords] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [feedbackMap, setFeedbackMap] = useState<Record<number, number>>({});
  const [feedbackLoading, setFeedbackLoading] = useState<number | null>(null);
  const requestIdRef = useRef(0);
  const toast = useToast();

  const loadAudit = useCallback(async (sid: string) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const list = await window.api.audit.list(sid, 200);
      if (requestId === requestIdRef.current) setRecords(list);
    } catch (err) {
      if (requestId === requestIdRef.current) {
        toast.show('error', '加载审计日志失败: ' + (err instanceof Error ? err.message : String(err)));
        setRecords([]);
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!shopId) {
      setRecords([]);
      return;
    }
    void loadAudit(shopId);
  }, [shopId, loadAudit]);

  const handleRefresh = () => {
    if (shopId) void loadAudit(shopId);
  };

  const handleFeedback = async (record: AuditLogEntry, rating: number) => {
    const current = feedbackMap[record.id];
    if (current === rating) return;
    setFeedbackLoading(record.id);
    try {
      const result = await window.api.feedback.add(record.id, record.shopId, record.sessionId, rating);
      if (!result.ok) {
        throw new Error(
          'error' in result && typeof result.error === 'string'
            ? result.error
            : '后端未能保存反馈',
        );
      }
      setFeedbackMap((prev) => ({ ...prev, [record.id]: rating }));
      toast.show('success', rating > 0 ? '已标记为优质回复' : '已标记为低质量回复');
    } catch (err) {
      toast.show('error', '反馈提交失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setFeedbackLoading(null);
    }
  };

  const loadFeedback = useCallback(async (sid: string) => {
    try {
      const list = await window.api.feedback.list(sid, 200);
      const map: Record<number, number> = {};
      for (const f of list) {
        if (map[f.auditId] === undefined) map[f.auditId] = f.rating;
      }
      setFeedbackMap(map);
    } catch (err) {
      toast.show('error', '加载反馈数据失败: ' + (err instanceof Error ? err.message : String(err)));
      setFeedbackMap({});
    }
  }, [toast]);

  useEffect(() => {
    if (!shopId) {
      setFeedbackMap({});
      return;
    }
    void loadFeedback(shopId);
  }, [shopId, loadFeedback]);

  const filteredRecords = search
    ? records.filter(
        (r) =>
          r.userMessage.toLowerCase().includes(search.toLowerCase()) ||
          r.aiReply.toLowerCase().includes(search.toLowerCase()) ||
          r.sessionId.toLowerCase().includes(search.toLowerCase()),
      )
    : records;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>审计日志</h2>
        <div className={styles.toolbar}>
          <Select
            aria-label="选择审计日志店铺"
            value={shopId}
            onChange={(e) => setShopId(e.target.value)}
            options={[
              { value: '', label: '选择店铺' },
              ...shops.map((s) => ({ value: s.shopId, label: s.shopName })),
            ]}
          />
          <SearchInput placeholder="搜索消息/回复/会话..." onSearch={setSearch} />
          <Button size="sm" onClick={handleRefresh} loading={loading} disabled={!shopId}>
            <RefreshCw size={13} />
            刷新
          </Button>
        </div>
      </div>
      <div className={styles.stats}>
        <span>当前加载 {records.length} 条（最多显示最近 200 条）</span>
        {search && <span>· 过滤后 {filteredRecords.length} 条</span>}
      </div>
      <div className={styles.tableWrap}>
        {loading ? (
          <LoadingSpinner size={24} />
        ) : filteredRecords.length === 0 ? (
          <EmptyState
            title={search && records.length > 0 ? '没有匹配的审计记录' : shopId ? '该店铺暂无审计记录' : '请选择店铺查看审计日志'}
            description={search && records.length > 0 ? '请调整搜索关键词，或清空搜索条件。' : undefined}
            icon={<FileText size={32} />}
          />
        ) : (
          <table className={styles.table}>
            <caption className={styles.srOnly}>当前店铺最近的 AI 客服审计记录</caption>
            <thead>
              <tr>
                <th className={styles.expandCol} scope="col"><span className={styles.srOnly}>展开详情</span></th>
                <th className={styles.time} scope="col">时间</th>
                <th scope="col">用户消息</th>
                <th className={styles.replyCol} scope="col">AI 回复</th>
                <th scope="col">模型</th>
                <th className={styles.numCol} scope="col">Token入</th>
                <th className={styles.numCol} scope="col">Token出</th>
                <th className={styles.numCol} scope="col">延迟</th>
              </tr>
            </thead>
            <tbody>
              {filteredRecords.map((r) => (
                <Fragment key={r.id}>
                  <tr className={styles.row}>
                    <td className={styles.expandCol}>
                      <button
                        type="button"
                        className={styles.expandButton}
                        aria-label={expandedId === r.id ? '收起审计详情' : '展开审计详情'}
                        aria-expanded={expandedId === r.id}
                        aria-controls={`audit-detail-${r.id}`}
                        onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                      >
                        {expandedId === r.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </button>
                    </td>
                    <td className={styles.time}>{formatDate(r.createdAt)}</td>
                    <td className={styles.message}>{truncate(r.userMessage, 40)}</td>
                    <td className={styles.replyCol}>{truncate(r.aiReply, 50)}</td>
                    <td className={styles.model}>{r.modelVersion}</td>
                    <td className={styles.numCol}>{r.tokenInput ?? '-'}</td>
                    <td className={styles.numCol}>{r.tokenOutput ?? '-'}</td>
                    <td className={styles.numCol}>{r.latencyMs != null ? `${r.latencyMs}ms` : '-'}</td>
                  </tr>
                  {expandedId === r.id && (
                    <tr className={styles.detailRow} id={`audit-detail-${r.id}`}>
                      <td colSpan={8}>
                        <div className={styles.detailContent}>
                          <div className={styles.detailSection}>
                            <span className={styles.detailLabel}>完整用户消息</span>
                            <p className={styles.detailText}>{r.userMessage}</p>
                          </div>
                          <div className={styles.detailSection}>
                            <span className={styles.detailLabel}>完整 AI 回复</span>
                            <p className={styles.detailText}>{r.aiReply}</p>
                          </div>
                          <div className={styles.detailMeta}>
                            <span>会话ID: {r.sessionId}</span>
                            <span>商品ID: {r.productId ?? '无'}</span>
                            <span>置信度: {r.confidence != null ? (r.confidence * 100).toFixed(0) + '%' : '-'}</span>
                            <span>Prompt Hash: {r.promptHash}</span>
                          </div>
                          <div className={styles.feedbackSection}>
                            <span className={styles.detailLabel}>回复质量反馈</span>
                            <div className={styles.feedbackButtons}>
                              <button
                                type="button"
                                className={`${styles.feedbackBtn} ${feedbackMap[r.id] === 1 ? styles.feedbackBtnActive : ''}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleFeedback(r, 1);
                                }}
                                disabled={feedbackLoading === r.id}
                                title="优质回复"
                              >
                                <ThumbsUp size={14} />
                                <span>优质</span>
                              </button>
                              <button
                                type="button"
                                className={`${styles.feedbackBtn} ${feedbackMap[r.id] === -1 ? styles.feedbackBtnActiveNegative : ''}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleFeedback(r, -1);
                                }}
                                disabled={feedbackLoading === r.id}
                                title="低质量回复"
                              >
                                <ThumbsDown size={14} />
                                <span>待改进</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
});
