import { useState } from 'react';
import { Bell, Bird, DownloadCloud, Moon, Settings, Sun } from 'lucide-react';
import { GlobalSearch } from './GlobalSearch';
import styles from './TopBar.module.css';

interface TopBarProps {
  shopCount: number;
  connectionStatus: 'connected' | 'connecting' | 'idle';
  activeShopId?: string | null;
  shopName?: string;
  alertCount?: number;
  onOpenNotifications?: () => void;
  onOpenSettings?: () => void;
  updateAvailable?: boolean;
  onOpenUpdates?: () => void;
  onSelectSearchResult?: (type: string, item: Record<string, unknown>) => void;
}

export function TopBar({ shopCount, connectionStatus, activeShopId, shopName, alertCount = 0, onOpenNotifications, onOpenSettings, updateAvailable = false, onOpenUpdates, onSelectSearchResult }: TopBarProps) {
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') || 'light',
  );

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  };

  return (
    <header className={styles.topbar}>
      <div className={styles.brand}>
        <div className={styles.logoWrap}>
          <Bird size={19} className={styles.logo} />
        </div>
        <div className={styles.brandCopy}>
          <span className={styles.title}>
            飞鸽AI客服 <em>工作台</em>
          </span>
        </div>
      </div>
      <div className={styles.center}>
        <GlobalSearch onSelectResult={onSelectSearchResult} />
        {activeShopId && shopName ? (
          <div className={styles.activeShop}>
            <span className={styles.activeShopLabel}>当前店铺</span>
            <span className={styles.activeShopName}>{shopName}</span>
          </div>
        ) : null}
      </div>
      <div className={styles.status}>
        <span
          className={[
            styles.connectionBadge,
            connectionStatus === 'connected'
              ? styles.connectionConnected
              : connectionStatus === 'connecting'
                ? styles.connectionConnecting
                : styles.connectionIdle,
          ].join(' ')}
          aria-live="polite"
        >
          <span
            className={[
              styles.dot,
              connectionStatus === 'connected'
                ? styles.connected
                : connectionStatus === 'connecting'
                  ? styles.connecting
                  : styles.idle,
            ]
              .filter(Boolean)
              .join(' ')}
          />
          <span>
            {connectionStatus === 'connected' ? '已连接' : connectionStatus === 'connecting' ? '连接中' : '未连接'}
          </span>
        </span>
        <span className={styles.shopStat} aria-label={`共 ${shopCount} 个店铺`}>
          <span className={styles.dot} />
          <strong className={styles.statusValue}>
            <span>{shopCount}</span> 家店铺在线
          </strong>
        </span>
        <button type="button" className={styles.iconBtn} title="通知" aria-label="通知" onClick={onOpenNotifications}>
          <Bell size={17} />
          {alertCount > 0 && <span className={styles.notificationDot}>{alertCount > 99 ? '99+' : alertCount}</span>}
        </button>
        <button type="button" className={styles.iconBtn} title="设置" aria-label="设置" onClick={onOpenSettings}>
          <Settings size={17} />
        </button>
        <button type="button" className={styles.iconBtn} title={updateAvailable ? '有新版本可用' : '软件更新'} aria-label="软件更新" onClick={onOpenUpdates}>
          <DownloadCloud size={17} />
          {updateAvailable && <span className={styles.updateDot} aria-label="有新版本" />}
        </button>
        <button
          className={styles.themeBtn}
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换到浅色主题' : '切换到暗色主题'}
          aria-label="切换主题"
        >
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </header>
  );
}
