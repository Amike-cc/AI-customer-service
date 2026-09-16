import { useEffect, useMemo, useState, useRef } from 'react';
import { Plus, Trash2, Search, Download, Upload, Edit2, Star } from 'lucide-react';
import { Modal } from '../common/Modal';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { Select } from '../common/Select';
import { Badge } from '../common/Badge';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import { useToast } from '../common/Toast';
import type { Template, TemplateCategory, CategoryStats } from '../../types/api';
import styles from './KnowledgeBase.module.css';

function assertTemplateOperationOk(
  result: { ok: boolean; error?: string },
  fallbackMessage: string,
): void {
  if (!result.ok) throw new Error(result.error ?? fallbackMessage);
}

const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  greeting: '问候',
  pre_sales: '售前咨询',
  after_sales: '售后处理',
  logistics: '物流查询',
  activity: '活动优惠',
  complaint: '投诉处理',
  
  closing: '结束语',
};

const CATEGORY_OPTIONS = [
  { value: '', label: '全部分类' },
  ...Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label })),
];

function downloadJson(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface TemplatePanelProps {
  shopId: string;
}

export function TemplatePanel({ shopId }: TemplatePanelProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [stats, setStats] = useState<CategoryStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [recommended, setRecommended] = useState<Template[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const loadRequestRef = useRef(0);
  const toast = useToast();

  useEffect(() => {
    void load(filterCategory);
  }, [shopId, filterCategory]);

  const load = async (category = filterCategory) => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    try {
      const [list, categoryStats] = await Promise.all([
        window.api.kb.listTemplates(shopId || undefined, category || undefined),
        window.api.kb.getCategoryStats(shopId || undefined),
      ]);
      if (requestId !== loadRequestRef.current) return;
      setTemplates(list);
      setStats(categoryStats);
    } catch (err) {
      if (requestId !== loadRequestRef.current) return;
      toast.show('error', '加载模板失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
      }
    }
  };

  const filtered = useMemo(() => {
    if (!debouncedSearch.trim()) return templates;
    const lower = debouncedSearch.toLowerCase();
    return templates.filter(
      (t) =>
        t.scenario.toLowerCase().includes(lower) ||
        t.content.toLowerCase().includes(lower) ||
        t.tags.some((tag) => tag.toLowerCase().includes(lower)),
    );
  }, [templates, debouncedSearch]);

  // 搜索防抖 300ms
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  // 加载推荐模板
  useEffect(() => {
    if (!debouncedSearch.trim()) {
      setRecommended([]);
      return;
    }
    void (async () => {
      try {
        const recs = await window.api.kb.recommendTemplates(debouncedSearch, 5);
        setRecommended(recs);
      } catch (err) {
        // 推荐为辅助功能，失败时仅记录日志并清空推荐列表
        console.error('[TemplatePanel] 加载推荐模板失败:', err);
        setRecommended([]);
      }
    })();
  }, [debouncedSearch]);

  const handleAdd = () => {
    setEditing(null);
    setShowForm(true);
  };

  const handleEdit = (tpl: Template) => {
    setEditing(tpl);
    setShowForm(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget || !shopId) return;
    try {
      const result = await window.api.kb.deleteTemplate(shopId, deleteTarget.id);
      assertTemplateOperationOk(result, '后端未能删除话术模板');
      toast.show('success', '模板已删除');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast.show('error', '删除失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleExport = async () => {
    try {
      const json = await window.api.kb.exportTemplates(shopId || undefined, filterCategory || undefined);
      downloadJson(`templates-${shopId || 'global'}-${Date.now()}.json`, json);
      toast.show('success', '模板已导出');
    } catch (err) {
      toast.show('error', '导出失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  if (loading) return <LoadingSpinner size={28} />;

  return (
    <div className={styles.panelSection}>
      <div className={styles.categoryStats}>
        {stats.map((s) => (
          <div key={s.category} className={styles.categoryStatItem}>
            <div className={styles.categoryStatValue}>{s.total}</div>
            <div className={styles.categoryStatLabel}>{CATEGORY_LABELS[s.category]}</div>
            <div className={styles.badgeMuted + ' ' + styles.badge}>
              内置 {s.builtin} · 自定义 {s.custom}
            </div>
          </div>
        ))}
      </div>

      <div className={styles.toolbar}>
        <Input
          aria-label="搜索话术模板"
          icon={<Search size={14} />}
          placeholder="搜索模板..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          aria-label="话术模板分类筛选"
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          options={CATEGORY_OPTIONS}
        />
        <Button size="sm" onClick={handleExport}>
          <Download size={12} />
          导出
        </Button>
        <Button size="sm" onClick={() => setShowImport(true)}>
          <Upload size={12} />
          导入
        </Button>
        <Button variant="primary" size="sm" onClick={handleAdd}>
          <Plus size={12} />
          新增模板
        </Button>
      </div>

      {filtered.length === 0 && recommended.length === 0 ? (
        <EmptyState
          title={(debouncedSearch || filterCategory) && templates.length > 0 ? '没有匹配的话术模板' : '暂无模板'}
          description={(debouncedSearch || filterCategory) && templates.length > 0 ? '请调整搜索关键词或分类筛选。' : '点击新增模板添加话术模板'}
        />
      ) : (
        <>
          {recommended.length > 0 && (
            <div className={styles.recommendedSection}>
              <div className={styles.recommendedTitle}>
                <Star size={14} />
                推荐模板
              </div>
              <div className={styles.recommendedList}>
                {recommended.map((t) => (
                  <div key={t.id} className={styles.recommendedItem}>
                    <div className={styles.recommendedHeader}>
                      <span className={styles.badge + ' ' + styles.badgeInfo}>
                        {CATEGORY_LABELS[t.category]}
                      </span>
                      <span className={styles.recommendedScenario}>{t.scenario}</span>
                    </div>
                    <div className={styles.recommendedContent}>{t.content}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {filtered.length > 0 && (
            <div className={styles.tableWrap}>
            <table className={styles.table}>
          <caption className={styles.srOnly}>话术模板列表</caption>
          <thead>
            <tr>
              <th scope="col">分类</th>
              <th scope="col">场景</th>
              <th scope="col">内容</th>
              <th scope="col">标签</th>
              <th scope="col" style={{ width: 60 }}>优先级</th>
              <th scope="col" style={{ width: 70 }}>来源</th>
              <th scope="col" style={{ width: 60 }}>状态</th>
              <th scope="col" style={{ width: 80 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <tr key={t.id}>
                <td>
                  <span className={styles.badge + ' ' + styles.badgeInfo}>
                    {CATEGORY_LABELS[t.category]}
                  </span>
                </td>
                <td>{t.scenario}</td>
                <td className={styles.cellTruncate} title={t.content}>
                  {t.content}
                </td>
                <td>
                  <div className={`${styles.rowActions} ${styles.tagList}`}>
                    {t.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className={styles.badge + ' ' + styles.badgeMuted}>
                        {tag}
                      </span>
                    ))}
                    {t.tags.length > 3 && <span className={styles.badgeMuted}>+{t.tags.length - 3}</span>}
                  </div>
                </td>
                <td>{t.priority}</td>
                <td>
                  {t.source === 'builtin' ? (
                    <Badge color="default">内置</Badge>
                  ) : (
                    <Badge color="info">自定义</Badge>
                  )}
                </td>
                <td>
                  {t.enabled ? (
                    <Badge color="success">启用</Badge>
                  ) : (
                    <Badge color="default">禁用</Badge>
                  )}
                </td>
                <td>
                  <div className={styles.rowActions}>
                    <button type="button" className={styles.editBtn} onClick={() => handleEdit(t)} aria-label={`编辑模板 ${t.scenario}`}>
                      <Edit2 size={14} />
                    </button>
                    {t.source === 'custom' && (
                      <button
                        type="button"
                        className={styles.deleteBtn}
                        onClick={() => setDeleteTarget(t)}
                        aria-label={`删除模板 ${t.scenario}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
          )}
        </>
      )}

      {showForm && (
        <TemplateFormDialog
          shopId={shopId}
          initial={editing}
          onClose={() => setShowForm(false)}
          onSaved={async () => {
            setShowForm(false);
            await load();
          }}
        />
      )}

      {showImport && (
        <ImportDialog
          onClose={() => setShowImport(false)}
          onImport={async (json) => {
            try {
              const result = await window.api.kb.importTemplates(shopId, json);
              toast.show(
                'success',
                `导入完成: 成功 ${result.imported} 条${result.errors.length > 0 ? `，错误 ${result.errors.length} 条` : ''}`,
              );
              setShowImport(false);
              await load();
            } catch (err) {
              toast.show('error', '导入失败: ' + (err instanceof Error ? err.message : String(err)));
            }
          }}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除模板"
        message={`确认删除模板 "${deleteTarget?.scenario}"？此操作不可恢复。`}
        confirmLabel="删除"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function TemplateFormDialog({
  shopId,
  initial,
  onClose,
  onSaved,
}: {
  shopId: string;
  initial: Template | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [category, setCategory] = useState<TemplateCategory>(initial?.category ?? 'greeting');
  const [scenario, setScenario] = useState(initial?.scenario ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(', '));
  const [priority, setPriority] = useState(initial?.priority ?? 50);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const handleSave = async () => {
    if (!scenario.trim() || !content.trim()) {
      toast.show('warn', '请填写场景和内容');
      return;
    }
    setSaving(true);
    try {
      const template: Partial<Template> = {
        id: initial?.id ?? `tpl_${Date.now()}`,
        category,
        scenario: scenario.trim(),
        content: content.trim(),
        tags: tagsText
          .split(/[,，、\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        priority,
        enabled,
      };
      const result = await window.api.kb.saveTemplate(shopId, template);
      assertTemplateOperationOk(result, '后端未能保存话术模板');
      toast.show('success', initial ? '模板已更新' : '模板已添加');
      onSaved();
    } catch (err) {
      toast.show('error', '保存失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const closeIfIdle = () => {
    if (!saving) onClose();
  };

  return (
    <Modal
      open
      onClose={closeIfIdle}
      title={initial ? '编辑模板' : '新增模板'}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={closeIfIdle} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={handleSave} loading={saving}>
            保存
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <label className={styles.field}>
          <span>分类</span>
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value as TemplateCategory)}
            options={Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))}
          />
        </label>
        <label className={styles.field}>
          <span>场景</span>
          <Input
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
            placeholder="如: 通用问候"
          />
        </label>
        <label className={styles.field}>
          <span>内容</span>
          <textarea
            className={styles.textarea}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="话术内容"
            rows={4}
          />
        </label>
        <label className={styles.field}>
          <span>标签（逗号分隔）</span>
          <Input
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="如: 你好, 在吗, 客服"
          />
        </label>
        <label className={styles.field}>
          <span>优先级（数字越大越优先）</span>
          <Input
            type="number"
            value={priority}
            min={0}
            step={1}
            onChange={(e) => setPriority(Number(e.target.value))}
          />
        </label>
        <label className={styles.toggleSwitch}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>启用此模板</span>
        </label>
      </div>
    </Modal>
  );
}

function ImportDialog({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (json: string) => Promise<void>;
}) {
  const [json, setJson] = useState('');
  const [importing, setImporting] = useState(false);
  const toast = useToast();

  const handleImport = async () => {
    if (!json.trim()) {
      toast.show('warn', '请粘贴 JSON 内容');
      return;
    }
    setImporting(true);
    await onImport(json);
    setImporting(false);
  };

  return (
    <Modal
      open
      onClose={() => { if (!importing) onClose(); }}
      title="导入模板"
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={importing}>
            取消
          </Button>
          <Button variant="primary" onClick={handleImport} loading={importing} disabled={!json.trim()}>
            导入
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.panelInfo}>
          粘贴导出的模板 JSON（数组或 {'{ templates: [...] }'} 格式）
        </div>
        <textarea
          className={styles.textarea}
          value={json}
          onChange={(e) => setJson(e.target.value)}
          placeholder='{"templates": [...]}'
          rows={10}
        />
      </div>
    </Modal>
  );
}
