import { useEffect, useRef, useState } from 'react';
import { History, RotateCcw, Trash2, Eye } from 'lucide-react';
import { Modal } from '../common/Modal';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Button } from '../common/Button';
import { Select } from '../common/Select';
import { Badge } from '../common/Badge';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import { useToast } from '../common/Toast';
import type { KbVersion, VersionComponent } from '../../types/api';
import styles from './KnowledgeBase.module.css';

const COMPONENT_LABELS: Record<VersionComponent, string> = {
  prompt: 'Prompt 模板',
  faq: 'FAQ',
  rules: '规则引擎',
  sensitive: '敏感词',
  templates: '话术模板',
};

const COMPONENT_OPTIONS = [
  { value: '', label: '全部组件' },
  ...Object.entries(COMPONENT_LABELS).map(([value, label]) => ({ value, label })),
];

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface VersionPanelProps {
  shopId: string;
}

export function VersionPanel({ shopId }: VersionPanelProps) {
  const [versions, setVersions] = useState<KbVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterComponent, setFilterComponent] = useState('');
  const [viewTarget, setViewTarget] = useState<KbVersion | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<KbVersion | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KbVersion | null>(null);
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
      const list = await window.api.kb.listVersions(
        shopId,
        (filterComponent || undefined) as VersionComponent | undefined,
      );
      // 竞态守卫：快速切换店铺/筛选时丢弃过期响应
      if (requestIdRef.current !== requestId) return;
      setVersions(list);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      toast.show('error', '加载版本失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  };

  const handleRollback = async () => {
    if (!rollbackTarget) return;
    setOperating(true);
    try {
      await window.api.kb.rollback(shopId, rollbackTarget.versionId);
      toast.show('success', '版本已回滚');
      setRollbackTarget(null);
      await load();
    } catch (err) {
      toast.show('error', '回滚失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setOperating(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setOperating(true);
    try {
      const res = await window.api.kb.deleteVersion(deleteTarget.versionId, shopId);
      if (!res.ok) {
        toast.show('error', res.error ?? '删除失败');
        return;
      }
      toast.show('success', '版本已删除');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast.show('error', '删除失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setOperating(false);
    }
  };

  if (loading) return <LoadingSpinner size={28} />;

  return (
    <div className={styles.panelSection}>
      <div className={styles.toolbar}>
        <div className={styles.panelInfo}>
          <History size={14} style={{ display: 'inline', marginRight: 4 }} />
          版本历史记录（共 {versions.length} 个版本）
        </div>
        <Select
          value={filterComponent}
          onChange={(e) => setFilterComponent(e.target.value)}
          options={COMPONENT_OPTIONS}
        />
      </div>

      {versions.length === 0 ? (
        <EmptyState title="暂无版本记录" description="知识库变更后将自动创建版本快照" />
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>版本ID</th>
              <th>组件</th>
              <th style={{ width: 90 }}>动作</th>
              <th>创建人</th>
              <th>创建时间</th>
              <th>描述</th>
              <th style={{ width: 120 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.versionId}>
                <td className={styles.cellTruncate} title={v.versionId}>
                  {v.versionId}
                </td>
                <td>
                  <span className={styles.badge + ' ' + styles.badgeInfo}>
                    {COMPONENT_LABELS[v.component] ?? v.component}
                  </span>
                </td>
                <td>
                  {v.action === 'rollback' ? (
                    <Badge color="warning">回滚</Badge>
                  ) : v.action === 'import' ? (
                    <Badge color="info">导入</Badge>
                  ) : (
                    <Badge color="default">更新</Badge>
                  )}
                </td>
                <td>{v.createdBy}</td>
                <td>{formatTime(v.createdAt)}</td>
                <td className={styles.cellTruncate} title={v.description}>
                  {v.description}
                </td>
                <td>
                  <div className={styles.rowActions}>
                    <button
                      className={styles.editBtn}
                      onClick={() => setViewTarget(v)}
                      title="查看快照"
                    >
                      <Eye size={14} />
                    </button>
                    <button
                      className={styles.editBtn}
                      onClick={() => setRollbackTarget(v)}
                      title="回滚到此版本"
                    >
                      <RotateCcw size={14} />
                    </button>
                    <button
                      className={styles.deleteBtn}
                      onClick={() => setDeleteTarget(v)}
                      title="删除版本"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal
        open={viewTarget !== null}
        onClose={() => setViewTarget(null)}
        title={`版本快照 - ${viewTarget?.versionId}`}
        width={640}
        footer={
          <Button variant="ghost" onClick={() => setViewTarget(null)}>
            关闭
          </Button>
        }
      >
        <div className={styles.jsonPreview}>
          {viewTarget
            ? (() => {
                try {
                  return JSON.stringify(JSON.parse(viewTarget.snapshot), null, 2);
                } catch {
                  return viewTarget.snapshot;
                }
              })()
            : ''}
        </div>
      </Modal>

      <ConfirmDialog
        open={rollbackTarget !== null}
        title="回滚版本"
        message={`确认回滚到版本 "${rollbackTarget?.versionId}"？将创建新的回滚版本记录。`}
        confirmLabel="回滚"
        onConfirm={handleRollback}
        onCancel={() => setRollbackTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除版本"
        message={`确认删除版本 "${deleteTarget?.versionId}"？此操作不可恢复。`}
        confirmLabel="删除"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
