/**
 * 平台定义类型
 *
 * 将平台特定的选择器和行为抽象为类型定义，使系统支持多平台客服。
 * 每个平台（飞鸽/拼多多/快手/微信）拥有独立的选择器和登录检测配置。
 */

export type PlatformId = 'feige' | 'pinduoduo' | 'kuaishou' | 'weixin';

export interface PlatformSelectors {
  /** MutationObserver 消息选择器（CSS选择器数组） */
  messageSelectors: string[];
  /** 排除选择器正则（非消息区域的元素） */
  excludeSelectors: string;
  /** 会话ID提取函数源码（注入到页面中，返回会话标识字符串） */
  sessionIdExtractor: string;
  /** 输入框选择器（逗号分隔的CSS选择器） */
  inputSelector: string;
  /** 发送按钮CSS选择器 */
  sendButtonSelectors: string[];
  /** 发送按钮文本（用于文本匹配） */
  sendButtonTexts: string[];
  /** 卖家消息class模式（检测消息来自卖家） */
  sellerClassPatterns: string[];
  /** 买家消息class模式（检测消息来自买家） */
  buyerClassPatterns: string[];
  /** 系统消息class模式 */
  systemClassPatterns: string[];
  /** 关闭对话框文本 */
  closeDialogTexts: string[];
  /** 会话列表项CSS选择器（用于自动点击未读会话） */
  conversationItemSelectors: string[];
  /** 未读消息指示器CSS选择器（会话列表中的红点/数字标记） */
  unreadIndicatorSelectors: string[];
}

export interface PlatformLoginDetection {
  /** 登录页URL匹配模式（子串匹配，存在误匹配风险，建议配合 loginPageUrlRegexps 使用） */
  loginPageUrlPatterns: string[];
  /** 登录页URL正则匹配模式（优先于 loginPageUrlPatterns，避免子串误匹配如 'shop'） */
  loginPageUrlRegexps?: string[];
  /** 登录页完整URL（用于强制重新登录时导航到此页面，不设置则使用 defaultWebUrl） */
  loginPageUrl?: string;
  /** 已登录DOM特征选择器 */
  loggedInDomSelectors: string[];
  /** 登录过期/无权限文本特征 */
  loginExpiredTexts: string[];
  /** 请求头过滤域名通配符 */
  requestHeaderDomains: string[];
  /** 导航守卫 - 平台基础URL（用于判断是否在平台页面内） */
  navigationGuardBaseUrl: string;
  /** 导航守卫白名单域名前缀（OAuth回调、认证中间页等允许通过的域名） */
  allowedAuthDomains?: string[];
  /** 是否需要 Shadow DOM 穿透检测（快手等使用 Shadow DOM 的平台设为 true） */
  requiresShadowDomTraversal?: boolean;
  /** HTTP 登录过期检测：响应状态码触发登录过期的 API URL 模式（用于 onResponseStarted 监控） */
  expiredResponseUrlPatterns?: string[];
  /**
   * 店铺名称抓取脚本（注入到页面中执行，返回字符串或 null）
   * 登录成功后异步执行，用于从平台页面同步真实店铺名到本地数据库。
   * 脚本应为 IIFE 形式字符串，返回字符串（店铺名）或 null（抓取失败时保留原名）。
   */
  shopNameScript?: string;
}

export interface PlatformDefinition {
  id: PlatformId;
  name: string;
  /** 平台icon标识（用于UI显示） */
  icon: string;
  /** 默认web_url */
  defaultWebUrl: string;
  selectors: PlatformSelectors;
  loginDetection: PlatformLoginDetection;
}
