import { useCallback, useEffect, useState } from 'react';
import { TopBar } from './components/layout/TopBar';
import { Sidebar } from './components/layout/Sidebar';
import { StatusBar } from './components/layout/StatusBar';
import { ToastProvider } from './components/common/Toast';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { DeepseekErrorHandler } from './components/common/DeepseekErrorHandler';
import { TransferNotifier } from './components/common/TransferNotifier';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { DiagnosticsPanel } from './components/config/DiagnosticsPanel';
import { AlertList } from './components/logs/AlertList';
import { Modal } from './components/common/Modal';
import { EmptyState } from './components/common/EmptyState';
import { Button } from './components/common/Button';
import { WorkspacePanel } from './components/workspace/WorkspacePanel';
import { SessionTimeline } from './components/workspace/SessionTimeline';
import { TestReplyDialog } from './components/shops/TestReplyDialog';
import { Settings2 } from 'lucide-react';
import { useShops } from './hooks/useShops';
import { useAlerts } from './hooks/useAlerts';
import { useWorkspaceLayout } from './hooks/useWorkspaceLayout';
import type { SettingsTabKey } from './utils/constants';
import type { NavKey } from './components/layout/Sidebar';
import styles from './App.module.css';

export default function App() {
  const [view, setView] = useState<'shop' | 'settings'>('shop');
  const [activeNav, setActiveNav] = useState<NavKey>('workspace');
  const [settingsTab, setSettingsTab] = useState<SettingsTabKey>('config');
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('就绪');
  const {
    shops,
    loading,
    error: shopsError,
    refresh,
    takeover,
    release,
    addAccount,
    removeAccount,
    switchView,
    exitView,
    startShop,
    stopShop,
    renameShop,
    setAutoReply,
    markRead,
    activeShopId,
    loginStatuses,
    forceReLogin,
    reloadShop,
  } = useShops();
  const { alerts, acknowledge } = useAlerts();
  const [alertsOpen, setAlertsOpen] = useState(false);
  const alertCount = alerts.filter((a) => a.level === 'warn' || a.level === 'critical').length;
  const showFeige = view === 'shop' && !!activeShopId;
  // 布局协调器：右侧面板仅在店铺工作台可见，尺寸同步给主进程计算 WebContentsView bounds
  const layout = useWorkspaceLayout(showFeige);
  const [compactPanelOpen, setCompactPanelOpen] = useState(false);
  const [testReplyOpen, setTestReplyOpen] = useState(false);
  // 中央区模式：平台页面（WebContentsView）或 React 消息时间线。
  // 时间线模式下由主进程隐藏 WebContentsView，避免网页盖住 React 内容。
  const [centerMode, setCenterMode] = useState<'platform' | 'timeline'>('timeline');
  const showTimeline = showFeige && centerMode === 'timeline';

  useEffect(() => {
    setCompactPanelOpen(false);
  }, [activeShopId, view]);

  useEffect(() => {
    if (showTimeline) {
      void window.api.view.hideForModal();
    } else {
      void window.api.view.restoreAfterModal();
    }
  }, [showTimeline]);

  const handleSelectShop = useCallback(
    (shopId: string) => {
      void switchView(shopId);
      void markRead(shopId);
      setView('shop');
      const shop = shops.find((s) => s.shopId === shopId);
      if (shop) {
        setStatusMessage(`已切换到店铺: ${shop.shopName}`);
      }
    },
    [switchView, markRead, shops],
  );

  const handleSearchResult = useCallback(
    (type: string, item: Record<string, unknown>) => {
      const shopId = typeof item.shopId === 'string' ? item.shopId : null;
      if (type === 'products') {
        setActiveNav('products');
        setSettingsTab('products');
        setView('settings');
        void exitView();
        setStatusMessage(`商品结果：${String(item.name ?? item.productId ?? '')}`);
        return;
      }
      if (shopId) {
        void handleSelectShop(shopId);
      }
      if (type === 'messages' || type === 'orders') {
        setFocusSessionId(typeof item.sessionId === 'string' ? item.sessionId : null);
        setActiveNav('workspace');
        setView('shop');
        setStatusMessage(type === 'orders' ? '已定位订单所属店铺' : '已定位消息所属会话');
      }
    },
    [exitView, handleSelectShop],
  );

  const handleOpenSettings = useCallback(() => {
    void exitView();
    setView('settings');
    setActiveNav('shops');
    setSettingsTab('config');
    setStatusMessage('全局设置');
  }, [exitView]);

  const handleNavigate = useCallback(
    (key: NavKey) => {
      setActiveNav(key);
      if (key === 'workspace' || key === 'shops') {
        setView('shop');
        setStatusMessage(key === 'shops' ? '店铺管理' : '客服工作台');
        return;
      }
      const tabMap: Partial<Record<Exclude<NavKey, 'workspace' | 'shops'>, SettingsTabKey>> = {
        sessions: 'sessions',
        products: 'products',
        knowledge: 'knowledge',
        quality: 'metrics',
        diagnostics: 'health',
      };
      const tab = tabMap[key];
      if (tab) {
        setSettingsTab(tab);
        setView('settings');
        void exitView();
        setStatusMessage(
          ({ sessions: '会话管理', products: '商品管理', knowledge: '知识库', quality: '质量分析', diagnostics: '系统诊断' } as Record<string, string>)[key],
        );
      }
    },
    [exitView],
  );

  const handleExitView = useCallback(() => {
    void exitView();
    setView('shop');
    setActiveNav('workspace');
    setStatusMessage('就绪');
  }, [exitView]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.ctrlKey && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        void refresh();
      }
      if (
        e.key === 'Escape' &&
        activeShopId &&
        view === 'shop' &&
        !document.querySelector('[role="dialog"][aria-modal="true"]')
      ) {
        void handleExitView();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [refresh, activeShopId, view, handleExitView]);

  const activeShop = activeShopId ? shops.find((s) => s.shopId === activeShopId) : null;
  const effectiveLoginStatuses = shops.map((shop) => loginStatuses[shop.shopId] ?? shop.loginStatus);
  const connectionStatus =
    loading || effectiveLoginStatuses.some((status) => status === 'logging_in')
      ? 'connecting'
      : effectiveLoginStatuses.some((status) => status === 'logged_in')
        ? 'connected'
        : 'idle';

  return (
    <ToastProvider>
      <DeepseekErrorHandler />
      <TransferNotifier />
      <ErrorBoundary>
        <TopBar
          shopCount={shops.length}
          connectionStatus={connectionStatus}
          activeShopId={activeShopId}
          shopName={activeShop?.shopName}
          alertCount={alertCount}
          onOpenNotifications={() => setAlertsOpen(true)}
          onOpenSettings={handleOpenSettings}
          onSelectSearchResult={handleSearchResult}
        />
        <div className={`${styles.main} ${showFeige ? styles.mainTransparent : ''}`}>
          <Sidebar
            shops={shops}
            activeShopId={activeShopId}
            view={view}
            alertCount={alertCount}
            loginStatuses={loginStatuses}
            error={shopsError}
            onSelectShop={handleSelectShop}
            onOpenSettings={handleOpenSettings}
            onTakeover={takeover}
            onRelease={release}
            onAddAccount={addAccount}
            onRemove={removeAccount}
            onStart={startShop}
            onStop={stopShop}
            onRename={renameShop}
            onSetAutoReply={setAutoReply}
            onForceReLogin={forceReLogin}
            onReloadShop={reloadShop}
            activeNav={activeNav}
            onNavigate={handleNavigate}
          />
          <main className={`${styles.content} ${showFeige && !showTimeline ? styles.contentTransparent : ''}`}>
            {view === 'settings' ? (
              activeNav === 'diagnostics' ? (
                <div className={styles.diagnosticsView}>
                  <DiagnosticsPanel />
                </div>
              ) : (
                <SettingsPanel shops={shops} initialTab={settingsTab} />
              )
            ) : activeShopId && showTimeline ? (
              <SessionTimeline
                shopId={activeShopId}
                shop={activeShop}
                autoReply={activeShop?.autoReply}
                focusSessionId={focusSessionId}
                onOpenPlatform={() => setCenterMode('platform')}
                showControlPanelButton={!layout.rightPanelVisible}
                controlPanelOpen={compactPanelOpen}
                onToggleControlPanel={() => setCompactPanelOpen((value) => !value)}
              />
            ) : activeShopId ? (
              <div className={styles.webviewTransparent} />
            ) : (
              <EmptyState
                title="未选择店铺"
                description="从左侧选择一个店铺进入客服工作台，或先完成全局能力配置。"
                action={
                  <Button variant="primary" onClick={handleOpenSettings}>
                    <Settings2 size={15} />
                    打开全局设置
                  </Button>
                }
              />
            )}
          </main>
          {showFeige && activeShop && (layout.rightPanelVisible || compactPanelOpen) && (
            <div
              className={`${styles.rightPanel} ${!layout.rightPanelVisible ? styles.rightPanelDrawer : ''}`}
              style={layout.rightPanelVisible ? { width: layout.rightPanelWidth } : undefined}
            >
              <WorkspacePanel
                shop={activeShop}
                autoReply={activeShop.autoReply}
                onSetAutoReply={setAutoReply}
                onTakeover={takeover}
                onRelease={release}
                onTestReply={() => setTestReplyOpen(true)}
                centerMode={centerMode}
                onToggleCenterMode={() => setCenterMode((m) => (m === 'platform' ? 'timeline' : 'platform'))}
              />
            </div>
          )}
        </div>
        {testReplyOpen && activeShop && <TestReplyDialog shop={activeShop} onClose={() => setTestReplyOpen(false)} />}
        <Modal open={alertsOpen} onClose={() => setAlertsOpen(false)} title="系统通知" width={640}>
          <AlertList alerts={alerts} onAcknowledge={acknowledge} />
        </Modal>
        <StatusBar
          message={statusMessage}
          shopName={activeShop?.shopName}
          loginStatus={activeShop?.loginStatus}
          platformLabel={
            activeShop
              ? ({ feige: '抖店', pinduoduo: '拼多多', kuaishou: '快手小店', weixin: '微信小店' }[
                  activeShop.platform
                ] ?? activeShop.platform)
              : undefined
          }
        />
      </ErrorBoundary>
    </ToastProvider>
  );
}
