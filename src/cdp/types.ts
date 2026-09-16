/**
 * Webview 基础类型定义
 *
 * 解耦 src/ 业务层与 electron/ 主进程：
 * - ShopSupervisor 依赖 IWebContents / IWebviewManager 接口
 * - electron/webview-manager.ts 实现这些接口
 *
 * 详见 docs/开发文档-v2.md §9
 */

/** 消息来源角色 */
export type MessageFrom = 'buyer' | 'seller' | 'system';

/** 单条飞鸽消息（从 CdpMessage 演进，保持兼容） */
export interface FeigeMessage {
  sessionId: string;
  from: MessageFrom;
  text: string;
  timestamp: number;
  /** Stable platform/DOM message identifier when the page exposes one. */
  messageId?: string;
  /**
   * 稳定买家标识（BUYER-ID-001）。平台页面若暴露 uid/openid 之类的稳定 ID 则填此字段；
   * 缺失时只能回退到 sessionId（feige 的 sessionId 实际是买家昵称），此时视为低置信度，
   * 不能仅凭昵称合并同名买家。
   */
  buyerId?: string;
  productId?: string;
  /** 图片 URL 列表（买家发送的图片消息，用于多模态 LLM 理解） */
  images?: string[];
}

/** 向后兼容：CdpMessage 仍可使用 */
export type CdpMessage = FeigeMessage;

/** 登录状态 */
export type LoginStatus = 'logged_out' | 'logging_in' | 'logged_in';

export interface VisualCaptureTarget {
  windowHandle: string;
  captureRegion: { x: number; y: number; width: number; height: number };
  /**
   * 显示器缩放系数（Electron display.scaleFactor，1.0 = 100%）。
   *
   * captureRegion 用的是 Electron 的 DIP 坐标，而 Win32 BitBlt 使用物理像素；
   * 在 125%/150% 缩放的显示器上两者不一致，必须由截图方按本系数换算，
   * 否则会截取到错误区域，视觉输入整体错位。
   */
  scaleFactor: number;
}

/**
 * WebContents 抽象接口
 * 包装 Electron.WebContents，使 src/ 层不直接依赖 electron
 */
export interface IWebContents {
  executeJavaScript(expression: string, userGesture?: boolean): Promise<unknown>;
  sendInputEvent(event: unknown): Promise<void>;
  isDestroyed(): boolean;
  isCrashed(): boolean;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  reload(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * Webview 管理器接口
 * 负责多账号 WebContentsView 的创建/销毁/切换
 */
export interface IWebviewManager {
  /** 确保指定店铺的 view 已创建并加载 webUrl，返回其 WebContents */
  ensureView(shopId: string, webUrl: string, platformId: string): Promise<IWebContents>;
  /** 销毁指定店铺的 view */
  removeView(shopId: string): void;
  /** 查询登录状态 */
  getLoginStatus(shopId: string): LoginStatus;
  /** 设置登录状态 */
  setLoginStatus(shopId: string, status: LoginStatus): void;
  /** 获取当前激活的店铺 ID */
  getActiveShopId(): string | null;
  /** 设置当前激活的店铺 ID */
  setActiveShopId(shopId: string | null): void;
  /** 确保店铺 view 已创建（若不存在则创建），并挂载为活跃 view */
  ensureAndMount(shopId: string, webUrl: string, platformId: string): Promise<void>;
  /** 获取所有已注册的店铺 ID */
  getAllShopIds(): string[];
  /** 静默刷新指定店铺的 session（cookie keepalive） */
  refreshSession(shopId: string): Promise<void>;
  /** 强制重新登录：清除 session 存储并重新加载页面 */
  forceReLogin(shopId: string): Promise<void>;
  /** 重新加载店铺页面（相当于浏览器 F5 刷新） */
  reloadShop(shopId: string): void;
  /** Return the native window and view bounds used by the visual recognition service. */
  getVisualCaptureTarget?(shopId: string): VisualCaptureTarget | null;
  /** 诊断：返回所有 view 的当前状态（bounds、可见性、z-order） */
  diagnoseViews?(): Record<string, unknown>;
  /** 诊断：获取指定店铺的 webContents（用于 capturePage） */
  getCapturableWebContents?(shopId: string): unknown;
  /**
   * 在隐藏窗口中加载指定 URL 并执行脚本，返回脚本结果。
   * 使用店铺的 session 分区（复用登录态），执行完毕后关闭窗口。
   * 用于在非客服页面（如商家后台商品列表）上抓取数据。
   */
  scrapeUrlInHiddenWindow(shopId: string, url: string, script: string, timeoutMs?: number, waitMs?: number, preloadScript?: string): Promise<unknown>;

  /**
   * 在隐藏窗口中加载 URL，拦截网络请求并执行脚本。
   * 用于诊断微前端架构页面的 API 请求。
   */
  diagnoseWithNetworkCapture(
    shopId: string,
    url: string,
    script: string,
    waitMs?: number,
    timeoutMs?: number,
  ): Promise<{
    scriptResult: unknown;
    apiRequests: Array<{ url: string; method: string; statusCode: number; contentType: string; resourceType: string }>;
  }>;

  /** 临时隐藏活跃视图（用于 Modal 弹窗显示时） */
  hideActiveViewForModal?(): void;

  /** 恢复活跃视图（用于 Modal 弹窗关闭后） */
  restoreActiveViewAfterModal?(): void;

  /** 更新工作台布局（sidebar/右侧面板），由主进程统一重算 WebContentsView bounds */
  setWorkspaceLayout?(layout: {
    sidebarWidth?: number;
    rightPanelWidth?: number;
    rightPanelVisible?: boolean;
  }): unknown;

  /** 读取当前工作台布局 */
  getWorkspaceLayout?(): unknown;
}

/** loginStatusChanged 事件负载 */
export interface LoginStatusChangedEvent {
  shopId: string;
  status: LoginStatus;
  oldStatus?: LoginStatus;
}
