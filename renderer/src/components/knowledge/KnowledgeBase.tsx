import { useEffect, useState, useMemo, useRef } from 'react';
import { Save, RefreshCw, Plus, Trash2, Search, FileText, Shield, ListChecks, BookOpen, Package, HelpCircle, Edit2, History, Target, ClipboardCheck, Upload, Download } from 'lucide-react';
import { Card } from '../common/Card';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { Select } from '../common/Select';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import { Modal } from '../common/Modal';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { useToast } from '../common/Toast';
import type { SensitiveWordEntry, ShopListItem, FaqInfo, AccuracyStats } from '../../types/api';
import { TemplatePanel } from './TemplatePanel';
import { VersionPanel } from './VersionPanel';
import { AccuracyPanel } from './AccuracyPanel';
import { ReviewPanel } from './ReviewPanel';
import styles from './KnowledgeBase.module.css';

type SubTab =
  | 'overview' | 'prompt' | 'sensitive' | 'faq'
  | 'templates' | 'versions' | 'accuracy' | 'review';

const SUB_TABS = [
  { key: 'overview', label: '概览', icon: <BookOpen size={14} /> },
  { key: 'prompt', label: 'Prompt 模板', icon: <FileText size={14} /> },
  { key: 'sensitive', label: '敏感词管理', icon: <Shield size={14} /> },
  { key: 'faq', label: '店铺 FAQ', icon: <HelpCircle size={14} /> },
  { key: 'templates', label: '话术模板', icon: <FileText size={14} /> },
  { key: 'versions', label: '版本管理', icon: <History size={14} /> },
  { key: 'accuracy', label: '准确率监控', icon: <Target size={14} /> },
  { key: 'review', label: '内容审核', icon: <ClipboardCheck size={14} /> },
] as const satisfies ReadonlyArray<{ key: SubTab; label: string; icon: JSX.Element }>;

interface IndexedFaq extends FaqInfo {
  originalIndex: number;
}

interface KnowledgeBaseProps {
  shops: ShopListItem[];
}

export function KnowledgeBase({ shops }: KnowledgeBaseProps) {
  const [subTab, setSubTab] = useState<SubTab>('overview');
  const [selectedShopId, setSelectedShopId] = useState('');
  const [ruleCount, setRuleCount] = useState(0);
  const [customRuleCount, setCustomRuleCount] = useState(0);
  const [faqCount, setFaqCount] = useState(0);

  useEffect(() => {
    setSelectedShopId((currentShopId) => {
      if (currentShopId && shops.some((shop) => shop.shopId === currentShopId)) {
        return currentShopId;
      }
      return shops[0]?.shopId ?? '';
    });
  }, [shops]);

  const shopOptions = useMemo(
    () => shops.length > 0
      ? shops.map((shop) => ({ value: shop.shopId, label: shop.shopName }))
      : [{ value: '', label: '暂无可用店铺' }],
    [shops],
  );

  useEffect(() => {
    void loadRuleStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShopId]);

  // 竞态守卫：店铺快速切换时，旧店铺的慢响应不能覆盖新店铺的数据
  const ruleStatsRequestRef = useRef(0);
  const loadRuleStats = async () => {
    const requestId = ++ruleStatsRequestRef.current;
    const shopId = selectedShopId;
    try {
      const rules = await window.api.rule.list(shopId || undefined);
      if (requestId !== ruleStatsRequestRef.current) return;
      setRuleCount(rules.length);
      setCustomRuleCount(rules.filter((r) => r.source === 'custom' || r.source === 'faq').length);
      if (shopId) {
        const faqs = await window.api.faq.list(shopId);
        if (requestId !== ruleStatsRequestRef.current) return;
        setFaqCount(faqs.length);
      } else {
        setFaqCount(0);
      }
    } catch (err) {
      console.error('[KnowledgeBase] loadRuleStats 失败:', err);
    }
  };

  const handleSubTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % SUB_TABS.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + SUB_TABS.length) % SUB_TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = SUB_TABS.length - 1;
    else return;
    event.preventDefault();
    const nextKey = SUB_TABS[nextIndex].key;
    setSubTab(nextKey);
    requestAnimationFrame(() => document.getElementById(`knowledge-tab-${nextKey}`)?.focus());
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>知识库管理</h2>
        <div className={styles.shopScope}>
          <label className={styles.shopScopeLabel} htmlFor="knowledge-shop-select">
            知识库店铺
          </label>
          <Select
            id="knowledge-shop-select"
            className={styles.shopSelect}
            value={selectedShopId}
            onChange={(event) => setSelectedShopId(event.target.value)}
            options={shopOptions}
            disabled={shops.length === 0}
          />
        </div>
      </div>

      <div className={styles.subTabs} role="tablist" aria-label="知识库功能">
        {SUB_TABS.map((tab, index) => (
          <button
            key={tab.key}
            id={`knowledge-tab-${tab.key}`}
            type="button"
            role="tab"
            aria-selected={subTab === tab.key}
            aria-controls="knowledge-tab-panel"
            tabIndex={subTab === tab.key ? 0 : -1}
            className={[styles.subTab, subTab === tab.key && styles.subTabActive].filter(Boolean).join(' ')}
            onClick={() => setSubTab(tab.key)}
            onKeyDown={(event) => handleSubTabKeyDown(event, index)}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      <div id="knowledge-tab-panel" className={styles.tabPanel} role="tabpanel" aria-labelledby={`knowledge-tab-${subTab}`}>
        {subTab === 'overview' && <OverviewPanel ruleCount={ruleCount} customRuleCount={customRuleCount} faqCount={faqCount} shopId={selectedShopId} />}
        {subTab === 'prompt' && <PromptEditorPanel />}
        {subTab === 'sensitive' && <SensitiveWordsPanel />}
        {subTab === 'faq' && <FaqPanel key={selectedShopId || 'no-shop'} shopId={selectedShopId} onChanged={loadRuleStats} />}
        {subTab === 'templates' && <TemplatePanel key={selectedShopId || 'no-shop'} shopId={selectedShopId} />}
        {subTab === 'versions' && <VersionPanel shopId={selectedShopId} />}
        {subTab === 'accuracy' && <AccuracyPanel shopId={selectedShopId} />}
        {subTab === 'review' && <ReviewPanel shopId={selectedShopId} />}
      </div>
    </div>
  );
}

function OverviewPanel({ ruleCount, customRuleCount, faqCount, shopId }: { ruleCount: number; customRuleCount: number; faqCount: number; shopId: string }) {
  const [sensitiveCount, setSensitiveCount] = useState(0);
  const [promptSize, setPromptSize] = useState(0);
  const [templateCount, setTemplateCount] = useState(0);
  const [accuracy, setAccuracy] = useState<AccuracyStats | null>(null);
  const [syncStatus, setSyncStatus] = useState<{ lastSyncAt: number | null; productCount: number } | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    void loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  // 竞态守卫：店铺切换后旧店铺的慢响应不得覆盖新店铺数据
  const statsRequestRef = useRef(0);
  const loadStats = async () => {
    const requestId = ++statsRequestRef.current;
    const currentShopId = shopId;
    try {
      const words = await window.api.kb.getSensitiveWords();
      if (requestId !== statsRequestRef.current) return;
      setSensitiveCount(words.length);
    } catch (err) {
      console.error('[OverviewPanel] 加载敏感词数量失败:', err);
    }
    try {
      const prompt = await window.api.kb.getPrompt();
      if (requestId !== statsRequestRef.current) return;
      setPromptSize(prompt.length);
    } catch (err) {
      console.error('[OverviewPanel] 加载 Prompt 大小失败:', err);
    }
    try {
      const stats = await window.api.kb.getCategoryStats(currentShopId || undefined);
      if (requestId !== statsRequestRef.current) return;
      setTemplateCount(stats.reduce((sum, s) => sum + s.total, 0));
    } catch (err) {
      console.error('[OverviewPanel] 加载模板分类统计失败:', err);
    }
    if (currentShopId) {
      try {
        const acc = await window.api.kb.getAccuracyStats(currentShopId, 'day');
        if (requestId !== statsRequestRef.current) return;
        setAccuracy(acc);
      } catch (err) {
        console.error('[OverviewPanel] 加载准确率统计失败:', err);
      }
      try {
        const status = await window.api.product.getSyncStatus(currentShopId);
        if (requestId !== statsRequestRef.current) return;
        setSyncStatus(status ? { lastSyncAt: status.lastSyncAt, productCount: status.productCount } : null);
      } catch (err) {
        console.error('[OverviewPanel] 加载商品同步状态失败:', err);
      }
      try {
        const pending = await window.api.kb.listPendingReviews(currentShopId);
        if (requestId !== statsRequestRef.current) return;
        setPendingCount(pending.length);
      } catch (err) {
        console.error('[OverviewPanel] 加载待审核数量失败:', err);
      }
    }
  };

  return (
    <div className={styles.overviewSection}>
      <Card className={styles.statCard}>
        <div className={styles.statIcon}>
          <ListChecks size={16} />
          <span>规则引擎</span>
        </div>
        <div className={styles.statValue}>{ruleCount}</div>
        <div className={styles.statLabel}>总规则数</div>
        <div className={styles.statDetail}>
          内置规则 {ruleCount - customRuleCount} 条 · 自定义规则 {customRuleCount} 条
        </div>
      </Card>

      <Card className={styles.statCard}>
        <div className={styles.statIcon}>
          <Shield size={16} />
          <span>敏感词库</span>
        </div>
        <div className={styles.statValue}>{sensitiveCount}</div>
        <div className={styles.statLabel}>敏感词数量</div>
        <div className={styles.statDetail}>
          包含广告违禁、承诺禁用、平台违禁、医疗、化妆品、食品等类别
        </div>
      </Card>

      <Card className={styles.statCard}>
        <div className={styles.statIcon}>
          <FileText size={16} />
          <span>Prompt 模板</span>
        </div>
        <div className={styles.statValue}>{(promptSize / 1024).toFixed(1)} KB</div>
        <div className={styles.statLabel}>模板大小</div>
        <div className={styles.statDetail}>
          DeepSeek AI 客服系统提示词，包含角色定位、回答规范、合规要求等
        </div>
      </Card>

      <Card className={styles.statCard}>
        <div className={styles.statIcon}>
          <Package size={16} />
          <span>店铺 FAQ</span>
        </div>
        <div className={styles.statValue}>{faqCount}</div>
        <div className={styles.statLabel}>FAQ 条目数</div>
        <div className={styles.statDetail}>
          在"店铺 FAQ"页签管理每个店铺的常见问题，命中后直接回复，无需调用 DeepSeek
        </div>
      </Card>

      <Card className={styles.statCard}>
        <div className={styles.statIcon}>
          <FileText size={16} />
          <span>话术模板</span>
        </div>
        <div className={styles.statValue}>{templateCount}</div>
        <div className={styles.statLabel}>模板条目数</div>
        <div className={styles.statDetail}>
          预置标准话术 + 自定义话术，覆盖 8 大客服场景分类
        </div>
      </Card>

      <Card className={styles.statCard}>
        <div className={styles.statIcon}>
          <RefreshCw size={16} />
          <span>商品数据</span>
        </div>
        <div className={styles.statValue}>{syncStatus?.productCount ?? '-'}</div>
        <div className={styles.statLabel}>商品数量</div>
        <div className={styles.statDetail}>
          {syncStatus?.lastSyncAt
            ? `最近同步: ${new Date(syncStatus.lastSyncAt).toLocaleString()}`
            : '尚未同步，请前往“商品管理”统一完成同步与维护'}
        </div>
      </Card>

      <Card className={styles.statCard}>
        <div className={styles.statIcon}>
          <Target size={16} />
          <span>准确率</span>
        </div>
        <div className={styles.statValue}>{accuracy ? `${accuracy.accuracy}%` : '-'}</div>
        <div className={styles.statLabel}>
          {accuracy ? (accuracy.meetsTarget ? '已达标 (≥95%)' : '未达标') : '今日准确率'}
        </div>
        <div className={styles.statDetail}>
          {accuracy
            ? `总回复 ${accuracy.totalReplies} · 👍 ${accuracy.thumbsUp} · 👎 ${accuracy.thumbsDown}`
            : '暂无数据，请在"准确率监控"页签查看详情'}
        </div>
      </Card>

      <Card className={styles.statCard}>
        <div className={styles.statIcon}>
          <ClipboardCheck size={16} />
          <span>内容审核</span>
        </div>
        <div className={styles.statValue}>{pendingCount}</div>
        <div className={styles.statLabel}>待审核条数</div>
        <div className={styles.statDetail}>
          {pendingCount > 0 ? '有内容待审核，请在"内容审核"页签处理' : '所有内容已审核完毕'}
        </div>
      </Card>
    </div>
  );
}

function PromptEditorPanel() {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void loadPrompt();
  }, []);

  const loadPrompt = async () => {
    setLoading(true);
    try {
      const text = await window.api.kb.getPrompt();
      setContent(text);
      setOriginalContent(text);
    } catch (err) {
      toast.show('error', '加载 Prompt 模板失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!content.trim()) {
      toast.show('warn', 'Prompt 内容不能为空');
      return;
    }
    setSaving(true);
    try {
      const res = await window.api.kb.savePrompt(content);
      // 失败返回 {ok:false} 不 reject，需检查避免误报"已保存"
      if (!res.ok) {
        toast.show('error', (res as { error?: string }).error ?? '保存失败');
        return;
      }
      setOriginalContent(content);
      toast.show('success', 'Prompt 模板已保存');
    } catch (err) {
      toast.show('error', '保存失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const handleReload = async () => {
    if (originalContent !== content) {
      if (!confirm('有未保存的修改，确认重新加载？')) return;
    }
    await loadPrompt();
    toast.show('info', '已重新加载');
  };

  const isDirty = content !== originalContent;

  if (loading) return <LoadingSpinner size={28} />;

  return (
    <div className={styles.promptSection}>
      <div className={styles.promptToolbar}>
        <div className={styles.promptInfo}>
          编辑 DeepSeek AI 客服的系统提示词模板 · 支持 {'{shop_info}'} 和 {'{product_info}'} 占位符
        </div>
        <Button size="sm" onClick={handleReload}>
          <RefreshCw size={12} />
          重新加载
        </Button>
      </div>
      <textarea
        className={styles.promptEditor}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
      />
      <div className={styles.saveBar}>
        {isDirty && <span className={styles.promptInfo}>有未保存的修改</span>}
        <Button variant="primary" onClick={handleSave} loading={saving} disabled={!isDirty}>
          <Save size={12} />
          保存模板
        </Button>
      </div>
    </div>
  );
}

function SensitiveWordsPanel() {
  const [words, setWords] = useState<SensitiveWordEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    void loadWords();
  }, []);

  const loadWords = async () => {
    setLoading(true);
    try {
      const list = await window.api.kb.getSensitiveWords();
      setWords(list);
    } catch (err) {
      toast.show('error', '加载敏感词失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (newList: SensitiveWordEntry[]): Promise<boolean> => {
    try {
      const res = await window.api.kb.saveSensitiveWords(newList);
      // 失败返回 {ok:false} 不 reject，需检查避免误报"已保存"
      if (!res.ok) {
        toast.show('error', (res as { error?: string }).error ?? '保存失败');
        return false;
      }
      await window.api.kb.reloadSensitiveWords();
      setWords(newList);
      toast.show('success', '敏感词库已保存并重载');
      return true;
    } catch (err) {
      toast.show('error', '保存失败: ' + (err instanceof Error ? err.message : String(err)));
      return false;
    }
  };

  const handleDelete = async (word: string) => {
    const newList = words.filter((w) => w.word !== word);
    if (await handleSave(newList)) setDeleteTarget(null);
  };

  const handleAdd = async (entry: SensitiveWordEntry) => {
    if (words.some((w) => w.word === entry.word)) {
      toast.show('warn', '该敏感词已存在');
      return;
    }
    const newList = [...words, entry];
    if (await handleSave(newList)) setShowAdd(false);
  };

  const categories = useMemo(() => {
    const set = new Set(words.map((w) => w.category));
    return Array.from(set).sort();
  }, [words]);

  const filtered = useMemo(() => {
    return words.filter((w) => {
      if (filterCategory && w.category !== filterCategory) return false;
      if (search && !w.word.includes(search) && !w.category.includes(search)) return false;
      return true;
    });
  }, [words, search, filterCategory]);

  if (loading) return <LoadingSpinner size={28} />;

  return (
    <div className={styles.sensitiveSection}>
      <div className={styles.sensitiveToolbar}>
        <Input
          aria-label="搜索敏感词或类别"
          icon={<Search size={14} />}
          placeholder="搜索敏感词或类别..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          aria-label="筛选敏感词类别"
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          options={[
            { value: '', label: '全部分类' },
            ...categories.map((c) => ({ value: c, label: c })),
          ]}
        />
        <Button variant="primary" size="sm" onClick={() => setShowAdd(true)}>
          <Plus size={12} />
          新增敏感词
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={(search || filterCategory) && words.length > 0 ? '没有匹配的敏感词' : '暂无敏感词'}
          description={(search || filterCategory) && words.length > 0 ? '请调整搜索关键词或分类筛选。' : '点击新增敏感词添加'}
        />
      ) : (
        <div className={styles.tableWrap}>
        <table className={styles.sensitiveTable}>
          <caption className={styles.srOnly}>敏感词规则列表</caption>
          <thead>
            <tr>
              <th scope="col">敏感词</th>
              <th scope="col">类别</th>
              <th scope="col">处理方式</th>
              <th scope="col" style={{ width: 60 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((w, idx) => (
              <tr key={`${w.word}-${w.category}-${idx}`}>
                <td>{w.word}</td>
                <td>
                  <span className={styles.categoryBadge}>{w.category}</span>
                </td>
                <td>
                  <span
                    className={[
                      styles.actionBadge,
                      w.action === 'block' && styles.actionBlock,
                      w.action === 'warn' && styles.actionWarn,
                      w.action === 'replace' && styles.actionReplace,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {w.action === 'block' ? '拦截' : w.action === 'warn' ? '告警' : '替换'}
                  </span>
                </td>
                <td>
                  <button type="button" className={styles.deleteBtn} onClick={() => setDeleteTarget(w.word)} aria-label={`删除敏感词 ${w.word}`}>
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {showAdd && (
        <AddSensitiveWordDialog
          categories={categories}
          onAdd={handleAdd}
          onClose={() => setShowAdd(false)}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除敏感词"
        message={deleteTarget ? `将删除敏感词“${deleteTarget}”并立即重载规则，此操作无法撤销。` : ''}
        confirmLabel="删除敏感词"
        variant="danger"
        onConfirm={() => deleteTarget ? handleDelete(deleteTarget) : undefined}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function AddSensitiveWordDialog({
  categories,
  onAdd,
  onClose,
}: {
  categories: string[];
  onAdd: (entry: SensitiveWordEntry) => Promise<void>;
  onClose: () => void;
}) {
  const [word, setWord] = useState('');
  const [category, setCategory] = useState(categories[0] ?? 'ad_violation');
  const [action, setAction] = useState<'block' | 'warn' | 'replace'>('block');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const handleSave = async () => {
    if (!word.trim()) {
      toast.show('warn', '请输入敏感词');
      return;
    }
    setSaving(true);
    try {
      await onAdd({ word: word.trim(), category, action });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => { if (!saving) onClose(); }}
      title="新增敏感词"
      width={540}
      closeOnEscape={!saving}
      footer={(
        <>
          <Button onClick={onClose} disabled={saving}>取消</Button>
          <Button variant="primary" onClick={() => void handleSave()} loading={saving}>添加敏感词</Button>
        </>
      )}
    >
        <div className={styles.form}>
          <label className={styles.field}>
            <span>敏感词</span>
            <Input value={word} onChange={(e) => setWord(e.target.value)} placeholder="如: 极品" />
          </label>
          <label className={styles.field}>
            <span>类别</span>
            <Input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="如: ad_violation"
            />
            <div className={styles.hint}>
              常见类别: ad_violation(广告违禁), promise_violation(承诺禁用), platform_violation(平台违禁), medical_violation(医疗), cosmetic_violation(化妆品), food_violation(食品)
            </div>
          </label>
          <label className={styles.field}>
            <span>处理方式</span>
            <Select
              value={action}
              onChange={(e) => setAction(e.target.value as 'block' | 'warn' | 'replace')}
              options={[
                { value: 'block', label: '拦截（不发送）' },
                { value: 'warn', label: '告警（仍发送）' },
                { value: 'replace', label: '替换（用***替代）' },
              ]}
            />
          </label>
        </div>
    </Modal>
  );
}

function FaqPanel({ shopId, onChanged }: { shopId: string; onChanged: () => void }) {
  const [faqs, setFaqs] = useState<IndexedFaq[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingFaq, setEditingFaq] = useState<IndexedFaq | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IndexedFaq | null>(null);
  const [filterCategory, setFilterCategory] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [importing, setImporting] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void loadFaqs();
  }, [shopId]);

  const loadFaqs = async () => {
    if (!shopId) {
      setFaqs([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await window.api.faq.list(shopId);
      setFaqs(list.map((faq, originalIndex) => ({ ...faq, originalIndex })));
    } catch (err) {
      toast.show('error', '加载 FAQ 失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  const filteredFaqs = useMemo(
    () => filterCategory
      ? faqs.filter((faq) => (faq.category ?? 'general') === filterCategory)
      : faqs,
    [faqs, filterCategory],
  );

  const handleDelete = async (faq: IndexedFaq) => {
    if (!shopId) return;
    try {
      await window.api.faq.delete(shopId, faq.originalIndex);
      toast.show('success', 'FAQ 已删除');
      setDeleteTarget(null);
      await loadFaqs();
      onChanged();
    } catch (err) {
      toast.show('error', '删除失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleEdit = (faq: IndexedFaq) => {
    setEditingFaq(faq);
    setShowForm(true);
  };

  const handleAdd = () => {
    setEditingFaq(null);
    setShowForm(true);
  };

  const handleExport = async () => {
    try {
      const json = await window.api.kb.exportKnowledge(shopId);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `knowledge-${shopId}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.show('success', '知识库已导出');
    } catch (err) {
      toast.show('error', '导出失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleImport = async () => {
    if (!importJson.trim()) {
      toast.show('warn', '请粘贴 JSON 内容');
      return;
    }
    if (!confirmImport) {
      toast.show('warn', '请先确认导入会覆盖现有知识库内容');
      return;
    }
    setImporting(true);
    try {
      const result = await window.api.kb.importKnowledge(importJson, shopId);
      toast.show('success', `导入完成: 成功 ${result.imported} 条`);
      setShowImport(false);
      setImportJson('');
      setConfirmImport(false);
      await loadFaqs();
      onChanged();
    } catch (err) {
      toast.show('error', '导入失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setImporting(false);
    }
  };

  if (!shopId) {
    return <EmptyState title="请先选择店铺" description="在顶部选择一个店铺后即可管理其专属 FAQ" />;
  }

  if (loading) return <LoadingSpinner size={28} />;

  return (
    <div className={styles.faqSection}>
      <div className={styles.faqToolbar}>
        <div className={styles.faqInfo}>
          管理「{shopId}」的专属 FAQ · 买家咨询命中后直接回复，不调用 DeepSeek，节省 Token
        </div>
        <div className={styles.rowActions}>
          <Select
            aria-label="FAQ 分类筛选"
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            options={[
              { value: '', label: '全部分类' },
              { value: 'general', label: '通用' },
              { value: 'after_sales', label: '售后' },
              { value: 'logistics', label: '物流' },
              { value: 'sizing', label: '尺码' },
              { value: 'product_comparison', label: '商品对比' },
              { value: 'other', label: '其他' },
            ]}
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
            新增 FAQ
          </Button>
        </div>
      </div>

      {filteredFaqs.length === 0 ? (
        <EmptyState
          title={filterCategory && faqs.length > 0 ? '该分类暂无 FAQ' : '暂无 FAQ'}
          description={filterCategory && faqs.length > 0 ? '请选择其他分类，或新增当前分类的 FAQ。' : '点击新增 FAQ 添加常见问题，命中后将直接回复买家'}
        />
      ) : (
        <div className={styles.tableWrap}>
        <table className={styles.faqTable}>
          <caption className={styles.srOnly}>当前店铺 FAQ 列表</caption>
          <thead>
            <tr>
              <th scope="col" style={{ width: 50 }}>序号</th>
              <th scope="col">问题</th>
              <th scope="col">回复内容</th>
              <th scope="col" style={{ width: 90 }}>分类</th>
              <th scope="col" style={{ width: 80 }}>优先级</th>
              <th scope="col" style={{ width: 80 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredFaqs.map((faq, idx) => (
              <tr key={faq.originalIndex}>
                <td>{idx + 1}</td>
                <td className={styles.faqCell}>{faq.q}</td>
                <td className={styles.faqCell}>{faq.a}</td>
                <td>
                  <span className={styles.badge + ' ' + styles.badgeMuted}>
                    {faq.category ?? 'general'}
                  </span>
                </td>
                <td>{faq.priority}</td>
                <td>
                  <div className={styles.faqActions}>
                    <button type="button" className={styles.editBtn} onClick={() => handleEdit(faq)} aria-label={`编辑 FAQ ${faq.q}`}>
                      <Edit2 size={14} />
                    </button>
                    <button type="button" className={styles.deleteBtn} onClick={() => setDeleteTarget(faq)} aria-label={`删除 FAQ ${faq.q}`}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {showForm && (
        <FaqFormDialog
          shopId={shopId}
          index={editingFaq?.originalIndex ?? null}
          initial={editingFaq ?? undefined}
          onClose={() => setShowForm(false)}
          onSaved={async () => {
            setShowForm(false);
            await loadFaqs();
            onChanged();
          }}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除 FAQ"
        message={deleteTarget ? `将永久删除 FAQ“${deleteTarget.q}”，此操作无法撤销。` : ''}
        confirmLabel="删除 FAQ"
        variant="danger"
        onConfirm={() => deleteTarget ? handleDelete(deleteTarget) : undefined}
        onCancel={() => setDeleteTarget(null)}
      />

      <Modal
        open={showImport}
        onClose={() => { if (!importing) { setShowImport(false); setConfirmImport(false); } }}
        title="导入知识库"
        width={560}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setShowImport(false); setConfirmImport(false); }} disabled={importing}>
              取消
            </Button>
            <Button variant="danger" onClick={handleImport} loading={importing} disabled={!confirmImport || !importJson.trim()}>
              覆盖并导入
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <div className={styles.panelInfo}>
            粘贴导出的知识库 JSON，将覆盖 Prompt、敏感词、模板、FAQ
          </div>
          <textarea
            className={styles.textarea}
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            placeholder='{"prompt": "...", "templates": [...], "faqs": [...]}'
            rows={10}
          />
          <label className={styles.confirmOverwrite}>
            <input type="checkbox" checked={confirmImport} onChange={(event) => setConfirmImport(event.target.checked)} />
            <span>我已确认当前店铺及备份情况，并了解导入会覆盖现有知识库内容。</span>
          </label>
        </div>
      </Modal>
    </div>
  );
}

function FaqFormDialog({
  shopId,
  index,
  initial,
  onClose,
  onSaved,
}: {
  shopId: string;
  index: number | null;
  initial?: FaqInfo;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [q, setQ] = useState(initial?.q ?? '');
  const [a, setA] = useState(initial?.a ?? '');
  const [priority, setPriority] = useState(initial?.priority ?? 75);
  const [category, setCategory] = useState(initial?.category ?? 'general');
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(', '));
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const handleSave = async () => {
    if (!q.trim() || !a.trim()) {
      toast.show('warn', '请填写问题和回复内容');
      return;
    }
    setSaving(true);
    try {
      const data: FaqInfo = {
        q: q.trim(),
        a: a.trim(),
        priority,
        category,
        tags: tagsText
          .split(/[,，、\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
      if (index !== null) {
        const res = await window.api.faq.update(shopId, index, data);
        if (!res.ok) {
          toast.show('error', (res as { error?: string }).error ?? '更新失败');
          return;
        }
        toast.show('success', 'FAQ 已更新');
      } else {
        const res = await window.api.faq.add(shopId, data);
        if (!res.ok) {
          toast.show('error', (res as { error?: string }).error ?? '添加失败');
          return;
        }
        toast.show('success', 'FAQ 已添加');
      }
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
      title={index !== null ? '编辑 FAQ' : '新增 FAQ'}
      width={620}
      closeOnEscape={!saving}
      footer={(
        <>
          <Button onClick={closeIfIdle} disabled={saving}>取消</Button>
          <Button variant="primary" onClick={handleSave} loading={saving}>保存 FAQ</Button>
        </>
      )}
    >
        <div className={styles.form}>
          <label className={styles.field}>
            <span>问题（买家咨询的关键词）</span>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="如: 怎么退货"
            />
            <div className={styles.hint}>
              买家发送的消息包含此问题时，将直接返回下方回复。支持部分匹配。
            </div>
          </label>
          <label className={styles.field}>
            <span>回复内容</span>
            <textarea
              className={styles.textarea}
              value={a}
              onChange={(e) => setA(e.target.value)}
              placeholder="自动回复的内容"
              rows={4}
            />
          </label>
          <label className={styles.field}>
            <span>分类</span>
            <Select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              options={[
                { value: 'general', label: '通用' },
                { value: 'after_sales', label: '售后' },
                { value: 'logistics', label: '物流' },
                { value: 'sizing', label: '尺码' },
                { value: 'product_comparison', label: '商品对比' },
                { value: 'other', label: '其他' },
              ]}
            />
          </label>
          <label className={styles.field}>
            <span>标签（逗号分隔，用于辅助匹配）</span>
            <Input
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="如: 退货, 退款, 换货"
            />
          </label>
          <label className={styles.field}>
            <span>优先级（数字越大越优先，默认 75）</span>
            <Input
              type="number"
              value={priority}
              min={0}
              step={1}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </label>
        </div>
    </Modal>
  );
}
