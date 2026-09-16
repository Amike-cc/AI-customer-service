/**
 * Webview 管理器
 *
 * 实现 IWebviewManager 接口，管理多个 WebContentsView：
 * - 每个店铺一个独立 session 分区（persist:shop_{id}）实现登录态隔离与持久化
 * - 切换店铺账号时在 BrowserWindow 上挂载/卸载对应 view
 * - 登录状态检测：URL 跳转 + DOM 特征双判断
 * - 崩溃恢复：webContents.on('crashed') 自动 reload
 *
 * 详见 docs/开发文档-v2.md §9
 */
import { WebContentsView, session, BrowserWindow, app, screen } from 'electron';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { IWebContents, IWebviewManager, LoginStatus, VisualCaptureTarget } from '../src/cdp/types';
import { getPlatform } from '../src/platform';
import type { PlatformId } from '../src/platform';
import { FingerprintManager } from './fingerprint/manager';
import { registerFramePreload, unregisterFramePreload } from './session-preload';
import type { AppLogger } from '../src/logging/logger';
import {
  computeViewBounds,
  SIDEBAR_WIDTH,
  RIGHT_PANEL_WIDTH_WIDE,
  type WorkspaceLayout as SharedWorkspaceLayout,
} from '../src/workspace/layout';

interface ShopView {
  view: WebContentsView;
  loginStatus: LoginStatus;
  webUrl: string;
  platformId: PlatformId;
  loginCheckTimer: NodeJS.Timeout | null;
  keepaliveTimer: NodeJS.Timeout | null;
  autoRecoveryAttempts: number;
  autoRecoveryTimer: NodeJS.Timeout | null;
  lastLoginStatusChange: number;
  responseMonitorRegistered: boolean;
  manualReLoginInProgress: boolean;
  startupGraceUntil: number;
  /** 店铺名称同步定时器（登录后异步抓取真实店铺名） */
  shopNameSyncTimer: NodeJS.Timeout | null;
  /** 最近一次店铺名称同步时间戳（防抖用，30 秒内不重复抓取） */
  lastShopNameSyncAt: number;
}

const LOGIN_CHECK_INTERVAL_MS = 10_000;
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_RECOVERY_INITIAL_DELAY_MS = 3_000;
const AUTO_RECOVERY_RETRY_DELAY_MS = 15_000;
const AUTO_RECOVERY_MAX_ATTEMPTS = 2;
const LOGGING_IN_TIMEOUT_MS = 60_000;
const RECOVERY_VERIFY_DELAY_MS = 5_000;
const STARTUP_GRACE_MS = 20_000;
const NAV_LOGIN_CHECK_DELAY_MS = 3_000;
/** 工作台布局模型：由渲染层通过 workspace:setLayout 上报，主进程统一计算 WebContentsView bounds */
export type WorkspaceLayout = SharedWorkspaceLayout;

export class WebviewManager extends EventEmitter implements IWebviewManager {
  private views = new Map<string, ShopView>();
  private activeShopId: string | null = null;
  private mainWindow: BrowserWindow | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private logger: AppLogger | null = null;
  private viewHiddenByModal = false;
  /** 当前工作台布局（布局协调器统一计算 WebContentsView bounds） */
  private layout: WorkspaceLayout = {
    sidebarWidth: SIDEBAR_WIDTH,
    rightPanelWidth: RIGHT_PANEL_WIDTH_WIDE,
    rightPanelVisible: false,
  };
  static readonly RELOAD_INTERVAL_MS = 9 * 60 * 1000;

  /**
   * 商家后台通常是持续发请求的 SPA，loadURL 可能长期不 resolve，或在登录重定向时返回
   * ERR_ABORTED。DOM 已就绪即可继续等待业务数据，不应被固定 30 秒加载超时误判为失败。
   */
  private async loadScrapePage(win: BrowserWindow, url: string, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let loadError: Error | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        win.webContents.removeListener('dom-ready', finish);
        win.webContents.removeListener('did-stop-loading', finish);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        win.webContents.removeListener('dom-ready', finish);
        win.webContents.removeListener('did-stop-loading', finish);
        const currentUrl = win.webContents.isDestroyed() ? '' : win.webContents.getURL();
        if (currentUrl && currentUrl !== 'about:blank') {
          resolve();
          return;
        }
        reject(loadError ?? new Error(`页面加载超时（${timeoutMs}ms）`));
      }, timeoutMs);

      win.webContents.once('dom-ready', finish);
      win.webContents.once('did-stop-loading', finish);
      void win.loadURL(url).then(finish).catch((error: Error) => {
        // 登录重定向可能中断首次导航；保留错误并继续等待后续 DOM 就绪事件。
        loadError = error;
      });
    });
  }

  setLogger(logger: AppLogger): void {
    this.logger = logger;
  }

  attachToWindow(win: BrowserWindow): void {
    this.mainWindow = win;
    if (this.activeShopId) {
      this.mountView(this.activeShopId);
    }
    win.on('closed', () => {
      this.mainWindow = null;
    });
    win.on('resize', () => {
      if (this.activeShopId) {
        this.resizeActiveView();
      }
    });
  }

  async ensureView(shopId: string, webUrl: string, platformId: string): Promise<IWebContents> {
    const existing = this.views.get(shopId);
    if (existing) {
      return existing.view.webContents as unknown as IWebContents;
    }

    const platform = getPlatform(platformId as PlatformId);
    const loginDetection = platform.loginDetection;

    const partition = `persist:shop_${shopId}`;
    const ses = session.fromPartition(partition);

    // 为每个店铺生成独立的浏览器指纹
    const fingerprint = FingerprintManager.getOrCreateFingerprint(shopId);
    const preloadPath = FingerprintManager.preparePreloadScript(shopId, fingerprint);

    // 注册 preload 脚本（在页面任何脚本执行之前注入指纹覆盖）
    registerFramePreload(ses, preloadPath);

    // 设置该店铺独有的 User-Agent
    ses.setUserAgent(fingerprint.userAgent);

    // 平台特定请求头修改，与指纹 UA 保持一致
    ses.webRequest.onBeforeSendHeaders(
      { urls: loginDetection.requestHeaderDomains },
      (details, callback) => {
        const headers = { ...details.requestHeaders };
        headers['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
        headers['Sec-Ch-Ua'] = fingerprint.secChUa;
        headers['Sec-Ch-Ua-Mobile'] = '?0';
        headers['Sec-Ch-Ua-Platform'] = fingerprint.secChUaPlatform;
        headers['Sec-Ch-Ua-Full-Version-List'] = fingerprint.secChUaFullVersionList;
        headers['Sec-Ch-Ua-Platform-Version'] = '"15.0.0"';
        headers['Sec-Ch-Ua-Arch'] = '"x86"';
        headers['Sec-Ch-Ua-Bitness'] = '"64"';
        headers['Sec-Ch-Ua-Wow64'] = '?0';
        callback({ requestHeaders: headers });
      },
    );

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor('#ffffff');

    // 将 view 添加到窗口并设置非零 bounds，确保 webContents 能正常渲染
    if (this.mainWindow) {
      this.mainWindow.contentView.addChildView(view);
      const [width, height] = this.mainWindow.getContentSize();
      view.setBounds(this.computeViewBounds(width, height));
      view.setVisible(false);
    }

    const shopView: ShopView = {
      view,
      loginStatus: 'logging_in',
      webUrl,
      platformId: platformId as PlatformId,
      loginCheckTimer: null,
      keepaliveTimer: null,
      autoRecoveryAttempts: 0,
      autoRecoveryTimer: null,
      lastLoginStatusChange: Date.now(),
      responseMonitorRegistered: false,
      manualReLoginInProgress: false,
      startupGraceUntil: Date.now() + STARTUP_GRACE_MS,
      shopNameSyncTimer: null,
      lastShopNameSyncAt: 0,
    };
    this.views.set(shopId, shopView);

    view.webContents.on('render-process-gone', (_event, details) => {
      this.emit('crashed', { shopId, reason: details?.reason });
      const sv = this.views.get(shopId);
      if (!sv) return;
      // 限制重试次数，防止无限 reload
      if (sv.autoRecoveryAttempts >= 3) {
        this.logger?.warn({ shopId, attempts: sv.autoRecoveryAttempts }, 'render-process-gone 重试次数已达上限，停止 reload');
        return;
      }
      sv.autoRecoveryAttempts++;
      // 仅在非正常退出情况下尝试自动 reload，避免掩盖 OOM 等需重启的场景
      if (details?.reason !== 'clean-exit' && !view.webContents.isDestroyed()) {
        try {
          view.webContents.reload();
        } catch {
          // ignore
        }
      }
    });

    view.webContents.on('did-navigate', (_event, url) => {
      void this.handleNavigation(shopId, url);
    });
    view.webContents.on('did-navigate-in-page', (_event, url) => {
      void this.handleNavigation(shopId, url);
    });
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        this.logger?.warn({ shopId, platform: platformId, errorCode, errorDescription, validatedURL }, '页面加载失败: did-fail-load');
      }
    });
    view.webContents.on('did-finish-load', () => {
      this.logger?.info({ shopId, platform: platformId, url: view.webContents.getURL() }, '页面加载完成: did-finish-load');
    });
    view.webContents.on('preload-error', (_event, preloadPath, error) => {
      this.logger?.warn({ shopId, platform: platformId, preloadPath, error: error instanceof Error ? error.message : String(error) }, 'preload 脚本错误');
    });
    view.webContents.on('console-message', (details) => {
      if (details.level !== 'debug') {
        this.logger?.warn(
          {
            shopId,
            platform: platformId,
            level: details.level,
            consoleMessage: details.message,
            line: details.lineNumber,
            sourceId: details.sourceId,
          },
          '页面控制台输出',
        );
      }
    });

    try {
      const url = webUrl || 'about:blank';
      await view.webContents.loadURL(url);
    } catch (err) {
      this.emit('load-failed', { shopId, err });
    }

    this.startLoginCheck(shopId);
    this.registerResponseMonitor(shopId, ses, loginDetection);
    this.startKeepalive(shopId);

    return view.webContents as unknown as IWebContents;
  }

  removeView(shopId: string): void {
    const shopView = this.views.get(shopId);
    if (!shopView) return;

    if (shopView.loginCheckTimer) {
      clearInterval(shopView.loginCheckTimer);
      shopView.loginCheckTimer = null;
    }
    this.stopKeepalive(shopId);
    if (shopView.autoRecoveryTimer) {
      clearTimeout(shopView.autoRecoveryTimer);
      shopView.autoRecoveryTimer = null;
    }
    if (shopView.shopNameSyncTimer) {
      clearTimeout(shopView.shopNameSyncTimer);
      shopView.shopNameSyncTimer = null;
    }
    shopView.autoRecoveryAttempts = 0;

    // 总是从窗口移除 view（后台 view 也被 addChildView 了）
    if (this.mainWindow) {
      try {
        this.mainWindow.contentView.removeChildView(shopView.view);
      } catch {
        // ignore
      }
    }

    // 清理所有 WebContents 事件监听器，防止内存泄漏
    try {
      shopView.view.webContents.removeAllListeners();
    } catch {
      // ignore
    }

    try {
      (shopView.view.webContents as unknown as { destroy?: () => void }).destroy?.();
    } catch {
      // ignore
    }

    this.views.delete(shopId);

    // 清理该店铺的指纹文件
    FingerprintManager.removeFingerprint(shopId);

    if (this.activeShopId === shopId) {
      this.activeShopId = null;
    }
  }

  getLoginStatus(shopId: string): LoginStatus {
    return this.views.get(shopId)?.loginStatus ?? 'logged_out';
  }

  setLoginStatus(shopId: string, status: LoginStatus): void {
    const shopView = this.views.get(shopId);
    if (!shopView || shopView.loginStatus === status) return;
    const oldStatus = shopView.loginStatus;
    shopView.loginStatus = status;
    shopView.lastLoginStatusChange = Date.now();
    this.logger?.info({ shopId, platform: shopView.platformId, oldStatus, newStatus: status }, '登录状态变更');
    this.emit('loginStatusChanged', { shopId, status, oldStatus });
    // 从 logged_in/logging_in 变为 logged_out 时触发自动恢复（手动重新登录期间不触发）
    if (status === 'logged_out' && oldStatus !== 'logged_out' && !shopView.manualReLoginInProgress) {
      this.triggerAutoRecovery(shopId);
    } else if (status === 'logged_in') {
      // 恢复成功，重置计数器
      shopView.autoRecoveryAttempts = 0;
      if (shopView.autoRecoveryTimer) {
        clearTimeout(shopView.autoRecoveryTimer);
        shopView.autoRecoveryTimer = null;
      }
      // 清除手动重新登录标志
      if (shopView.manualReLoginInProgress) {
        shopView.manualReLoginInProgress = false;
        this.logger?.info({ shopId, platform: shopView.platformId }, '手动重新登录成功，已恢复自动恢复机制');
      }
      // 登录成功后，如果当前 URL 不是客服会话页面，主动导航到 webUrl
      // （拼多多登录后默认跳转到首页 mms.pinduoduo.com/home/，而非客服会话页面）
      this.navigateToWebUrlIfNeeded(shopId, shopView);
      // 登录成功后异步抓取真实店铺名并同步到数据库（延迟 4 秒等页面完全加载）
      this.scheduleShopNameSync(shopId);
    } else if (status === 'logging_in') {
      // logging_in 状态超时检测在 checkLoginStatus 中处理
    }
  }

  /**
   * 安排店铺名称同步任务。
   * 登录成功后延迟 6 秒执行，避免与页面导航/加载冲突（飞鸽等 React 应用需要更长时间渲染）。
   * 同一店铺 30 秒内只抓取一次，避免重复。
   */
  private scheduleShopNameSync(shopId: string): void {
    const shopView = this.views.get(shopId);
    if (!shopView) return;
    // 防抖：30 秒内已抓取过则跳过
    if (shopView.lastShopNameSyncAt && Date.now() - shopView.lastShopNameSyncAt < 30_000) {
      return;
    }
    if (shopView.shopNameSyncTimer) {
      clearTimeout(shopView.shopNameSyncTimer);
    }
    shopView.shopNameSyncTimer = setTimeout(() => {
      shopView.shopNameSyncTimer = null;
      void this.fetchShopName(shopId);
    }, 6000);
    shopView.shopNameSyncTimer.unref?.();
  }

  /**
   * 从平台页面抓取真实店铺名并同步到数据库。
   * 失败时静默忽略（保留数据库中现有的 shopName）。
   * 首次失败后 10 秒自动重试一次（页面可能仍在加载）。
   */
  private async fetchShopName(shopId: string, isRetry = false): Promise<void> {
    const shopView = this.views.get(shopId);
    if (!shopView) return;
    const wc = shopView.view.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) return;
    if (shopView.loginStatus !== 'logged_in') return;

    const platform = getPlatform(shopView.platformId);
    const script = platform.loginDetection.shopNameScript;
    if (!script) return;

    // 定时器已触发，清理引用（避免阻止重试定时器设置）
    shopView.shopNameSyncTimer = null;
    if (!isRetry) {
      shopView.lastShopNameSyncAt = Date.now();
    }
    try {
      const result = (await wc.executeJavaScript(script)) as string | null;
      if (!result || typeof result !== 'string') {
        // 诊断：脚本返回 null，记录页面 title 和候选元素文本，便于后续优化选择器
        try {
          const diag = (await wc.executeJavaScript(`(function(){
            var title = document.title || '';
            var nameEls = document.querySelectorAll('[class*="name"], [class*="Name"], [class*="shop"], [class*="Shop"], [class*="merchant"], [class*="Merchant"]');
            var texts = [];
            var seen = {};
            for (var i = 0; i < nameEls.length && texts.length < 15; i++) {
              var t = (nameEls[i].textContent || '').trim();
              if (t && t.length >= 2 && t.length <= 50 && !seen[t]) { seen[t] = 1; texts.push(t); }
            }
            return { url: location.href, title: title, candidateTexts: texts };
          })()`)) as { url: string; title: string; candidateTexts: string[] } | null;
          this.logger?.debug(
            { shopId, platform: shopView.platformId, diag, isRetry },
            '店铺名称抓取返回 null，已记录诊断信息（页面候选元素文本）',
          );
        } catch {
          // 诊断脚本失败时静默
        }
        this.scheduleShopNameRetry(shopId, isRetry);
        return;
      }
      const trimmed = result.trim();
      if (!trimmed || trimmed.length < 2 || trimmed.length > 50) {
        this.logger?.debug(
          { shopId, platform: shopView.platformId, rawResult: result, isRetry },
          '店铺名称抓取结果长度不合法，已忽略',
        );
        this.scheduleShopNameRetry(shopId, isRetry);
        return;
      }
      this.logger?.info(
        { shopId, platform: shopView.platformId, fetchedName: trimmed },
        '店铺名称抓取成功',
      );
      this.emit('shopNameUpdated', { shopId, shopName: trimmed });
    } catch (err) {
      this.logger?.debug(
        { shopId, platform: shopView.platformId, isRetry, err: err instanceof Error ? err.message : String(err) },
        '店铺名称抓取失败（页面导航中或脚本异常）',
      );
      this.scheduleShopNameRetry(shopId, isRetry);
    }
  }

  /**
   * 安排店铺名称抓取重试。
   * 仅在首次抓取失败时触发，15 秒后重试一次（页面可能仍在加载）。
   */
  private scheduleShopNameRetry(shopId: string, isRetry: boolean): void {
    if (isRetry) return; // 只重试一次
    const shopView = this.views.get(shopId);
    if (!shopView) return;
    if (shopView.shopNameSyncTimer) return; // 已有定时器在等待
    if (shopView.loginStatus !== 'logged_in') return;
    shopView.shopNameSyncTimer = setTimeout(() => {
      shopView.shopNameSyncTimer = null;
      void this.fetchShopName(shopId, true);
    }, 15_000);
    shopView.shopNameSyncTimer.unref?.();
  }

  /**
   * 登录成功后检查当前 URL 是否为客服会话页面，不是则主动导航。
   * 拼多多登录后默认跳转到首页（mms.pinduoduo.com/home/），而非客服会话页面。
   */
  private navigateToWebUrlIfNeeded(shopId: string, shopView: ShopView): void {
    const wc = shopView.view.webContents;
    if (wc.isDestroyed()) return;
    const webUrl = shopView.webUrl;
    if (!webUrl) return;
    const currentUrl = wc.getURL();
    if (!currentUrl) return;
    if (this.isSamePageUrl(currentUrl, webUrl)) return;
    this.logger?.info(
      { shopId, platform: shopView.platformId, currentUrl, targetUrl: webUrl },
      '登录成功: 当前页面非客服会话页面，自动导航到客服会话页面',
    );
    wc.loadURL(webUrl).catch((err: unknown) => {
      this.logger?.warn(
        { shopId, platform: shopView.platformId, err: err instanceof Error ? err.message : String(err) },
        '登录成功: 导航到客服会话页面失败',
      );
    });
  }

  /** 比较两个 URL 是否在同一页面（origin + pathname 相同，忽略 hash 和 query） */
  private isSamePageUrl(url1: string, url2: string): boolean {
    try {
      const u1 = new URL(url1);
      const u2 = new URL(url2);
      return u1.origin === u2.origin && u1.pathname === u2.pathname;
    } catch {
      return url1 === url2;
    }
  }

  getActiveShopId(): string | null {
    return this.activeShopId;
  }

  getVisualCaptureTarget(shopId: string): VisualCaptureTarget | null {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return null;
    if (this.activeShopId !== shopId) return null;
    const shopView = this.views.get(shopId);
    if (!shopView || shopView.view.webContents.isDestroyed()) return null;

    const handle = this.mainWindow.getNativeWindowHandle();
    const value = handle.length >= 8
      ? handle.readBigUInt64LE(0)
      : BigInt(handle.readUInt32LE(0));
    const bounds = shopView.view.getBounds();
    if (bounds.width <= 0 || bounds.height <= 0) return null;

    // getBounds() 返回 DIP；截图侧（Win32 BitBlt）使用物理像素。
    // 取 view 所在显示器的 scaleFactor，交给截图方换算，避免高 DPI 下截错区域。
    let scaleFactor = 1;
    try {
      const display = screen.getDisplayMatching(bounds);
      if (display?.scaleFactor && display.scaleFactor > 0) {
        scaleFactor = display.scaleFactor;
      }
    } catch {
      // screen 不可用时保持 1，等价于 100% 缩放
    }

    return {
      windowHandle: `0x${value.toString(16)}`,
      captureRegion: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
      scaleFactor,
    };
  }

  setActiveShopId(shopId: string | null): void {
    if (shopId === this.activeShopId) {
      this.logger?.info({ shopId, activeShopId: this.activeShopId }, 'setActiveShopId: 已是活跃店铺，跳过');
      return;
    }

    // 隐藏旧的活跃 view
    const oldShopId = this.activeShopId;
    if (oldShopId && oldShopId !== shopId) {
      const oldView = this.views.get(oldShopId);
      if (oldView) {
        try {
          oldView.view.setVisible(false);
          this.logger?.info({ oldShopId, newShopId: shopId }, 'setActiveShopId: 已隐藏旧活跃 view');
        } catch (err) {
          this.logger?.warn({ oldShopId, err: err instanceof Error ? err.message : String(err) }, 'setActiveShopId: 隐藏旧 view 失败');
        }
      }
    }

    this.activeShopId = shopId;

    if (shopId && this.mainWindow) {
      this.logger?.info({ shopId, hasMainWindow: !!this.mainWindow }, 'setActiveShopId: 开始 mount view');
      this.mountView(shopId);
    } else {
      this.logger?.warn({ shopId, hasMainWindow: !!this.mainWindow }, 'setActiveShopId: shopId 为空或 mainWindow 不存在，未 mount view');
    }
  }

  /** 确保店铺 view 已创建（若不存在则创建），并挂载为活跃 view */
  async ensureAndMount(shopId: string, webUrl: string, platformId: string): Promise<void> {
    if (!this.views.has(shopId)) {
      await this.ensureView(shopId, webUrl, platformId);
    }
    this.setActiveShopId(shopId);
  }

  private mountView(shopId: string): void {
    const shopView = this.views.get(shopId);
    if (!shopView || !this.mainWindow) {
      this.logger?.warn({ shopId, hasShopView: !!shopView, hasMainWindow: !!this.mainWindow }, 'mountView: shopView 或 mainWindow 不存在');
      return;
    }
    try {
      // 先移除再添加，确保 view 在最上层（z-order）
      try {
        this.mainWindow.contentView.removeChildView(shopView.view);
      } catch {
        // view 不在子列表中，忽略
      }
      this.mainWindow.contentView.addChildView(shopView.view);
      shopView.view.setVisible(true);
      this.resizeActiveView();
      // 强制重绘，解决 GPU 合成层未及时刷新导致白屏的问题
      try {
        shopView.view.webContents.invalidate();
      } catch {
        // ignore
      }
      const bounds = shopView.view.getBounds();
      const childCount = this.mainWindow.contentView.children.length;
      this.logger?.info(
        { shopId, bounds, childCount, visible: true },
        'mountView: view 已挂载并设置为可见',
      );
    } catch (err) {
      this.logger?.error(
        { shopId, err: err instanceof Error ? err.message : String(err) },
        'mountView: 挂载 view 失败',
      );
    }
  }

  private resizeActiveView(): void {
    if (!this.mainWindow || !this.activeShopId) return;
    const shopView = this.views.get(this.activeShopId);
    if (!shopView) return;
    const [width, height] = this.mainWindow.getContentSize();
    shopView.view.setBounds(this.computeViewBounds(width, height));
  }

  /**
   * 计算中央 WebContentsView 的 bounds。
   * 逻辑集中在 src/workspace/layout.ts，与渲染层共用，避免两侧尺寸漂移。
   */
  private computeViewBounds(
    width: number,
    height: number,
  ): { x: number; y: number; width: number; height: number } {
    return computeViewBounds(width, height, this.layout);
  }

  /** 更新工作台布局并立即重算活跃 view 的 bounds（workspace:setLayout） */
  setWorkspaceLayout(partial: Partial<WorkspaceLayout>): WorkspaceLayout {
    const next: WorkspaceLayout = {
      sidebarWidth: typeof partial.sidebarWidth === 'number' && partial.sidebarWidth >= 0
        ? partial.sidebarWidth
        : this.layout.sidebarWidth,
      rightPanelWidth: typeof partial.rightPanelWidth === 'number' && partial.rightPanelWidth >= 0
        ? partial.rightPanelWidth
        : this.layout.rightPanelWidth,
      rightPanelVisible: typeof partial.rightPanelVisible === 'boolean'
        ? partial.rightPanelVisible
        : this.layout.rightPanelVisible,
    };
    this.layout = next;
    this.resizeActiveView();
    this.logger?.info({ layout: next }, 'workspace:setLayout 已应用');
    return next;
  }

  getWorkspaceLayout(): WorkspaceLayout {
    return { ...this.layout };
  }

  private startLoginCheck(shopId: string): void {
    const shopView = this.views.get(shopId);
    if (!shopView || shopView.loginCheckTimer) return;

    shopView.loginCheckTimer = setInterval(() => {
      void this.checkLoginStatus(shopId);
    }, LOGIN_CHECK_INTERVAL_MS);
    shopView.loginCheckTimer.unref?.();
    this.logger?.info({ shopId, intervalMs: LOGIN_CHECK_INTERVAL_MS }, '登录状态定时检测已启动');
  }

  private async handleNavigation(shopId: string, url: string): Promise<void> {
    const shopView = this.views.get(shopId);
    if (!shopView) return;
    const webUrl = shopView.webUrl;
    if (!url || !webUrl) return;

    const platform = getPlatform(shopView.platformId);
    const loginDetection = platform.loginDetection;
    const isLoginPage = this.isLoginPage(url, loginDetection.loginPageUrlPatterns, loginDetection.loginPageUrlRegexps);
    // 域名精确匹配：startsWith 可被 https://im.jinritemai.com.evil.com 前缀劫持绕过，
    // 必须按 hostname 精确比较（含子域名放行）
    const isSameHost = (base: string): boolean => {
      try {
        const baseHost = new URL(base).hostname.toLowerCase();
        const urlHost = new URL(url).hostname.toLowerCase();
        return urlHost === baseHost || urlHost.endsWith('.' + baseHost);
      } catch {
        return false;
      }
    };
    const isPlatformHost = isSameHost(loginDetection.navigationGuardBaseUrl);
    // 白名单域名放行（OAuth 回调、SSO 中间域名等）——同样按 hostname 精确匹配
    const isAllowedAuthDomain = (loginDetection.allowedAuthDomains ?? []).some((d) => isSameHost(d));

    if (!isPlatformHost && !isLoginPage && !isAllowedAuthDomain) {
      if (!shopView.view.webContents.isDestroyed()) {
        shopView.view.webContents.loadURL(webUrl).catch(() => {});
      }
    }

    // 延迟检查登录状态，等页面完全加载后再检测，避免页面加载过程中误检测到"登录过期"文本
    setTimeout(() => {
      void this.checkLoginStatus(shopId);
    }, NAV_LOGIN_CHECK_DELAY_MS);
  }

  private async checkLoginStatus(shopId: string): Promise<void> {
    const shopView = this.views.get(shopId);
    if (!shopView) return;
    const wc = shopView.view.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) {
      this.logger?.warn({ shopId, platform: shopView.platformId }, '登录检测: webContents 已销毁或崩溃');
      this.setLoginStatus(shopId, 'logged_out');
      return;
    }

    const platform = getPlatform(shopView.platformId);
    const loginDetection = platform.loginDetection;

    const currentUrl = wc.getURL();
    const isLoginPage = this.isLoginPage(currentUrl, loginDetection.loginPageUrlPatterns, loginDetection.loginPageUrlRegexps);

    if (isLoginPage) {
      if (shopView.loginStatus !== 'logged_out') {
        this.logger?.info({ shopId, platform: shopView.platformId, url: currentUrl }, '登录检测: URL 匹配登录页');
      }
      this.setLoginStatus(shopId, 'logged_out');
      return;
    }

    try {
      const domSelectors = JSON.stringify(loginDetection.loggedInDomSelectors);
      const expiredTexts = JSON.stringify(loginDetection.loginExpiredTexts);
      const useShadowDom = !!loginDetection.requiresShadowDomTraversal;

      // 合并两次 executeJavaScript 为一次，减少 IPC 开销
      const result = (await wc.executeJavaScript(`(function() {
        var selectors = ${domSelectors};
        var texts = ${expiredTexts};
        var useShadow = ${useShadowDom};

        // 深度查询选择器：穿透 Shadow DOM 和 iframe
        function deepQuerySelector(sel) {
          var found = document.querySelector(sel);
          if (found) return found;
          // 穿透 open shadow roots
          if (useShadow) {
            var shadows = [];
            function collectShadows(root) {
              var nodes = root.querySelectorAll('*');
              for (var i = 0; i < nodes.length; i++) {
                if (nodes[i].shadowRoot) {
                  shadows.push(nodes[i].shadowRoot);
                  var inner = nodes[i].shadowRoot.querySelectorAll('*');
                  for (var j = 0; j < inner.length; j++) {
                    if (inner[j].shadowRoot) shadows.push(inner[j].shadowRoot);
                  }
                }
              }
            }
            collectShadows(document);
            for (var s = 0; s < shadows.length; s++) {
              found = shadows[s].querySelector(sel);
              if (found) return found;
            }
          }
          // 穿透同源 iframe
          var iframes = document.querySelectorAll('iframe');
          for (var k = 0; k < iframes.length; k++) {
            try {
              var doc = iframes[k].contentDocument || iframes[k].contentWindow.document;
              if (doc) {
                found = doc.querySelector(sel);
                if (found) return found;
              }
            } catch(e) {}
          }
          return null;
        }

        // 深度获取文本：穿透 Shadow DOM
        function deepInnerText() {
          var parts = [];
          function collectText(root) {
            if (root.body) {
              parts.push(root.body.innerText || '');
            } else {
              parts.push(root.textContent || '');
            }
            if (useShadow) {
              var nodes = root.querySelectorAll('*');
              for (var i = 0; i < nodes.length; i++) {
                if (nodes[i].shadowRoot) {
                  parts.push(nodes[i].shadowRoot.textContent || '');
                  collectText(nodes[i].shadowRoot);
                }
              }
            }
          }
          collectText(document);
          // 同源 iframe
          var iframes = document.querySelectorAll('iframe');
          for (var k = 0; k < iframes.length; k++) {
            try {
              var doc = iframes[k].contentDocument || iframes[k].contentWindow.document;
              if (doc) collectText(doc);
            } catch(e) {}
          }
          return parts.join(' ');
        }

        // DOM 选择器检测
        var domFound = false;
        for (var i = 0; i < selectors.length; i++) {
          if (deepQuerySelector(selectors[i])) { domFound = true; break; }
        }

        // 过期文本检测
        var bodyText = deepInnerText();
        var loginExpired = false;
        var matchedExpiredText = '';
        for (var j = 0; j < texts.length; j++) {
          if (bodyText.indexOf(texts[j]) !== -1) { loginExpired = true; matchedExpiredText = texts[j]; break; }
        }

        // 收集页面主要元素的 class 列表（用于诊断选择器不匹配问题）
        var domClasses = [];
        if (!domFound && !loginExpired) {
          var allElements = document.querySelectorAll('[class]');
          var seen = {};
          for (var n = 0; n < allElements.length && domClasses.length < 40; n++) {
            var cls = (allElements[n].className || '').toString();
            if (cls && !seen[cls] && cls.length < 200) {
              seen[cls] = true;
              domClasses.push(cls);
            }
          }
        }

        return { domFound: domFound, loginExpired: loginExpired, matchedExpiredText: matchedExpiredText, bodyTextSnippet: bodyText.substring(0, 500), domClasses: domClasses };
      })()`)) as { domFound: boolean; loginExpired: boolean; matchedExpiredText: string; bodyTextSnippet: string; domClasses: string[] } | null;

      if (!result) {
        this.logger?.debug({ shopId, platform: shopView.platformId }, '登录检测: executeJavaScript 返回 null（页面导航中）');
        return;
      }

      if (result.loginExpired) {
        const inGrace = Date.now() < shopView.startupGraceUntil;
        if (inGrace) {
          this.logger?.info({ shopId, platform: shopView.platformId, matchedText: result.matchedExpiredText }, '登录检测: 启动宽限期内检测到登录过期文本，暂不触发恢复（等待页面自动重新认证）');
          this.setLoginStatus(shopId, 'logging_in');
          return;
        }
        this.logger?.info({ shopId, platform: shopView.platformId, matchedText: result.matchedExpiredText }, '登录检测: 页面文本含登录过期关键词');
        this.setLoginStatus(shopId, 'logged_out');
        return;
      }
      if (result.domFound) {
        this.setLoginStatus(shopId, 'logged_in');
      } else {
        // logging_in 超时检测：超过 60s 仍未变为 logged_in 时记录告警
        const elapsed = Date.now() - shopView.lastLoginStatusChange;
        if (shopView.loginStatus === 'logging_in' && elapsed > LOGGING_IN_TIMEOUT_MS) {
          this.logger?.warn(
            { shopId, platform: shopView.platformId, elapsedMs: elapsed, url: currentUrl, bodyTextSnippet: result.bodyTextSnippet, domClasses: result.domClasses },
            '登录检测: logging_in 状态超时（DOM 选择器未匹配），可能页面结构变更或未完全加载',
          );
        }
        this.setLoginStatus(shopId, 'logging_in');
      }
    } catch (err) {
      this.logger?.debug({ shopId, platform: shopView.platformId, err: err instanceof Error ? err.message : String(err) }, '登录检测: executeJavaScript 失败（页面导航中或 JS 上下文未就绪）');
    }
  }

  private isLoginPage(url: string, patterns: string[], regexps?: string[]): boolean {
    if (!url) return true;
    if (regexps && regexps.length > 0) {
      for (const regexp of regexps) {
        try {
          if (new RegExp(regexp, 'i').test(url)) return true;
        } catch {
          // 正则编译失败，跳过
        }
      }
      return false;
    }
    const lower = url.toLowerCase();
    for (const pattern of patterns) {
      if (lower.includes(pattern)) return true;
    }
    return false;
  }

  // ============ Session Keepalive ============

  private startKeepalive(shopId: string): void {
    const shopView = this.views.get(shopId);
    if (!shopView || shopView.keepaliveTimer) return;
    // 首次 30 秒后执行一次（快速持久化登录后的 session cookies），
    // 之后每 KEEPALIVE_INTERVAL_MS 执行一次
    setTimeout(() => {
      void this.refreshSession(shopId);
    }, 30_000);
    shopView.keepaliveTimer = setInterval(() => {
      void this.refreshSession(shopId);
    }, KEEPALIVE_INTERVAL_MS);
    shopView.keepaliveTimer.unref?.();
  }

  private stopKeepalive(shopId: string): void {
    const shopView = this.views.get(shopId);
    if (!shopView) return;
    if (shopView.keepaliveTimer) {
      clearInterval(shopView.keepaliveTimer);
      shopView.keepaliveTimer = null;
    }
  }

  async refreshSession(shopId: string): Promise<void> {
    const shopView = this.views.get(shopId);
    if (!shopView) return;
    const wc = shopView.view.webContents;
    if (wc.isDestroyed()) return;
    try {
      // 使用 fetch 静默刷新 cookie，不使用 reload 避免打断客服对话
      await wc.executeJavaScript(`fetch('${shopView.webUrl}', { credentials: 'include', mode: 'no-cors' }).catch(function(){})`);
    } catch {
      // 页面可能正在导航，忽略
    }

    // 持久化 session cookies（快手/微信小店扫码登录只下发 session cookies，重启后丢失）
    // Electron persist: session 默认只持久化 persistent cookies，session cookies 关闭即丢
    // 这里把 session cookies 改写为 7 天过期的 persistent cookies，让登录态能跨重启保留
    await this.persistSessionCookies(shopId);
  }

  private async persistSessionCookies(shopId: string): Promise<void> {
    const shopView = this.views.get(shopId);
    if (!shopView) return;
    try {
      const partition = `persist:shop_${shopId}`;
      const ses = session.fromPartition(partition);
      const allCookies = await ses.cookies.get({});
      const sessionCookies = allCookies.filter((c) => c.session);
      if (sessionCookies.length === 0) return;

      const sevenDaysLater = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
      let persisted = 0;

      for (const cookie of sessionCookies) {
        try {
          if (!cookie.domain) continue;
          const protocol = cookie.secure ? 'https' : 'http';
          const domain = cookie.domain.replace(/^\./, '');
          const url = `${protocol}://${domain}${cookie.path || '/'}`;
          const details: Electron.CookiesSetDetails = {
            url,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path || '/',
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            expirationDate: sevenDaysLater,
          };
          // sameSite 为 'unspecified' 时不能传给 set()，否则会报错
          if (cookie.sameSite && cookie.sameSite !== 'unspecified') {
            details.sameSite = cookie.sameSite;
          }
          await ses.cookies.set(details);
          persisted++;
        } catch {
          // 单个 cookie 设置失败（受限域名/属性冲突等）忽略，继续下一个
        }
      }

      if (persisted > 0) {
        this.logger?.info(
          { shopId, platform: shopView.platformId, persisted, total: sessionCookies.length },
          '已将 session cookies 持久化为 7 天过期',
        );
      }
    } catch (err) {
      this.logger?.warn(
        { shopId, platform: shopView.platformId, err: err instanceof Error ? err.message : String(err) },
        '持久化 session cookies 失败',
      );
    }
  }

  /** 重新加载店铺页面（相当于浏览器 F5 刷新） */
  reloadShop(shopId: string): void {
    const shopView = this.views.get(shopId);
    if (!shopView) return;
    const wc = shopView.view.webContents;
    if (wc.isDestroyed()) return;
    try {
      wc.reload();
      this.logger?.info({ shopId, platform: shopView.platformId }, '店铺页面已刷新');
    } catch (err) {
      this.logger?.error({ shopId, platform: shopView.platformId, err: err instanceof Error ? err.message : String(err) }, '店铺页面刷新失败');
    }
  }

  async forceReLogin(shopId: string): Promise<void> {
    const shopView = this.views.get(shopId);
    if (!shopView) return;
    const wc = shopView.view.webContents;
    if (wc.isDestroyed()) return;

    this.logger?.info({ shopId, platform: shopView.platformId }, '强制重新登录: 开始清除 session 存储');

    try {
      const partition = `persist:shop_${shopId}`;
      const ses = session.fromPartition(partition);
      await ses.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'shadercache', 'serviceworkers', 'cachestorage'],
      });
      await ses.clearCache();
      await ses.clearHostResolverCache();
      this.logger?.info({ shopId, platform: shopView.platformId }, '强制重新登录: session 存储已清除，重新加载页面');
    } catch (err) {
      this.logger?.error({ shopId, platform: shopView.platformId, err: err instanceof Error ? err.message : String(err) }, '强制重新登录: 清除 session 存储失败');
    }

    shopView.autoRecoveryAttempts = 0;
    if (shopView.autoRecoveryTimer) {
      clearTimeout(shopView.autoRecoveryTimer);
      shopView.autoRecoveryTimer = null;
    }
    // 设置手动重新登录标志，防止登录页面的 logged_out 状态触发自动恢复
    shopView.manualReLoginInProgress = true;
    // 重置启动宽限期，让用户手动登录后页面有足够时间加载
    shopView.startupGraceUntil = Date.now() + STARTUP_GRACE_MS;
    this.setLoginStatus(shopId, 'logging_in');

    const platform = getPlatform(shopView.platformId);
    const loginUrl = platform.loginDetection.loginPageUrl ?? shopView.webUrl;

    try {
      await wc.loadURL(loginUrl);
      this.logger?.info({ shopId, platform: shopView.platformId, url: loginUrl }, '强制重新登录: 已导航到登录页面');
    } catch (err) {
      this.logger?.error({ shopId, platform: shopView.platformId, err: err instanceof Error ? err.message : String(err) }, '强制重新登录: 导航到登录页面失败');
    }
  }

  // ============ 登录过期自动恢复 ============

  private triggerAutoRecovery(shopId: string): void {
    const shopView = this.views.get(shopId);
    if (!shopView) return;
    if (shopView.autoRecoveryTimer) return; // 已有恢复计划在执行

    // 如果当前 URL 已经是登录页面，跳过自动恢复
    // 用户需要手动扫码登录，重新加载页面无法解决未登录问题，只会导致循环跳转
    const wc = shopView.view.webContents;
    if (!wc.isDestroyed()) {
      const currentUrl = wc.getURL();
      const platform = getPlatform(shopView.platformId);
      const isCurrentlyOnLoginPage = this.isLoginPage(
        currentUrl,
        platform.loginDetection.loginPageUrlPatterns,
        platform.loginDetection.loginPageUrlRegexps,
      );
      if (isCurrentlyOnLoginPage) {
        this.logger?.info(
          { shopId, platform: shopView.platformId, url: currentUrl },
          '自动恢复: 当前已在登录页面，跳过自动恢复（等待用户手动扫码登录）',
        );
        return;
      }
    }

    if (shopView.autoRecoveryAttempts >= AUTO_RECOVERY_MAX_ATTEMPTS) {
      this.logger?.warn({ shopId, platform: shopView.platformId, attempts: shopView.autoRecoveryAttempts }, '自动恢复: 已达最大重试次数，放弃恢复');
      this.emit('recovery-exhausted', { shopId, attempts: shopView.autoRecoveryAttempts });
      return;
    }

    const delay = shopView.autoRecoveryAttempts === 0
      ? AUTO_RECOVERY_INITIAL_DELAY_MS
      : AUTO_RECOVERY_RETRY_DELAY_MS;
    shopView.autoRecoveryAttempts += 1;
    this.logger?.info({ shopId, platform: shopView.platformId, attempt: shopView.autoRecoveryAttempts, delayMs: delay }, '自动恢复: 已安排恢复任务');
    this.emit('recovery-scheduled', { shopId, attempt: shopView.autoRecoveryAttempts, delayMs: delay });

    shopView.autoRecoveryTimer = setTimeout(() => {
      shopView.autoRecoveryTimer = null;
      void this.executeRecovery(shopId);
    }, delay);
    shopView.autoRecoveryTimer.unref?.();
  }

  private async executeRecovery(shopId: string): Promise<void> {
    const shopView = this.views.get(shopId);
    if (!shopView) return;
    const wc = shopView.view.webContents;
    if (wc.isDestroyed()) return;
    // 仅当仍处于 logged_out 时才尝试恢复
    if (shopView.loginStatus !== 'logged_out') return;

    // 最后一次尝试时清除 session 存储，强制进入登录页面
    const isLastAttempt = shopView.autoRecoveryAttempts >= AUTO_RECOVERY_MAX_ATTEMPTS;
    try {
      this.logger?.info({ shopId, platform: shopView.platformId, attempt: shopView.autoRecoveryAttempts, url: shopView.webUrl, clearSession: isLastAttempt }, '自动恢复: 开始重新加载页面');
      this.emit('recovery-start', { shopId, attempt: shopView.autoRecoveryAttempts });

      if (isLastAttempt) {
        try {
          const partition = `persist:shop_${shopId}`;
          const ses = session.fromPartition(partition);
          await ses.clearStorageData({
            storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
          });
          await ses.clearCache();
          this.logger?.info({ shopId, platform: shopView.platformId }, '自动恢复: 已清除 session 存储（最后一次尝试）');
        } catch (clearErr) {
          this.logger?.warn({ shopId, platform: shopView.platformId, err: clearErr instanceof Error ? clearErr.message : String(clearErr) }, '自动恢复: 清除 session 存储失败（忽略，继续重载）');
        }
      }

      // 最后一次尝试或当前已在登录页面时导航到登录页面，其他时候重新加载工作台 URL
      // 避免未登录时循环跳转：登录页面 → 客服会话页面 → 重定向回登录页面
      const platform = getPlatform(shopView.platformId);
      const currentUrl = wc.getURL();
      const isCurrentlyOnLoginPage = this.isLoginPage(
        currentUrl,
        platform.loginDetection.loginPageUrlPatterns,
        platform.loginDetection.loginPageUrlRegexps,
      );
      const targetUrl = (isLastAttempt || isCurrentlyOnLoginPage) && platform.loginDetection.loginPageUrl
        ? platform.loginDetection.loginPageUrl
        : shopView.webUrl;
      await wc.loadURL(targetUrl);
      // loadURL 后等待页面加载完成，然后检查是否恢复成功
      // did-navigate 中的 checkLoginStatus 可能过早执行（页面未完全加载），此处做延迟复查
      setTimeout(() => {
        const sv = this.views.get(shopId);
        if (sv && sv.loginStatus === 'logged_out') {
          this.logger?.warn({ shopId, platform: sv.platformId, attempt: sv.autoRecoveryAttempts }, '自动恢复: 页面重载后仍为 logged_out，安排下一次重试');
          this.triggerAutoRecovery(shopId);
        } else if (sv) {
          this.logger?.info({ shopId, platform: sv.platformId, status: sv.loginStatus }, '自动恢复: 页面重载后登录状态已恢复');
        }
      }, RECOVERY_VERIFY_DELAY_MS);
    } catch (err) {
      this.logger?.error({ shopId, platform: shopView.platformId, attempt: shopView.autoRecoveryAttempts, err: err instanceof Error ? err.message : String(err) }, '自动恢复: 重新加载页面失败');
      this.emit('recovery-failed', { shopId, err });
      // 安排下一次重试
      this.triggerAutoRecovery(shopId);
    }
  }

  // ============ HTTP 401/302 响应监控 ============

  private registerResponseMonitor(
    shopId: string,
    ses: Electron.Session,
    loginDetection: { expiredResponseUrlPatterns?: string[] },
  ): void {
    const shopView = this.views.get(shopId);
    if (!shopView || shopView.responseMonitorRegistered) return;
    const patterns = loginDetection.expiredResponseUrlPatterns;
    if (!patterns || patterns.length === 0) return;

    try {
      ses.webRequest.onResponseStarted({ urls: patterns }, (details) => {
        const status = details.statusCode;
        // 401 未授权 → 登录过期
        if (status === 401) {
          this.logger?.info({ shopId, platform: shopView.platformId, url: details.url, status }, '响应监控: 检测到 401 未授权');
          this.setLoginStatus(shopId, 'logged_out');
        } else if (status === 302) {
          // 302 重定向：检查 Location 响应头是否指向登录页
          const locationHeader = details.responseHeaders?.['Location'] || details.responseHeaders?.['location'];
          const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
          if (location) {
            const platform = getPlatform(shopView.platformId);
            const ld = platform.loginDetection;
            if (this.isLoginPage(location, ld.loginPageUrlPatterns, ld.loginPageUrlRegexps)) {
              this.logger?.info({ shopId, platform: shopView.platformId, url: details.url, location }, '响应监控: 302 重定向至登录页');
              this.setLoginStatus(shopId, 'logged_out');
            }
          }
        }
      });
      shopView.responseMonitorRegistered = true;
    } catch {
      // onResponseStarted 注册失败，忽略
    }
  }

  /** 获取所有已注册的店铺 ID */
  getAllShopIds(): string[] {
    return Array.from(this.views.keys());
  }

  async reloadAllViews(): Promise<void> {
    for (const shopView of this.views.values()) {
      try {
        const wc = shopView.view.webContents;
        if (!wc.isDestroyed()) {
          wc.reload();
        }
      } catch {
        // ignore
      }
    }
  }

  async reloadShopView(shopId: string): Promise<void> {
    const shopView = this.views.get(shopId);
    if (!shopView) return;
    const wc = shopView.view.webContents;
    if (!wc.isDestroyed()) {
      try {
        wc.reload();
      } catch {
        // ignore
      }
    }
  }

  /**
   * @deprecated 已被 per-shop keepalive 替代，调用为 no-op。
   * 保留方法签名以向后兼容，但不再执行全量 reload。
   */
  startPeriodicReload(_intervalMs: number = WebviewManager.RELOAD_INTERVAL_MS): void {
    // no-op: per-shop keepalive 已在 ensureView() 中启动，全量 reload 会打断客服对话
  }

  stopPeriodicReload(): void {
    if (this.reloadTimer) {
      clearInterval(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  destroyAll(): void {
    this.stopPeriodicReload();
    for (const shopId of Array.from(this.views.keys())) {
      this.stopKeepalive(shopId);
      this.removeView(shopId);
    }
    this.activeShopId = null;
  }

  /**
   * 诊断：获取指定店铺 webContents（用于 capturePage 等）
   * 返回 Electron 原生 WebContents，调用方需自行判空
   */
  getCapturableWebContents(shopId: string): Electron.WebContents | null {
    const shopView = this.views.get(shopId);
    if (!shopView || shopView.view.webContents.isDestroyed()) return null;
    return shopView.view.webContents;
  }

  /**
   * 诊断：返回所有 view 的当前状态（bounds、可见性、z-order）
   */
  diagnoseViews(): Record<string, unknown> {
    const children = this.mainWindow?.contentView.children ?? [];
    const viewsState: Record<string, unknown> = {};
    for (const [shopId, shopView] of this.views) {
      const bounds = shopView.view.getBounds();
      // 通过 children 数组查找 z-order 索引（越大越在上层）
      const zOrder = children.indexOf(shopView.view);
      viewsState[shopId] = {
        bounds,
        zOrder,
        isDestroyed: shopView.view.webContents.isDestroyed(),
        url: shopView.view.webContents.getURL(),
        loginStatus: shopView.loginStatus,
      };
    }
    return {
      activeShopId: this.activeShopId,
      hasMainWindow: !!this.mainWindow,
      contentSize: this.mainWindow?.getContentSize() ?? null,
      childCount: children.length,
      views: viewsState,
    };
  }

  hideActiveViewForModal(): void {
    if (!this.activeShopId) return;
    const shopView = this.views.get(this.activeShopId);
    if (!shopView) return;
    try {
      shopView.view.setVisible(false);
      this.viewHiddenByModal = true;
      this.logger?.info({ shopId: this.activeShopId }, 'hideActiveViewForModal: 已隐藏活跃视图');
    } catch (err) {
      this.logger?.warn({ shopId: this.activeShopId, err: err instanceof Error ? err.message : String(err) }, 'hideActiveViewForModal: 隐藏视图失败');
    }
  }

  restoreActiveViewAfterModal(): void {
    if (!this.viewHiddenByModal) return;
    if (!this.activeShopId) {
      this.viewHiddenByModal = false;
      return;
    }
    const shopView = this.views.get(this.activeShopId);
    if (!shopView) {
      this.viewHiddenByModal = false;
      return;
    }
    try {
      shopView.view.setVisible(true);
      try {
        shopView.view.webContents.invalidate();
      } catch {
        // ignore
      }
      this.viewHiddenByModal = false;
      this.logger?.info({ shopId: this.activeShopId }, 'restoreActiveViewAfterModal: 已恢复活跃视图');
    } catch (err) {
      this.logger?.warn({ shopId: this.activeShopId, err: err instanceof Error ? err.message : String(err) }, 'restoreActiveViewAfterModal: 恢复视图失败');
    }
  }

  /**
   * 在隐藏窗口中加载指定 URL 并执行脚本。
   * 复用店铺的 session 分区（登录态），执行完毕后关闭窗口。
   *
   * 使用 paintWhenInitiallyHidden: true 让窗口在隐藏状态下仍然渲染内容，
   * 解决 show: false 时 React SPA 不渲染内容区域的问题。
   */
  async scrapeUrlInHiddenWindow(
    shopId: string,
    url: string,
    script: string,
    timeoutMs = 60_000,
    waitMs = 6_000,
    preloadScript?: string,
  ): Promise<unknown> {
    const partition = `persist:shop_${shopId}`;
    const ses = session.fromPartition(partition);

    // 收集所有请求的 URL，用于诊断和注入页面上下文供脚本直接 fetch
    const capturedApiUrls: string[] = [];
    const allRequestUrls: Array<{ url: string; resourceType: string; statusCode: number; contentType: string }> = [];
    const filter = { urls: ['*://*/*'] };
    const onCompleted = (details: Electron.OnCompletedListenerDetails) => {
      const ct = details.responseHeaders?.['content-type']?.[0]
        || details.responseHeaders?.['Content-Type']?.[0] || '';
      if (allRequestUrls.length < 200) {
        allRequestUrls.push({
          url: details.url,
          resourceType: details.resourceType,
          statusCode: details.statusCode,
          contentType: ct.substring(0, 100),
        });
      }
      // Electron 中 Fetch API 请求归类为 'xhr'；部分场景下可能为 'other'。
      // 放宽资源类型限制，同时接受 2xx 状态码，避免遗漏微前端/iframe 内发起的商品 API 请求。
      const isApiLikeType = details.resourceType === 'xhr'
        || details.resourceType === 'other';
      const isOkStatus = details.statusCode >= 200 && details.statusCode < 300;
      if (isApiLikeType && isOkStatus) {
        if (ct.includes('application/json') || /product|detail|spu|goods|item|sku|spec|property|category|tproduct/i.test(details.url)) {
          if (!capturedApiUrls.includes(details.url)) {
            capturedApiUrls.push(details.url);
          }
        }
      }
    };
    ses.webRequest.onCompleted(filter, onCompleted);

    // 如果提供了 preloadScript，写入临时文件并在窗口创建时加载
    let preloadPath: string | undefined;
    let framePreloadId: string | undefined;
    if (preloadScript) {
      const tmpDir = path.join(app.getPath('temp'), 'aikefu-preload');
      fs.mkdirSync(tmpDir, { recursive: true });
      preloadPath = path.join(tmpDir, `preload-${shopId}-${Date.now()}.js`);
      // 在隔离的 preload world 中，通过 Electron 官方 bridge 将受控脚本放到页面主 world 执行。
      // 这样仍可在 SPA 发起请求前安装 fetch/XHR 拦截器，同时不必关闭 contextIsolation/sandbox。
      const isolatedPreload = [
        "const { contextBridge } = require('electron');",
        `const source = ${JSON.stringify(preloadScript)};`,
        'contextBridge.executeInMainWorld({',
        '  func: (scriptSource) => { (0, eval)(scriptSource); },',
        '  args: [source],',
        '});',
      ].join('\n');
      fs.writeFileSync(preloadPath, isolatedPreload, 'utf-8');
      // 额外将 preload 注册为 frame 类型，使其在所有 frame（包括 iframe/微前端容器）中运行，
      // 从而拦截微前端内发起的 fetch/XHR 请求（如抖店商品列表 API /product/tproduct/list）
      try {
        framePreloadId = registerFramePreload(ses, preloadPath);
        this.logger?.info({ shopId, preloadPath, framePreloadId }, 'scrapeUrlInHiddenWindow: 已注册frame preload（覆盖iframe）');
      } catch (e) {
        this.logger?.warn({ shopId, err: e instanceof Error ? e.message : String(e) }, 'scrapeUrlInHiddenWindow: 注册frame preload失败，仅主frame生效');
      }
    }

    const win = new BrowserWindow({
      show: true,
      x: -3000,
      y: -3000,
      width: 1280,
      height: 800,
      webPreferences: {
        session: ses,
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    try {
      this.logger?.info({ shopId, url }, 'scrapeUrlInHiddenWindow: 开始加载页面');

      // 监听隐藏窗口的控制台消息，便于诊断脚本错误
      win.webContents.on('console-message', (details) => {
        if (details.level !== 'debug') {
          this.logger?.warn(
            {
              shopId,
              url,
              level: details.level,
              consoleMessage: details.message,
              line: details.lineNumber,
              sourceId: (details.sourceId || '').substring(0, 200),
            },
            'scrapeUrlInHiddenWindow: 页面控制台输出',
          );
        }
      });

      await this.loadScrapePage(win, url, Math.min(timeoutMs, 90_000));

      // 等待页面渲染 + API 数据加载
      await new Promise((r) => setTimeout(r, waitMs));

      // 注入捕获到的 API URL 和所有请求 URL 到页面上下文，供脚本使用
      try {
        await win.webContents.executeJavaScript(
          `window.__capturedApiUrls = ${JSON.stringify(capturedApiUrls)};` +
          `window.__allRequestUrls = ${JSON.stringify(allRequestUrls)};`,
        );
        this.logger?.info(
          {
            shopId,
            url,
            currentUrl: win.webContents.getURL(),
            waitMs,
            capturedApiUrlCount: capturedApiUrls.length,
            allRequestCount: allRequestUrls.length,
          },
          'scrapeUrlInHiddenWindow: 页面已加载',
        );
      } catch {
        // ignore
      }

      // 执行主脚本，带超时
      const result = await Promise.race([
        win.webContents.executeJavaScript(script, true),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('脚本执行超时')), timeoutMs),
        ),
      ]);

      this.logger?.info({ shopId, url, resultType: typeof result }, 'scrapeUrlInHiddenWindow: 脚本执行完成');
      return result;
    } finally {
      // 清理拦截器
      ses.webRequest.onCompleted(filter, null);
      win.destroy();
      // 注销 frame preload 注册，避免删除文件后 session 残留无效注册
      if (framePreloadId) {
        try { unregisterFramePreload(ses, framePreloadId, preloadPath); } catch { /* ignore */ }
      }
      // 清理临时 preload 文件
      if (preloadPath) {
        try { fs.unlinkSync(preloadPath); } catch { /* ignore */ }
      }
    }
  }

  /**
   * 在隐藏窗口中加载指定 URL，拦截网络请求并执行脚本。
   * 用于诊断微前端架构页面（如抖店后台）的 API 请求。
   *
   * 返回 { scriptResult, apiRequests }：
   * - scriptResult: 脚本执行结果
   * - apiRequests: 拦截到的返回 JSON 的 API 请求列表
   */
  async diagnoseWithNetworkCapture(
    shopId: string,
    url: string,
    script: string,
    waitMs = 15_000,
    timeoutMs = 90_000,
  ): Promise<{ scriptResult: unknown; apiRequests: Array<{ url: string; method: string; statusCode: number; contentType: string; resourceType: string }> }> {
    const partition = `persist:shop_${shopId}`;
    const ses = session.fromPartition(partition);

    // 拦截网络请求，记录返回 JSON 的 API
    const apiRequests: Array<{ url: string; method: string; statusCode: number; contentType: string; resourceType: string }> = [];
    const allRequests: Array<{ url: string; method: string; statusCode: number; contentType: string; resourceType: string }> = [];

    const filter = { urls: ['*://*/*'] };
    ses.webRequest.onCompleted(filter, (details) => {
      const contentType = details.responseHeaders?.['content-type']?.[0] || details.responseHeaders?.['Content-Type']?.[0] || '';
      const entry = {
        url: details.url,
        method: details.method,
        statusCode: details.statusCode,
        contentType,
        resourceType: details.resourceType,
      };
      allRequests.push(entry);
      // 记录 XHR 请求（Electron 中 fetch 请求也归为 xhr 类型）
      if (details.resourceType === 'xhr') {
        apiRequests.push(entry);
      }
    });

    const win = new BrowserWindow({
      show: false,
      paintWhenInitiallyHidden: true,
      width: 1280,
      height: 800,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    try {
      this.logger?.info({ shopId, url }, 'diagnoseWithNetworkCapture: 开始加载页面');

      await this.loadScrapePage(win, url, Math.min(timeoutMs, 90_000));

      // 等待 SPA 路由和 API 请求完成
      await new Promise((r) => setTimeout(r, waitMs));
      this.logger?.info(
        { shopId, url, currentUrl: win.webContents.getURL(), apiRequestCount: apiRequests.length, totalRequestCount: allRequests.length },
        'diagnoseWithNetworkCapture: 页面已加载，网络请求已收集',
      );

      // 执行脚本
      const scriptResult = await Promise.race([
        win.webContents.executeJavaScript(script, true),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('脚本执行超时')), timeoutMs),
        ),
      ]);

      return { scriptResult, apiRequests };
    } finally {
      // 清理拦截器
      ses.webRequest.onCompleted(filter, null);
      win.destroy();
    }
  }
}
