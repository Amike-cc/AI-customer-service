import { useState, useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import {
  Activity,
  BarChart3,
  BookOpen,
  Home,
  MessageSquare,
  MoreVertical,
  Package,
  Plus,
  Settings,
  Store,
} from 'lucide-react';
import type { ShopListItem } from '../../types/api';
import { DropdownMenu } from '../common/DropdownMenu';
import { PlatformIcon } from '../common/PlatformIcon';
import { Input } from '../common/Input';
import { Modal } from '../common/Modal';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Button } from '../common/Button';
import { useToast } from '../common/Toast';
import { getShopStateConfig, getPlatformTheme } from '../../utils/constants';
import { truncate, formatRelative } from '../../utils/format';
import { TestReplyDialog } from '../shops/TestReplyDialog';
import { ShopBusinessConfigEditor } from '../config/ShopBusinessConfigEditor';
import styles from './Sidebar.module.css';

interface SidebarProps {
  shops: ShopListItem[];
  activeShopId: string | null;
  view: 'shop' | 'settings';
  alertCount: number;
  loginStatuses: Record<string, string>;
  error?: string | null;
  onSelectShop: (shopId: string) => void;
  onOpenSettings: () => void;
  onTakeover: (shopId: string) => Promise<void>;
  onRelease: (shopId: string) => Promise<void>;
  onAddAccount: (shopName: string, platform?: string) => Promise<void>;
  onRemove: (shopId: string) => Promise<void>;
  onStart: (shopId: string) => Promise<void>;
  onStop: (shopId: string) => Promise<void>;
  onRename: (shopId: string, newName: string) => Promise<void>;
  onSetAutoReply: (shopId: string, autoReply: boolean) => Promise<void>;
  onForceReLogin: (shopId: string) => Promise<void>;
  onReloadShop: (shopId: string) => Promise<void>;
  activeNav?: NavKey;
  onNavigate?: (key: NavKey) => void;
}

export type NavKey = 'workspace' | 'shops' | 'sessions' | 'products' | 'knowledge' | 'quality' | 'diagnostics';

const LOGIN_LABEL: Record<string, string> = {
  logged_in: '已登录',
  logging_in: '登录中',
  logged_out: '未登录',
};

const PLATFORM_LIST = [
  // feige 是历史兼容内部 ID，面向用户的文案统一为「抖店」
  { value: 'feige', label: '抖店' },
  { value: 'pinduoduo', label: '拼多多' },
  { value: 'kuaishou', label: '快手小店' },
  { value: 'weixin', label: '微信小店' },
];

const PLATFORM_LOGIN_HINTS: Record<string, string> = {
  feige: '添加后打开抖店后台，在平台页面完成登录。',
  pinduoduo: '添加后打开拼多多商家后台，在平台页面完成登录。',
  kuaishou: '添加后打开快手小店，在平台页面完成登录。',
  weixin: '添加后打开微信小店，在平台页面完成登录。',
};

interface ConversationPreview {
  sessionId: string;
  lastMessageAt: number;
  messageCount: number;
  lastDirection?: 'in' | 'out';
  hasManual?: boolean;
}

type ConversationFilter = 'all' | 'unread' | 'manual';

export function Sidebar({
  shops,
  activeShopId,
  view,
  alertCount,
  loginStatuses,
  error,
  onSelectShop,
  onOpenSettings,
  onTakeover,
  onRelease,
  onAddAccount,
  onRemove,
  onStart,
  onStop,
  onRename,
  onSetAutoReply,
  onForceReLogin,
  onReloadShop,
  activeNav: controlledActiveNav,
  onNavigate,
}: SidebarProps) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [addValue, setAddValue] = useState('');
  const [addPlatform, setAddPlatform] = useState('feige');
  const [addLoading, setAddLoading] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameShopId, setRenameShopId] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [renameLoading, setRenameLoading] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [removeShopId, setRemoveShopId] = useState('');
  const [removeLoading, setRemoveLoading] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [stopShopId, setStopShopId] = useState('');
  const [stopLoading, setStopLoading] = useState(false);
  const [autoReplyConfirmShop, setAutoReplyConfirmShop] = useState<ShopListItem | null>(null);
  const [autoReplyLoadingId, setAutoReplyLoadingId] = useState<string | null>(null);
  const [reloginShopId, setReloginShopId] = useState('');
  const [reloginLoading, setReloginLoading] = useState(false);
  const [testShop, setTestShop] = useState<ShopListItem | null>(null);
  const [businessConfigShop, setBusinessConfigShop] = useState<ShopListItem | null>(null);
  const [internalActiveNav, setInternalActiveNav] = useState<NavKey>('workspace');
  const [conversationRows, setConversationRows] = useState<ConversationPreview[]>([]);
  const [conversationFilter, setConversationFilter] = useState<ConversationFilter>('all');
  const toast = useToast();
  const addInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showAddModal) {
      setAddValue('');
      const t = setTimeout(() => addInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [showAddModal]);

  useEffect(() => {
    if (showRenameModal) {
      // 只在打开时设置一次初始值：依赖 shops 会导致 15s 轮询刷新时
      // effect 重跑并覆盖用户正在输入的名字（输入超过 15s 即丢字）
      const shop = shops.find((s) => s.shopId === renameShopId);
      setRenameValue(shop?.shopName ?? '');
      const t = setTimeout(() => renameInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRenameModal, renameShopId]);

  useEffect(() => {
    let disposed = false;
    if (!activeShopId || !window.api?.conversation?.platformSessions) {
      setConversationRows([]);
      return () => {
        disposed = true;
      };
    }
    void window.api.conversation
      .platformSessions(activeShopId, 20)
      .then((rows) => {
        if (!disposed) setConversationRows(rows as ConversationPreview[]);
      })
      .catch(() => {
        if (!disposed) setConversationRows([]);
      });
    return () => {
      disposed = true;
    };
  }, [activeShopId]);

  useEffect(() => {
    setConversationFilter('all');
  }, [activeShopId]);

  const visibleConversationRows = useMemo(() => {
    if (conversationFilter === 'unread') {
      return conversationRows.filter((row) => row.lastDirection === 'in');
    }
    if (conversationFilter === 'manual') {
      return conversationRows.filter((row) => row.hasManual === true);
    }
    return conversationRows;
  }, [conversationFilter, conversationRows]);

  const handleAddConfirm = async () => {
    const name = addValue.trim();
    if (!name) {
      toast.show('error', '店铺名称不能为空');
      return;
    }
    setAddLoading(true);
    try {
      await onAddAccount(name, addPlatform);
      toast.show('success', `已添加账号: ${name}`);
      setShowAddModal(false);
    } catch (err) {
      toast.show('error', '添加账号失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setAddLoading(false);
    }
  };

  const handleRenameConfirm = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      toast.show('error', '店铺名称不能为空');
      return;
    }
    setRenameLoading(true);
    try {
      await onRename(renameShopId, trimmed);
      toast.show('success', `已重命名为: ${trimmed}`);
      setShowRenameModal(false);
    } catch (err) {
      toast.show('error', '重命名失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRenameLoading(false);
    }
  };

  const handleRemoveConfirm = async () => {
    setRemoveLoading(true);
    try {
      await onRemove(removeShopId);
      setShowRemoveConfirm(false);
      toast.show('success', '已删除账号');
    } catch (err) {
      toast.show('error', '删除失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRemoveLoading(false);
    }
  };

  const handleStopConfirm = async () => {
    setStopLoading(true);
    try {
      await onStop(stopShopId);
      setShowStopConfirm(false);
      toast.show('success', '已停止店铺');
    } catch (err) {
      toast.show('error', '停止失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setStopLoading(false);
    }
  };

  const handleTakeover = async (shopId: string) => {
    try {
      await onTakeover(shopId);
      toast.show('success', '已接管店铺');
    } catch (err) {
      toast.show('error', '接管失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleRelease = async (shopId: string) => {
    try {
      await onRelease(shopId);
      toast.show('success', '已释放店铺');
    } catch (err) {
      toast.show('error', '释放失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleStart = async (shopId: string) => {
    try {
      await onStart(shopId);
      toast.show('success', '已启动店铺');
    } catch (err) {
      toast.show('error', '启动失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const executeForceReLogin = async () => {
    if (!reloginShopId) return;
    setReloginLoading(true);
    try {
      await onForceReLogin(reloginShopId);
      toast.show('success', '已清除登录状态并重新加载，请在页面中重新登录');
      setReloginShopId('');
    } catch (err) {
      toast.show('error', '重新登录失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setReloginLoading(false);
    }
  };

  const handleReloadShop = async (shopId: string) => {
    try {
      await onReloadShop(shopId);
      toast.show('success', '店铺页面已刷新');
    } catch (err) {
      toast.show('error', '页面刷新失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const applyAutoReply = async (shop: ShopListItem, next: boolean) => {
    setAutoReplyLoadingId(shop.shopId);
    try {
      await onSetAutoReply(shop.shopId, next);
      toast.show('success', next ? '已开启 AI 自动回复' : '已关闭 AI 自动回复');
      setAutoReplyConfirmShop(null);
    } catch (err) {
      toast.show('error', '切换 AI 回复失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setAutoReplyLoadingId(null);
    }
  };

  const handleToggleAutoReply = (shop: ShopListItem) => {
    if (autoReplyLoadingId) return;
    if (!shop.autoReply) {
      setAutoReplyConfirmShop(shop);
      return;
    }
    void applyAutoReply(shop, false);
  };

  const openRename = (shopId: string) => {
    setRenameShopId(shopId);
    setShowRenameModal(true);
  };

  const openRemove = (shopId: string) => {
    setRemoveShopId(shopId);
    setShowRemoveConfirm(true);
  };

  const openStop = (shopId: string) => {
    setStopShopId(shopId);
    setShowStopConfirm(true);
  };

  const openTestReply = (shop: ShopListItem) => {
    setTestShop(shop);
  };

  const activeNav = controlledActiveNav ?? internalActiveNav;
  const handleNavigate = (key: NavKey) => {
    setInternalActiveNav(key);
    onNavigate?.(key);
  };

  const navigation = [
    { key: 'workspace' as const, label: '工作台', icon: Home },
    { key: 'shops' as const, label: '店铺', icon: Store },
    { key: 'sessions' as const, label: '会话', icon: MessageSquare },
    { key: 'products' as const, label: '商品', icon: Package },
    { key: 'knowledge' as const, label: '知识库', icon: BookOpen },
    { key: 'quality' as const, label: '质量', icon: BarChart3 },
    { key: 'diagnostics' as const, label: '诊断', icon: Activity },
  ];

  return (
    <nav className={styles.sidebar} aria-label="店铺导航">
      <div className={styles.rail} aria-label="主导航">
        <div className={styles.railBrand} aria-label="飞鸽 AI 客服">
          <span className={styles.railBird}>飞</span>
        </div>
        <div className={styles.railItems}>
          {navigation.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              className={[styles.railItem, activeNav === key && styles.railItemActive].filter(Boolean).join(' ')}
              onClick={() => handleNavigate(key)}
              aria-current={activeNav === key ? 'page' : undefined}
              title={label}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className={styles.railFooter}>
          <button type="button" className={styles.railItem} onClick={onOpenSettings} title="设置">
            <Settings size={18} />
            <span>设置</span>
          </button>
          <div className={styles.avatar} aria-label="当前用户">
            L<span className={styles.avatarDot} />
          </div>
        </div>
      </div>
      <div className={styles.sidebarBody}>
        <div className={styles.header}>
          <div className={styles.headerLabel}>
            <span className={styles.headerTitle}>我的店铺</span>
          </div>
          <div className={styles.headerActions}>
            <span className={styles.shopCount} aria-label={`${shops.length} 个店铺`}>
              {shops.length}
            </span>
            <button
              type="button"
              className={styles.headerAdd}
              onClick={() => setShowAddModal(true)}
              aria-label="添加店铺"
            >
              <Plus size={17} />
            </button>
          </div>
        </div>

        <div className={styles.shopList}>
          {error && (
            <div className={styles.errorHint} title={error}>
              {error}
            </div>
          )}
          {shops.length === 0 && !error ? (
            <div className={styles.emptyHint}>暂无店铺，点击下方"添加"按钮</div>
          ) : (
            shops.map((shop) => {
              const stateConfig = getShopStateConfig(shop.state);
              const isManual = shop.state === 'ManualMode';
              const isRunning = shop.state !== null;
              const loginLabel = LOGIN_LABEL[loginStatuses[shop.shopId] ?? shop.loginStatus] ?? '未登录';
              const stateRecord = (shop.stateRecord ?? {}) as Record<string, unknown>;
              const lastMessageAt = stateRecord.lastMessageAt as number | undefined;
              const unreadCount = (stateRecord.unreadCount as number | undefined) ?? 0;

              const menuItems = [
                isManual
                  ? { label: '释放控制', onClick: () => handleRelease(shop.shopId) }
                  : { label: '手动接管', onClick: () => handleTakeover(shop.shopId) },
                isRunning
                  ? { label: '停止', danger: true, onClick: () => openStop(shop.shopId) }
                  : { label: '启动', onClick: () => handleStart(shop.shopId) },
                { label: '刷新页面', onClick: () => handleReloadShop(shop.shopId) },
                { label: '重新登录', danger: true, onClick: () => setReloginShopId(shop.shopId) },
                { label: '重命名', onClick: () => openRename(shop.shopId) },
                { label: '测试回复', onClick: () => openTestReply(shop) },
                { label: '店铺配置', onClick: () => setBusinessConfigShop(shop) },
                { label: '删除账号', danger: true, onClick: () => openRemove(shop.shopId) },
              ];

              return (
                <div
                  key={shop.shopId}
                  className={[styles.shopRow, activeShopId === shop.shopId && view === 'shop' && styles.shopRowActive]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => onSelectShop(shop.shopId)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelectShop(shop.shopId);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-current={activeShopId === shop.shopId && view === 'shop' ? 'page' : undefined}
                  aria-label={`打开店铺 ${shop.shopName}，${loginLabel}`}
                >
                  <div className={styles.shopRowMain}>
                    <span
                      className={styles.platformAvatar}
                      style={{
                        background: getPlatformTheme(shop.platform).bgColor,
                        color: getPlatformTheme(shop.platform).color,
                      }}
                      title={getPlatformTheme(shop.platform).label}
                    >
                      <PlatformIcon platform={shop.platform} size={22} />
                    </span>
                    <div className={styles.shopInfo}>
                      <div className={styles.shopNameRow}>
                        <span className={styles.shopName} title={shop.shopName}>
                          {truncate(shop.shopName, 16)}
                        </span>
                        {unreadCount > 0 && (
                          <span className={styles.unreadBadge} title={`${unreadCount} 条未读消息`}>
                            {unreadCount > 99 ? '99+' : unreadCount}
                          </span>
                        )}
                      </div>
                      <div className={styles.shopMeta}>
                        <span
                          className={styles.platformTag}
                          style={{
                            background: getPlatformTheme(shop.platform).bgColor,
                            color: getPlatformTheme(shop.platform).color,
                          }}
                        >
                          <PlatformIcon platform={shop.platform} /> {getPlatformTheme(shop.platform).shortLabel}
                        </span>
                        <span className={styles.onlineDot} style={{ background: stateConfig.color }} />
                        <span>{loginLabel}</span>
                        {lastMessageAt && (
                          <>
                            <span className={styles.metaDot}>·</span>
                            <span>{formatRelative(lastMessageAt)}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className={styles.shopActions} onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className={[styles.autoReplyToggle, shop.autoReply ? styles.autoReplyOn : styles.autoReplyOff]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => handleToggleAutoReply(shop)}
                      disabled={autoReplyLoadingId === shop.shopId}
                      title={shop.autoReply ? 'AI 自动回复：开启中，点击关闭' : 'AI 自动回复：已关闭，点击开启'}
                      role="switch"
                      aria-checked={shop.autoReply}
                      aria-busy={autoReplyLoadingId === shop.shopId || undefined}
                      aria-label={shop.autoReply ? '关闭 AI 自动回复' : '开启 AI 自动回复'}
                    >
                      <span className={styles.autoReplyLabel}>AI</span>
                      <span className={styles.autoReplyKnob} />
                    </button>
                    <DropdownMenu
                      trigger={<MoreVertical size={14} className={styles.moreIcon} />}
                      items={menuItems}
                      align="right"
                      label={`${shop.shopName} 的更多操作`}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>

        {activeShopId && (
          <section className={styles.conversationSection} aria-label="当前店铺会话">
            <div className={styles.conversationHeader}>
              <strong>当前店铺会话</strong>
              <span>{visibleConversationRows.length}</span>
            </div>
            <div className={styles.conversationTabs} role="tablist" aria-label="会话筛选">
              <button
                type="button"
                role="tab"
                aria-selected={conversationFilter === 'all'}
                className={conversationFilter === 'all' ? styles.conversationTabActive : styles.conversationTab}
                onClick={() => setConversationFilter('all')}
              >
                全部
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={conversationFilter === 'unread'}
                className={conversationFilter === 'unread' ? styles.conversationTabActive : styles.conversationTab}
                onClick={() => setConversationFilter('unread')}
              >
                未读
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={conversationFilter === 'manual'}
                className={conversationFilter === 'manual' ? styles.conversationTabActive : styles.conversationTab}
                onClick={() => setConversationFilter('manual')}
              >
                人工
              </button>
            </div>
            <div className={styles.conversationList}>
              {visibleConversationRows.length === 0 ? (
                <span className={styles.conversationEmpty}>
                  {conversationFilter === 'unread' ? '暂无未读会话' : conversationFilter === 'manual' ? '暂无人工会话' : '暂无活跃会话'}
                </span>
              ) : (
                visibleConversationRows.slice(0, 8).map((row) => (
                  <button
                    type="button"
                    key={row.sessionId}
                    className={styles.conversationRow}
                    onClick={() => onSelectShop(activeShopId)}
                  >
                    <span className={styles.conversationAvatar}>{row.sessionId.slice(0, 1).toUpperCase()}</span>
                    <span className={styles.conversationCopy}>
                      <strong>
                        {row.sessionId}
                        {row.lastDirection === 'in' && <span className={styles.conversationUnreadDot} title="最近一条消息来自买家" />}
                      </strong>
                      <small>{row.messageCount} 条消息</small>
                    </span>
                    {row.hasManual && <span className={styles.conversationManualBadge}>人工</span>}
                    <time>{formatRelative(row.lastMessageAt)}</time>
                  </button>
                ))
              )}
            </div>
          </section>
        )}

        <div className={styles.bottom}>
          <button className={styles.addBtn} onClick={() => setShowAddModal(true)}>
            <Plus size={14} />
            <span>添加店铺</span>
          </button>
          <div className={styles.divider} />
          <button
            className={[styles.settingsBtn, view === 'settings' && styles.settingsBtnActive].filter(Boolean).join(' ')}
            onClick={onOpenSettings}
          >
            <Settings size={15} />
            <span>全局设置</span>
            {alertCount > 0 && <span className={styles.alertBadge}>{alertCount > 99 ? '99+' : alertCount}</span>}
          </button>
        </div>
      </div>
      <Modal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="添加客服店铺账号"
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowAddModal(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={handleAddConfirm} loading={addLoading} disabled={!addValue.trim()}>
              添加
            </Button>
          </>
        }
      >
        <div className={styles.modalForm}>
          <div className={styles.formField}>
            <span className={styles.fieldLabel}>选择平台</span>
            <div className={styles.platformChoices} role="radiogroup" aria-label="店铺平台">
              {PLATFORM_LIST.map((platform) => {
                const theme = getPlatformTheme(platform.value);
                const selected = addPlatform === platform.value;
                return (
                  <button
                    key={platform.value}
                    type="button"
                    className={[styles.platformChoice, selected && styles.platformChoiceActive]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => setAddPlatform(platform.value)}
                    role="radio"
                    aria-checked={selected}
                    aria-label={platform.label}
                    style={{ '--platform-color': theme.color, '--platform-bg': theme.bgColor } as CSSProperties}
                  >
                    <span className={styles.platformChoiceIcon}>
                      <PlatformIcon platform={platform.value} size={18} />
                    </span>
                    <span className={styles.platformChoiceLabel}>{platform.label}</span>
                    {selected && <span className={styles.platformChoiceCheck}>已选</span>}
                  </button>
                );
              })}
            </div>
            <span className={styles.platformHint}>{PLATFORM_LOGIN_HINTS[addPlatform]}</span>
          </div>
          <Input
            ref={addInputRef}
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            placeholder="请输入店铺名称"
            aria-label="店铺名称"
            maxLength={100}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!addLoading) handleAddConfirm();
              }
            }}
          />
        </div>
      </Modal>

      <Modal
        open={showRenameModal}
        onClose={() => setShowRenameModal(false)}
        title="重命名店铺"
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowRenameModal(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={handleRenameConfirm}
              loading={renameLoading}
              disabled={!renameValue.trim()}
            >
              确认
            </Button>
          </>
        }
      >
        <div className={styles.modalForm}>
          <Input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="请输入店铺名称"
            aria-label="店铺名称"
            maxLength={100}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!renameLoading) handleRenameConfirm();
              }
            }}
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={showRemoveConfirm}
        title="删除账号"
        message={`确定要删除账号「${shops.find((s) => s.shopId === removeShopId)?.shopName ?? ''}」吗？此操作不可撤销。`}
        confirmLabel="删除"
        variant="danger"
        onConfirm={handleRemoveConfirm}
        onCancel={() => setShowRemoveConfirm(false)}
      />

      <ConfirmDialog
        open={showStopConfirm}
        title="停止店铺"
        message={`确定要停止店铺「${shops.find((s) => s.shopId === stopShopId)?.shopName ?? ''}」吗？停止后将不再接收和处理消息。`}
        confirmLabel="停止"
        variant="danger"
        onConfirm={handleStopConfirm}
        onCancel={() => setShowStopConfirm(false)}
      />

      <ConfirmDialog
        open={autoReplyConfirmShop !== null}
        title="开启 AI 自动回复"
        message={`开启后，店铺「${autoReplyConfirmShop?.shopName ?? ''}」将自动回复真实买家消息。请确认模型、规则和知识库已经配置并测试。`}
        confirmLabel="确认开启"
        onConfirm={() => {
          if (autoReplyConfirmShop) void applyAutoReply(autoReplyConfirmShop, true);
        }}
        onCancel={() => setAutoReplyConfirmShop(null)}
      />

      <ConfirmDialog
        open={Boolean(reloginShopId)}
        title="重新登录店铺"
        message={`此操作会清除店铺「${shops.find((shop) => shop.shopId === reloginShopId)?.shopName ?? ''}」的当前平台登录状态，并要求重新扫码或验证登录。`}
        confirmLabel={reloginLoading ? '处理中…' : '清除并重新登录'}
        variant="danger"
        onConfirm={() => {
          void executeForceReLogin();
        }}
        onCancel={() => {
          if (!reloginLoading) setReloginShopId('');
        }}
      />

      {testShop && <TestReplyDialog shop={testShop} onClose={() => setTestShop(null)} />}

      <Modal
        open={businessConfigShop !== null}
        onClose={() => setBusinessConfigShop(null)}
        title={businessConfigShop ? `店铺配置 - ${businessConfigShop.shopName}` : '店铺配置'}
        width={560}
        footer={
          <Button variant="primary" onClick={() => setBusinessConfigShop(null)}>
            关闭
          </Button>
        }
      >
        {businessConfigShop && <ShopBusinessConfigEditor shopId={businessConfigShop.shopId} />}
      </Modal>
    </nav>
  );
}
