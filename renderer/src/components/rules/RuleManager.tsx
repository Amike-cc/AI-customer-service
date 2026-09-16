import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Trash2, Edit2, FlaskConical, Check, X, Upload } from 'lucide-react';
import { Card } from '../common/Card';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import { Select } from '../common/Select';
import { useToast } from '../common/Toast';
import { PlatformIcon } from '../common/PlatformIcon';
import { Modal } from '../common/Modal';
import { ConfirmDialog } from '../common/ConfirmDialog';
import type { RuleInfo, RuleMatchResult, ShopListItem } from '../../types/api';
import { getPlatformTheme } from '../../utils/constants';
import styles from './RuleManager.module.css';

interface RuleManagerProps {
  shops: ShopListItem[];
}

function assertOperationOk(
  result: { ok: boolean; error?: string },
  fallbackMessage: string,
): void {
  if (!result.ok) throw new Error(result.error ?? fallbackMessage);
}

export function RuleManager({ shops }: RuleManagerProps) {
  const [selectedShopId, setSelectedShopId] = useState('');
  const [rules, setRules] = useState<RuleInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<RuleInfo | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState<RuleMatchResult | null>(null);
  const requestIdRef = useRef(0);
  const toast = useToast();

  useEffect(() => {
    if (shops.length === 0) {
      setSelectedShopId('');
    } else if (!shops.some((shop) => shop.shopId === selectedShopId)) {
      setSelectedShopId(shops[0].shopId);
    }
  }, [shops, selectedShopId]);

  const loadRules = async (shopId = selectedShopId) => {
    const requestId = ++requestIdRef.current;
    if (!shopId) {
      setRules([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await window.api.rule.list(shopId);
      if (requestId === requestIdRef.current) setRules(list);
    } catch (err) {
      if (requestId === requestIdRef.current) {
        toast.show('error', '加载规则失败: ' + (err instanceof Error ? err.message : String(err)));
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void loadRules(selectedShopId);
  }, [selectedShopId]);

  const handleReload = async () => {
    try {
      const result = await window.api.rule.reload();
      assertOperationOk(result, '后端未能重载规则');
      await loadRules();
      toast.show('success', '规则已重载');
    } catch (err) {
      toast.show('error', '重载失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleDelete = async (name: string) => {
    try {
      const result = await window.api.rule.delete(selectedShopId, name);
      assertOperationOk(result, '后端未能删除规则');
      toast.show('success', '规则已删除');
      setDeleteTarget(null);
      await loadRules();
    } catch (err) {
      toast.show('error', '删除失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleEdit = (rule: RuleInfo) => {
    setEditing(rule);
    setShowForm(true);
  };

  const handleAdd = () => {
    setEditing(null);
    setShowForm(true);
  };

  const handleTest = async () => {
    if (!testText.trim()) {
      toast.show('warn', '请输入测试文本');
      return;
    }
    try {
      const result = await window.api.rule.test(selectedShopId, testText);
      setTestResult(result);
    } catch (err) {
      toast.show('error', '测试失败');
    }
  };

  if (shops.length === 0) return <EmptyState title="暂无店铺" description="请先添加并登录店铺后管理规则。" />;
  if (loading) return <LoadingSpinner size={28} />;

  const selectedShop = shops.find((s) => s.shopId === selectedShopId);
  const platformTheme = selectedShop ? getPlatformTheme(selectedShop.platform) : null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>规则引擎管理</h2>
        <div className={styles.actions}>
          {platformTheme && (
            <span
              className={styles.platformBadge}
              style={{ background: platformTheme.bgColor, color: platformTheme.color }}
            >
              <PlatformIcon platform={selectedShop!.platform} size={14} /> {platformTheme.shortLabel}
            </span>
          )}
          <Select
            aria-label="选择规则所属店铺"
            value={selectedShopId}
            onChange={(e) => setSelectedShopId(e.target.value)}
            className={styles.shopSelect}
            options={shops.map((s) => ({ value: s.shopId, label: `${getPlatformTheme(s.platform).shortLabel} - ${s.shopName}` }))}
          />
          <Button size="sm" onClick={handleReload}>
            <RefreshCw size={12} />
            重载规则
          </Button>
          <Button size="sm" onClick={() => setShowImport(true)}>
            <Upload size={12} />
            导入规则
          </Button>
          <Button variant="primary" size="sm" onClick={handleAdd}>
            <Plus size={12} />
            新增规则
          </Button>
        </div>
      </div>

      <Card className={styles.tester}>
        <div className={styles.testerHeader}>
          <FlaskConical size={14} />
          <span>规则测试{selectedShopId ? `（当前店铺）` : ''}</span>
        </div>
        <div className={styles.testerRow}>
          <Input
            placeholder="输入测试文本..."
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
          />
          <Button variant="primary" size="md" onClick={handleTest}>
            测试
          </Button>
        </div>
        {testResult && (
          <div className={styles.testResult}>
            {testResult.matched ? (
              <>
                <Check size={14} className={styles.iconOk} />
                <span>命中规则: {testResult.ruleName}</span>
                <div className={styles.testAnswer}>{testResult.answer}</div>
              </>
            ) : (
              <>
                <X size={14} className={styles.iconNo} />
                <span>未命中任何规则</span>
              </>
            )}
          </div>
        )}
      </Card>

      {rules.length === 0 ? (
        <EmptyState title="暂无规则" description="点击新增规则添加客服自动回复规则" />
      ) : (
        <div className={styles.ruleList}>
          {rules.map((rule) => (
            <Card key={rule.name} className={styles.ruleCard}>
              <div className={styles.ruleHeader}>
                <div className={styles.ruleNameRow}>
                  <span className={styles.ruleName}>{rule.name}</span>
                  <span className={styles.badge} data-source={rule.source}>
                    {rule.source === 'default' ? '内置' : rule.source === 'faq' ? 'FAQ' : '自定义'}
                  </span>
                  {!rule.enabled && <span className={styles.badgeDisabled}>已禁用</span>}
                </div>
                <div className={styles.ruleActions}>
                  <span className={styles.priority}>优先级: {rule.priority}</span>
                  {rule.source === 'custom' && (
                    <>
                      <Button size="sm" aria-label={`编辑规则 ${rule.name}`} onClick={() => handleEdit(rule)}>
                        <Edit2 size={12} />
                      </Button>
                      <Button size="sm" aria-label={`删除规则 ${rule.name}`} onClick={() => setDeleteTarget(rule.name)}>
                        <Trash2 size={12} />
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <div className={styles.rulePattern}>正则: {rule.pattern}</div>
              <div className={styles.ruleAnswer}>{rule.answer}</div>
            </Card>
          ))}
        </div>
      )}

      {showForm && (
        <RuleFormDialog
          rule={editing}
          shopId={selectedShopId}
          onClose={() => setShowForm(false)}
          onSaved={async () => {
            setShowForm(false);
            await loadRules();
          }}
        />
      )}

      {showImport && (
        <RuleImportDialog
          shopId={selectedShopId}
          onClose={() => setShowImport(false)}
          onImported={async () => {
            setShowImport(false);
            await loadRules();
          }}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除自定义规则"
        message={deleteTarget ? `将永久删除规则“${deleteTarget}”，此操作无法撤销。` : ''}
        confirmLabel="删除规则"
        variant="danger"
        onConfirm={() => deleteTarget ? handleDelete(deleteTarget) : undefined}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function RuleFormDialog({
  rule,
  shopId,
  onClose,
  onSaved,
}: {
  rule: RuleInfo | null;
  shopId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? '');
  const [pattern, setPattern] = useState(rule?.pattern ?? '');
  const [answer, setAnswer] = useState(rule?.answer ?? '');
  const [priority, setPriority] = useState(rule?.priority ?? 50);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const handleSave = async () => {
    if (!name.trim() || !pattern.trim() || !answer.trim()) {
      toast.show('warn', '请填写所有必填字段');
      return;
    }
    setSaving(true);
    try {
      const data: RuleInfo = { name: name.trim(), pattern: pattern.trim(), answer: answer.trim(), priority, enabled, source: 'custom' };
      if (rule) {
        const result = await window.api.rule.update(shopId, rule.name, data);
        assertOperationOk(result, '后端未能更新规则');
        toast.show('success', '规则已更新');
      } else {
        const result = await window.api.rule.add(shopId, data);
        assertOperationOk(result, '后端未能添加规则');
        toast.show('success', '规则已添加');
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
      title={rule ? '编辑规则' : '新增规则'}
      width={520}
      closeOnEscape={!saving}
      footer={(
        <>
          <Button onClick={closeIfIdle} disabled={saving}>取消</Button>
          <Button variant="primary" onClick={handleSave} loading={saving}>保存规则</Button>
        </>
      )}
    >
        <div className={styles.form}>
          <label className={styles.field}>
            <span>规则名称</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!!rule} placeholder="如: size_inquiry" />
          </label>
          <label className={styles.field}>
            <span>正则表达式</span>
            <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="如: 尺码|尺寸|多大" />
          </label>
          <label className={styles.field}>
            <span>回复内容</span>
            <textarea
              className={styles.textarea}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="自动回复的内容"
              rows={3}
            />
          </label>
          <label className={styles.field}>
            <span>优先级 (数字越大越优先)</span>
            <Input
              type="number"
              value={priority}
              min={0}
              step={1}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </label>
          <label className={styles.checkboxField}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>启用</span>
          </label>
        </div>
    </Modal>
  );
}

function RuleImportDialog({
  shopId,
  onClose,
  onImported,
}: {
  shopId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [json, setJson] = useState('');
  const [importing, setImporting] = useState(false);
  const toast = useToast();

  const handleImport = async () => {
    if (!json.trim()) {
      toast.show('warn', '请粘贴规则 JSON');
      return;
    }
    setImporting(true);
    try {
      const result = await window.api.rule.importJson(shopId, json);
      if (result.errors.length > 0) {
        toast.show('warn', `导入 ${result.imported} 条，${result.errors.length} 条失败`);
      } else {
        toast.show('success', `成功导入 ${result.imported} 条规则`);
      }
      onImported();
    } catch (err) {
      toast.show('error', '导入失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setImporting(false);
    }
  };

  const closeIfIdle = () => {
    if (!importing) onClose();
  };

  return (
    <Modal
      open
      onClose={closeIfIdle}
      title="批量导入规则"
      width={620}
      closeOnEscape={!importing}
      footer={(
        <>
          <Button onClick={closeIfIdle} disabled={importing}>取消</Button>
          <Button variant="primary" onClick={handleImport} loading={importing}>导入规则</Button>
        </>
      )}
    >
        <div className={styles.form}>
          <p className={styles.importHint}>导入只会新增或覆盖同名自定义规则，请先核对当前店铺和 JSON 内容。</p>
          <label className={styles.field}>
            <span>规则 JSON（格式: {`{ "rules": [{ "name": "...", "pattern": "...", "answer": "...", "priority": 50, "enabled": true }] }`}）</span>
            <textarea
              className={styles.textarea}
              value={json}
              onChange={(e) => setJson(e.target.value)}
              placeholder='{"rules": [{"name": "example", "pattern": "示例", "answer": "回复", "priority": 50, "enabled": true}]}'
              rows={8}
            />
          </label>
        </div>
    </Modal>
  );
}
