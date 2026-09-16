import { useEffect, useRef, useState } from 'react';
import { Check, X, ClipboardList } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Select } from '../common/Select';
import { Badge } from '../common/Badge';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import { useToast } from '../common/Toast';
import type { ReviewRecord, ReviewStatus } from '../../types/api';
import styles from './KnowledgeBase.module.css';

const COMPONENT_OPTIONS = [
  { value: '', label: '全部组件' },
  { value: 'faq', label: 'FAQ' },
  { value: 'template', label: '话术模板' },
  { value: 'prompt', label: 'Prompt 模板' },
];

function formatTime(ts: number | null): string {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function statusBadge(status: ReviewStatus) {
  switch (status) {
    case 'pending_review':
      return <Badge color="warning">待审核</Badge>;
    case 'approved':
      return <Badge color="success">已通过</Badge>;
    case 'rejected':
      return <Badge color="danger">已拒绝</Badge>;
    case 'published':
      return <Badge color="info">已发布</Badge>;
    default:
      return <Badge color="default">草稿</Badge>;
  }
}

interface ReviewPanelProps {
  shopId: string;
}

export function ReviewPanel({ shopId }: ReviewPanelProps) {
  const [pending, setPending] = useState<ReviewRecord[]>([]);
  const [history, setHistory] = useState<ReviewRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterComponent, setFilterComponent] = useState('');
  const [reviewTarget, setReviewTarget] = useState<ReviewRecord | null>(null);
  const [comment, setComment] = useState('');
  const [operating, setOperating] = useState(false);
  const toast = useToast();
  const requestIdRef = useRef(0);

  useEffect(() => {
    void load();
  }, [shopId, filterComponent]);

  const load = async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const [p, h] = await Promise.all([
        window.api.kb.listPendingReviews(shopId),
        window.api.kb.listReviewHistory(
          shopId,
          (filterComponent || undefined) as 'faq' | 'template' | 'prompt' | undefined,
        ),
      ]);
      // 竞态守卫：快速切换店铺/筛选时丢弃过期响应
      if (requestIdRef.current !== requestId) return;
      setPending(p);
      setHistory(h);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      toast.show('error', '加载审核数据失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  };

  const openReview = (r: ReviewRecord) => {
    setReviewTarget(r);
    setComment('');
  };

  const handleApprove = async () => {
    if (!reviewTarget) return;
    setOperating(true);
    try {
      const res = await window.api.kb.approveReview(reviewTarget.reviewId, comment);
      if (!res.ok) {
        toast.show('error', (res as { error?: string }).error ?? '审核失败');
        return;
      }
      toast.show('success', '审核已通过');
      setReviewTarget(null);
      await load();
    } catch (err) {
      toast.show('error', '操作失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setOperating(false);
    }
  };

  const handleReject = async () => {
    if (!reviewTarget) return;
    setOperating(true);
    try {
      const res = await window.api.kb.rejectReview(reviewTarget.reviewId, comment);
      if (!res.ok) {
        toast.show('error', (res as { error?: string }).error ?? '拒绝失败');
        return;
      }
      toast.show('success', '已拒绝');
      setReviewTarget(null);
      await load();
    } catch (err) {
      toast.show('error', '操作失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setOperating(false);
    }
  };

  if (loading) return <LoadingSpinner size={28} />;

  return (
    <div className={styles.panelSection}>
      <PendingReviewSection title="待审核" pending={pending} onApprove={openReview} />
      <div className={styles.toolbar}>
        <div className={styles.panelInfo}>
          <ClipboardList size={14} style={{ display: 'inline', marginRight: 4 }} />
          审核历史（共 {history.length} 条）
        </div>
        <Select
          value={filterComponent}
          onChange={(e) => setFilterComponent(e.target.value)}
          options={COMPONENT_OPTIONS}
        />
      </div>

      {history.length === 0 ? (
        <EmptyState title="暂无审核记录" description="提交审核后将在此显示历史记录" />
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>审核ID</th>
              <th>组件</th>
              <th style={{ width: 80 }}>状态</th>
              <th>提交人</th>
              <th>审核人</th>
              <th>提交时间</th>
              <th>审核时间</th>
              <th>意见</th>
            </tr>
          </thead>
          <tbody>
            {history.map((r) => (
              <tr key={r.reviewId}>
                <td className={styles.cellTruncate} title={r.reviewId}>
                  {r.reviewId}
                </td>
                <td>
                  <span className={styles.badge + ' ' + styles.badgeInfo}>{r.component}</span>
                </td>
                <td>{statusBadge(r.status)}</td>
                <td>{r.author}</td>
                <td>{r.reviewer ?? '-'}</td>
                <td>{formatTime(r.submittedAt)}</td>
                <td>{formatTime(r.reviewedAt)}</td>
                <td className={styles.cellTruncate} title={r.reviewComment ?? ''}>
                  {r.reviewComment ?? '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal
        open={reviewTarget !== null}
        onClose={() => setReviewTarget(null)}
        title="审核内容"
        width={560}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReviewTarget(null)}>
              取消
            </Button>
            <Button variant="danger" onClick={handleReject} loading={operating}>
              <X size={12} />
              拒绝
            </Button>
            <Button variant="primary" onClick={handleApprove} loading={operating}>
              <Check size={12} />
              通过
            </Button>
          </>
        }
      >
        {reviewTarget && (
          <div className={styles.form}>
            <div className={styles.suggestionHeader}>
              <span className={styles.badge + ' ' + styles.badgeInfo}>{reviewTarget.component}</span>
              <span className={styles.panelInfo}>目标: {reviewTarget.targetId}</span>
              <span className={styles.panelInfo}>提交人: {reviewTarget.author}</span>
            </div>
            <label className={styles.field}>
              <span>内容</span>
              <div className={styles.jsonPreview}>
                {(() => {
                  try {
                    return JSON.stringify(JSON.parse(reviewTarget.payload), null, 2);
                  } catch {
                    return reviewTarget.payload;
                  }
                })()}
              </div>
            </label>
            <label className={styles.field}>
              <span>审核意见</span>
              <textarea
                className={styles.textarea}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="填写审核意见（可选）"
                rows={3}
              />
            </label>
          </div>
        )}
      </Modal>
    </div>
  );
}

function PendingReviewSection({
  title,
  pending,
  onApprove,
}: {
  title: string;
  pending: ReviewRecord[];
  onApprove: (r: ReviewRecord) => void;
}) {
  return (
    <>
      <div className={styles.panelInfo} style={{ fontWeight: 600 }}>
        {title}（{pending.length} 条）
      </div>
      {pending.length === 0 ? (
        <EmptyState title="暂无待审核内容" description="所有内容已审核完毕" />
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>审核ID</th>
              <th>组件</th>
              <th>目标ID</th>
              <th>提交人</th>
              <th>提交时间</th>
              <th style={{ width: 100 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((r) => (
              <tr key={r.reviewId}>
                <td className={styles.cellTruncate} title={r.reviewId}>
                  {r.reviewId}
                </td>
                <td>
                  <span className={styles.badge + ' ' + styles.badgeInfo}>{r.component}</span>
                </td>
                <td className={styles.cellTruncate} title={r.targetId}>
                  {r.targetId}
                </td>
                <td>{r.author}</td>
                <td>{formatTime(r.submittedAt)}</td>
                <td>
                  <Button size="sm" variant="primary" onClick={() => onApprove(r)}>
                    <Check size={12} />
                    审核
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
