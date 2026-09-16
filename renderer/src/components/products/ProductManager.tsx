import { useEffect, useRef, useState } from 'react';
import { Plus, Upload, Trash2, Edit2, Search, RefreshCw, Stethoscope, Download, ChevronDown, ChevronUp, Copy } from 'lucide-react';
import { Card } from '../common/Card';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { Select } from '../common/Select';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import { Modal } from '../common/Modal';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { useToast } from '../common/Toast';
import { PlatformIcon } from '../common/PlatformIcon';
import type { ShopListItem, Product, SyncStatus, SyncProgress } from '../../types/api';
import { getPlatformTheme } from '../../utils/constants';
import styles from './ProductManager.module.css';

export function ProductManager({ shops }: { shops: ShopListItem[] }) {
  const [selectedShopId, setSelectedShopId] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagResult, setDiagResult] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const productsRequestRef = useRef(0);
  const syncStatusRequestRef = useRef(0);
  // 同步进度订阅：组件卸载时提前取消，避免长任务期间对已卸载组件 setState
  const syncUnsubRef = useRef<(() => void) | null>(null);
  const toast = useToast();

  useEffect(() => {
    return () => {
      syncUnsubRef.current?.();
      syncUnsubRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (shops.length === 0) {
      setSelectedShopId('');
    } else if (!shops.some((shop) => shop.shopId === selectedShopId)) {
      setSelectedShopId(shops[0].shopId);
    }
  }, [shops, selectedShopId]);

  useEffect(() => {
    if (!selectedShopId) return;
    void loadProducts(selectedShopId);
    void loadSyncStatus(selectedShopId);
  }, [selectedShopId]);

  const loadProducts = async (shopId = selectedShopId) => {
    const requestId = ++productsRequestRef.current;
    setLoading(true);
    try {
      const list = await window.api.product.list(shopId);
      if (requestId === productsRequestRef.current) setProducts(list);
    } catch (err) {
      if (requestId === productsRequestRef.current) {
        toast.show('error', '加载商品失败: ' + (err instanceof Error ? err.message : String(err)));
      }
    } finally {
      if (requestId === productsRequestRef.current) setLoading(false);
    }
  };

  const loadSyncStatus = async (shopId = selectedShopId) => {
    const requestId = ++syncStatusRequestRef.current;
    try {
      const status = await window.api.product.getSyncStatus(shopId);
      if (requestId === syncStatusRequestRef.current) setSyncStatus(status);
    } catch (err) {
      // 同步状态为辅助展示信息，失败时仅记录日志，不打扰用户
      console.error('[ProductManager] 加载同步状态失败:', err);
    }
  };

  const handleSync = async () => {
    if (!selectedShopId) return;
    setSyncing(true);
    setSyncProgress({ phase: 'opening', message: '正在准备同步...' });
    const unsub = window.api.product.onSyncProgress((progress) => {
      setSyncProgress(progress);
    });
    syncUnsubRef.current = unsub;
    try {
      const result = await window.api.product.sync(selectedShopId);
      if (result.errors.length > 0) {
        toast.show('warn', `同步完成: 新增${result.imported}个，更新${result.updated}个，清理${result.removed}个，${result.errors.length}个错误`);
      } else {
        toast.show('success', `同步成功: 新增${result.imported}个，更新${result.updated}个，清理${result.removed}个`);
      }
      await loadProducts();
      await loadSyncStatus();
    } catch (err) {
      toast.show('error', '同步失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      unsub();
      if (syncUnsubRef.current === unsub) syncUnsubRef.current = null;
      setSyncing(false);
      setSyncProgress(null);
    }
  };

  const formatSyncTime = (ts: number | null): string => {
    if (!ts) return '从未同步';
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const handleDiagnose = async () => {
    if (!selectedShopId) return;
    setDiagnosing(true);
    setDiagResult(null);
    try {
      const res = await window.api.product.diagnoseListPage(selectedShopId);
      if (res.ok && res.data) {
        setDiagResult(res.data);
        toast.show('success', '诊断完成，请查看下方结果');
      } else {
        toast.show('error', '诊断失败: ' + (res.error || '未知错误'));
      }
    } catch (err) {
      toast.show('error', '诊断失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setDiagnosing(false);
    }
  };

  const handleCopyDiag = async () => {
    if (!diagResult) return;
    const text = formatDiagResult(diagResult);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.show('success', '诊断结果已复制到剪贴板');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 降级方案
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        toast.show('success', '诊断结果已复制到剪贴板');
        setTimeout(() => setCopied(false), 2000);
      } catch {
        toast.show('error', '复制失败，请手动选中文本复制');
      }
      document.body.removeChild(textarea);
    }
  };

  const formatDiagResult = (jsonStr: string): string => {
    const MAX_CHARS = 6000;
    try {
      const data = JSON.parse(jsonStr);
      const lines: string[] = [];
      lines.push(`页面URL: ${data.url || '未知'}`);
      lines.push('');

      // workStation 右侧面板信息
      if (data.workStationInfo) {
        const ws = data.workStationInfo;
        lines.push('=== 右侧面板（workStation）===');
        lines.push(`  id="${ws.id}" class="${(ws.className || '').substring(0, 80)}"`);
        lines.push(`  位置=(${ws.rect.x},${ws.rect.y}) 尺寸=${ws.rect.w}x${ws.rect.h} 子元素=${ws.childCount}`);
        lines.push(`  文本: "${(ws.textSnippet || '').substring(0, 200)}"`);
        lines.push('');
      }

      // 标签页元素
      const tabItems = data.tabItems || [];
      if (tabItems.length > 0) {
        lines.push(`=== 标签页元素（tabItem，共${tabItems.length}个）===`);
        tabItems.forEach((t: { tag: string; className: string; text: string; rect: { x: number; y: number; w: number; h: number } }, i: number) => {
          lines.push(`  [${i}] <${t.tag}> text="${t.text}" class="${(t.className || '').substring(0, 60)}" 位置=(${t.rect.x},${t.rect.y}) 尺寸=${t.rect.w}x${t.rect.h}`);
        });
        lines.push('');
      }

      // 关键文本元素
      lines.push('=== 关键文本元素 ===');
      const foundTexts = data.foundTexts || {};
      const foundKeys = Object.keys(foundTexts);
      if (foundKeys.length === 0) {
        lines.push('  （未找到关键文本元素）');
      }
      for (const text of foundKeys) {
        const arr = foundTexts[text] as Array<{ tag: string; className: string; path: Array<{ tag: string; className: string; id: string }>; rect: { x: number; y: number; w: number; h: number } }>;
        lines.push(`\n"${text}" (${arr.length}个匹配):`);
        arr.forEach((item, i) => {
          lines.push(`  [${i}] <${item.tag}> class="${(item.className || '').substring(0, 60)}" 位置=(${item.rect.x},${item.rect.y}) 尺寸=${item.rect.w}x${item.rect.h}`);
          if (item.path && item.path.length > 0) {
            const pathStr = item.path.slice(0, 3).map((p) => `<${p.tag}>${p.className ? '.' + p.className.split(' ')[0] : ''}`).join(' > ');
            lines.push(`      路径: ${pathStr}`);
          }
        });
      }
      lines.push('');

      // 右侧边栏候选容器
      lines.push('=== 右侧边栏候选容器 ===');
      const candidates = data.sidebarCandidates || [];
      if (candidates.length === 0) {
        lines.push('  （未找到右侧边栏候选容器）');
      } else {
        candidates.forEach((c: { selector: string; index: number; className: string; textSnippet: string; childCount: number }) => {
          lines.push(`  ${c.selector}[${c.index}] class="${(c.className || '').substring(0, 60)}" 子元素=${c.childCount}`);
          lines.push(`    文本: "${(c.textSnippet || '').substring(0, 120)}"`);
        });
      }
      lines.push('');

      // 页面文本摘要（动态截断，保证总长度不超过 6000 字符）
      const usedChars = lines.join('\n').length;
      const snippetMax = Math.max(200, MAX_CHARS - usedChars - 50);
      lines.push(`=== 页面文本摘要（前${snippetMax}字）===`);
      lines.push((data.bodyTextSnippet || '').substring(0, snippetMax));

      let result = lines.join('\n');
      if (result.length > MAX_CHARS) {
        result = result.substring(0, MAX_CHARS - 20) + '\n...(已截断)';
      }
      return result;
    } catch {
      return jsonStr.length > MAX_CHARS ? jsonStr.substring(0, MAX_CHARS - 20) + '\n...(已截断)' : jsonStr;
    }
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const result = await window.api.product.importJson(selectedShopId, text);
        toast.show('success', `导入成功: ${result.imported} 个商品${result.errors.length > 0 ? `，${result.errors.length} 个错误` : ''}`);
        await loadProducts();
      } catch (err) {
        toast.show('error', '导入失败: ' + (err instanceof Error ? err.message : String(err)));
      }
    };
    input.click();
  };

  const handleExport = () => {
    if (products.length === 0) {
      toast.show('warn', '当前没有可导出的商品');
      return;
    }
    try {
      const json = JSON.stringify(products, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `products_${selectedShopId}_${ts}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.show('success', `已导出 ${products.length} 个商品`);
    } catch (err) {
      toast.show('error', '导出失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleDelete = async (productId: string) => {
    try {
      const result = await window.api.product.delete(selectedShopId, productId);
      if (!result.ok) {
        toast.show('error', '删除失败：商品未被删除，请重试');
        return;
      }
      toast.show('success', '商品已删除');
      setDeleteTarget(null);
      await loadProducts();
    } catch (err) {
      toast.show('error', '删除失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const filtered = products.filter((p) => {
    if (!search) return true;
    const lower = search.toLowerCase();
    return p.name.toLowerCase().includes(lower) || p.sku.toLowerCase().includes(lower) || p.keywords.some((k) => k.toLowerCase().includes(lower));
  });

  const stats = {
    total: products.length,
    active: products.filter((p) => p.active).length,
    inactive: products.filter((p) => !p.active).length,
    variants: products.reduce((sum, p) => sum + (p.variants?.length ?? 0), 0),
  };

  if (shops.length === 0) {
    return <EmptyState title="暂无店铺" description="请先在飞鸽客户端登录店铺" />;
  }

  const selectedShop = shops.find((s) => s.shopId === selectedShopId);
  const platformTheme = selectedShop ? getPlatformTheme(selectedShop.platform) : null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>商品数据管理</h2>
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
            aria-label="选择商品所属店铺"
            value={selectedShopId}
            onChange={(e) => setSelectedShopId(e.target.value)}
            options={shops.map((s) => ({ value: s.shopId, label: `${getPlatformTheme(s.platform).shortLabel} - ${s.shopName}` }))}
          />
          <Button
            size="sm"
            onClick={handleSync}
            loading={syncing}
            disabled={!selectedShopId || syncing}
            title="从平台商品管理中同步商品信息"
          >
            <RefreshCw size={12} />
            {syncing ? '同步中...' : '同步商品'}
          </Button>
          <Button
            size="sm"
            onClick={handleDiagnose}
            loading={diagnosing}
            disabled={!selectedShopId || diagnosing}
            title="诊断客服会话页面的商品面板DOM结构"
          >
            <Stethoscope size={12} />
            {diagnosing ? '诊断中...' : '诊断面板'}
          </Button>
          <Button size="sm" onClick={handleImport} disabled={!selectedShopId}>
            <Upload size={12} />
            导入JSON
          </Button>
          <Button size="sm" onClick={handleExport} disabled={!selectedShopId || products.length === 0} title="导出当前店铺商品为JSON文件">
            <Download size={12} />
            导出
          </Button>
          <Button variant="primary" size="sm" onClick={() => { setEditing(null); setShowForm(true); }} disabled={!selectedShopId}>
            <Plus size={12} />
            新增商品
          </Button>
        </div>
      </div>

      {syncStatus && (
        <div className={styles.syncStatusRow}>
          <span className={styles.syncStatusText}>
            上次同步：{formatSyncTime(syncStatus.lastSyncAt)}
          </span>
          <span className={styles.syncStatusSep}>·</span>
          <span className={styles.syncStatusText}>
            商品总数：{syncStatus.productCount}
          </span>
          {syncStatus.lastResult && syncStatus.lastResult.errors.length > 0 && (
            <>
              <span className={styles.syncStatusSep}>·</span>
              <span className={styles.syncStatusError}>
                {syncStatus.lastResult.errors.length} 个错误
              </span>
            </>
          )}
        </div>
      )}

      {syncProgress && (
        <div className={styles.syncProgressBar}>
          <div className={styles.syncProgressContent}>
            <RefreshCw size={14} className={syncing ? styles.spinning : undefined} />
            <span className={styles.syncProgressText}>
              {syncProgress.message || '同步中...'}
            </span>
            {syncProgress.found !== undefined && (
              <span className={styles.syncProgressCount}>
                已发现 {syncProgress.found} 个商品
              </span>
            )}
            {syncProgress.page !== undefined && (
              <span className={styles.syncProgressPage}>
                第 {syncProgress.page} 页
              </span>
            )}
          </div>
          <div className={styles.syncProgressTrack}>
            <div
              className={styles.syncProgressFill}
              style={{
                width: syncProgress.phase === 'done' ? '100%'
                  : syncProgress.phase === 'scanning' ? '60%'
                  : syncProgress.phase === 'saving' ? '85%'
                  : syncProgress.phase === 'error' ? '100%'
                  : '20%',
                backgroundColor: syncProgress.phase === 'error' ? 'var(--danger)' : undefined,
              }}
            />
          </div>
        </div>
      )}

      <div className={styles.statsRow}>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>商品总数</span>
          <span className={styles.statValue}>{stats.total}</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>上架</span>
          <span className={styles.statValue}>{stats.active}</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>未上架</span>
          <span className={styles.statValue}>{stats.inactive}</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>总规格数</span>
          <span className={styles.statValue}>{stats.variants}</span>
        </div>
      </div>

      {diagResult && (
        <div className={styles.diagResultContainer}>
          <div className={styles.diagResultHeader}>
            <span>商家后台商品页面诊断结果</span>
            <div className={styles.diagHeaderActions}>
              <Button size="sm" onClick={handleCopyDiag} title="复制诊断结果到剪贴板">
                <Copy size={12} />
                {copied ? '已复制' : '复制'}
              </Button>
              <Button size="sm" onClick={() => setDiagResult(null)}>关闭</Button>
            </div>
          </div>
          <pre className={styles.diagResultPre}>{formatDiagResult(diagResult)}</pre>
        </div>
      )}

      <div className={styles.searchRow}>
        <Search size={14} />
        <Input
          aria-label="搜索商品"
          placeholder="搜索商品名称、SKU或关键词..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <LoadingSpinner size={28} />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={products.length > 0 ? '没有匹配的商品' : '暂无商品'}
          description={products.length > 0 ? '请调整搜索关键词，或清空搜索条件。' : '点击导入JSON或新增商品添加商品数据'}
        />
      ) : (
        <div className={styles.productList}>
          {filtered.map((p) => {
            const expanded = expandedId === p.product_id;
            const prices = (p.variants ?? []).map((v) => v.price).filter((n) => typeof n === 'number');
            const priceRange = prices.length === 0
              ? '无价格'
              : prices.length === 1
                ? `¥${prices[0]}`
                : `¥${Math.min(...prices)} - ¥${Math.max(...prices)}`;
            return (
              <Card key={p.product_id} className={styles.productCard}>
                <div className={styles.productHeader}>
                  <div className={styles.productNameRow}>
                    <span className={styles.productName}>{p.name}</span>
                    {p.active ? (
                      <span className={styles.badgeActive}>已上架</span>
                    ) : (
                      <span className={styles.badgeInactive}>未上架</span>
                    )}
                  </div>
                  <div className={styles.productActions}>
                    <Button size="sm" aria-label={`编辑商品 ${p.name}`} onClick={() => { setEditing(p); setShowForm(true); }}>
                      <Edit2 size={12} />
                    </Button>
                    <Button size="sm" aria-label={`删除商品 ${p.name}`} onClick={() => setDeleteTarget(p)}>
                      <Trash2 size={12} />
                    </Button>
                    <Button
                      size="sm"
                      aria-label={expanded ? `收起商品 ${p.name}` : `展开商品 ${p.name}`}
                      onClick={() => setExpandedId(expanded ? null : p.product_id)}
                      title={expanded ? '收起' : '展开'}
                    >
                      {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </Button>
                  </div>
                </div>
                <div className={styles.productMeta}>
                  <span>ID: {p.product_id}</span>
                  <span>SKU: {p.sku}</span>
                  <span>{(p.variants ?? []).length} 个规格</span>
                  <span>价格: {priceRange}</span>
                  <span>{p.shipping?.free_shipping ? '包邮' : '不包邮'}</span>
                </div>
                {(p.keywords ?? []).length > 0 && (
                  <div className={styles.productKeywords}>
                    {p.keywords.map((k) => (
                      <span key={k} className={styles.keyword}>{k}</span>
                    ))}
                  </div>
                )}
                {expanded && (
                  <div className={styles.expandedSection}>
                    {(p.specs ?? []).length > 0 && (
                      <div className={styles.subSection}>
                        <div className={styles.sectionTitle}>商品规格</div>
                        <div className={styles.infoGrid}>
                          {p.specs.map((s, i) => (
                            <div key={i} className={styles.infoItem}>
                              <span className={styles.infoLabel}>{s.name}</span>
                              <span className={styles.infoValue}>{s.values.join(' / ')}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {(p.attrs ?? []).length > 0 && (
                      <div className={styles.subSection}>
                        <div className={styles.sectionTitle}>商品属性</div>
                        <div className={styles.infoGrid}>
                          {p.attrs.map((a, i) => (
                            <div key={i} className={styles.infoItem}>
                              <span className={styles.infoLabel}>{a.name}</span>
                              <span className={styles.infoValue}>{a.value}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className={styles.subSection}>
                      <div className={styles.sectionTitle}>SKU规格信息</div>
                      {(p.variants ?? []).length > 0 ? (
                        <table className={styles.variantTable}>
                          <thead>
                            <tr>
                              <th className={styles.variantTh}>规格</th>
                              <th className={styles.variantTh}>价格</th>
                              <th className={styles.variantTh}>库存</th>
                              <th className={styles.variantTh}>SKU</th>
                            </tr>
                          </thead>
                          <tbody>
                            {p.variants.map((v, i) => (
                              <tr key={i}>
                                <td className={styles.variantTd}>{v.spec}</td>
                                <td className={styles.variantTd}>¥{v.price}</td>
                                <td className={styles.variantTd}>{v.stock}</td>
                                <td className={styles.variantTd}>{v.sku}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <div className={styles.emptyHint}>无规格信息</div>
                      )}
                    </div>

                    <div className={styles.subSection}>
                      <div className={styles.sectionTitle}>物流信息</div>
                      <div className={styles.infoGrid}>
                        <div className={styles.infoItem}>
                          <span className={styles.infoLabel}>包邮</span>
                          <span className={styles.infoValue}>{p.shipping?.free_shipping ? '是' : '否'}</span>
                        </div>
                        <div className={styles.infoItem}>
                          <span className={styles.infoLabel}>发货时长</span>
                          <span className={styles.infoValue}>{p.shipping?.delivery_days || '-'}</span>
                        </div>
                        <div className={styles.infoItem}>
                          <span className={styles.infoLabel}>物流公司</span>
                          <span className={styles.infoValue}>{(p.shipping?.logistics ?? []).join('、') || '-'}</span>
                        </div>
                      </div>
                    </div>

                    <div className={styles.subSection}>
                      <div className={styles.sectionTitle}>售后信息</div>
                      <div className={styles.infoGrid}>
                        <div className={styles.infoItem}>
                          <span className={styles.infoLabel}>退货天数</span>
                          <span className={styles.infoValue}>{p.after_sales?.return_days ?? '-'}</span>
                        </div>
                        <div className={styles.infoItem}>
                          <span className={styles.infoLabel}>换货天数</span>
                          <span className={styles.infoValue}>{p.after_sales?.exchange_days ?? '-'}</span>
                        </div>
                        <div className={styles.infoItem}>
                          <span className={styles.infoLabel}>售后政策</span>
                          <span className={styles.infoValue}>{p.after_sales?.policy || '-'}</span>
                        </div>
                      </div>
                    </div>

                    <div className={styles.subSection}>
                      <div className={styles.sectionTitle}>常见问题</div>
                      {(p.faq ?? []).length > 0 ? (
                        <div className={styles.faqList}>
                          {p.faq.map((item, i) => (
                            <div key={i} className={styles.faqItem}>
                              <div className={styles.faqQ}>Q: {item.q}</div>
                              <div className={styles.faqA}>A: {item.a}</div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className={styles.emptyHint}>无常见问题</div>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {showForm && (
        <ProductFormDialog
          shopId={selectedShopId}
          product={editing}
          onClose={() => setShowForm(false)}
          onSaved={async () => {
            setShowForm(false);
            await loadProducts();
          }}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除商品"
        message={deleteTarget ? `将永久删除“${deleteTarget.name}”（${deleteTarget.product_id}），此操作无法撤销。` : ''}
        confirmLabel="删除商品"
        variant="danger"
        onConfirm={() => deleteTarget ? handleDelete(deleteTarget.product_id) : undefined}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

type VariantRow = { spec: string; price: number; stock: number; sku: string };
type FaqRow = { q: string; a: string };
type SpecRow = { name: string; values: string };
type AttrRow = { name: string; value: string };

function ProductFormDialog({
  shopId,
  product,
  onClose,
  onSaved,
}: {
  shopId: string;
  product: Product | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(product?.name ?? '');
  const [productId, setProductId] = useState(product?.product_id ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [keywords, setKeywords] = useState(product?.keywords.join(', ') ?? '');
  const [active, setActive] = useState(product?.active ?? true);
  const [variants, setVariants] = useState<VariantRow[]>(
    product?.variants && product.variants.length > 0
      ? product.variants.map((v) => ({ ...v }))
      : [{ spec: '', price: 0, stock: 0, sku: '' }]
  );
  const [freeShipping, setFreeShipping] = useState(product?.shipping?.free_shipping ?? true);
  const [deliveryDays, setDeliveryDays] = useState(product?.shipping?.delivery_days ?? '2-3天');
  const [logistics, setLogistics] = useState((product?.shipping?.logistics ?? ['中通']).join(', '));
  const [returnDays, setReturnDays] = useState(product?.after_sales?.return_days ?? 7);
  const [exchangeDays, setExchangeDays] = useState(product?.after_sales?.exchange_days ?? 15);
  const [policy, setPolicy] = useState(product?.after_sales?.policy ?? '7天无理由退货');
  const [faq, setFaq] = useState<FaqRow[]>(
    product?.faq && product.faq.length > 0
      ? product.faq.map((f) => ({ ...f }))
      : [{ q: '', a: '' }]
  );
  const [specs, setSpecs] = useState<SpecRow[]>(
    product?.specs && product.specs.length > 0
      ? product.specs.map((s) => ({ name: s.name, values: s.values.join(', ') }))
      : [{ name: '', values: '' }]
  );
  const [attrs, setAttrs] = useState<AttrRow[]>(
    product?.attrs && product.attrs.length > 0
      ? product.attrs.map((a) => ({ ...a }))
      : [{ name: '', value: '' }]
  );
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const updateVariant = (index: number, field: keyof VariantRow, value: string | number) => {
    setVariants((prev) => prev.map((v, i) => (i === index ? { ...v, [field]: value } : v)));
  };
  const addVariant = () => {
    setVariants((prev) => [...prev, { spec: '', price: 0, stock: 0, sku: '' }]);
  };
  const removeVariant = (index: number) => {
    setVariants((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  };

  const updateSpec = (index: number, field: keyof SpecRow, value: string) => {
    setSpecs((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  };
  const addSpec = () => {
    setSpecs((prev) => [...prev, { name: '', values: '' }]);
  };
  const removeSpec = (index: number) => {
    setSpecs((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  };

  const updateAttr = (index: number, field: keyof AttrRow, value: string) => {
    setAttrs((prev) => prev.map((a, i) => (i === index ? { ...a, [field]: value } : a)));
  };
  const addAttr = () => {
    setAttrs((prev) => [...prev, { name: '', value: '' }]);
  };
  const removeAttr = (index: number) => {
    setAttrs((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  };

  const updateFaq = (index: number, field: keyof FaqRow, value: string) => {
    setFaq((prev) => prev.map((f, i) => (i === index ? { ...f, [field]: value } : f)));
  };
  const addFaq = () => {
    setFaq((prev) => [...prev, { q: '', a: '' }]);
  };
  const removeFaq = (index: number) => {
    setFaq((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  };

  const handleSave = async () => {
    if (!name.trim() || !productId.trim()) {
      toast.show('warn', '请填写商品名称和ID');
      return;
    }
    setSaving(true);
    try {
      const cleanVariants = variants
        .map((v) => ({
          spec: v.spec.trim(),
          price: typeof v.price === 'number' && !Number.isNaN(v.price) ? v.price : Number(v.price) || 0,
          stock: typeof v.stock === 'number' && !Number.isNaN(v.stock) ? v.stock : Number(v.stock) || 0,
          sku: v.sku.trim(),
        }))
        .filter((v) => v.spec || v.sku || v.price > 0 || v.stock > 0);

      const cleanFaq = faq
        .map((f) => ({ q: f.q.trim(), a: f.a.trim() }))
        .filter((f) => f.q || f.a);

      const cleanSpecs = specs
        .map((s) => ({
          name: s.name.trim(),
          values: s.values.split(/[,，、]/).map((v) => v.trim()).filter(Boolean),
        }))
        .filter((s) => s.name && s.values.length > 0);

      const cleanAttrs = attrs
        .map((a) => ({ name: a.name.trim(), value: a.value.trim() }))
        .filter((a) => a.name && a.value);

      const data: Partial<Product> = {
        product_id: productId.trim(),
        name: name.trim(),
        sku: sku.trim(),
        keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
        active,
        specs: cleanSpecs,
        attrs: cleanAttrs,
        variants: cleanVariants,
        shipping: {
          free_shipping: freeShipping,
          delivery_days: deliveryDays.trim(),
          logistics: logistics.split(',').map((l) => l.trim()).filter(Boolean),
        },
        after_sales: {
          return_days: Number(returnDays) || 0,
          exchange_days: Number(exchangeDays) || 0,
          policy: policy.trim(),
        },
        faq: cleanFaq,
      };
      if (product) {
        const result = await window.api.product.update(shopId, productId, data);
        if (!result.ok) {
          toast.show('error', '保存失败：商品更新未生效，请重试');
          return;
        }
        toast.show('success', '商品已更新');
      } else {
        const result = await window.api.product.add(shopId, data as Product);
        if (!result.ok) {
          toast.show('error', '保存失败：商品未添加，请重试');
          return;
        }
        toast.show('success', '商品已添加');
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
      title={product ? '编辑商品' : '新增商品'}
      width={920}
      closeOnOverlay={false}
      closeOnEscape={!saving}
      footer={(
        <>
          <Button onClick={closeIfIdle} disabled={saving}>取消</Button>
          <Button variant="primary" onClick={handleSave} loading={saving}>
            保存商品
          </Button>
        </>
      )}
    >
        <div className={styles.dialogBody} aria-busy={saving}>
          <div className={styles.formSection}>
            <div className={styles.formSectionTitle}>基本信息</div>
            <label className={styles.field}>
              <span>商品名称</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如: 柚子货架桌面收纳盒" />
            </label>
            <label className={styles.field}>
              <span>商品ID</span>
              <Input value={productId} onChange={(e) => setProductId(e.target.value)} disabled={!!product} placeholder="如: YZ_001" />
            </label>
            <label className={styles.field}>
              <span>SKU</span>
              <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="如: YZ-SN-001" />
            </label>
            <label className={styles.field}>
              <span>关键词 (逗号分隔)</span>
              <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="如: 收纳盒, 桌面收纳, 置物架" />
            </label>
            <label className={styles.checkboxField}>
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              <span>上架中</span>
            </label>
          </div>

          <div className={styles.formSection}>
            <div className={styles.formSectionTitle}>
              商品规格
              <Button size="sm" variant="ghost" onClick={addSpec} className={styles.addRowBtn} type="button" aria-label="添加商品规格">
                <Plus size={12} />
                添加
              </Button>
            </div>
            {specs.map((s, i) => (
              <div key={i} className={styles.variantRow} role="group" aria-label={`商品规格第 ${i + 1} 行`}>
                <Input
                  className={styles.variantInput}
                  aria-label={`第 ${i + 1} 行商品规格名称`}
                  value={s.name}
                  onChange={(e) => updateSpec(i, 'name', e.target.value)}
                  placeholder="规格名 (如: 颜色)"
                />
                <Input
                  className={styles.variantInput}
                  aria-label={`第 ${i + 1} 行商品规格值`}
                  value={s.values}
                  onChange={(e) => updateSpec(i, 'values', e.target.value)}
                  placeholder="规格值 (逗号分隔, 如: 红色, 蓝色)"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`删除第 ${i + 1} 行商品规格${s.name.trim() ? `“${s.name.trim()}”` : ''}`}
                  onClick={() => removeSpec(i)}
                  className={styles.removeRowBtn}
                  type="button"
                  disabled={specs.length === 1}
                >
                  <Trash2 size={12} />
                </Button>
              </div>
            ))}
          </div>

          <div className={styles.formSection}>
            <div className={styles.formSectionTitle}>
              商品属性
              <Button size="sm" variant="ghost" onClick={addAttr} className={styles.addRowBtn} type="button" aria-label="添加商品属性">
                <Plus size={12} />
                添加
              </Button>
            </div>
            {attrs.map((a, i) => (
              <div key={i} className={styles.variantRow} role="group" aria-label={`商品属性第 ${i + 1} 行`}>
                <Input
                  className={styles.variantInput}
                  aria-label={`第 ${i + 1} 行商品属性名称`}
                  value={a.name}
                  onChange={(e) => updateAttr(i, 'name', e.target.value)}
                  placeholder="属性名 (如: 材质)"
                />
                <Input
                  className={styles.variantInput}
                  aria-label={`第 ${i + 1} 行商品属性值`}
                  value={a.value}
                  onChange={(e) => updateAttr(i, 'value', e.target.value)}
                  placeholder="属性值 (如: 棉)"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`删除第 ${i + 1} 行商品属性${a.name.trim() ? `“${a.name.trim()}”` : ''}`}
                  onClick={() => removeAttr(i)}
                  className={styles.removeRowBtn}
                  type="button"
                  disabled={attrs.length === 1}
                >
                  <Trash2 size={12} />
                </Button>
              </div>
            ))}
          </div>

          <div className={styles.formSection}>
            <div className={styles.formSectionTitle}>
              SKU规格信息
              <Button size="sm" variant="ghost" onClick={addVariant} className={styles.addRowBtn} type="button" aria-label="添加 SKU 规格行">
                <Plus size={12} />
                添加规格
              </Button>
            </div>
            {variants.map((v, i) => (
              <div key={i} className={styles.variantRow} role="group" aria-label={`SKU 规格第 ${i + 1} 行`}>
                <Input
                  className={styles.variantInput}
                  aria-label={`第 ${i + 1} 行 SKU 规格`}
                  value={v.spec}
                  onChange={(e) => updateVariant(i, 'spec', e.target.value)}
                  placeholder="规格"
                />
                <Input
                  className={styles.variantInput}
                  aria-label={`第 ${i + 1} 行 SKU 价格`}
                  type="number"
                  min={0}
                  step={0.01}
                  value={String(v.price)}
                  onChange={(e) => updateVariant(i, 'price', Number(e.target.value))}
                  placeholder="价格"
                />
                <Input
                  className={styles.variantInput}
                  aria-label={`第 ${i + 1} 行 SKU 库存`}
                  type="number"
                  min={0}
                  step={1}
                  value={String(v.stock)}
                  onChange={(e) => updateVariant(i, 'stock', Number(e.target.value))}
                  placeholder="库存"
                />
                <Input
                  className={styles.variantInput}
                  aria-label={`第 ${i + 1} 行 SKU 编码`}
                  value={v.sku}
                  onChange={(e) => updateVariant(i, 'sku', e.target.value)}
                  placeholder="SKU"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`删除第 ${i + 1} 行 SKU 规格${v.spec.trim() || v.sku.trim() ? `“${v.spec.trim() || v.sku.trim()}”` : ''}`}
                  onClick={() => removeVariant(i)}
                  className={styles.removeRowBtn}
                  type="button"
                  disabled={variants.length === 1}
                >
                  <Trash2 size={12} />
                </Button>
              </div>
            ))}
          </div>

          <div className={styles.formSection}>
            <div className={styles.formSectionTitle}>物流信息</div>
            <label className={styles.checkboxField}>
              <input type="checkbox" checked={freeShipping} onChange={(e) => setFreeShipping(e.target.checked)} />
              <span>包邮</span>
            </label>
            <label className={styles.field}>
              <span>发货时长</span>
              <Input value={deliveryDays} onChange={(e) => setDeliveryDays(e.target.value)} placeholder="如: 2-3天" />
            </label>
            <label className={styles.field}>
              <span>物流公司 (逗号分隔)</span>
              <Input value={logistics} onChange={(e) => setLogistics(e.target.value)} placeholder="如: 中通, 圆通, 顺丰" />
            </label>
          </div>

          <div className={styles.formSection}>
            <div className={styles.formSectionTitle}>售后信息</div>
            <label className={styles.field}>
              <span>退货天数</span>
              <Input
                type="number"
                min={0}
                step={1}
                value={String(returnDays)}
                onChange={(e) => setReturnDays(Number(e.target.value))}
                placeholder="如: 7"
              />
            </label>
            <label className={styles.field}>
              <span>换货天数</span>
              <Input
                type="number"
                min={0}
                step={1}
                value={String(exchangeDays)}
                onChange={(e) => setExchangeDays(Number(e.target.value))}
                placeholder="如: 15"
              />
            </label>
            <label className={styles.field}>
              <span>售后政策</span>
              <textarea
                className={styles.textarea}
                value={policy}
                onChange={(e) => setPolicy(e.target.value)}
                placeholder="如: 7天无理由退货，非质量问题不退换"
                rows={3}
              />
            </label>
          </div>

          <div className={styles.formSection}>
            <div className={styles.formSectionTitle}>
              常见问题
              <Button size="sm" variant="ghost" onClick={addFaq} className={styles.addRowBtn} type="button" aria-label="添加商品常见问题">
                <Plus size={12} />
                添加问题
              </Button>
            </div>
            {faq.map((f, i) => (
              <div key={i} className={styles.faqRow} role="group" aria-label={`常见问题第 ${i + 1} 行`}>
                <Input
                  aria-label={`第 ${i + 1} 条常见问题的问题`}
                  value={f.q}
                  onChange={(e) => updateFaq(i, 'q', e.target.value)}
                  placeholder="问题"
                />
                <textarea
                  className={styles.textarea}
                  aria-label={`第 ${i + 1} 条常见问题的回答`}
                  value={f.a}
                  onChange={(e) => updateFaq(i, 'a', e.target.value)}
                  placeholder="回答"
                  rows={2}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`删除第 ${i + 1} 条常见问题${f.q.trim() ? `“${f.q.trim()}”` : ''}`}
                  onClick={() => removeFaq(i)}
                  className={styles.removeRowBtn}
                  type="button"
                  disabled={faq.length === 1}
                >
                  <Trash2 size={12} />
                  删除
                </Button>
              </div>
            ))}
          </div>
        </div>
    </Modal>
  );
}
