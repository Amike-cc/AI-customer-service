/**
 * Webview 客户端
 *
 * 替代 CdpClient，通过 webContents.executeJavaScript() 抓取/发送消息。
 * 接口与 CdpClient 对齐，使 ShopSupervisor 无感切换。
 *
 * 消息抓取机制：
 * - connect() 时注入 MutationObserver 脚本，将消息 push 到 window.__feigeMsgQueue
 * - 启动 500ms 轮询定时器，executeJavaScript 取出并清空队列
 * - 替代 CdpClient 的 Runtime.addBinding（executeJavaScript 不支持）
 *
 * 发送回复：
 * - 复用 CdpClient 的多候选 DOM 选择器
 * - typeChar 用 sendInputEvent 替代 Input.dispatchKeyEvent
 */
import type { Config } from '../config/schema';
import type { PlatformSelectors } from '../platform';
import type { IWebContents, FeigeMessage, MessageFrom } from './types';
import type { AppLogger } from '../logging/logger';
import fs from 'fs';
import path from 'path';
import { resolveData } from '../paths';

interface RawMessage {
  sessionId: string;
  from: string;
  text: string;
  timestamp: number;
  messageId?: string;
  productId?: string;
}

function focusInputScript(selector: string): string {
  return `(function() {
    function findInput(sel) {
      // 优先返回第一个可见元素（非零尺寸），避免命中 dialog 内隐藏的 textarea（如 weixin debug-config-dialog）
      var input = null;
      var nodes = document.querySelectorAll(sel);
      for (var idx = 0; idx < nodes.length; idx++) {
        var r = nodes[idx].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { input = nodes[idx]; break; }
      }
      if (input) return input;
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        try {
          var doc = iframes[i].contentDocument || iframes[i].contentWindow.document;
          if (doc) {
            input = doc.querySelector(sel);
            if (input) return input;
          }
        } catch(e) {}
      }
      // Shadow DOM 支持：遍历 open shadow roots
      function searchShadowRoots(root) {
        try {
          var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
          var node;
          while ((node = walker.nextNode())) {
            if (node.shadowRoot) {
              var el = node.shadowRoot.querySelector(sel);
              if (el) return el;
              var found = searchShadowRoots(node.shadowRoot);
              if (found) return found;
            }
          }
        } catch(e) {}
        return null;
      }
      return searchShadowRoots(document.body);
    }
    var input = findInput('${selector}');
    if (!input) return false;
    input.focus();
    input.click();
    return true;
  })()`;
}

function clearInputScript(selector: string): string {
  return `(function() {
    function findInput(sel) {
      // 优先返回第一个可见元素（非零尺寸），避免命中 dialog 内隐藏的 textarea（如 weixin debug-config-dialog）
      var input = null;
      var nodes = document.querySelectorAll(sel);
      for (var idx = 0; idx < nodes.length; idx++) {
        var r = nodes[idx].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { input = nodes[idx]; break; }
      }
      if (input) return input;
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        try {
          var doc = iframes[i].contentDocument || iframes[i].contentWindow.document;
          if (doc) {
            input = doc.querySelector(sel);
            if (input) return input;
          }
        } catch(e) {}
      }
      // Shadow DOM 支持：遍历 open shadow roots
      function searchShadowRoots(root) {
        try {
          var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
          var node;
          while ((node = walker.nextNode())) {
            if (node.shadowRoot) {
              var el = node.shadowRoot.querySelector(sel);
              if (el) return el;
              var found = searchShadowRoots(node.shadowRoot);
              if (found) return found;
            }
          }
        } catch(e) {}
        return null;
      }
      return searchShadowRoots(document.body);
    }
    var input = findInput('${selector}');
    if (!input) return false;
    if (input.contentEditable === 'true') {
      input.textContent = '';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      var setter = Object.getOwnPropertyDescriptor(
        input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
        'value'
      ).set;
      if (setter) { setter.call(input, ''); }
      else { input.value = ''; }
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  })()`;
}

export class WebviewClient {
  private connected = false;
  private observerInstalled = false;
  private messageBuffer: FeigeMessage[] = [];
  private messageHandler: ((msg: FeigeMessage) => void) | null = null;
  private revokeHandler: ((sessionId: string, revokedText: string) => void) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private currentPollIntervalMs = 300;
  private suppressUntil = 0;
  private readonly pollMinMs: number;
  private readonly pollMaxMs: number;
  private readonly pollIdleIncreaseMs: number;
  private readonly suppressMs: number;
  private readonly platformId: string;
  // 后台模式（非活跃店铺）使用更长的轮询间隔以降低资源占用
  private backgroundMode = false;
  private readonly backgroundPollMs: number;
  private logger: AppLogger | null = null;
  // 未读会话扫描
  private unreadScanTimer: NodeJS.Timeout | null = null;
  private unreadScanInFlight = false;
  private lastUnreadClickAt = 0;
  private static readonly UNREAD_SCAN_INTERVAL_MS = 3000;
  private static readonly UNREAD_CLICK_LOAD_MS = 1500;
  /** 转接会话进行中标志：transferToAgent 执行期间为 true，扫描器检查此标志并跳过扫描，
   *  避免扫描器点击会话列表项导致 React 重新渲染关闭转接抽屉。 */
  private transferInProgress = false;
  /** autoReply 开关：为 false 时扫描器跳过，避免点击菜单项覆盖用户手动操作 */
  private autoReplyEnabled = true;

  constructor(
    private webContents: IWebContents,
    private platformSelectors: PlatformSelectors,
    private config: Config,
    platformId?: string,
  ) {
    this.pollMinMs = config.cdp?.poll?.min_ms ?? 200;
    this.pollMaxMs = config.cdp?.poll?.max_ms ?? 2000;
    this.pollIdleIncreaseMs = config.cdp?.poll?.idle_increase_ms ?? 50;
    this.suppressMs = config.cdp?.poll?.suppress_ms ?? 5000;
    this.platformId = platformId ?? 'unknown';
    this.backgroundPollMs = config.cdp?.poll?.background_ms ?? 3000;
  }

  setLogger(logger: AppLogger): void {
    this.logger = logger;
  }

  /** 切换后台模式：非活跃店铺使用更长轮询间隔以降低 CPU 占用 */
  setBackgroundMode(enabled: boolean): void {
    if (this.backgroundMode === enabled) return;
    this.backgroundMode = enabled;
    if (enabled) {
      // 进入后台模式时立即放慢轮询
      this.currentPollIntervalMs = Math.max(this.currentPollIntervalMs, this.backgroundPollMs);
    } else {
      // 恢复前台模式时立即加速
      this.currentPollIntervalMs = this.pollMinMs;
    }
  }

  /** 设置 autoReply 开关：为 false 时扫描器跳过扫描，避免点击菜单项覆盖用户手动操作 */
  setAutoReplyEnabled(enabled: boolean): void {
    if (this.autoReplyEnabled === enabled) return;
    this.autoReplyEnabled = enabled;
    this.logger?.info({ platform: this.platformId, autoReplyEnabled: enabled }, '扫描器 autoReply 开关已更新');
  }

  // ============ 平台选择器动态脚本构建 ============

  private buildCloseDialogScript(): string {
    const texts = JSON.stringify(this.platformSelectors.closeDialogTexts);
    // 仅在弹窗容器（mask/overlay/drawer 及其兄弟节点）内查找关闭按钮，
    // 避免全页面扫描误点会话列表"返回"按钮、订单弹窗按钮等可见元素
    return `(function() {
  var closeTexts = ${texts};
  var containers = [];
  var masks = document.querySelectorAll('.auxo-modal-mask, [class*="overlay"], [class*="mask"], [class*="drawer"]');
  for (var m = 0; m < masks.length; m++) {
    containers.push(masks[m]);
    var parent = masks[m].parentElement;
    if (parent) {
      for (var c = 0; c < parent.children.length; c++) {
        containers.push(parent.children[c]);
      }
    }
  }
  var seen = {};
  for (var k = 0; k < containers.length; k++) {
    var container = containers[k];
    if (!container || seen[container]) continue;
    seen[container] = true;
    var els = container.querySelectorAll('button, span, div, a');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].innerText || els[i].textContent || '').trim();
      if (t.length > 0 && t.length < 20 && closeTexts.indexOf(t) >= 0 && els[i].offsetParent !== null) {
        els[i].click();
        return true;
      }
    }
  }
  var mask = document.querySelector('.auxo-modal-mask, [class*="overlay"], [class*="mask"]');
  if (mask) { mask.click(); return true; }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  return false;
})()`;
  }

  /** 关闭弹窗/对话框：执行关闭脚本 */
  async closeDialog(): Promise<boolean> {
    if (!this.webContents || this.webContents.isDestroyed()) return false;
    try {
      const result = await this.webContents.executeJavaScript(this.buildCloseDialogScript());
      if (result) {
        this.logger?.debug({ platform: this.platformId }, '关闭弹窗成功');
      }
      return !!result;
    } catch {
      return false;
    }
  }

  private buildFindUnreadConversationScript(): string {
    const itemSelectors = JSON.stringify(this.platformSelectors.conversationItemSelectors);
    const unreadSelectors = JSON.stringify(this.platformSelectors.unreadIndicatorSelectors);
    return `(function() {
  var itemSelectors = ${itemSelectors};
  var unreadSelectors = ${unreadSelectors};

  function findItems(root) {
    for (var i = 0; i < itemSelectors.length; i++) {
      var items = root.querySelectorAll(itemSelectors[i]);
      if (items && items.length > 0) return items;
    }
    return [];
  }

  function findItemsAll() {
    var items = findItems(document);
    if (items.length > 0) return items;
    var iframes = document.querySelectorAll('iframe');
    for (var fi = 0; fi < iframes.length; fi++) {
      try {
        var doc = iframes[fi].contentDocument || iframes[fi].contentWindow.document;
        if (doc) {
          items = findItems(doc);
          if (items.length > 0) return items;
        }
      } catch(e) {}
    }
    return [];
  }

  function hasUnread(item) {
    for (var i = 0; i < unreadSelectors.length; i++) {
      try {
        var badge = item.querySelector(unreadSelectors[i]);
        if (badge) {
          var t = (badge.innerText || badge.textContent || '').trim();
          if (t === '' || /^\\d+$/.test(t)) return true;
          if (t.length <= 3) return true;
        }
      } catch(e) {}
    }
    var cls = (item.className || '').toString();
    if (/unread|has-new|new-msg/i.test(cls)) return true;
    // 快手 SessionBaseCard: 通过 topHeadTime 含"超时"判断有未读消息
    // 注意：SessionBaseCard-topHeadName 默认是 bold 字体，不能作为未读判据
    if (/SessionBaseCard/.test(cls)) {
      try {
        var timeEl = item.querySelector('.SessionBaseCard-topHeadTime, [class*="topHeadTime"]');
        if (timeEl) {
          var timeText = (timeEl.innerText || '').trim();
          if (/超时/.test(timeText)) return true;
        }
      } catch(e) {}
      // 快手卡片不使用 fontWeight 检查（topHeadName 默认 bold 会误判）
      return false;
    }
    // 抖店新版联系人名称默认使用粗体，不能沿用通用“font-weight >= 600 即未读”规则；
    // 这里只接受上面的 unread/has-new/badge/count 等真实标记。
    if (/auxo-dropdown-trigger/.test(cls)) return false;
    // 飞鸽 CSS Modules: selectedNew、HoverSelected 是默认样式类，不表示激活状态
    var cleanCls = cls.replace(/\S*selectedNew\S*/g, '').replace(/\S*HoverSelected\S*/g, '');
    try {
      var nameEls = item.querySelectorAll('span, div, p');
      for (var j = 0; j < nameEls.length && j < 10; j++) {
        var fw = window.getComputedStyle(nameEls[j]).fontWeight;
        if (fw === 'bold' || parseInt(fw) >= 600) {
          if (!/active|selected|current/i.test(cleanCls)) return true;
        }
      }
    } catch(e) {}
    return false;
  }

  // 优先点击内部子元素，避免触发外层 Dropdown 的下拉菜单
  // 快手 SessionBaseCard 外层是 ant-dropdown-trigger，直接 .click() 可能触发 Dropdown 下拉
  function clickItem(item) {
    var innerSelectors = [
      '.SessionBaseCard-info',
      '.SessionBaseCard-topHead',
      '.SessionBaseCard-Static',
      '[class*="conversation-info"]',
      '[class*="session-info"]'
    ];
    for (var i = 0; i < innerSelectors.length; i++) {
      try {
        var inner = item.querySelector(innerSelectors[i]);
        if (inner) {
          try {
            inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            inner.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          } catch(e) {
            inner.click();
          }
          return true;
        }
      } catch(e) {}
    }
    // 回退：直接点击外层元素
    try { item.click(); return true; } catch(e) {}
    return false;
  }

  function isActive(item) {
    var cls = (item.className || '').toString();
    // 飞鸽 CSS Modules: selectedNew、HoverSelected 是默认样式类，不表示激活状态
    // 移除这些类名段后再检查是否包含真正的 active/selected/current 标记
    var cleanCls = cls.replace(/\S*selectedNew\S*/g, '').replace(/\S*HoverSelected\S*/g, '');
    if (/active|selected|current|选中|当前/i.test(cleanCls)) return true;
    // 快手 SessionBaseCard: 活动态用 colorHighLight（非活动态用 colorLowLight）
    if (/colorHighLight/i.test(cls)) return true;
    // Ant Design Dropdown 展开状态（会话卡片被点击展开为下拉菜单）
    if (/ant-dropdown-trigger-open/i.test(cls)) return true;
    return false;
  }

  function getAbsolutePos(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    var x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
    var y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
    var ownerDoc = el.ownerDocument;
    if (ownerDoc !== document) {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        if (iframes[i].contentDocument === ownerDoc) {
          var iframeRect = iframes[i].getBoundingClientRect();
          x += iframeRect.left;
          y += iframeRect.top;
          break;
        }
      }
    }
    return { x: x, y: y };
  }

  function hasMessagePreview(item) {
    var text = (item.innerText || item.textContent || '').trim();
    if (!text || text.length < 2) return false;
    if (/暂无|加载中|loading|empty|无会话/i.test(text)) return false;
    var lines = text.split(/\\n/).filter(function(l) { return l.trim().length > 0; });
    // 抖店新版会话项统一使用 auxo-dropdown-trigger；页面顶部也有同名下拉触发器，
    // 只接受位于会话列表区域、包含时间/状态或至少两行摘要的候选，避免误点导航。
    if (/auxo-dropdown-trigger/.test((item.className || '').toString())) {
      var rect = item.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 35 || rect.left < 70 || rect.left > window.innerWidth * 0.55) return false;
      if (/^(当前会话|最近联系|平台消息|会话搜索|商品|订单|快捷短语|最近常用|个人短语|团队短语)$/.test(lines[0].trim())) return false;
      // 抖店历史列表会保留“系统关闭会话”的记录，没有待处理消息时不应重复点击。
      if (/系统关闭会话|会话已关闭|已关闭会话/.test(text)) return false;
      if (lines.length < 2 && !/\\d{1,2}[\\/:月-]\\d{1,2}|用户超时|客服超时|未回复|新消息/.test(text)) return false;
    }
    return lines.length >= 1;
  }

  var items = findItemsAll();
  if (items.length === 0) {
    // 调试：记录 itemSelectors 和 findItemsAll 的执行情况
    var dbgSelectors = itemSelectors.slice(0, 3);
    var dbgDirect = 0;
    try { dbgDirect = document.querySelectorAll('[class*="conversationCard"]').length; } catch(e) {}
    // 飞鸽专用：如果"当前会话"tab为空，切换到"最近联系"tab寻找历史会话
    if (!window.__feigeTabSwitched) {
      var currentTab = document.querySelector('#rc-tabs-0-tab-current');
      var historyTab = document.querySelector('#rc-tabs-0-tab-history');
      if (currentTab && historyTab) {
        var currentTabParent = currentTab.closest('.auxo-tabs-tab');
        var isActiveTab = currentTabParent && currentTabParent.classList.contains('auxo-tabs-tab-active');
        var bodyText = (document.body.innerText || '');
        var isEmptyTab = bodyText.indexOf('暂无会话中用户') >= 0 || bodyText.indexOf('暂无会话') >= 0;
        if (isActiveTab && isEmptyTab) {
          try {
            historyTab.click();
            window.__feigeTabSwitched = true;
            return JSON.stringify({ found: false, reason: 'tab-switched', tabSwitched: true });
          } catch(e) {}
        }
      }
    }
    return JSON.stringify({ found: false, reason: 'no-items', dbgSelectors: dbgSelectors, dbgDirect: dbgDirect, totalSelectors: itemSelectors.length });
  }

  // 第一遍：优先找有未读标记的会话
  for (var k = 0; k < items.length; k++) {
    var item = items[k];
    if (isActive(item)) continue;
    if (hasUnread(item)) {
      var pos = getAbsolutePos(item);
      if (pos) return JSON.stringify({ found: true, x: pos.x, y: pos.y, reason: 'unread-found', hadUnread: true });
      return JSON.stringify({ found: false, reason: 'rect-failed', hadUnread: true });
    }
  }
  // 第二遍：轮询扫描所有有消息预览的会话（使用 scanIndex 实现全量轮询）
  var scanIdx = window.__feigeScanIndex || 0;
  if (scanIdx >= items.length || scanIdx < 0) scanIdx = 0;
  var dbgActiveCount = 0;
  var dbgUnreadCount = 0;
  var dbgPreviewCount = 0;
  for (var offset = 0; offset < items.length; offset++) {
    var idx = (scanIdx + offset) % items.length;
    var item2 = items[idx];
    if (isActive(item2)) { dbgActiveCount++; continue; }
    if (hasUnread(item2)) { dbgUnreadCount++; continue; }
    if (hasMessagePreview(item2)) {
      dbgPreviewCount++;
      var pos2 = getAbsolutePos(item2);
      if (pos2) {
        window.__feigeScanIndex = idx + 1;
        return JSON.stringify({ found: true, x: pos2.x, y: pos2.y, reason: 'preview-found', hadUnread: false });
      }
    }
  }
  window.__feigeScanIndex = 0;
  return JSON.stringify({ found: false, reason: 'no-unread', hadUnread: false, itemsCount: items.length, activeCount: dbgActiveCount, unreadCount: dbgUnreadCount, previewCount: dbgPreviewCount });
})()`;
  }

  /**
   * 后台模式专用：DOM 点击未读会话（element.click()），不使用 sendInputEvent
   * 两遍扫描：先找有未读标记的会话（优先），再轮询扫描所有有消息预览的会话
   * 使用 window.__feigeScanIndex 追踪扫描位置，实现全量轮询
   * 返回 JSON { clicked: boolean, hadUnread: boolean }
   */
  private buildClickUnreadConversationScript(): string {
    const itemSelectors = JSON.stringify(this.platformSelectors.conversationItemSelectors);
    const unreadSelectors = JSON.stringify(this.platformSelectors.unreadIndicatorSelectors);
    return `(function() {
  var itemSelectors = ${itemSelectors};
  var unreadSelectors = ${unreadSelectors};

  function findItems(root) {
    for (var i = 0; i < itemSelectors.length; i++) {
      var items = root.querySelectorAll(itemSelectors[i]);
      if (items && items.length > 0) return items;
    }
    return [];
  }

  function findItemsAll() {
    var items = findItems(document);
    if (items.length > 0) return items;
    var iframes = document.querySelectorAll('iframe');
    for (var fi = 0; fi < iframes.length; fi++) {
      try {
        var doc = iframes[fi].contentDocument || iframes[fi].contentWindow.document;
        if (doc) {
          items = findItems(doc);
          if (items.length > 0) return items;
        }
      } catch(e) {}
    }
    return [];
  }

  function hasUnread(item) {
    for (var i = 0; i < unreadSelectors.length; i++) {
      try {
        var badge = item.querySelector(unreadSelectors[i]);
        if (badge) {
          var t = (badge.innerText || badge.textContent || '').trim();
          if (t === '' || /^\\d+$/.test(t)) return true;
          if (t.length <= 3) return true;
        }
      } catch(e) {}
    }
    var cls = (item.className || '').toString();
    if (/unread|has-new|new-msg/i.test(cls)) return true;
    // 快手 SessionBaseCard: 通过 topHeadTime 含"超时"判断有未读消息
    // 注意：SessionBaseCard-topHeadName 默认是 bold 字体，不能作为未读判据
    if (/SessionBaseCard/.test(cls)) {
      try {
        var timeEl = item.querySelector('.SessionBaseCard-topHeadTime, [class*="topHeadTime"]');
        if (timeEl) {
          var timeText = (timeEl.innerText || '').trim();
          if (/超时/.test(timeText)) return true;
        }
      } catch(e) {}
      // 快手卡片不使用 fontWeight 检查（topHeadName 默认 bold 会误判）
      return false;
    }
    // 抖店新版联系人名称默认使用粗体，避免把所有最近联系人误判成未读。
    if (/auxo-dropdown-trigger/.test(cls)) return false;
    // 飞鸽 CSS Modules: selectedNew、HoverSelected 是默认样式类，不表示激活状态
    var cleanCls = cls.replace(/\S*selectedNew\S*/g, '').replace(/\S*HoverSelected\S*/g, '');
    try {
      var nameEls = item.querySelectorAll('span, div, p');
      for (var j = 0; j < nameEls.length && j < 10; j++) {
        var fw = window.getComputedStyle(nameEls[j]).fontWeight;
        if (fw === 'bold' || parseInt(fw) >= 600) {
          if (!/active|selected|current/i.test(cleanCls)) return true;
        }
      }
    } catch(e) {}
    return false;
  }

  // 优先点击内部子元素，避免触发外层 Dropdown 的下拉菜单
  // 快手 SessionBaseCard 外层是 ant-dropdown-trigger，直接 .click() 可能触发 Dropdown 下拉
  function clickItem(item) {
    var innerSelectors = [
      '.SessionBaseCard-info',
      '.SessionBaseCard-topHead',
      '.SessionBaseCard-Static',
      '[class*="conversation-info"]',
      '[class*="session-info"]'
    ];
    for (var i = 0; i < innerSelectors.length; i++) {
      try {
        var inner = item.querySelector(innerSelectors[i]);
        if (inner) {
          try {
            inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            inner.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          } catch(e) {
            inner.click();
          }
          return true;
        }
      } catch(e) {}
    }
    // 回退：直接点击外层元素
    try { item.click(); return true; } catch(e) {}
    return false;
  }

  function isActive(item) {
    var cls = (item.className || '').toString();
    // 飞鸽 CSS Modules: selectedNew、HoverSelected 是默认样式类，不表示激活状态
    // 移除这些类名段后再检查是否包含真正的 active/selected/current 标记
    var cleanCls = cls.replace(/\S*selectedNew\S*/g, '').replace(/\S*HoverSelected\S*/g, '');
    if (/active|selected|current|选中|当前/i.test(cleanCls)) return true;
    // 快手 SessionBaseCard: 活动态用 colorHighLight（非活动态用 colorLowLight）
    if (/colorHighLight/i.test(cls)) return true;
    // Ant Design Dropdown 展开状态（会话卡片被点击展开为下拉菜单）
    if (/ant-dropdown-trigger-open/i.test(cls)) return true;
    return false;
  }

  function hasMessagePreview(item) {
    var text = (item.innerText || item.textContent || '').trim();
    if (!text || text.length < 2) return false;
    if (/暂无|加载中|loading|empty|无会话/i.test(text)) return false;
    var lines = text.split(/\\n/).filter(function(l) { return l.trim().length > 0; });
    // 抖店新版会话项统一使用 auxo-dropdown-trigger；过滤同页的导航下拉项。
    if (/auxo-dropdown-trigger/.test((item.className || '').toString())) {
      var rect = item.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 35 || rect.left < 70 || rect.left > window.innerWidth * 0.55) return false;
      if (/^(当前会话|最近联系|平台消息|会话搜索|商品|订单|快捷短语|最近常用|个人短语|团队短语)$/.test(lines[0].trim())) return false;
      // 抖店历史列表会保留“系统关闭会话”的记录，没有待处理消息时不应重复点击。
      if (/系统关闭会话|会话已关闭|已关闭会话/.test(text)) return false;
      if (lines.length < 2 && !/\\d{1,2}[\\/:月-]\\d{1,2}|用户超时|客服超时|未回复|新消息/.test(text)) return false;
    }
    return lines.length >= 1;
  }

  var items = findItemsAll();
  if (items.length === 0) {
    // 飞鸽专用：如果"当前会话"tab为空，切换到"最近联系"tab寻找历史会话
    if (!window.__feigeTabSwitched) {
      var currentTab = document.querySelector('#rc-tabs-0-tab-current');
      var historyTab = document.querySelector('#rc-tabs-0-tab-history');
      if (currentTab && historyTab) {
        var currentTabParent = currentTab.closest('.auxo-tabs-tab');
        var isActive = currentTabParent && currentTabParent.classList.contains('auxo-tabs-tab-active');
        var bodyText = (document.body.innerText || '');
        var isEmpty = bodyText.indexOf('暂无会话中用户') >= 0 || bodyText.indexOf('暂无会话') >= 0;
        if (isActive && isEmpty) {
          try {
            historyTab.click();
            window.__feigeTabSwitched = true;
            return JSON.stringify({ clicked: false, hadUnread: false, tabSwitched: true });
          } catch(e) {}
        }
      }
    }
    return JSON.stringify({ clicked: false, hadUnread: false });
  }

  // 第一遍：优先点击有未读标记的会话
  for (var k = 0; k < items.length; k++) {
    var item = items[k];
    if (isActive(item)) continue;
    if (hasUnread(item)) {
      if (clickItem(item)) return JSON.stringify({ clicked: true, hadUnread: true });
    }
  }

  // 第二遍：轮询扫描所有有消息预览的会话（使用 scanIndex 实现全量轮询）
  var scanIdx = window.__feigeScanIndex || 0;
  if (scanIdx >= items.length || scanIdx < 0) scanIdx = 0;
  for (var offset = 0; offset < items.length; offset++) {
    var idx = (scanIdx + offset) % items.length;
    var item2 = items[idx];
    if (isActive(item2)) continue;
    if (hasUnread(item2)) continue;
    if (hasMessagePreview(item2)) {
      if (clickItem(item2)) {
        window.__feigeScanIndex = idx + 1;
        return JSON.stringify({ clicked: true, hadUnread: false });
      }
    }
  }
  // 所有会话已扫描完一轮，重置索引
  window.__feigeScanIndex = 0;
  return JSON.stringify({ clicked: false, hadUnread: false });
})()`;
  }

  private getSessionIdExtractor(): string {
    return this.platformSelectors.sessionIdExtractor;
  }

  /**
   * 读取平台页面当前选中的会话 ID。
   * 发送前用它重新定位会话，避免 LLM 生成期间用户切换会话导致回复发错。
   * 页面未选中会话或提取失败时返回 null。
   */
  async getCurrentSessionId(): Promise<string | null> {
    if (!this.webContents || !this.connected) return null;
    try {
      const extractor = this.getSessionIdExtractor();
      const result = (await this.webContents.executeJavaScript(
        `(function(){ ${extractor}; try { return __feigeGetSessionId(); } catch { return null; } })()`,
      )) as string | null;
      return typeof result === 'string' && result.length > 0 ? result : null;
    } catch (err) {
      this.logger?.warn(
        { platform: this.platformId, err: err instanceof Error ? err.message : String(err) },
        '读取当前会话 ID 失败',
      );
      return null;
    }
  }

  private buildObserverScript(): string {
    const sessionIdExtractor = this.getSessionIdExtractor();
    const msgSelectors = JSON.stringify(this.platformSelectors.messageSelectors);
    const excludeSelectors = this.platformSelectors.excludeSelectors;
    const sellerPatterns = JSON.stringify(this.platformSelectors.sellerClassPatterns);
    const buyerPatterns = JSON.stringify(this.platformSelectors.buyerClassPatterns);
    const systemPatterns = JSON.stringify(this.platformSelectors.systemClassPatterns);
    return `(function() {
  if (window.__feigeObserverInstalled) return;
  window.__feigeObserverInstalled = true;
  window.__feigeMsgQueue = window.__feigeMsgQueue || [];
  window.__feigeSeenMessages = new Set();
  window.__feigeSuppressUntil = window.__feigeSuppressUntil || 0;
  ${sessionIdExtractor}

  var msgSelectors = ${msgSelectors};
  var excludeSelectors = /${excludeSelectors}/;

  function isMessageNode(node) {
    for (var i = 0; i < msgSelectors.length; i++) {
      if (node.matches && node.matches(msgSelectors[i])) return true;
    }
    return false;
  }

  function hasNestedMessageNode(node) {
    if (!node.querySelector) return false;
    for (var i = 0; i < msgSelectors.length; i++) {
      if (node.querySelector(msgSelectors[i])) return true;
    }
    return false;
  }

  function isInsideMessageList(node) {
    var parent = node.parentElement;
    if (!parent) return false;
    var cls = (parent.className || '').toString();
    if (cls.indexOf('messageList') >= 0 || cls.indexOf('message-list') >= 0) return true;
    if (parent.closest && parent.closest('[class*="messageList"], [class*="message-list"]')) return true;
    return false;
  }

  function isExcluded(node) {
    var cls = (node.className || '').toString();
    if (excludeSelectors.test(cls)) return true;
    return false;
  }

  function matchesClassPattern(cls, pattern) {
    if (!cls || !pattern) return false;
    var escaped = pattern.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    var regex = new RegExp('(?:^|[\\\\s\\\\-._])' + escaped + '(?:$|[\\\\s\\\\-._])', 'i');
    return regex.test(cls);
  }

  function detectFrom(node) {
    var systemPatterns = ${systemPatterns};
    var sellerPatterns = ${sellerPatterns};
    var buyerPatterns = ${buyerPatterns};
    var nodeText = (node.innerText || node.textContent || '').trim();
    if (
      (node.querySelector && node.querySelector('[class*="system"], [data-role="system"], [data-from="system"]'))
      || /^(系统消息|用户正在查看商品，来自电商小助手|商家配置发送)/.test(nodeText)
    ) return 'system';
    if (node.querySelector && node.querySelector('[class*="messageIsMe"]')) return 'seller';
    if (node.querySelector && node.querySelector('[class*="messageNotMe"]')) return 'buyer';
    var allCls = '';
    var current = node;
    for (var level = 0; level < 6 && current; level++) {
      var currentCls = (current.className || '').toString();
      if (currentCls) allCls += ' ' + currentCls;
      current = current.parentElement;
    }
    for (var si = 0; si < systemPatterns.length; si++) {
      if (matchesClassPattern(allCls, systemPatterns[si])) return 'system';
    }
    for (var se = 0; se < sellerPatterns.length; se++) {
      if (matchesClassPattern(allCls, sellerPatterns[se])) return 'seller';
    }
    for (var bu = 0; bu < buyerPatterns.length; bu++) {
      if (matchesClassPattern(allCls, buyerPatterns[bu])) {
        return 'buyer';
      }
    }
    var roleEl = node.closest ? node.closest('[data-role], [data-from]') : null;
    var role = (roleEl ? (roleEl.getAttribute('data-role') || roleEl.getAttribute('data-from')) : null)
      || node.getAttribute('data-role') || node.getAttribute('data-from');
    if (role === 'seller' || role === 'self' || role === 'mine') return 'seller';
    if (role === 'buyer' || role === 'customer' || role === 'other') return 'buyer';
    if (role === 'system') return 'system';
    var rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.width < window.innerWidth * 0.8) {
      return rect.x + rect.width / 2 > window.innerWidth / 2 ? 'seller' : 'buyer';
    }
    return 'system';
  }

  function getMessageId(node) {
    var attrs = ['data-msg-id', 'data-message-id', 'data-client-message-id', 'data-server-message-id', 'data-id'];
    var current = node;
    for (var level = 0; level < 8 && current; level++) {
      for (var i = 0; i < attrs.length; i++) {
        var value = current.getAttribute && current.getAttribute(attrs[i]);
        if (value) return value;
      }
      current = current.parentElement;
    }
    return '';
  }

  function getMessageTimestamp(node) {
    var attrs = ['data-msg-ts', 'data-timestamp', 'data-time'];
    var current = node;
    for (var level = 0; level < 8 && current; level++) {
      for (var i = 0; i < attrs.length; i++) {
        var value = current.getAttribute && current.getAttribute(attrs[i]);
        if (!value) continue;
        var parsed = parseInt(value, 10);
        if (!isNaN(parsed)) return parsed;
      }
      current = current.parentElement;
    }
    return Date.now();
  }

  function pushMessage(node) {
    if (isExcluded(node)) return;
    if (hasNestedMessageNode(node)) return;
    var text = node.innerText || node.textContent || '';
    // 图片检测：提取消息中的图片 URL（用于多模态 LLM 理解图片内容）
    var images = [];
    if (node.querySelectorAll) {
      var imgs = node.querySelectorAll('img');
      for (var ii = 0; ii < imgs.length; ii++) {
        var src = imgs[ii].src || imgs[ii].getAttribute('data-src') || '';
        if (src && src.indexOf('data:') !== 0 && src.indexOf('blob:') !== 0) {
          images.push(src);
        }
      }
    }
    if (!text.trim() && images.length === 0) return;
    if (!text.trim() && images.length > 0) text = '[图片]';
    if (text.trim().length < 1) return;
    if (/^\\d{1,2}:\\d{2}(:\\d{2})?$/.test(text.trim())) return;
    var messageId = getMessageId(node);
    // 去重 key 必须包含 sessionId：同一店铺不同买家发送相同文本（如"在吗"）时，
    // 无 messageId 的平台（拼多多/快手/微信）依赖文本作为 key，跨会话会误去重导致漏回复
    var key = __feigeGetSessionId() + '|' + text.trim() + '|' + (messageId || text.length) + (images.length > 0 ? '|' + images.join(',').substring(0, 100) : '');
    if (window.__feigeSeenMessages.has(key)) return;
    window.__feigeSeenMessages.add(key);
    if (window.__feigeSeenMessages.size > 500) {
      window.__feigeSeenMessages = new Set(Array.from(window.__feigeSeenMessages).slice(-250));
    }
    var inSuppress = Date.now() < (window.__feigeSuppressUntil || 0);
    if (inSuppress) return;
    var from;
    try {
      from = detectFrom(node);
    } catch(e) {
      from = 'system';
    }
    // 稳定买家标识（BUYER-ID-001）：优先从页面暴露的 uid/openid/data-* 属性读取，
    // 读不到时留空，由 Node 侧按低置信度处理（昵称不能当稳定 ID）。
    var buyerId;
    try {
      var root = node.closest ? node.closest('[data-uid],[data-buyer-id],[data-openid]') : null;
      if (root) {
        buyerId = root.getAttribute('data-uid') || root.getAttribute('data-buyer-id') || root.getAttribute('data-openid') || undefined;
      }
      if (!buyerId && node.getAttribute) {
        buyerId = node.getAttribute('data-uid') || node.getAttribute('data-buyer-id') || undefined;
      }
    } catch(e) { buyerId = undefined; }
    var msg = {
      sessionId: __feigeGetSessionId(),
      from: from,
      text: text.trim(),
      timestamp: getMessageTimestamp(node),
      messageId: messageId || undefined
    };
    if (buyerId) msg.buyerId = buyerId;
    if (images.length > 0) msg.images = images;
    window.__feigeMsgQueue.push(msg);
  }

  var observer = new MutationObserver(function(mutations) {
	    for (var i = 0; i < mutations.length; i++) {
	      var m = mutations[i];
	      if (m.addedNodes) {
	        m.addedNodes.forEach(function(node) {
	          if (node.nodeType !== 1) return;
	          if (isMessageNode(node)) {
	            pushMessage(node);
	          } else if (isInsideMessageList(node)) {
	            pushMessage(node);
	          }
	          node.querySelectorAll && node.querySelectorAll(msgSelectors.join(', ')).forEach(pushMessage);
	        });
		      }
		      // 处理消息撤回：节点被移除时清理去重集合并通知主进程
		      if (m.removedNodes && m.removedNodes.length > 0) {
		        m.removedNodes.forEach(function(node) {
		          if (node.nodeType !== 1) return;
		          if (!isMessageNode(node)) return;
		          var rText = (node.innerText || node.textContent || '').trim();
		          if (!rText || rText.length < 1) return;
		          if (/^\\d{1,2}:\\d{2}(:\\d{2})?$/.test(rText)) return;
		          var rMessageId = getMessageId(node);
		          // 与 pushMessage 的 key 格式保持一致（含 sessionId），撤回时才能正确删除对应条目
		          var rKey = __feigeGetSessionId() + '|' + rText + '|' + (rMessageId || rText.length);
		          window.__feigeSeenMessages.delete(rKey);
		          var rFrom = detectFrom(node);
		          if (rFrom === 'buyer' || rFrom === 'seller') {
		            window.__feigeMsgQueue.push({
		              sessionId: __feigeGetSessionId(),
		              from: 'system',
		              text: '__MSG_REVOKED__:' + rText.substring(0, 200),
		              timestamp: Date.now()
		            });
		          }
		        });
		      }
		      if (m.type === 'characterData' && m.target && m.target.parentElement) {
	        var msgNode = m.target.parentElement.closest(msgSelectors.join(', '));
	        if (msgNode) pushMessage(msgNode);
	      }
	      if (m.type === 'attributes' && m.target && m.target.nodeType === 1) {
	        if (isMessageNode(m.target)) pushMessage(m.target);
	      }
	    }
	  });
	  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'data-msg-id', 'data-role', 'data-time'] });

	  // 跨iframe支持：遍历同源iframe并注入Observer
	  function observeIframes() {
	    var iframes = document.querySelectorAll('iframe');
	    for (var i = 0; i < iframes.length; i++) {
	      try {
	        var iframeDoc = iframes[i].contentDocument || iframes[i].contentWindow.document;
	        if (iframeDoc && iframeDoc.body && !iframeDoc.body.__feigeIframeObserved) {
	          iframeDoc.body.__feigeIframeObserved = true;
	          observer.observe(iframeDoc.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'data-msg-id', 'data-role', 'data-time'] });
	          // 在iframe中重新查找消息节点
	          var existingNodes = iframeDoc.body.querySelectorAll(msgSelectors.join(', '));
	          for (var k = 0; k < existingNodes.length; k++) {
	            pushMessage(existingNodes[k]);
	          }
	        }
	      } catch(e) {}
	    }
	  }

	  // Shadow DOM支持：遍历open shadow roots
	  function observeShadowRoots(root) {
	    try {
	      var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
	      var node;
	      while ((node = walker.nextNode())) {
	        if (node.shadowRoot) {
	          observer.observe(node.shadowRoot, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'data-msg-id', 'data-role', 'data-time'] });
	          observeShadowRoots(node.shadowRoot);
	        }
	      }
	    } catch(e) {}
	  }

	  observeIframes();
	  observeShadowRoots(document.body);

	  // 定期重新扫描iframe（新iframe可能动态加载）
	  setInterval(function() {
	    observeIframes();
	  }, 2000);

	  // 兜底全量扫描：定期扫描消息节点，捕获 MutationObserver 可能遗漏的消息
	  // （虚拟列表复用节点、WebSocket 状态更新等场景）
	  setInterval(function() {
	    function scanMessages(root) {
	      var nodes = root.querySelectorAll(msgSelectors.join(', '));
	      for (var i = 0; i < nodes.length; i++) {
	        pushMessage(nodes[i]);
	      }
	    }
	    try { scanMessages(document); } catch(e) {}
	    var iframes = document.querySelectorAll('iframe');
	    for (var fi = 0; fi < iframes.length; fi++) {
	      try {
	        var doc = iframes[fi].contentDocument || iframes[fi].contentWindow.document;
	        if (doc) scanMessages(doc);
	      } catch(e) {}
	    }
	  }, 3000);
	})()`;
	  }

  private buildDrainQueueScript(): string {
    return `(function() {
  var q = window.__feigeMsgQueue || [];
  window.__feigeMsgQueue = [];
  return JSON.stringify(q);
})()`;
  }

  /**
   * 排空队列并检测未回复的买家消息
   * 用于无未读标记的会话点击后：pushMessage 在抑制期内已将消息标记为已见但未入队，
   * 此脚本绕过抑制期检查，扫描 DOM 找到最后一条消息，若来自买家（未回复）则加入队列。
   * 使用 __feigeScannerProcessed 集合去重，避免同一会话重复处理。
   */
  private buildDrainAndProcessLastBuyerScript(): string {
    const sessionIdExtractor = this.getSessionIdExtractor();
    const msgSelectors = JSON.stringify(this.platformSelectors.messageSelectors.concat(['[class*="message"]']));
    const excludeSelectors = this.platformSelectors.excludeSelectors;
    const sellerPatterns = JSON.stringify(this.platformSelectors.sellerClassPatterns);
    const buyerPatterns = JSON.stringify(this.platformSelectors.buyerClassPatterns);
    const systemPatterns = JSON.stringify(this.platformSelectors.systemClassPatterns);
    return `(function() {
  ${sessionIdExtractor}
  // Conversation switches can enqueue historical DOM mutations. Discard that
  // transient queue and inspect only the latest visible buyer message below.
  window.__feigeMsgQueue = [];
  var q = [];
  if (!window.__feigeScannerProcessed) window.__feigeScannerProcessed = new Set();

  var msgSelectors = ${msgSelectors};
  var excludeSelectors = /${excludeSelectors}/;
  var sellerPatterns = ${sellerPatterns};
  var buyerPatterns = ${buyerPatterns};
  var systemPatterns = ${systemPatterns};

  function matchesClassPattern(cls, pattern) {
    if (!cls || !pattern) return false;
    var escaped = pattern.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    var regex = new RegExp('(?:^|[\\\\s\\\\-._])' + escaped + '(?:$|[\\\\s\\\\-._])', 'i');
    return regex.test(cls);
  }

  function detectFrom(node) {
    var nodeText = (node.innerText || node.textContent || '').trim();
    if (
      (node.querySelector && node.querySelector('[class*="system"], [data-role="system"], [data-from="system"]'))
      || /^(系统消息|用户正在查看商品，来自电商小助手|商家配置发送)/.test(nodeText)
    ) return 'system';
    if (node.querySelector && node.querySelector('[class*="messageIsMe"]')) return 'seller';
    if (node.querySelector && node.querySelector('[class*="messageNotMe"]')) return 'buyer';
    var allCls = '';
    var current = node;
    for (var level = 0; level < 6 && current; level++) {
      var currentCls = (current.className || '').toString();
      if (currentCls) allCls += ' ' + currentCls;
      current = current.parentElement;
    }
    for (var si = 0; si < systemPatterns.length; si++) {
      if (matchesClassPattern(allCls, systemPatterns[si])) return 'system';
    }
    for (var se = 0; se < sellerPatterns.length; se++) {
      if (matchesClassPattern(allCls, sellerPatterns[se])) return 'seller';
    }
    for (var bu = 0; bu < buyerPatterns.length; bu++) {
      if (matchesClassPattern(allCls, buyerPatterns[bu])) return 'buyer';
    }
    var roleEl = node.closest ? node.closest('[data-role], [data-from]') : null;
    var role = (roleEl ? (roleEl.getAttribute('data-role') || roleEl.getAttribute('data-from')) : null)
      || node.getAttribute('data-role') || node.getAttribute('data-from');
    if (role === 'seller' || role === 'self' || role === 'mine') return 'seller';
    if (role === 'system') return 'system';
    var rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.width < window.innerWidth * 0.8) {
      return rect.x + rect.width / 2 > window.innerWidth / 2 ? 'seller' : 'buyer';
    }
    return 'system';
  }

  function getMessageId(node) {
    var attrs = ['data-msg-id', 'data-message-id', 'data-client-message-id', 'data-server-message-id', 'data-id'];
    var current = node;
    for (var level = 0; level < 8 && current; level++) {
      for (var i = 0; i < attrs.length; i++) {
        var value = current.getAttribute && current.getAttribute(attrs[i]);
        if (value) return value;
      }
      current = current.parentElement;
    }
    return '';
  }

  function getMessageTimestamp(node) {
    var attrs = ['data-msg-ts', 'data-timestamp', 'data-time'];
    var current = node;
    for (var level = 0; level < 8 && current; level++) {
      for (var i = 0; i < attrs.length; i++) {
        var value = current.getAttribute && current.getAttribute(attrs[i]);
        if (!value) continue;
        var parsed = parseInt(value, 10);
        if (!isNaN(parsed)) return parsed;
      }
      current = current.parentElement;
    }
    return Date.now();
  }

  function scanMessages(root) {
    var matched = root.querySelectorAll(msgSelectors.join(', '));
    var nodes = [];
    for (var i = 0; i < matched.length; i++) {
      var node = matched[i];
      var nested = false;
      for (var j = 0; j < msgSelectors.length; j++) {
        if (node.querySelector && node.querySelector(msgSelectors[j])) {
          nested = true;
          break;
        }
      }
      if (!nested) nodes.push(node);
    }
    return nodes;
  }

  var nodes = scanMessages(document);
  // 跨 iframe 搜索
  if (!nodes || nodes.length === 0) {
    var iframes = document.querySelectorAll('iframe');
    for (var fi = 0; fi < iframes.length; fi++) {
      try {
        var doc = iframes[fi].contentDocument || iframes[fi].contentWindow.document;
        if (doc) {
          nodes = scanMessages(doc);
          if (nodes && nodes.length > 0) break;
        }
      } catch(e) {}
    }
  }
  if (!nodes || nodes.length === 0) return JSON.stringify(q);

  // 找最后一条消息（不限发送方），判断是否未回复（最后一条来自买家）
  var lastMsg = null;
  nodes.forEach(function(n) {
    var cls = (n.className || '').toString();
    if (excludeSelectors.test(cls)) return;
    var text = (n.innerText || n.textContent || '').trim();
    // 图片检测：提取消息中的图片 URL（用于多模态 LLM 理解图片内容）
    var images = [];
    if (n.querySelectorAll) {
      var imgs = n.querySelectorAll('img');
      for (var ii = 0; ii < imgs.length; ii++) {
        var src = imgs[ii].src || imgs[ii].getAttribute('data-src') || '';
        if (src && src.indexOf('data:') !== 0 && src.indexOf('blob:') !== 0) {
          images.push(src);
        }
      }
    }
    if (!text && images.length === 0) return;
    if (!text && images.length > 0) text = '[图片]';
    if (/^\\d{1,2}:\\d{2}(:\\d{2})?$/.test(text)) return;
    var from;
    try { from = detectFrom(n); } catch(e) { from = 'system'; }
    if (from === 'buyer' || from === 'seller') {
      lastMsg = {
        text: text,
        from: from,
        messageId: getMessageId(n),
        timestamp: getMessageTimestamp(n),
        images: images
      };
    }
  });

  // 只有最后一条消息来自买家时才入队（未回复）
  if (lastMsg && lastMsg.from === 'buyer') {
    // 去重 key 含 sessionId，避免跨会话同文本消息被误判为已处理
    var key = __feigeGetSessionId() + '|' + lastMsg.text + '|' + (lastMsg.messageId || lastMsg.text.length);
    // 检查是否已在排空队列中（MutationObserver 已入队的新消息）
    var alreadyInQueue = false;
    for (var qi = 0; qi < q.length; qi++) {
      if (q[qi].text === lastMsg.text) { alreadyInQueue = true; break; }
    }
    if (!alreadyInQueue && !window.__feigeScannerProcessed.has(key)) {
      window.__feigeScannerProcessed.add(key);
      if (window.__feigeScannerProcessed.size > 200) {
        window.__feigeScannerProcessed = new Set(Array.from(window.__feigeScannerProcessed).slice(-100));
      }
      var pushMsg = {
        sessionId: __feigeGetSessionId(),
        from: 'buyer',
        text: lastMsg.text,
        timestamp: lastMsg.timestamp,
        messageId: lastMsg.messageId || undefined
      };
      if (lastMsg.images && lastMsg.images.length > 0) pushMsg.images = lastMsg.images;
      q.push(pushMsg);
    }
  }

  return JSON.stringify(q);
})()`;
  }

  private buildLatestMessagesScript(): string {
    const sessionIdExtractor = this.getSessionIdExtractor();
    const msgSelectors = JSON.stringify(this.platformSelectors.messageSelectors.concat(['[class*="message"]']));
    const excludeSelectors = this.platformSelectors.excludeSelectors;
    const sellerPatterns = JSON.stringify(this.platformSelectors.sellerClassPatterns);
    const buyerPatterns = JSON.stringify(this.platformSelectors.buyerClassPatterns);
    const systemPatterns = JSON.stringify(this.platformSelectors.systemClassPatterns);
    return `(function() {
  ${sessionIdExtractor}
  var selectors = ${msgSelectors};
  var excludeSelectors = /${excludeSelectors}/;
  var msgs = [];
  var sellerPatterns = ${sellerPatterns};
  var buyerPatterns = ${buyerPatterns};
  var systemPatterns = ${systemPatterns};

  function matchesClassPattern(cls, pattern) {
    if (!cls || !pattern) return false;
    var escaped = pattern.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    var regex = new RegExp('(?:^|[\\\\s\\\\-._])' + escaped + '(?:$|[\\\\s\\\\-._])', 'i');
    return regex.test(cls);
  }

  function detectFrom(n) {
    var nodeText = (n.innerText || n.textContent || '').trim();
    if (
      (n.querySelector && n.querySelector('[class*="system"], [data-role="system"], [data-from="system"]'))
      || /^(系统消息|用户正在查看商品，来自电商小助手|商家配置发送)/.test(nodeText)
    ) return 'system';
    if (n.querySelector && n.querySelector('[class*="messageIsMe"]')) return 'seller';
    if (n.querySelector && n.querySelector('[class*="messageNotMe"]')) return 'buyer';
    var allCls = '';
    var cur = n;
    for (var lvl = 0; lvl < 6 && cur; lvl++) {
      var curCls = (cur.className || '').toString();
      if (curCls) allCls += ' ' + curCls;
      cur = cur.parentElement;
    }
    for (var si = 0; si < systemPatterns.length; si++) {
      if (matchesClassPattern(allCls, systemPatterns[si])) return 'system';
    }
    for (var se = 0; se < sellerPatterns.length; se++) {
      if (matchesClassPattern(allCls, sellerPatterns[se])) return 'seller';
    }
    for (var bu = 0; bu < buyerPatterns.length; bu++) {
      if (matchesClassPattern(allCls, buyerPatterns[bu])) return 'buyer';
    }
    var roleEl = n.closest ? n.closest('[data-role], [data-from]') : null;
    var role = (roleEl ? (roleEl.getAttribute('data-role') || roleEl.getAttribute('data-from')) : null)
      || n.getAttribute('data-role') || n.getAttribute('data-from');
    if (role === 'seller' || role === 'self' || role === 'mine') return 'seller';
    if (role === 'buyer' || role === 'customer' || role === 'other') return 'buyer';
    if (role === 'system') return 'system';
    var rect = n.getBoundingClientRect();
    if (rect.width > 0 && rect.width < window.innerWidth * 0.8) {
      return rect.x + rect.width / 2 > window.innerWidth / 2 ? 'seller' : 'buyer';
    }
    return 'system';
  }

  function getMessageId(node) {
    var attrs = ['data-msg-id', 'data-message-id', 'data-client-message-id', 'data-server-message-id', 'data-id'];
    var current = node;
    for (var level = 0; level < 8 && current; level++) {
      for (var i = 0; i < attrs.length; i++) {
        var value = current.getAttribute && current.getAttribute(attrs[i]);
        if (value) return value;
      }
      current = current.parentElement;
    }
    return '';
  }

  function getMessageTimestamp(node) {
    var attrs = ['data-msg-ts', 'data-timestamp', 'data-time'];
    var current = node;
    for (var level = 0; level < 8 && current; level++) {
      for (var i = 0; i < attrs.length; i++) {
        var value = current.getAttribute && current.getAttribute(attrs[i]);
        if (!value) continue;
        var parsed = parseInt(value, 10);
        if (!isNaN(parsed)) return parsed;
      }
      current = current.parentElement;
    }
    return 0;
  }

  function scanLeafMessages(root) {
    var matched = root.querySelectorAll(selectors.join(', '));
    var leaves = [];
    for (var i = 0; i < matched.length; i++) {
      var node = matched[i];
      var nested = false;
      for (var j = 0; j < selectors.length; j++) {
        if (node.querySelector && node.querySelector(selectors[j])) {
          nested = true;
          break;
        }
      }
      if (!nested) leaves.push(node);
    }
    return leaves;
  }

  function appendMessages(root) {
    var nodes = scanLeafMessages(root);
    nodes.forEach(function(n) {
      var cls = (n.className || '').toString();
      if (excludeSelectors.test(cls)) return;
      var text = n.innerText || n.textContent || '';
      // 图片检测：提取消息中的图片 URL（用于多模态 LLM 理解图片内容）
      var images = [];
      if (n.querySelectorAll) {
        var imgs = n.querySelectorAll('img');
        for (var ii = 0; ii < imgs.length; ii++) {
          var src = imgs[ii].src || imgs[ii].getAttribute('data-src') || '';
          if (src && src.indexOf('data:') !== 0 && src.indexOf('blob:') !== 0) {
            images.push(src);
          }
        }
      }
      if (!text.trim() && images.length === 0) return;
      if (!text.trim() && images.length > 0) text = '[图片]';
      if (/^\\d{1,2}:\\d{2}(:\\d{2})?$/.test(text.trim())) return;
      var from = detectFrom(n);
      var ts = getMessageTimestamp(n);
      var msgId = getMessageId(n);
      var msg = {
        sessionId: __feigeGetSessionId(),
        from: from,
        text: text.trim(),
        timestamp: ts,
        messageId: msgId || undefined
      };
      if (images.length > 0) msg.images = images;
      msgs.push(msg);
    });
  }

  appendMessages(document);

  var iframes = document.querySelectorAll('iframe');
  for (var fi = 0; fi < iframes.length; fi++) {
    try {
      var iframeDoc = iframes[fi].contentDocument || iframes[fi].contentWindow.document;
      if (iframeDoc && iframeDoc.body) appendMessages(iframeDoc);
    } catch(e) {}
  }

  return JSON.stringify(msgs.slice(-20));
})()`;
  }

  private getDefaultInputSelector(): string {
    return this.platformSelectors.inputSelector;
  }

  private buildFindInputScript(selector: string): string {
    return `(function() {
    function findInput(sel) {
      // 优先返回第一个可见元素（非零尺寸），避免命中 dialog 内隐藏的 textarea（如 weixin debug-config-dialog）
      var input = null;
      var nodes = document.querySelectorAll(sel);
      for (var idx = 0; idx < nodes.length; idx++) {
        var r = nodes[idx].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { input = nodes[idx]; break; }
      }
      if (input) return input;
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        try {
          var doc = iframes[i].contentDocument || iframes[i].contentWindow.document;
          if (doc) {
            input = doc.querySelector(sel);
            if (input) return input;
          }
        } catch(e) {}
      }
      // Shadow DOM 支持：遍历 open shadow roots
      function searchShadowRoots(root) {
        try {
          var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
          var node;
          while ((node = walker.nextNode())) {
            if (node.shadowRoot) {
              var el = node.shadowRoot.querySelector(sel);
              if (el) return el;
              var found = searchShadowRoots(node.shadowRoot);
              if (found) return found;
            }
          }
        } catch(e) {}
        return null;
      }
      return searchShadowRoots(document.body);
    }
    var input = findInput(${JSON.stringify(selector)});
    if (!input) return JSON.stringify({ found: false });
    var rect = input.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return JSON.stringify({ found: false });
    var x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
    var y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
    var ownerDoc = input.ownerDocument;
    if (ownerDoc !== document) {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        if (iframes[i].contentDocument === ownerDoc) {
          var iframeRect = iframes[i].getBoundingClientRect();
          x += iframeRect.left;
          y += iframeRect.top;
          break;
        }
      }
    }
    return JSON.stringify({ found: true, x: x, y: y });
  })()`;
  }

  private buildFindSendButtonScript(): string {
    const s = this.platformSelectors;
    const selectors = JSON.stringify(s.sendButtonSelectors);
    const texts = JSON.stringify(s.sendButtonTexts);
    return `(function() {
    function getAbsolutePos(el) {
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      var x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
      var y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
      var ownerDoc = el.ownerDocument;
      if (ownerDoc !== document) {
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          if (iframes[i].contentDocument === ownerDoc) {
            var iframeRect = iframes[i].getBoundingClientRect();
            x += iframeRect.left;
            y += iframeRect.top;
            break;
          }
        }
      }
      return { x: x, y: y };
    }
    var selectors = ${selectors};
    for (var i = 0; i < selectors.length; i++) {
      var btn = document.querySelector(selectors[i]);
      if (btn) {
        var pos = getAbsolutePos(btn);
        if (pos) return JSON.stringify({ found: true, x: pos.x, y: pos.y });
      }
    }
    var sendTexts = ${texts};
    var imBox = document.querySelector('#im-input-box') || document.body;
    var divs = imBox.querySelectorAll('div, span, button');
    for (var j = 0; j < divs.length; j++) {
      var t = (divs[j].innerText || divs[j].textContent || '').trim();
      for (var k = 0; k < sendTexts.length; k++) {
        if (t === sendTexts[k]) {
          var pos2 = getAbsolutePos(divs[j]);
          if (pos2) return JSON.stringify({ found: true, x: pos2.x, y: pos2.y });
        }
      }
    }
    var iframes = document.querySelectorAll('iframe');
    for (var fi = 0; fi < iframes.length; fi++) {
      try {
        var doc = iframes[fi].contentDocument || iframes[fi].contentWindow.document;
        if (doc) {
          for (var si = 0; si < selectors.length; si++) {
            var frameBtn = doc.querySelector(selectors[si]);
            if (frameBtn) {
              var pos3 = getAbsolutePos(frameBtn);
              if (pos3) return JSON.stringify({ found: true, x: pos3.x, y: pos3.y });
            }
          }
          var frameDivs = doc.querySelectorAll('div, span, button');
          for (var fj = 0; fj < frameDivs.length; fj++) {
            var ft = (frameDivs[fj].innerText || frameDivs[fj].textContent || '').trim();
            for (var fk = 0; fk < sendTexts.length; fk++) {
              if (ft === sendTexts[fk]) {
                var pos4 = getAbsolutePos(frameDivs[fj]);
                if (pos4) return JSON.stringify({ found: true, x: pos4.x, y: pos4.y });
              }
            }
          }
        }
      } catch(e) {}
    }
    // Shadow DOM 支持：遍历 open shadow roots 搜索发送按钮
    function searchShadowRootsForButtonPos(root) {
      try {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
        var node;
        while ((node = walker.nextNode())) {
          if (node.shadowRoot) {
            for (var si = 0; si < selectors.length; si++) {
              var btn = node.shadowRoot.querySelector(selectors[si]);
              if (btn) {
                var pos = getAbsolutePos(btn);
                if (pos) return JSON.stringify({ found: true, x: pos.x, y: pos.y });
              }
            }
            var srDivs = node.shadowRoot.querySelectorAll('div, span, button');
            for (var sj = 0; sj < srDivs.length; sj++) {
              var st = (srDivs[sj].innerText || srDivs[sj].textContent || '').trim();
              for (var sk = 0; sk < sendTexts.length; sk++) {
                if (st === sendTexts[sk]) {
                  var pos2 = getAbsolutePos(srDivs[sj]);
                  if (pos2) return JSON.stringify({ found: true, x: pos2.x, y: pos2.y });
                }
              }
            }
            var found = searchShadowRootsForButtonPos(node.shadowRoot);
            if (found) return found;
          }
        }
      } catch(e) {}
      return null;
    }
    var srResult = searchShadowRootsForButtonPos(document.body);
    if (srResult) return srResult;
    return JSON.stringify({ found: false });
  })()`;
  }

  /**
   * 构建 Enter 键派发脚本：在 textarea 上派发 keydown Enter 事件。
   * 用于后台模式下 sendInputEvent 不可靠时的回退方案。
   * 飞鸽页面 placeholder 提示"使用Enter 发送消息"，Enter 键可触发发送。
   */
  private buildEnterKeyScript(selector: string): string {
    return `(function() {
      function findInput(sel) {
        // 优先返回第一个可见元素（非零尺寸），避免命中 dialog 内隐藏的 textarea 或 ant-select 内的 INPUT
        // weixin debug-config-dialog 内有隐藏 weui-desktop-form__textarea；
        // ant-design Select 组件有 ant-select-selection-search-input（placeholder 可能含"发送"）
        var input = null;
        var nodes = document.querySelectorAll(sel);
        for (var idx = 0; idx < nodes.length; idx++) {
          var r = nodes[idx].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { input = nodes[idx]; break; }
        }
        if (input) return input;
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var doc = iframes[i].contentDocument || iframes[i].contentWindow.document;
            if (doc) {
              var frameNodes = doc.querySelectorAll(sel);
              for (var j = 0; j < frameNodes.length; j++) {
                var fr = frameNodes[j].getBoundingClientRect();
                if (fr.width > 0 && fr.height > 0) { input = frameNodes[j]; break; }
              }
              if (input) return input;
            }
          } catch(e) {}
        }
        return null;
      }
      var input = findInput(${JSON.stringify(selector)});
      if (!input) return false;
      input.focus();
      var enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(enterEvent);
      return true;
    })()`;
  }

  /**
   * 构建发送后验证脚本：检查输入框是否已被清空。
   * 飞鸽发送成功后会清空输入框，这是发送成功的可靠标志。
   * 如果输入框仍有内容，说明发送逻辑未真正触发（React 状态未更新或网络错误）。
   */
  private buildVerifyClearedScript(selector: string): string {
    return `(function() {
      function findInput(sel) {
        // 优先返回第一个可见元素（非零尺寸），与 buildSetTextScript/buildEnterKeyScript 保持一致
        // 否则验证会检查错误的元素，导致"输入框未清空"误报
        var input = null;
        var nodes = document.querySelectorAll(sel);
        for (var idx = 0; idx < nodes.length; idx++) {
          var r = nodes[idx].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { input = nodes[idx]; break; }
        }
        if (input) return input;
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var doc = iframes[i].contentDocument || iframes[i].contentWindow.document;
            if (doc) {
              var frameNodes = doc.querySelectorAll(sel);
              for (var j = 0; j < frameNodes.length; j++) {
                var fr = frameNodes[j].getBoundingClientRect();
                if (fr.width > 0 && fr.height > 0) { input = frameNodes[j]; break; }
              }
              if (input) return input;
            }
          } catch(e) {}
        }
        return null;
      }
      var input = findInput(${JSON.stringify(selector)});
      if (!input) return true;
      if (input.contentEditable === 'true') {
        var t = (input.textContent || '').trim();
        return t.length === 0;
      }
      var v = (input.value || '').trim();
      return v.length === 0;
    })()`;
  }

  private buildClickSendButtonScript(): string {
    const s = this.platformSelectors;
    const selectors = JSON.stringify(s.sendButtonSelectors);
    const texts = JSON.stringify(s.sendButtonTexts);
    return `(function() {
    // 跨iframe搜索元素
    function querySelectorAllInFrames(sel) {
      var results = [];
      var mainResults = document.querySelectorAll(sel);
      for (var i = 0; i < mainResults.length; i++) results.push(mainResults[i]);
      var iframes = document.querySelectorAll('iframe');
      for (var fi = 0; fi < iframes.length; fi++) {
        try {
          var doc = iframes[fi].contentDocument || iframes[fi].contentWindow.document;
          if (doc) {
            var frameResults = doc.querySelectorAll(sel);
            for (var j = 0; j < frameResults.length; j++) results.push(frameResults[j]);
          }
        } catch(e) {}
      }
      return results;
    }
    var selectors = ${selectors};
    for (var i = 0; i < selectors.length; i++) {
      var btn = document.querySelector(selectors[i]);
      if (btn) { btn.click(); return true; }
    }
    var sendTexts = ${texts};
    var imBox = document.querySelector('#im-input-box') || document.body;
    var divs = imBox.querySelectorAll('div, span, button');
    for (var j = 0; j < divs.length; j++) {
      var t = (divs[j].innerText || divs[j].textContent || '').trim();
      for (var k = 0; k < sendTexts.length; k++) {
        if (t === sendTexts[k]) { divs[j].click(); return true; }
      }
    }
    // 跨iframe搜索发送按钮
    var iframes = document.querySelectorAll('iframe');
    for (var fi = 0; fi < iframes.length; fi++) {
      try {
        var doc = iframes[fi].contentDocument || iframes[fi].contentWindow.document;
        if (doc) {
          for (var si = 0; si < selectors.length; si++) {
            var frameBtn = doc.querySelector(selectors[si]);
            if (frameBtn) { frameBtn.click(); return true; }
          }
          var frameDivs = doc.querySelectorAll('div, span, button');
          for (var fj = 0; fj < frameDivs.length; fj++) {
            var ft = (frameDivs[fj].innerText || frameDivs[fj].textContent || '').trim();
            for (var fk = 0; fk < sendTexts.length; fk++) {
              if (ft === sendTexts[fk]) { frameDivs[fj].click(); return true; }
            }
          }
        }
      } catch(e) {}
    }
    // Shadow DOM 支持：遍历 open shadow roots 搜索发送按钮
    function searchShadowRootsForButton(root) {
      try {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
        var node;
        while ((node = walker.nextNode())) {
          if (node.shadowRoot) {
            for (var si = 0; si < selectors.length; si++) {
              var btn = node.shadowRoot.querySelector(selectors[si]);
              if (btn) { btn.click(); return true; }
            }
            var srDivs = node.shadowRoot.querySelectorAll('div, span, button');
            for (var sj = 0; sj < srDivs.length; sj++) {
              var st = (srDivs[sj].innerText || srDivs[sj].textContent || '').trim();
              for (var sk = 0; sk < sendTexts.length; sk++) {
                if (st === sendTexts[sk]) { srDivs[sj].click(); return true; }
              }
            }
            var found = searchShadowRootsForButton(node.shadowRoot);
            if (found) return true;
          }
        }
      } catch(e) {}
      return false;
    }
    if (searchShadowRootsForButton(document.body)) return true;
    return false;
  })()`;
  }

  async connect(): Promise<void> {
    try {
      // 复位停止标志：disconnect() 后复用同一实例重新 connect 时，
      // 若不清除 stopped，startPolling/startUnreadScanner/startDiagnosticTimer 会全部提前返回，
      // 消息静默不再被抓取
      this.stopped = false;
      this.diagnosticRunCount = 0;
      await this.installMessageObserver();
      // 连接后立即尝试关闭可能的弹窗（如 AI 智能客服弹窗）
      this.closeDialog().catch(() => {});
      this.connected = true;
      this.startPolling();
      this.startUnreadScanner();
      this.startDiagnosticTimer();
    } catch (err) {
      this.logger?.error({ platform: this.platformId, err }, 'WebviewClient 连接失败');
      this.connected = false;
      throw err;
    }
  }

  onMessage(handler: (msg: FeigeMessage) => void): void {
    this.messageHandler = handler;
    while (this.messageBuffer.length > 0) {
      const msg = this.messageBuffer.shift()!;
      handler(msg);
    }
  }

  /** 注册消息撤回回调：当检测到消息被撤回时触发 */
  onRevoke(handler: (sessionId: string, revokedText: string) => void): void {
    this.revokeHandler = handler;
  }

  async heartbeat(): Promise<boolean> {
    if (!this.webContents || this.webContents.isDestroyed() || this.webContents.isCrashed()) {
      return false;
    }
    try {
      await this.webContents.executeJavaScript('1+1');
      return true;
    } catch {
      return false;
    }
  }

  async executeScript(script: string): Promise<unknown> {
    if (!this.webContents || this.webContents.isDestroyed()) {
      throw new Error('WebContents 不可用');
    }
    // 订阅 console-message 事件，捕获渲染进程的 console.error/warning 输出。
    // webContents.executeJavaScript 在脚本抛未捕获异常时，只返回泛化错误信息
    // "Script failed to execute, this normally means an error was thrown."
    // 不会暴露具体的 JS 异常详情。这里通过订阅 console-message 捕获详细错误，
    // 在脚本失败时附加到错误信息中以便诊断。
    const consoleErrors: string[] = [];
    const handler = (eventDetails: unknown): void => {
      const details = eventDetails as {
        level?: 'info' | 'warning' | 'error' | 'debug';
        message?: string;
        lineNumber?: number;
        sourceId?: string;
      };
      if (details.level === 'warning' || details.level === 'error') {
        consoleErrors.push(
          `[L${details.lineNumber ?? 0} ${details.sourceId ?? ''}] ${details.message ?? ''}`,
        );
      }
    };
    this.webContents.on('console-message', handler);
    try {
      return await this.webContents.executeJavaScript(script);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (consoleErrors.length > 0) {
        // 附加渲染进程 console 错误，便于定位脚本失败根因
        const detail = consoleErrors.slice(0, 10).join('\n  ');
        throw new Error(`${errMsg}\n渲染进程 console 错误:\n  ${detail}`);
      }
      throw err;
    } finally {
      this.webContents.off('console-message', handler);
    }
  }

  /** 向页面发送 Escape 键（用于关闭弹窗/抽屉），避免外部直接访问私有 webContents */
  sendEscapeKey(): void {
    void this.webContents?.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    void this.webContents?.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  }

  async probe(): Promise<boolean> {
    if (!this.webContents || this.webContents.isDestroyed()) {
      return false;
    }
    if (this.webContents.isCrashed()) {
      try {
        await this.webContents.reload();
        this.observerInstalled = false;
        await this.installMessageObserver();
        return true;
      } catch {
        return false;
      }
    }
    const ok = await this.heartbeat();
    if (ok) {
      try {
        const installed = (await this.webContents.executeJavaScript(
          '!!window.__feigeObserverInstalled',
        )) as boolean;
        if (!installed) {
          this.observerInstalled = false;
          this.logger?.info({ platform: this.platformId }, 'Probe: Observer 未安装，尝试重新安装');
          await this.installMessageObserver();
        } else {
          // 同步 TS 侧标志：浏览器已安装时，确保 this.observerInstalled 也为 true
          // 否则 resetObserver() 设置 false 后，探测看到浏览器标志为 true 不会恢复 TS 侧标志，
          // 导致扫描器永远跳过（"扫描器: 跳过（observer 未安装）"）
          if (!this.observerInstalled) {
            this.observerInstalled = true;
            this.logger?.info({ platform: this.platformId }, 'Probe: Observer 已安装（同步 TS 侧标志）');
          }
        }
        // 诊断：检查页面 DOM 和选择器匹配情况
        await this.diagnosePage();
      } catch {
        // ignore
      }
    }
    return ok;
  }

  /**
   * 诊断页面 DOM 结构和选择器匹配情况
   * 将完整 DOM 结构写入 data/feige-dom-dump.json 以便离线分析
   */
  async diagnosePage(): Promise<void> {
    if (!this.webContents || this.webContents.isDestroyed()) return;
    try {
      const script = `(function() {
        var result = {
          url: window.location.href,
          observerInstalled: !!window.__feigeObserverInstalled,
          queueLength: (window.__feigeMsgQueue || []).length,
          seenMessages: (window.__feigeSeenMessages || {size: 0}).size || 0,
          bodyClasses: (document.body.className || '').substring(0, 200),
          bodyTextSnippet: (document.body.innerText || '').substring(0, 800),
          now: Date.now(),
        };

        // ===== 1. 深度扫描：查找所有可见的叶子文本节点及其DOM链 =====
        // 目的：发现聊天消息气泡的实际 class 名称
        result.textNodeDump = [];
        var seen = {};
        var allEls = document.querySelectorAll('div, span, p, li, td, label');
        for (var i = 0; i < allEls.length && i < 5000; i++) {
          var el = allEls[i];
          // 跳过不可见元素
          if (el.offsetParent === null && el.tagName !== 'BODY') continue;
          // 只看直接包含文本（子节点中没有其他元素，或只有 <br>）
          var hasBlockChild = false;
          for (var c = 0; c < el.children.length; c++) {
            var childTag = el.children[c].tagName;
            if (childTag !== 'BR' && childTag !== 'SPAN' && childTag !== 'A') { hasBlockChild = true; break; }
          }
          if (hasBlockChild) continue;
          var t = (el.innerText || el.textContent || '').trim();
          if (!t || t.length < 1 || t.length > 300) continue;
          // 跳过纯数字、纯时间
          if (/^\\d{1,2}:\\d{2}(:\\d{2})?$/.test(t)) continue;
          if (/^\\d+$/.test(t) && t.length < 3) continue;
          // 获取 5 层父链
          var chain = [];
          var cur = el;
          for (var d = 0; d < 6 && cur; d++) {
            var curCls = (cur.className || '').toString();
            chain.push({
              tag: cur.tagName,
              cls: curCls.substring(0, 150),
              id: (cur.id || '').substring(0, 50),
              role: cur.getAttribute ? (cur.getAttribute('role') || '') : '',
              dataRole: cur.getAttribute ? (cur.getAttribute('data-role') || cur.getAttribute('data-from') || '') : ''
            });
            cur = cur.parentElement;
          }
          var key = t.substring(0, 30) + '|' + chain[0].cls.substring(0, 30);
          if (seen[key]) continue;
          seen[key] = true;
          result.textNodeDump.push({
            text: t.substring(0, 200),
            chain: chain,
            rect: (function() {
              var r = el.getBoundingClientRect();
              return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
            })()
          });
          if (result.textNodeDump.length >= 80) break;
        }

        // ===== 2. 扫描所有 textarea 和 contenteditable =====
        result.textareas = [];
        var tas = document.querySelectorAll('textarea');
        for (var ti = 0; ti < tas.length && ti < 20; ti++) {
          var taRect = tas[ti].getBoundingClientRect();
          result.textareas.push({
            cls: (tas[ti].className || '').toString().substring(0, 150),
            placeholder: (tas[ti].getAttribute('placeholder') || '').substring(0, 100),
            visible: tas[ti].offsetParent !== null,
            w: Math.round(taRect.width),
            h: Math.round(taRect.height),
            x: Math.round(taRect.x),
            y: Math.round(taRect.y),
            parentChain: (function() {
              var c2 = []; var p = tas[ti];
              for (var pi = 0; pi < 5 && p; pi++) {
                c2.push({ tag: p.tagName, cls: (p.className || '').toString().substring(0, 120) });
                p = p.parentElement;
              }
              return c2;
            })()
          });
        }
        result.contentEditables = [];
        var ces = document.querySelectorAll('[contenteditable]');
        for (var ci = 0; ci < ces.length && ci < 20; ci++) {
          var ceRect = ces[ci].getBoundingClientRect();
          result.contentEditables.push({
            tag: ces[ci].tagName,
            cls: (ces[ci].className || '').toString().substring(0, 150),
            ce: ces[ci].getAttribute('contenteditable'),
            visible: ces[ci].offsetParent !== null,
            w: Math.round(ceRect.width),
            h: Math.round(ceRect.height),
            x: Math.round(ceRect.x),
            y: Math.round(ceRect.y),
            parentChain: (function() {
              var c3 = []; var p = ces[ci];
              for (var pi2 = 0; pi2 < 5 && p; pi2++) {
                c3.push({ tag: p.tagName, cls: (p.className || '').toString().substring(0, 120) });
                p = p.parentElement;
              }
              return c3;
            })()
          });
        }

        // ===== 3. 扫描所有可见的按钮和可点击元素 =====
        result.buttons = [];
        var btns = document.querySelectorAll('button, [role="button"], a[class*="btn"], div[class*="btn"], span[class*="btn"], div[class*="send"], [class*="submit"]');
        for (var bi = 0; bi < btns.length && bi < 30; bi++) {
          if (btns[bi].offsetParent === null) continue;
          var btnText = (btns[bi].innerText || btns[bi].textContent || '').trim();
          if (!btnText) continue;
          var btnRect = btns[bi].getBoundingClientRect();
          result.buttons.push({
            tag: btns[bi].tagName,
            cls: (btns[bi].className || '').toString().substring(0, 120),
            text: btnText.substring(0, 30),
            w: Math.round(btnRect.width),
            h: Math.round(btnRect.height),
            x: Math.round(btnRect.x),
            y: Math.round(btnRect.y)
          });
        }

        // ===== 4. 统计所有 class 前缀出现频率（找 CSS Modules 命名规律）=====
        result.classPrefixFreq = {};
        var allDivs = document.querySelectorAll('div[class], span[class], li[class]');
        for (var di2 = 0; di2 < allDivs.length && di2 < 3000; di2++) {
          var cls2 = (allDivs[di2].className || '').toString();
          if (!cls2) continue;
          // 提取前缀（第一个 _ 或 - 之前的部分）
          var parts = cls2.split(/[\\s_\\-]/);
          for (var pp = 0; pp < parts.length && pp < 3; pp++) {
            var prefix = parts[pp].substring(0, 20);
            if (prefix.length >= 3) {
              result.classPrefixFreq[prefix] = (result.classPrefixFreq[prefix] || 0) + 1;
            }
          }
        }
        // 取出现次数最多的前 30 个前缀
        result.topClassPrefixes = Object.keys(result.classPrefixFreq)
          .map(function(k) { return { prefix: k, count: result.classPrefixFreq[k] }; })
          .sort(function(a, b) { return b.count - a.count; })
          .slice(0, 30);
        delete result.classPrefixFreq;

        // ===== 5. iframe 信息 =====
        result.iframes = [];
        var iframes = document.querySelectorAll('iframe');
        for (var fi = 0; fi < iframes.length && fi < 10; fi++) {
          try {
            var iframeDoc = iframes[fi].contentDocument || (iframes[fi].contentWindow ? iframes[fi].contentWindow.document : null);
            result.iframes.push({
              src: (iframes[fi].src || '').substring(0, 200),
              hasAccess: !!iframeDoc,
              bodyClasses: iframeDoc ? (iframeDoc.body.className || '').substring(0, 100) : ''
            });
          } catch(e) {
            result.iframes.push({ src: (iframes[fi].src || '').substring(0, 200), error: String(e) });
          }
        }

        // ===== 6. Shadow DOM 检测 =====
        result.shadowRootCount = 0;
        try {
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null, false);
          var node;
          while ((node = walker.nextNode())) {
            if (node.shadowRoot) result.shadowRootCount++;
          }
        } catch(e) {}

        return JSON.stringify(result);
      })()`;
      const raw = (await this.webContents.executeJavaScript(script)) as string;
      if (raw) {
        const diag = JSON.parse(raw);
        this.logger?.info(
          {
            platform: this.platformId,
            url: diag.url,
            observerInstalled: diag.observerInstalled,
            queueLength: diag.queueLength,
            seenMessages: diag.seenMessages,
            bodyClasses: diag.bodyClasses,
            textNodeCount: diag.textNodeDump ? diag.textNodeDump.length : 0,
            textareaCount: diag.textareas ? diag.textareas.length : 0,
            contentEditableCount: diag.contentEditables ? diag.contentEditables.length : 0,
            buttonCount: diag.buttons ? diag.buttons.length : 0,
            topClassPrefixes: diag.topClassPrefixes,
            shadowRootCount: diag.shadowRootCount,
          },
          '页面诊断: DOM 结构分析',
        );
        // 将完整诊断结果写入文件以便离线分析
        try {
          const dumpDir = resolveData(undefined, 'data');
          if (!fs.existsSync(dumpDir)) fs.mkdirSync(dumpDir, { recursive: true });
          const dumpPath = path.join(dumpDir, `dom-dump-${this.platformId}.json`);
          fs.writeFileSync(dumpPath, JSON.stringify(diag, null, 2), 'utf-8');
          this.logger?.info({ platform: this.platformId, dumpPath }, 'DOM 诊断已写入文件');
        } catch (writeErr) {
          this.logger?.warn({ err: writeErr }, 'DOM 诊断文件写入失败');
        }
      }
    } catch {
      // ignore diagnostic errors
    }
  }

  async getLatestMessages(): Promise<FeigeMessage[]> {
    if (!this.webContents || this.webContents.isDestroyed()) return [];
    try {
      const raw = (await this.webContents.executeJavaScript(this.buildLatestMessagesScript())) as string;
      if (!raw) return [];
      const parsed = JSON.parse(raw) as RawMessage[];
      return parsed.map((m) => ({
        sessionId: m.sessionId,
        from: m.from as MessageFrom,
        text: m.text,
        timestamp: m.timestamp,
        messageId: m.messageId,
        productId: m.productId,
      }));
    } catch {
      return [];
    }
  }

  async sendReply(text: string, inputBoxSelector?: string): Promise<void> {
    if (!this.webContents || !this.connected) throw new Error('Webview not connected');

    const selector = inputBoxSelector || this.getDefaultInputSelector();

    if (this.backgroundMode) {
      // 后台模式：DOM focus + click（隐藏视图上 sendInputEvent 不可靠）
      let focused = false;
      try {
        focused = (await this.webContents.executeJavaScript(focusInputScript(selector))) as boolean;
      } catch (err) {
        this.logger?.warn({ platform: this.platformId, err }, '后台模式输入框聚焦失败');
        throw new Error('后台模式输入框聚焦异常: ' + (err instanceof Error ? err.message : String(err)));
      }
      if (!focused) {
        await this.logInputDiagnostic(selector);
        throw new Error('输入框未找到，选择器未匹配: ' + selector);
      }
      this.logger?.info({ platform: this.platformId }, 'DOM 聚焦输入框(后台模式,逐字)');
    } else {
      // 活跃模式：humanClick
      const inputPos = await this.findElementPosition(this.buildFindInputScript(selector));
      if (!inputPos) {
        await this.logInputDiagnostic(selector);
        throw new Error('输入框未找到，选择器未匹配: ' + selector);
      }
      this.logger?.info({ platform: this.platformId, x: inputPos.x, y: inputPos.y }, '人工点击输入框(逐字)');
      await this.humanClick(inputPos.x, inputPos.y);
      await this.delay(100 + Math.random() * 200);
    }

    await this.webContents.executeJavaScript(clearInputScript(selector));

    for (const ch of text) {
      if (ch === '\n') {
        // 多行回复的换行用 Shift+Enter（飞鸽中 Enter 是发送，Shift+Enter 才是换行）
        await this.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });
        await this.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] });
      } else {
        await this.typeChar(ch);
      }
    }

    // 逐字输入后等待 React 状态更新
    await this.delay(300);

    // 优先用 Enter 键发送（飞鸽原生方式）
    const enterSent = (await this.webContents.executeJavaScript(
      this.buildEnterKeyScript(selector),
    )) as boolean;
    await this.delay(1200);

    // 发送后验证
    let verified = enterSent ? ((await this.webContents.executeJavaScript(
      this.buildVerifyClearedScript(selector),
    )) as boolean) : false;

    // Enter 键未生效则回退到发送按钮点击
    if (!verified) {
      this.logger?.warn({ platform: this.platformId, enterSent }, '逐字模式: Enter 键发送未生效，回退到发送按钮点击');
      let btnClicked = false;
      if (this.backgroundMode) {
        btnClicked = (await this.webContents.executeJavaScript(
          this.buildClickSendButtonScript(),
        )) as boolean;
      } else {
        const btnPos = await this.findElementPosition(this.buildFindSendButtonScript());
        if (btnPos) {
          this.logger?.info({ platform: this.platformId, x: btnPos.x, y: btnPos.y }, '人工点击发送按钮(逐字)');
          await this.delay(80 + Math.random() * 150);
          await this.humanClick(btnPos.x, btnPos.y);
          btnClicked = true;
        } else {
          btnClicked = (await this.webContents.executeJavaScript(
            this.buildClickSendButtonScript(),
          )) as boolean;
        }
      }
      if (btnClicked) {
        await this.delay(1200);
        verified = (await this.webContents.executeJavaScript(
          this.buildVerifyClearedScript(selector),
        )) as boolean;
      }
    }

    if (!verified) {
      this.logger?.warn({ platform: this.platformId, replyLength: text.length }, '逐字模式: 发送后验证失败：输入框未清空');
    } else {
      this.logger?.info({ platform: this.platformId }, '逐字模式: 回复已发送并验证');
    }
  }

  private buildSetTextScript(selector: string, text: string): string {
    return `(function() {
      function findInput(sel) {
        // 优先返回第一个可见元素（非零尺寸），避免命中 dialog 内隐藏的 textarea 或 ant-select INPUT
        // 与 buildEnterKeyScript/buildVerifyClearedScript 保持一致，
        // 否则文字会键入错误的元素，导致后续 Enter/验证全部失效
        var input = null;
        var nodes = document.querySelectorAll(sel);
        for (var idx = 0; idx < nodes.length; idx++) {
          var r = nodes[idx].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { input = nodes[idx]; break; }
        }
        if (input) return input;
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var doc = iframes[i].contentDocument || iframes[i].contentWindow.document;
            if (doc) {
              var frameNodes = doc.querySelectorAll(sel);
              for (var j = 0; j < frameNodes.length; j++) {
                var fr = frameNodes[j].getBoundingClientRect();
                if (fr.width > 0 && fr.height > 0) { input = frameNodes[j]; break; }
              }
              if (input) return input;
            }
          } catch(e) {}
        }
        // Shadow DOM 支持：遍历 open shadow roots
        function searchShadowRoots(root) {
          try {
            var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
            var node;
            while ((node = walker.nextNode())) {
              if (node.shadowRoot) {
                var el = node.shadowRoot.querySelector(sel);
                if (el) return el;
                var found = searchShadowRoots(node.shadowRoot);
                if (found) return found;
              }
            }
          } catch(e) {}
          return null;
        }
        return searchShadowRoots(document.body);
      }
      var input = findInput(${JSON.stringify(selector)});
      if (!input) return { success: false, method: 'no-input' };
      if (input.contentEditable === 'true') {
        input.textContent = '';
        input.textContent = ${JSON.stringify(text)};
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, method: 'contenteditable' };
      }
      if (input.tagName === 'TEXTAREA') {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        if (setter) { setter.call(input, ''); }
        else { input.value = ''; }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (setter) { setter.call(input, ${JSON.stringify(text)}); }
        else { input.value = ${JSON.stringify(text)}; }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, method: 'textarea-native' };
      }
      if (input.tagName === 'INPUT') {
        var setter2 = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        if (setter2) { setter2.call(input, ''); }
        else { input.value = ''; }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (setter2) { setter2.call(input, ${JSON.stringify(text)}); }
        else { input.value = ${JSON.stringify(text)}; }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, method: 'input-native' };
      }
      return { success: false, method: 'unknown-type' };
    })()`;
  }

  /** 诊断：输入框未找到时，检查页面上的输入元素统计 */
  private async logInputDiagnostic(selector: string): Promise<void> {
    try {
      const diag = (await this.webContents.executeJavaScript(`(function() {
        var textareas = document.querySelectorAll('textarea');
        var contentEditables = document.querySelectorAll('[contenteditable]');
        var textInputs = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])');
        var shadowRootCount = 0;
        try {
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null, false);
          var node;
          while ((node = walker.nextNode())) {
            if (node.shadowRoot) shadowRootCount++;
          }
        } catch(e) {}
        var ceDetails = [];
        for (var i = 0; i < contentEditables.length && i < 10; i++) {
          ceDetails.push({
            tag: contentEditables[i].tagName,
            cls: (contentEditables[i].className || '').toString().substring(0, 100),
            ce: contentEditables[i].getAttribute('contenteditable'),
            visible: contentEditables[i].offsetParent !== null
          });
        }
        var taDetails = [];
        for (var j = 0; j < textareas.length && j < 10; j++) {
          taDetails.push({
            cls: (textareas[j].className || '').toString().substring(0, 100),
            visible: textareas[j].offsetParent !== null
          });
        }
        var inputAreaEls = document.querySelectorAll('[class*="input"], [class*="editor"], [class*="send-box"], [class*="chat-input"]');
        var inputAreaDetails = [];
        for (var k = 0; k < inputAreaEls.length && k < 10; k++) {
          inputAreaDetails.push({
            tag: inputAreaEls[k].tagName,
            cls: (inputAreaEls[k].className || '').toString().substring(0, 100),
            visible: inputAreaEls[k].offsetParent !== null
          });
        }
        return JSON.stringify({
          textareas: textareas.length,
          contentEditables: contentEditables.length,
          textInputs: textInputs.length,
          shadowRoots: shadowRootCount,
          inputAreaEls: inputAreaEls.length,
          ceDetails: ceDetails,
          taDetails: taDetails,
          inputAreaDetails: inputAreaDetails
        });
      })()`)) as string;
      this.logger?.warn({ platform: this.platformId, selector, diag: diag ? JSON.parse(diag) : null }, '输入框诊断：页面输入元素统计');
    } catch (e) {
      this.logger?.warn({ platform: this.platformId, err: String(e) }, '输入框诊断失败');
    }
  }

  async sendReplyFast(text: string): Promise<{ success: boolean; method: string }> {
    if (!this.webContents || !this.connected) throw new Error('Webview not connected');
    const selector = this.getDefaultInputSelector();

    if (this.backgroundMode) {
      // 后台模式：DOM focus + click（隐藏视图上 sendInputEvent 不可靠）
      const focused = (await this.webContents.executeJavaScript(focusInputScript(selector))) as boolean;
      if (!focused) {
        await this.logInputDiagnostic(selector);
        return { success: false, method: 'no-input' };
      }
      this.logger?.info({ platform: this.platformId }, 'DOM 聚焦输入框(后台模式)');
    } else {
      // 活跃模式：humanClick
      const inputPos = await this.findElementPosition(this.buildFindInputScript(selector));
      if (!inputPos) {
        await this.logInputDiagnostic(selector);
        return { success: false, method: 'no-input' };
      }
      this.logger?.info({ platform: this.platformId, x: inputPos.x, y: inputPos.y }, '人工点击输入框');
      await this.humanClick(inputPos.x, inputPos.y);
      await this.delay(100 + Math.random() * 200);
    }

    // 设置回复文本（两种模式共用）
    const result = (await this.webContents.executeJavaScript(
      this.buildSetTextScript(selector, text),
    )) as { success: boolean; method: string } | null;
    if (!result || !result.success) {
      return { success: false, method: result?.method ?? 'no-result' };
    }

    // 等待 React 处理 input 事件并更新内部状态后再发送
    // React 18 事件批处理可能导致设置文本后立即发送时状态尚未更新
    await this.delay(300);

    // 优先用 Enter 键发送（飞鸽原生方式：placeholder 提示"使用Enter 发送消息"）
    const enterSent = (await this.webContents.executeJavaScript(
      this.buildEnterKeyScript(selector),
    )) as boolean;

    // 等待发送处理（飞鸽需要时间清空输入框并提交网络请求）
    await this.delay(1200);

    // 发送后验证：检查输入框是否已被清空（飞鸽发送成功后会清空）
    let verified = enterSent ? ((await this.webContents.executeJavaScript(
      this.buildVerifyClearedScript(selector),
    )) as boolean) : false;

    // 如果 Enter 键未生效（输入框仍有内容），回退到发送按钮点击
    if (!verified) {
      this.logger?.warn({ platform: this.platformId, enterSent }, 'Enter 键发送未生效，回退到发送按钮点击');
      let btnClicked = false;
      if (this.backgroundMode) {
        btnClicked = (await this.webContents.executeJavaScript(
          this.buildClickSendButtonScript(),
        )) as boolean;
      } else {
        // 活跃模式：优先 humanClick，失败则 DOM click
        const btnPos = await this.findElementPosition(this.buildFindSendButtonScript());
        if (btnPos) {
          this.logger?.info({ platform: this.platformId, x: btnPos.x, y: btnPos.y }, '人工点击发送按钮');
          await this.delay(80 + Math.random() * 150);
          await this.humanClick(btnPos.x, btnPos.y);
          btnClicked = true;
        } else {
          btnClicked = (await this.webContents.executeJavaScript(
            this.buildClickSendButtonScript(),
          )) as boolean;
        }
      }
      if (btnClicked) {
        await this.delay(1200);
        verified = (await this.webContents.executeJavaScript(
          this.buildVerifyClearedScript(selector),
        )) as boolean;
      }
    }

    if (verified) {
      this.logger?.info({ platform: this.platformId, method: result.method }, '回复已发送并验证');
      return { success: true, method: result.method };
    }
    // 发送后验证失败：输入框仍有内容，说明消息未真正发送
    this.logger?.warn({ platform: this.platformId, method: result.method, replyLength: text.length }, '发送后验证失败：输入框未清空');
    return { success: false, method: 'verify-failed' };
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.unreadScanTimer) {
      clearTimeout(this.unreadScanTimer);
      this.unreadScanTimer = null;
    }
    if (this.diagnosticTimer) {
      clearTimeout(this.diagnosticTimer);
      this.diagnosticTimer = null;
    }
    this.connected = false;
    this.observerInstalled = false;
  }

  /** 定期诊断页面状态，帮助排查消息检测问题 */
  private diagnosticTimer: NodeJS.Timeout | null = null;
  private static readonly DIAGNOSTIC_INTERVAL_MS = 20000;
  private diagnosticRunCount = 0;
  private static readonly DIAGNOSTIC_MAX_RUNS = 15;

  private startDiagnosticTimer(): void {
    if (this.diagnosticTimer || this.stopped) return;
    const run = () => {
      if (this.stopped) return;
      if (this.diagnosticRunCount >= WebviewClient.DIAGNOSTIC_MAX_RUNS) {
        this.diagnosticTimer = null;
        return;
      }
      this.diagnosticRunCount++;
      void this.diagnosePage().finally(() => {
        if (this.stopped || this.diagnosticRunCount >= WebviewClient.DIAGNOSTIC_MAX_RUNS) {
          this.diagnosticTimer = null;
          return;
        }
        this.diagnosticTimer = setTimeout(run, WebviewClient.DIAGNOSTIC_INTERVAL_MS);
        this.diagnosticTimer.unref?.();
      });
    };
    this.diagnosticTimer = setTimeout(run, 5000);
    this.diagnosticTimer.unref?.();
  }

  resetObserver(): void {
    this.observerInstalled = false;
    this.suppressUntil = Date.now() + this.suppressMs;
    try {
      void this.webContents.executeJavaScript(`window.__feigeSuppressUntil = ${this.suppressUntil}; window.__feigeTabSwitched = false; window.__feigeScanIndex = 0;`);
    } catch {}
  }

  /**
   * 等待聊天页面加载完成
   */
  async waitForChatLoaded(timeoutMs: number = 10000): Promise<void> {
    const inputSelector = this.getDefaultInputSelector();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const found = await this.executeScript(`
          (function() {
            var selector = ${JSON.stringify(inputSelector)};
            var el = document.querySelector(selector);
            return !!el && el.offsetParent !== null;
          })()
        `) as boolean;
        if (found) {
          await this.delay(500); // 额外等待 React 渲染稳定
          return;
        }
      } catch {}
      await this.delay(300);
    }
    this.logger?.warn({ platform: this.platformId, timeoutMs }, '等待聊天页面加载超时');
  }

  /**
   * 验证消息已发送（检查最后一条消息气泡）
   */
  async verifySent(text: string, timeoutMs: number = 5000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const verified = await this.executeScript(`
          (function() {
            var selectors = ${JSON.stringify(this.platformSelectors.messageSelectors)};
            var sellerPatterns = ${JSON.stringify(this.platformSelectors.sellerClassPatterns)};
            var targetText = ${JSON.stringify(text.slice(0, 50))};
            for (var i = 0; i < selectors.length; i++) {
              var nodes = document.querySelectorAll(selectors[i]);
              // 从后往前检查最后 5 条消息
              for (var j = nodes.length - 1; j >= 0 && j >= nodes.length - 5; j--) {
                var node = nodes[j];
                var cls = node.className || '';
                var isSeller = sellerPatterns.some(function(p) {
                  return cls.toLowerCase().indexOf(p.toLowerCase()) >= 0;
                });
                if (!isSeller) continue;
                var content = (node.innerText || '').trim();
                if (content.indexOf(targetText) >= 0) return true;
              }
            }
            return false;
          })()
        `) as boolean;
        if (verified) return true;
      } catch {}
      await this.delay(500);
    }
    return false;
  }

  get isConnected(): boolean {
    return this.connected && !this.webContents.isDestroyed();
  }

  get platformName(): string {
    return this.platformId;
  }

  // ============ 私有方法 ============

  private async installMessageObserver(): Promise<void> {
    if (this.observerInstalled || this.webContents.isDestroyed()) return;
    try {
      await this.webContents.executeJavaScript(this.buildObserverScript());
      this.observerInstalled = true;
      this.logger?.info({ platform: this.platformId }, 'Observer 已安装');
    } catch (err) {
      this.logger?.warn({ platform: this.platformId, err: err instanceof Error ? err.message : String(err) }, 'Observer 安装失败（页面可能仍在加载）');
    }
  }

  private startPolling(): void {
    if (this.pollTimer || this.stopped) return;
    this.scheduleNextPoll();
  }

  private scheduleNextPoll(): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => {
      void this.drainMessageQueue()
        .then(() => {
          this.scheduleNextPoll();
        })
        .catch((err) => {
          this.logger?.warn(
            { platform: this.platformId, err: err instanceof Error ? err.message : String(err) },
            'drainMessageQueue 异常，继续轮询',
          );
          this.scheduleNextPoll();
        });
    }, this.currentPollIntervalMs);
    this.pollTimer.unref?.();
  }

  private async drainMessageQueue(): Promise<void> {
    if (this.webContents.isDestroyed() || this.stopped) return;
    const now = Date.now();
    if (now < this.suppressUntil) {
      // Leave the browser-side queue intact so messages are processed after
      // navigation or conversation-loading suppression ends.
      this.logger?.debug({ platform: this.platformId, suppressUntil: this.suppressUntil, now }, '消息队列: 抑制期内延后处理');
      return;
    }
    let raw: unknown;
    try {
      raw = await this.webContents.executeJavaScript(this.buildDrainQueueScript());
    } catch {
      return;
    }
    if (!raw) {
      this.increasePollInterval();
      return;
    }
    let parsed: RawMessage[];
    try {
      parsed = JSON.parse(raw as string) as RawMessage[];
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) {
      this.increasePollInterval();
      return;
    }
    if (parsed.length > 0) {
      this.currentPollIntervalMs = this.pollMinMs;
    } else {
      this.increasePollInterval();
    }

    // 分离撤回消息和普通消息：撤回消息即使在抑制期内也需处理
    const revokeMessages = parsed.filter((m) => m.text?.startsWith('__MSG_REVOKED__:'));
    const regularMessages = parsed.filter((m) => !m.text?.startsWith('__MSG_REVOKED__:'));

    // 处理撤回消息：从上下文中移除被撤回的用户消息
    for (const r of revokeMessages) {
      const revokedText = r.text.substring('__MSG_REVOKED__:'.length);
      this.logger?.info(
        { platform: this.platformId, sessionId: r.sessionId, revokedText: revokedText.substring(0, 50) },
        '消息撤回: 检测到消息被撤回',
      );
      if (this.revokeHandler) {
        this.revokeHandler(r.sessionId, revokedText);
      }
    }

    if (regularMessages.length > 0) {
      this.logger?.info(
        {
          platform: this.platformId,
          msgCount: regularMessages.length,
          fromValues: regularMessages.map((m) => m.from),
          texts: regularMessages.map((m) => (m.text || '').substring(0, 30)),
        },
        '消息队列: 检测到新消息',
      );
    }

    for (const m of regularMessages) {
      const msg: FeigeMessage = {
        sessionId: m.sessionId,
        from: m.from as MessageFrom,
        text: m.text,
        timestamp: m.timestamp,
        productId: m.productId,
      };
      // 逐条容错：单条消息处理抛错不能中断循环，否则该批消息已从页面队列
      // 清空（buildDrainQueueScript 整体取出），剩余消息会永久丢失
      try {
        if (this.messageHandler) {
          this.messageHandler(msg);
        } else {
          this.messageBuffer.push(msg);
        }
      } catch (err) {
        this.logger?.error(
          { platform: this.platformId, sessionId: m.sessionId, err: err instanceof Error ? err.message : String(err) },
          '处理消息回调异常（已跳过该条）',
        );
      }
    }
  }

  private increasePollInterval(): void {
    const ceiling = this.backgroundMode ? Math.max(this.pollMaxMs, this.backgroundPollMs) : this.pollMaxMs;
    const next = this.currentPollIntervalMs + this.pollIdleIncreaseMs;
    if (next <= ceiling) {
      this.currentPollIntervalMs = next;
    }
  }

  private startUnreadScanner(): void {
    if (this.unreadScanTimer || this.stopped) return;
    this.scheduleNextUnreadScan();
  }

  private scheduleNextUnreadScan(): void {
    if (this.stopped) return;
    this.unreadScanTimer = setTimeout(() => {
      void this.scanUnreadConversations()
        .then(() => {
          this.scheduleNextUnreadScan();
        })
        .catch((err) => {
          this.logger?.error({ platform: this.platformId, err: err instanceof Error ? err.message : String(err) }, '扫描器: 异常退出，重新调度');
          this.scheduleNextUnreadScan();
        });
    }, WebviewClient.UNREAD_SCAN_INTERVAL_MS);
    this.unreadScanTimer.unref?.();
  }

  private async scanUnreadConversations(): Promise<void> {
    if (this.webContents.isDestroyed() || this.stopped || !this.connected) {
      this.logger?.debug({ platform: this.platformId, destroyed: this.webContents.isDestroyed(), stopped: this.stopped, connected: this.connected }, '扫描器: 跳过（destroyed/stopped/disconnected）');
      return;
    }
    // autoReply 关闭时跳过扫描，避免点击菜单项覆盖用户手动操作
    if (!this.autoReplyEnabled) {
      return;
    }
    if (this.unreadScanInFlight) return;
    // Observer 未安装时不扫描（页面正在加载/重载）
    if (!this.observerInstalled) {
      this.logger?.debug({ platform: this.platformId }, '扫描器: 跳过（observer 未安装）');
      return;
    }
    // 抑制期内不扫描（页面正在加载/重载）
    if (Date.now() < this.suppressUntil) {
      this.logger?.debug({ platform: this.platformId, suppressUntil: this.suppressUntil, now: Date.now() }, '扫描器: 抑制期内，跳过扫描');
      return;
    }
    // 转接会话进行中：跳过扫描，避免点击会话列表项导致 React 重新渲染关闭转接抽屉
    if (this.transferInProgress) {
      this.logger?.debug({ platform: this.platformId }, '扫描器: 跳过（转接会话进行中）');
      return;
    }
    // 刚点击过未读会话，等待聊天区域加载完毕
    if (Date.now() - this.lastUnreadClickAt < WebviewClient.UNREAD_CLICK_LOAD_MS + 500) {
      this.logger?.debug({ platform: this.platformId, lastUnreadClickAt: this.lastUnreadClickAt, elapsed: Date.now() - this.lastUnreadClickAt }, '扫描器: 跳过（点击冷却期）');
      return;
    }
    this.logger?.debug({ platform: this.platformId, backgroundMode: this.backgroundMode }, '扫描器: 开始扫描');

    this.unreadScanInFlight = true;
    try {
      // 每次扫描前尝试关闭弹窗
      await this.closeDialog();
      let clicked = false;
      let hadUnread = false;
      if (this.backgroundMode) {
        // 后台模式：DOM 点击（隐藏视图上 sendInputEvent 不可靠）
        let raw: string | null = null;
        try {
          raw = (await this.webContents.executeJavaScript(
            this.buildClickUnreadConversationScript(),
          )) as string;
        } catch (err) {
          this.logger?.debug({ platform: this.platformId, err: err instanceof Error ? err.message : String(err) }, '扫描器: executeJavaScript 失败(后台模式)');
          return;
        }
        if (raw) {
          try {
            const result = JSON.parse(raw);
            clicked = !!result.clicked;
            hadUnread = !!result.hadUnread;
            // 飞鸽专用：tab 切换后等待页面加载并触发诊断
            if (result.tabSwitched) {
              this.lastUnreadClickAt = Date.now();
              const suppressEnd = Date.now() + WebviewClient.UNREAD_CLICK_LOAD_MS + 500;
              this.suppressUntil = suppressEnd;
              try {
                await this.webContents.executeJavaScript(`window.__feigeSuppressUntil = ${suppressEnd};`);
              } catch {}
              this.logger?.info({ platform: this.platformId }, '扫描器: 已切换到"最近联系"标签页，等待会话列表加载');
              await new Promise<void>((r) => {
                const t = setTimeout(r, WebviewClient.UNREAD_CLICK_LOAD_MS);
                t.unref?.();
              });
              // 切换 tab 后触发诊断，dump 新的 DOM 结构以便分析会话列表项
              void this.diagnosePage();
              return;
            }
          } catch {
            // 兼容旧版 boolean 返回
            clicked = raw === 'true';
            hadUnread = true;
          }
        }
        if (clicked) {
          this.logger?.info({ platform: this.platformId, hadUnread }, 'DOM 点击会话(后台模式)');
        } else {
          this.logger?.debug({ platform: this.platformId, raw: raw ? raw.substring(0, 100) : 'null' }, '扫描器: 未找到可点击会话(后台模式)');
        }
      } else {
        // 活跃模式：humanClick（sendInputEvent 模拟人工）
        let raw: string | null = null;
        try {
          raw = (await this.webContents.executeJavaScript(
            this.buildFindUnreadConversationScript(),
          )) as string;
        } catch (err) {
          this.logger?.debug({ platform: this.platformId, err: err instanceof Error ? err.message : String(err) }, '扫描器: executeJavaScript 失败(活跃模式)');
          return;
        }
        if (!raw) {
          this.logger?.debug({ platform: this.platformId }, '扫描器: 脚本返回空(活跃模式)');
          return;
        }
        let result: { found: boolean; x?: number; y?: number; reason: string; hadUnread?: boolean; tabSwitched?: boolean };
        try {
          result = JSON.parse(raw);
        } catch {
          this.logger?.debug({ platform: this.platformId, raw: raw.substring(0, 100) }, '扫描器: JSON 解析失败(活跃模式)');
          return;
        }
        // 飞鸽专用：tab 切换后等待页面加载并触发诊断
        if (result.tabSwitched) {
          this.lastUnreadClickAt = Date.now();
          const suppressEnd = Date.now() + WebviewClient.UNREAD_CLICK_LOAD_MS + 500;
          this.suppressUntil = suppressEnd;
          try {
            await this.webContents.executeJavaScript(`window.__feigeSuppressUntil = ${suppressEnd};`);
          } catch {}
          this.logger?.info({ platform: this.platformId }, '扫描器: 已切换到"最近联系"标签页，等待会话列表加载');
          await new Promise<void>((r) => {
            const t = setTimeout(r, WebviewClient.UNREAD_CLICK_LOAD_MS);
            t.unref?.();
          });
          void this.diagnosePage();
          return;
        }
        if (result.found && typeof result.x === 'number' && typeof result.y === 'number') {
          clicked = true;
          hadUnread = !!result.hadUnread;
          this.logger?.info({ platform: this.platformId, x: result.x, y: result.y, reason: result.reason, hadUnread }, '人工点击会话');
          await this.humanClick(result.x, result.y);
        } else {
          this.logger?.debug({ platform: this.platformId, reason: result.reason, hadUnread: result.hadUnread }, '扫描器: 未找到可点击会话(活跃模式)');
        }
      }

      if (clicked) {
        this.lastUnreadClickAt = Date.now();
        const suppressEnd = Date.now() + WebviewClient.UNREAD_CLICK_LOAD_MS + 500;
        this.suppressUntil = suppressEnd;
        try {
          await this.webContents.executeJavaScript(`window.__feigeSuppressUntil = ${suppressEnd};`);
        } catch {}
        this.logger?.info({ platform: this.platformId, hadUnread }, '已点击会话，等待聊天区域加载');
        await new Promise<void>((r) => {
          const t = setTimeout(r, WebviewClient.UNREAD_CLICK_LOAD_MS);
          t.unref?.();
        });
        try {
          // Regardless of whether the platform exposes an unread badge, only
          // process the latest visible buyer message after the conversation loads.
          const raw = await this.webContents.executeJavaScript(this.buildDrainAndProcessLastBuyerScript());
          if (raw) {
            try {
              const msgs = JSON.parse(raw as string) as RawMessage[];
              if (Array.isArray(msgs) && msgs.length > 0) {
                this.logger?.info(
                  {
                    platform: this.platformId,
                    msgCount: msgs.length,
                    fromValues: msgs.map((m) => m.from),
                    texts: msgs.map((m) => (m.text || '').substring(0, 30)),
                  },
                  '扫描器: 检测到未回复买家消息',
                );
                for (const m of msgs) {
                  if (!m || typeof m.text !== 'string' || typeof m.sessionId !== 'string') continue;
                  const msg: FeigeMessage = {
                    sessionId: m.sessionId,
                    from: m.from as MessageFrom,
                    text: m.text,
                    timestamp: m.timestamp,
                    messageId: m.messageId,
                    productId: m.productId,
                  };
                  if (this.messageHandler) {
                    this.messageHandler(msg);
                  } else {
                    this.messageBuffer.push(msg);
                  }
                }
              }
            } catch {}
          }
          this.logger?.info({ platform: this.platformId, hadUnread }, '已检查会话最新消息，等待处理');
        } catch {}
      }
    } finally {
      this.unreadScanInFlight = false;
    }
  }

  private async typeChar(ch: string): Promise<void> {
    if (ch === '\n' || ch === '\r' || ch === '\t') {
      // 特殊字符不能作为 keyCode 直接发送，避免 sendInputEvent 抛错
      return;
    }
    await this.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch, text: ch });
    await this.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
  }

  // ============ 人工模拟点击 ============

  private delay(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      t.unref?.();
    });
  }

  /**
   * 模拟鼠标移动：分步移动到目标位置，带 easeInOutQuad 缓动和随机抖动
   */
  private async humanMouseMove(targetX: number, targetY: number): Promise<void> {
    const steps = 6 + Math.floor(Math.random() * 5);
    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      const eased = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      const jitterX = (Math.random() - 0.5) * 3;
      const jitterY = (Math.random() - 0.5) * 3;
      await this.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(targetX * eased + jitterX),
        y: Math.round(targetY * eased + jitterY),
      });
      await this.delay(8 + Math.random() * 20);
    }
  }

  /**
   * 模拟人工点击：移动鼠标到目标位置，按下并释放
   */
  async humanClick(x: number, y: number): Promise<void> {
    await this.humanMouseMove(x, y);
    await this.delay(50 + Math.random() * 100);
    await this.webContents.sendInputEvent({
      type: 'mouseDown',
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      clickCount: 1,
    });
    await this.delay(30 + Math.random() * 70);
    await this.webContents.sendInputEvent({
      type: 'mouseUp',
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      clickCount: 1,
    });
  }

  /**
   * 查找元素位置（支持 iframe 内元素），返回页面绝对坐标
   */
  private async findElementPosition(finderScript: string): Promise<{ x: number; y: number } | null> {
    try {
      const raw = await this.webContents.executeJavaScript(finderScript);
      if (!raw) return null;
      const pos = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!pos || !pos.found) return null;
      return { x: pos.x, y: pos.y };
    } catch {
      return null;
    }
  }

  /**
   * 在飞鸽客服页面中为当前会话的订单添加/修改备注
   *
   * 飞鸽真实 UI 结构（2026-07-21 调研确认）：
   * - 入口：会话面板顶部"添加备注" SPAN 按钮（cls 含 VrCnnilt0ZKyVxxUhlvv，x≈488, y≈62）
   * - 点击后弹出右侧抽屉（auxo-drawer-content-wrapper，x≈1024，w≈412）
   * - 备注输入框：textarea，placeholder="请输入买家备注"，cls="auxo-input"
   * - 保存按钮：SPAN 文本"保存"（在抽屉底部）
   * - 取消按钮：SPAN 文本"取消"
   * - 字数限制：500 字符
   *
   * 支持两种模式：
   * - 'append'（默认）：保留已有备注，将新备注追加到末尾（避免覆盖）
   * - 'replace'：清空已有备注后写入新备注（仅在买家明确要求修改时使用）
   *
   * 实现：JS 定位元素坐标 + sendInputEvent 真实键盘/鼠标事件
   *
   * 流程：
   * 1. 点击"添加备注"按钮打开抽屉
   * 2. 定位 placeholder="请输入买家备注" 的 textarea，返回坐标
   * 3. sendInputEvent 点击该坐标激活输入框
   * 4. 读取已有备注内容
   * 5. 根据 mode 计算最终备注内容（append 追加 / replace 替换）
   * 6. 清空已有内容 + 逐字输入最终备注（截断到 500 字符）
   * 7. 定位"保存"按钮坐标，sendInputEvent 点击保存
   * 8. 发送 Esc 关闭抽屉
   *
   * 返回 { success: boolean; error?: string; diag?: string; existingRemark?: string }
   */
  async addOrderRemark(
    remark: string,
    mode: 'append' | 'replace' = 'append',
  ): Promise<{ success: boolean; error?: string; diag?: string; existingRemark?: string }> {
    if (!this.webContents || this.webContents.isDestroyed()) {
      return { success: false, error: 'WebContents 不可用' };
    }
    if (!this.connected) {
      return { success: false, error: 'Webview 未连接' };
    }

    // 新备注内容（截断到 500 字符，飞鸽备注字数限制 0/500）
    const newRemark = remark.slice(0, 500);

    try {
      // ===== 步骤1：点击"添加备注"按钮打开抽屉 =====
      this.logger?.info({ platform: this.platformId }, '点击"添加备注"按钮打开备注抽屉');
      const openDrawerResult = (await this.webContents.executeJavaScript(`(function(){
        function visible(el){
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }
        function ownText(el){
          var t = '';
          for (var i = 0; i < el.childNodes.length; i++) {
            if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].textContent || '';
          }
          return t.trim();
        }
        // 先检查抽屉是否已打开（避免重复点击）
        var existingDrawer = document.querySelector('.auxo-drawer-content-wrapper');
        if (existingDrawer) {
          var er = existingDrawer.getBoundingClientRect();
          if (er.width > 0 && er.height > 0) {
            return { ok: true, alreadyOpen: true, x: Math.round(er.left + er.width/2), y: Math.round(er.top + er.height/2) };
          }
        }
        // 找"添加备注"按钮
        var els = document.querySelectorAll('span, div, a, button, li');
        for (var i = 0; i < els.length; i++) {
          var e = els[i];
          if (!visible(e)) continue;
          if (e.children.length > 0) continue;
          var t = ownText(e);
          // 匹配"添加备注"（无备注时）/"修改备注"/"编辑备注"（有备注时）/含"备注"的按钮
          if (t === '添加备注' || t === '修改备注' || t === '编辑备注' ||
              (t.indexOf('备注') >= 0 && t.length <= 8)) {
            var r = e.getBoundingClientRect();
            return {
              ok: true,
              alreadyOpen: false,
              x: Math.round(r.left + r.width/2),
              y: Math.round(r.top + r.height/2),
              cls: (e.className || '').toString().slice(0, 60),
              tag: e.tagName,
              buttonText: t
            };
          }
        }
        return { ok: false, reason: 'no-add-remark-button' };
      })()`)) as { ok: boolean; alreadyOpen?: boolean; x?: number; y?: number; cls?: string; tag?: string; reason?: string };

      if (!openDrawerResult.ok || !openDrawerResult.x || !openDrawerResult.y) {
        return { success: false, error: '未找到"添加备注"按钮' };
      }

      if (!openDrawerResult.alreadyOpen) {
        this.logger?.info(
          { platform: this.platformId, x: openDrawerResult.x, y: openDrawerResult.y, cls: openDrawerResult.cls, tag: openDrawerResult.tag },
          '已定位"添加备注"按钮，sendInputEvent 点击',
        );
        // 先移动鼠标到按钮位置（触发 hover 效果，部分 UI 需要 mouseMove 才响应 click）
        await this.webContents.sendInputEvent({ type: 'mouseMove', x: openDrawerResult.x, y: openDrawerResult.y });
        await new Promise((r) => setTimeout(r, 100));
        // 用 sendInputEvent 真实点击
        await this.webContents.sendInputEvent({ type: 'mouseDown', x: openDrawerResult.x, y: openDrawerResult.y, button: 'left', clickCount: 1 });
        await new Promise((r) => setTimeout(r, 80));
        await this.webContents.sendInputEvent({ type: 'mouseUp', x: openDrawerResult.x, y: openDrawerResult.y, button: 'left', clickCount: 1 });
        // 等待抽屉滑出动画（初始等待）
        await new Promise((r) => setTimeout(r, 1200));

        // 诊断：检查抽屉是否打开
        const drawerCheck = (await this.webContents.executeJavaScript(`(function(){
          var drawer = document.querySelector('.auxo-drawer-content-wrapper')
                   || document.querySelector('.auxo-drawer-content')
                   || document.querySelector('.auxo-drawer.auxo-drawer-open')
                   || document.querySelector('.auxo-drawer');
          var mask = document.querySelector('.auxo-drawer-mask');
          var allTextareas = document.querySelectorAll('textarea');
          var taInfo = [];
          for (var i = 0; i < allTextareas.length && i < 5; i++) {
            var r = allTextareas[i].getBoundingClientRect();
            taInfo.push({
              id: allTextareas[i].id || '',
              ph: allTextareas[i].placeholder || '',
              cls: (allTextareas[i].className || '').toString().slice(0, 40),
              visible: r.width > 0 && r.height > 0,
              w: Math.round(r.width),
              h: Math.round(r.height),
              x: Math.round(r.left),
              y: Math.round(r.top)
            });
          }
          // 诊断：dump 抽屉内容（前 500 字符）和所有含"备注"文字的元素
          var drawerHtml = '';
          var drawerTexts = [];
          if (drawer) {
            drawerHtml = (drawer.innerHTML || '').replace(/\\s+/g, ' ').slice(0, 500);
            var drawerEls = drawer.querySelectorAll('*');
            for (var j = 0; j < drawerEls.length && drawerTexts.length < 15; j++) {
              var t = (drawerEls[j].textContent || '').trim();
              if (t.length > 0 && t.length <= 30) {
                drawerTexts.push({
                  tag: drawerEls[j].tagName,
                  cls: (drawerEls[j].className || '').toString().slice(0, 30),
                  text: t
                });
              }
            }
          }
          // 检查是否有 shadow DOM
          var shadowCount = 0;
          if (drawer) {
            var allEls = drawer.querySelectorAll('*');
            for (var k = 0; k < allEls.length; k++) {
              if (allEls[k].shadowRoot) shadowCount++;
            }
          }
          return {
            drawerExists: !!drawer,
            drawerClass: drawer ? (drawer.className || '').toString().slice(0, 80) : '',
            maskExists: !!mask,
            textareaCount: allTextareas.length,
            textareas: taInfo,
            drawerTexts: drawerTexts,
            shadowCount: shadowCount,
            drawerHtmlPreview: drawerHtml
          };
        })()`)) as { drawerExists: boolean; drawerClass: string; maskExists: boolean; textareaCount: number; textareas: Array<unknown>; drawerTexts: Array<unknown>; shadowCount: number; drawerHtmlPreview: string };

        this.logger?.info(
          {
            platform: this.platformId,
            drawerExists: drawerCheck.drawerExists,
            drawerClass: drawerCheck.drawerClass,
            maskExists: drawerCheck.maskExists,
            textareaCount: drawerCheck.textareaCount,
            textareas: drawerCheck.textareas,
            drawerTexts: drawerCheck.drawerTexts,
            shadowCount: drawerCheck.shadowCount,
            drawerHtmlPreview: drawerCheck.drawerHtmlPreview,
          },
          '点击"添加备注"后抽屉诊断',
        );

        // 如果 sendInputEvent 点击没打开抽屉，用 JS click 兜底
        if (!drawerCheck.drawerExists && !drawerCheck.maskExists) {
          this.logger?.warn({ platform: this.platformId }, 'sendInputEvent 点击未打开抽屉，尝试 JS click 兜底');
          const jsClickResult = (await this.webContents.executeJavaScript(`(function(){
            function visible(el){
              var r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            }
            function ownText(el){
              var t = '';
              for (var i = 0; i < el.childNodes.length; i++) {
                if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].textContent || '';
              }
              return t.trim();
            }
            var els = document.querySelectorAll('span, div, a, button');
            for (var i = 0; i < els.length; i++) {
              var e = els[i];
              if (!visible(e)) continue;
              if (e.children.length > 0) continue;
              var t = ownText(e);
              if (t === '添加备注' || t === '修改备注' || t === '编辑备注') {
                e.click();
                return { clicked: true, tag: e.tagName, cls: (e.className || '').toString().slice(0, 40), text: t };
              }
            }
            return { clicked: false };
          })()`)) as { clicked: boolean; tag?: string; cls?: string; text?: string };
          this.logger?.info({ platform: this.platformId, result: jsClickResult }, 'JS click 兜底结果');
          // 等待抽屉动画
          await new Promise((r) => setTimeout(r, 1500));
        }
      } else {
        this.logger?.info({ platform: this.platformId }, '备注抽屉已打开，跳过点击');
      }

      // ===== 步骤2：定位备注输入框（轮询搜索，给抽屉渲染时间） =====
      let locateResult: { found: boolean; x?: number; y?: number; tag?: string; placeholder?: string; cls?: string } = { found: false };
      const locateScript = `(function(){
        function visible(el){
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }
        // 策略A：placeholder 匹配"买家备注"或"备注"
        var textareas = document.querySelectorAll('textarea');
        for (var i = 0; i < textareas.length; i++) {
          var ta = textareas[i];
          if (!visible(ta)) continue;
          var ph = ta.placeholder || '';
          if (ph.indexOf('买家备注') >= 0 || ph.indexOf('备注') >= 0) {
            var r = ta.getBoundingClientRect();
            return {
              found: true,
              x: Math.round(r.left + r.width/2),
              y: Math.round(r.top + r.height/2),
              tag: ta.tagName,
              placeholder: ph,
              cls: (ta.className || '').toString().slice(0, 80),
              w: Math.round(r.width),
              h: Math.round(r.height)
            };
          }
        }
        // 策略B：在抽屉内找任意 textarea（多选择器兼容）
        var drawer = document.querySelector('.auxo-drawer-content-wrapper')
                   || document.querySelector('.auxo-drawer-content')
                   || document.querySelector('.auxo-drawer.auxo-drawer-open')
                   || document.querySelector('.auxo-drawer');
        if (drawer) {
          var drawerTas = drawer.querySelectorAll('textarea');
          for (var j = 0; j < drawerTas.length; j++) {
            if (!visible(drawerTas[j])) continue;
            var r2 = drawerTas[j].getBoundingClientRect();
            return {
              found: true,
              x: Math.round(r2.left + r2.width/2),
              y: Math.round(r2.top + r2.height/2),
              tag: drawerTas[j].tagName,
              placeholder: drawerTas[j].placeholder || '',
              cls: (drawerTas[j].className || '').toString().slice(0, 80),
              w: Math.round(r2.width),
              h: Math.round(r2.height)
            };
          }
        }
        // 检测组件是否正在渲染中（Garfish 微前端异步加载）
        var rendering = false;
        var renderDrawer = document.querySelector('.auxo-drawer-content-wrapper')
                        || document.querySelector('.auxo-drawer-content')
                        || document.querySelector('.auxo-drawer');
        if (renderDrawer) {
          var renderText = (renderDrawer.textContent || '');
          if (renderText.indexOf('组件渲染中') >= 0 || renderText.indexOf('渲染中') >= 0 || renderText.indexOf('加载中') >= 0) {
            rendering = true;
          }
        }
        return { found: false, rendering: rendering };
      })()`;
      // 轮询搜索输入框（最多 20 秒，每 500ms 检查一次，兼容 Garfish 微前端异步加载）
      let pollRenderingLogged = false;
      for (let pollI = 0; pollI < 40; pollI++) {
        const pollResult = (await this.webContents.executeJavaScript(locateScript)) as typeof locateResult & { rendering?: boolean };
        locateResult = pollResult;
        if (locateResult.found) {
          if (pollRenderingLogged) {
            this.logger?.info({ platform: this.platformId, pollCount: pollI + 1, elapsedMs: (pollI + 1) * 500 }, '备注输入框已渲染完成（组件加载完毕）');
          }
          break;
        }
        // 如果组件正在渲染中，记录一次日志
        if (pollResult.rendering && !pollRenderingLogged) {
          this.logger?.info({ platform: this.platformId }, '备注组件正在渲染中（Garfish 微前端加载），继续等待...');
          pollRenderingLogged = true;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      if (!locateResult.found || !locateResult.x || !locateResult.y) {
        // 关闭抽屉后返回
        void this.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        void this.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        return { success: false, error: '点击"添加备注"后未找到备注输入框' };
      }

      this.logger?.info(
        { platform: this.platformId, x: locateResult.x, y: locateResult.y, ph: locateResult.placeholder, cls: locateResult.cls },
        '已定位备注输入框坐标',
      );

      // ===== 步骤3：sendInputEvent 点击输入框激活 =====
      await this.webContents.sendInputEvent({ type: 'mouseDown', x: locateResult.x, y: locateResult.y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 50));
      await this.webContents.sendInputEvent({ type: 'mouseUp', x: locateResult.x, y: locateResult.y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 400));

      // ===== 步骤4：读取已有备注内容 =====
      const existingRemarkResult = (await this.webContents.executeJavaScript(`(function(){
        function visible(el){
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }
        var textareas = document.querySelectorAll('textarea');
        for (var i = 0; i < textareas.length; i++) {
          var ta = textareas[i];
          if (!visible(ta)) continue;
          var ph = ta.placeholder || '';
          if (ph.indexOf('买家备注') >= 0 || ph.indexOf('备注') >= 0) {
            return { found: true, value: ta.value || '' };
          }
        }
        // 回退：抽屉内任意 textarea
        var drawer = document.querySelector('.auxo-drawer-content-wrapper');
        if (drawer) {
          var drawerTas = drawer.querySelectorAll('textarea');
          for (var j = 0; j < drawerTas.length; j++) {
            if (!visible(drawerTas[j])) continue;
            return { found: true, value: drawerTas[j].value || '' };
          }
        }
        return { found: false, value: '' };
      })()`)) as { found: boolean; value: string };

      const existingRemark = existingRemarkResult.value || '';

      // ===== 步骤5：根据 mode 计算最终备注内容 =====
      // append 模式：保留已有备注，追加新备注（用分号分隔）
      // replace 模式：直接使用新备注（覆盖已有）
      let finalRemark: string;
      if (mode === 'append' && existingRemark.trim().length > 0) {
        // 已有备注 + 分隔符 + 新备注，截断到 500 字符
        const separator = existingRemark.endsWith(';') || existingRemark.endsWith('；') ? ' ' : '; ';
        finalRemark = (existingRemark + separator + newRemark).slice(0, 500);
      } else {
        // replace 模式或已有备注为空：使用新备注
        finalRemark = newRemark;
      }

      this.logger?.info(
        {
          platform: this.platformId,
          mode,
          existingRemarkPreview: existingRemark.slice(0, 80),
          existingRemarkLength: existingRemark.length,
          newRemarkPreview: newRemark.slice(0, 80),
          finalRemarkPreview: finalRemark.slice(0, 80),
          finalRemarkLength: finalRemark.length,
        },
        '备注模式决策',
      );

      // 清空已有内容（Ctrl+A 全选 + Delete 删除）
      void this.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: ['control'] });
      void this.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: ['control'] });
      await new Promise((r) => setTimeout(r, 150));
      void this.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' });
      void this.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' });
      await new Promise((r) => setTimeout(r, 200));

      // ===== 步骤6：逐字输入最终备注内容（真实键盘事件） =====
      for (const ch of finalRemark) {
        void this.webContents.sendInputEvent({ type: 'char', keyCode: ch });
        await new Promise((r) => setTimeout(r, 30));
      }
      await new Promise((r) => setTimeout(r, 500));

      // ===== 步骤7：定位"保存"按钮并点击 =====
      const saveBtnResult = (await this.webContents.executeJavaScript(`(function(){
        function visible(el){
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }
        function ownText(el){
          var t = '';
          for (var i = 0; i < el.childNodes.length; i++) {
            if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].textContent || '';
          }
          return t.trim();
        }
        // 抽屉容器选择器：依次尝试多种选择器
        var drawer = document.querySelector('.auxo-drawer-content-wrapper')
                  || document.querySelector('.auxo-drawer-content')
                  || document.querySelector('.auxo-drawer.auxo-drawer-open')
                  || document.querySelector('.auxo-drawer');
        if (!drawer) {
          // 诊断：列出页面上所有含"保存"/"确定"文字的可点击元素
          var diag = [];
          var all = document.querySelectorAll('span, div, button, a');
          for (var k = 0; k < all.length && diag.length < 10; k++) {
            var ae = all[k];
            if (!visible(ae)) continue;
            var at = (ae.textContent || '').trim();
            if (at === '保存' || at === '确定' || at === '确认' || at === '提交' || at === '保存备注') {
              var ar = ae.getBoundingClientRect();
              diag.push({
                tag: ae.tagName,
                cls: (ae.className || '').toString().slice(0, 80),
                text: at.slice(0, 20),
                x: Math.round(ar.left + ar.width/2),
                y: Math.round(ar.top + ar.height/2),
                parentCls: ae.parentElement ? (ae.parentElement.className || '').toString().slice(0, 60) : ''
              });
            }
          }
          return { found: false, reason: 'no-drawer', diag: diag };
        }
        // 策略A：在抽屉内精确匹配"保存"等文字（用 textContent 兼容嵌套结构）
        var els = drawer.querySelectorAll('span, div, button, a, li');
        var candidates = [];
        for (var i = 0; i < els.length; i++) {
          var e = els[i];
          if (!visible(e)) continue;
          // 用 textContent 而非 ownText，兼容文字嵌套在子元素中的情况
          var t = (e.textContent || '').trim();
          // 先用 ownText 精确匹配（避免误匹配大块容器）
          var ot = ownText(e);
          if (ot === '保存' || ot === '确定' || ot === '确认' || ot === '提交' || ot === '保存备注') {
            var r = e.getBoundingClientRect();
            return {
              found: true,
              x: Math.round(r.left + r.width/2),
              y: Math.round(r.top + r.height/2),
              text: ot,
              cls: (e.className || '').toString().slice(0, 60),
              tag: e.tagName,
              strategy: 'ownText-exact'
            };
          }
          // textContent 精确匹配（兜底，文字可能在子 span 中）
          if (t === '保存' || t === '确定' || t === '确认' || t === '提交' || t === '保存备注') {
            candidates.push({
              tag: e.tagName,
              cls: (e.className || '').toString().slice(0, 60),
              text: t,
              x: Math.round((e.getBoundingClientRect().left + e.getBoundingClientRect().width/2)),
              y: Math.round((e.getBoundingClientRect().top + e.getBoundingClientRect().height/2))
            });
          }
        }
        // 策略B：如果有 textContent 精确匹配的候选，取第一个
        if (candidates.length > 0) {
          var c = candidates[0];
          return { found: true, x: c.x, y: c.y, text: c.text, cls: c.cls, tag: c.tag, strategy: 'textContent-exact' };
        }
        // 策略C：查找抽屉内的 primary 按钮（auxo-btn-primary 通常是保存/确认按钮）
        var primaryBtn = drawer.querySelector('.auxo-btn-primary, button[type="submit"], .auxo-btn-primary:not([disabled])');
        if (primaryBtn && visible(primaryBtn)) {
          var pr = primaryBtn.getBoundingClientRect();
          return {
            found: true,
            x: Math.round(pr.left + pr.width/2),
            y: Math.round(pr.top + pr.height/2),
            text: (primaryBtn.textContent || '').trim().slice(0, 20),
            cls: (primaryBtn.className || '').toString().slice(0, 60),
            tag: primaryBtn.tagName,
            strategy: 'primary-btn'
          };
        }
        // 诊断：列出抽屉内所有可点击元素文字
        var drawerDiag = [];
        var drawerEls = drawer.querySelectorAll('span, div, button, a');
        for (var j = 0; j < drawerEls.length && drawerDiag.length < 20; j++) {
          var de = drawerEls[j];
          if (!visible(de)) continue;
          var dt = (de.textContent || '').trim();
          if (dt.length > 0 && dt.length <= 20) {
            drawerDiag.push({
              tag: de.tagName,
              cls: (de.className || '').toString().slice(0, 40),
              text: dt,
              x: Math.round(de.getBoundingClientRect().left),
              y: Math.round(de.getBoundingClientRect().top)
            });
          }
        }
        return { found: false, reason: 'no-save-button', drawerDiag: drawerDiag };
      })()`)) as { found: boolean; x?: number; y?: number; text?: string; cls?: string; tag?: string; reason?: string; strategy?: string; diag?: Array<unknown>; drawerDiag?: Array<unknown> };

      if (!saveBtnResult.found || !saveBtnResult.x || !saveBtnResult.y) {
        // 诊断日志：输出找不到保存按钮的详细信息
        this.logger?.warn(
          {
            platform: this.platformId,
            reason: saveBtnResult.reason,
            strategy: saveBtnResult.strategy,
            diag: saveBtnResult.diag,
            drawerDiag: saveBtnResult.drawerDiag,
          },
          '未找到保存按钮（已输出诊断信息），尝试 Ctrl+Enter 提交',
        );
        // 尝试 Ctrl+Enter 提交
        void this.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['control'] });
        void this.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['control'] });
        await new Promise((r) => setTimeout(r, 800));
      } else {
        this.logger?.info(
          { platform: this.platformId, x: saveBtnResult.x, y: saveBtnResult.y, text: saveBtnResult.text, cls: saveBtnResult.cls, tag: saveBtnResult.tag },
          '点击保存按钮',
        );
        // 用 sendInputEvent 真实点击保存按钮
        await this.webContents.sendInputEvent({ type: 'mouseDown', x: saveBtnResult.x, y: saveBtnResult.y, button: 'left', clickCount: 1 });
        await new Promise((r) => setTimeout(r, 50));
        await this.webContents.sendInputEvent({ type: 'mouseUp', x: saveBtnResult.x, y: saveBtnResult.y, button: 'left', clickCount: 1 });
        await new Promise((r) => setTimeout(r, 1000));
      }

      // ===== 步骤8：发送 Esc 关闭可能残留的抽屉 =====
      void this.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      void this.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await new Promise((r) => setTimeout(r, 500));

      this.logger?.info(
        { platform: this.platformId, mode, remark: finalRemark, existingRemarkPreview: existingRemark.slice(0, 80) },
        '订单备注操作完成',
      );
      return { success: true, existingRemark };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.logger?.warn({ platform: this.platformId, err: errorMsg }, '添加订单备注失败');
      return { success: false, error: errorMsg };
    }
  }

  /**
   * 等待条件成立（轮询）
   * @param condFn 条件检查函数（返回 boolean 或 Promise<boolean>）
   * @param timeoutMs 总超时
   * @param intervalMs 轮询间隔
   */
  private async waitForCondition(
    condFn: () => Promise<boolean>,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if (await condFn()) return true;
      } catch {
        // 忽略单个轮询的错误
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }

  /**
   * 智能转接到指定客服专员
   *
   * 执行流程：
   * 1. 检查 transfer 图标是否存在（在线会话才有）
   * 2. 点击 i-icon-transfer 图标弹出抽屉
   * 3. 等待抽屉加载（含"转接会话"文本）
   * 4. 在搜索框输入目标客服账号名
   * 5. 等待搜索结果出现，点击匹配项
   * 6. 在备注输入框输入转接原因
   * 7. 点击确认按钮提交
   * 8. 验证转接成功
   *
   * 失败降级：
   * - transfer 图标不存在 → 返回 {ok:false, reason:'no-transfer-icon'}（留言会话不支持转接）
   * - 搜索不到目标客服 → 返回 {ok:false, reason:'agent-not-found'}
   * - 抽屉加载超时 → 返回 {ok:false, reason:'drawer-load-timeout'}
   * - 确认按钮点击失败 → 返回 {ok:false, reason:'confirm-failed'}
   *
   * @param agentName 目标飞鸽客服账号名（如"客服晓晓"）
   * @param remark 转接备注（可选，≤200 字）
   * @returns { ok: boolean; reason?: string; detail?: string }
   */
  async transferToAgent(
    agentName?: string,
    remark?: string,
  ): Promise<{ ok: boolean; reason?: string; detail?: string; drawerInfo?: unknown }> {
    if (!this.webContents || this.webContents.isDestroyed()) {
      return { ok: false, reason: 'webContents-unavailable' };
    }
    if (!this.connected) {
      return { ok: false, reason: 'not-connected' };
    }
    // agentName 为空时表示"转移到任意在线客服"（不指定具体客服名）
    const trimmedAgentName = (agentName || '').trim();
    this.logger?.info(
      { platform: this.platformId, agentName: trimmedAgentName || '(any-online)', remark },
      '开始执行飞鸽转接',
    );

    // 暂停扫描器：transferToAgent 执行期间禁止扫描器点击会话列表项，
    // 否则 React 重新渲染会关闭转接抽屉导致步骤 5 找不到抽屉
    this.transferInProgress = true;
    try {
      // 步骤 1：检查 transfer 图标是否存在（在线会话才有）
      const iconCheck = (await this.webContents.executeJavaScript(`(function(){
        var icons = document.querySelectorAll('[class*="i-icon-transfer"]');
        if (icons.length === 0) return { ok: false, reason: 'no-transfer-icon' };
        var r = icons[0].getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return { ok: false, reason: 'icon-not-visible' };
        var x = Math.round(r.left + r.width/2);
        var y = Math.round(r.top + r.height/2);
        return { ok: true, x: x, y: y };
      })()`)) as { ok: boolean; reason?: string; x?: number; y?: number };
      if (!iconCheck?.ok) {
        this.logger?.warn({ platform: this.platformId, reason: iconCheck?.reason }, 'transfer 图标不可用（可能为留言会话）');
        return { ok: false, reason: iconCheck?.reason ?? 'icon-check-failed' };
      }

      // 步骤 2：点击 transfer 图标
      // 使用 PointerEvent + MouseEvent 直接派发（实测 dispatchEvent 可触发 React onClick）
      await this.webContents.executeJavaScript(`(function(){
        var icons = document.querySelectorAll('[class*="i-icon-transfer"]');
        if (icons.length === 0) return false;
        var target = icons[0];
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: 0, clientY: 0 }));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 1500));

      // 步骤 3：等待抽屉加载（最多 8 秒，每 500ms 轮询一次，检查"转接会话"文本出现）
      const drawerReady = await this.waitForCondition(async () => {
        const result = await this.webContents!.executeJavaScript(`(function(){
          var divs = document.querySelectorAll('div');
          var vh = window.innerHeight, vw = window.innerWidth;
          for (var j = 0; j < divs.length; j++) {
            var r = divs[j].getBoundingClientRect();
            if (r.width < 200 || r.height < 100 || r.width > 1000) continue;
            // 抽屉必须在视口内可见（避免匹配到滚出视口的聊天面板容器）
            if (r.top < 0 || r.bottom > vh + 50 || r.left < -50 || r.right > vw + 50) continue;
            var t = (divs[j].innerText || '').trim();
            if (t.indexOf('转接会话') >= 0 && t.length < 3000) return true;
          }
          return false;
        })()`);
        return Boolean(result);
      }, 8000, 500);

      if (!drawerReady) {
        this.logger?.warn({ platform: this.platformId }, '转接抽屉加载超时');
        return { ok: false, reason: 'drawer-load-timeout' };
      }
      await new Promise((r) => setTimeout(r, 800)); // 抽屉内部元素加载缓冲

      // 步骤 4：在搜索框输入目标客服账号名（空 agentName 时跳过搜索，直接进入步骤 5）
      const trimmedAgentName = (agentName || '').trim();
      if (trimmedAgentName.length > 0) {
        const searchInputScript = `(function(){
          // 找含"转接会话"文本的抽屉容器
          var drawer = null;
          var divs = document.querySelectorAll('div');
          for (var j = 0; j < divs.length; j++) {
            var r = divs[j].getBoundingClientRect();
            if (r.width < 200 || r.height < 100 || r.width > 1000) continue;
            var t = (divs[j].innerText || '').trim();
            if (t.indexOf('转接会话') >= 0 && t.length < 3000) { drawer = divs[j]; break; }
          }
          if (!drawer) return { ok: false, reason: 'drawer-not-found' };

          // 策略A：在抽屉中查找 input（搜索框 placeholder 通常含"搜索"/"客服"/"输入"）
          var inputs = drawer.querySelectorAll('input, textarea');
          var searchInput = null;
          for (var k = 0; k < inputs.length; k++) {
            var ph = (inputs[k].placeholder || '').toLowerCase();
            var r2 = inputs[k].getBoundingClientRect();
            if (r2.width === 0) continue;
            if (ph.indexOf('搜索') >= 0 || ph.indexOf('客服') >= 0 || ph.indexOf('输入') >= 0) {
              searchInput = inputs[k];
              break;
            }
          }
          // 策略B：取抽屉中第一个可见的 input
          if (!searchInput) {
            for (var m = 0; m < inputs.length; m++) {
              var r3 = inputs[m].getBoundingClientRect();
              if (r3.width > 0) { searchInput = inputs[m]; break; }
            }
          }
          if (!searchInput) return { ok: false, reason: 'no-search-input' };

          // 用 React 兼容方式赋值（触发 onChange）
          var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
            || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          nativeSetter.call(searchInput, ${JSON.stringify(trimmedAgentName)});
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          searchInput.dispatchEvent(new Event('change', { bubbles: true }));
          searchInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
          return { ok: true };
        })()`;
        const searchResult = (await this.webContents.executeJavaScript(searchInputScript)) as { ok: boolean; reason?: string };
        if (!searchResult?.ok) {
          this.logger?.warn({ platform: this.platformId, reason: searchResult?.reason }, '搜索框输入失败（继续尝试直接选择在线客服）');
          // 不直接返回失败，继续尝试步骤 5 直接选择列表中第一个在线客服
        } else {
          // 搜索成功，等待搜索结果出现
          await new Promise((r) => setTimeout(r, 1500));
        }
      } else {
        // 空 agentName：等待抽屉默认加载在线客服列表
        this.logger?.info({ platform: this.platformId }, '未指定目标客服账号名，将选择列表中第一个在线客服');
        await new Promise((r) => setTimeout(r, 1200));
      }

      // 步骤 5：点击匹配的客服项（找不到指定客服时回退到列表第一个在线客服）
      const selectResult = (await this.webContents.executeJavaScript(`(async function(){
        var drawer = null;
        var divs = document.querySelectorAll('div');
        var vh = window.innerHeight, vw = window.innerWidth;
        for (var j = 0; j < divs.length; j++) {
          var r = divs[j].getBoundingClientRect();
          if (r.width < 200 || r.height < 100 || r.width > 1000) continue;
          // 抽屉必须在视口内可见（避免匹配到滚出视口的聊天面板容器）
          if (r.top < 0 || r.bottom > vh + 50 || r.left < -50 || r.right > vw + 50) continue;
          var t = (divs[j].innerText || '').trim();
          if (t.indexOf('转接会话') >= 0 && t.length < 3000) { drawer = divs[j]; break; }
        }
        if (!drawer) return { ok: false, reason: 'drawer-not-found' };

        // 取元素的直接文本节点内容（不含子元素的文本）
        // 飞鸽抽屉的 div.innerText 会聚合所有后代文本，无法用来识别单个客服项
        function getOwnText(el) {
          var text = '';
          for (var i = 0; i < el.childNodes.length; i++) {
            var n = el.childNodes[i];
            if (n.nodeType === 3) text += n.textContent;
          }
          return text.trim();
        }

        // 判断元素是否为"纯文本元素"（非容器）
        // 容器元素的 innerText 会包含所有子元素的文本，远长于 getOwnText
        // 纯文本元素的 innerText ≈ getOwnText（差异 <= 3 字符）
        function isPureText(el) {
          var own = getOwnText(el).replace(/\\s+/g, '');
          var full = ((el.innerText || '').replace(/\\s+/g, '')).trim();
          return full.length <= own.length + 3;
        }

        // 用真实坐标模拟用户点击（避免合成事件 clientX=0 被忽略）
        function clickAt(el) {
          var r = el.getBoundingClientRect();
          var x = r.left + r.width / 2;
          var y = r.top + r.height / 2;
          var cfg = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
          el.dispatchEvent(new MouseEvent('mousedown', cfg));
          el.dispatchEvent(new MouseEvent('mouseup', cfg));
          el.dispatchEvent(new MouseEvent('click', cfg));
        }

        // 找客服项卡片元素：
        // 向上查找第一个具有 cursor:pointer 样式的祖先（React onClick 注册的元素）
        // 限制范围避免匹配到包含多个客服名的容器或整个 drawer
        function findClickableAncestor(el) {
          var candidateText = getOwnText(el);
          var cur = el;
          var chain = [];
          for (var i = 0; i < 10 && cur && cur !== drawer; i++) {
            var cr = cur.getBoundingClientRect();
            if (cr.width > 0 && cr.height > 0 && cr.height < 200 && cr.width < 800) {
              var cs = null;
              try { cs = getComputedStyle(cur); } catch(e) {}
              var isPointer = cs && cs.cursor === 'pointer';
              var curFull = ((cur.innerText || '').replace(/\\s+/g, '')).trim();
              chain.push({ tag: cur.tagName, cls: (cur.className || '').toString().slice(0, 40), cursor: cs ? cs.cursor : '?', w: Math.round(cr.width), h: Math.round(cr.height), pointer: isPointer, fullLen: curFull.length, ownLen: candidateText.length });
              if (isPointer) {
                // 优先返回 cursor:pointer 元素
                // 但要避免匹配到包含多个客服名的容器（innerText 远长于候选文本）
                if (curFull.length <= candidateText.length + 10) {
                  return { el: cur, chain: chain };
                }
                // 容器有 pointer 但包含多个客服名，继续向上找
              }
            }
            cur = cur.parentElement;
          }
          // 兜底：返回 el 本身
          return { el: el, chain: chain };
        }

        var agentName = ${JSON.stringify(trimmedAgentName)};
        var candidates = [];
        // 收集所有"纯文本元素"（非容器），用直接文本节点识别客服名
        var items = drawer.querySelectorAll('div, span, li, button, a');
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          var r2 = it.getBoundingClientRect();
          if (r2.width === 0 || r2.height === 0) continue;
          if (r2.top < 0 || r2.bottom > vh) continue;
          if (it.tagName === 'INPUT' || it.tagName === 'TEXTAREA') continue;
          // 排除聊天消息项
          var cls = (it.className || '').toString();
          if (cls.indexOf('msgItemWrap') >= 0 || cls.indexOf('messageIsMe') >= 0 || cls.indexOf('messageNotMe') >= 0) continue;
          // 用直接文本节点（不包含子元素的文本）
          var t = getOwnText(it);
          if (!t) continue;
          if (t.length > 50) continue;
          // 【纯度检查】排除容器元素：innerText 远长于 getOwnText 说明包含多个子元素的文本
          // 例如 DIV.rT2eijieC36mIyNb9EVQ 的 getOwnText="唯衣美服装工作室"(8字符) 但 innerText="唯衣美服装工作室唯衣美童装"(13字符)
          if (!isPureText(it)) continue;
          // 排除关键字
          if (t.indexOf('转接到') >= 0) continue;
          if (t === '取消' || t === '确认转接' || t === '确定' || t === '搜索') continue;
          if (t.indexOf('客服') === 0 && t.indexOf('工作室') < 0 && t.indexOf('专营') < 0) continue;
          // 排除时间格式
          if (/^\\d{1,2}:\\d{2}/.test(t)) continue;
          // 排除纯数字或 "0/99" 格式
          if (/^\\d+([\/／]\\d+)?$/.test(t)) continue;
          // 排除明显的 UI 标签（"最近联系"、"在线客服" 等）
          if (t === '最近联系' || t === '在线客服' || t === '全部客服') continue;
          candidates.push({ el: it, text: t, w: Math.round(r2.width), h: Math.round(r2.height) });
        }
        // 策略A：精确匹配客服名（如果有指定）
        // 不在 JS 里点击（合成 MouseEvent 的 isTrusted=false，React 不响应 onClick）
        // 返回坐标，由 TS 端用 sendInputEvent 模拟真实 OS 鼠标事件（isTrusted=true）
        if (agentName) {
          for (var k = 0; k < candidates.length; k++) {
            if (candidates[k].text === agentName || candidates[k].text.indexOf(agentName) >= 0) {
              var result = findClickableAncestor(candidates[k].el);
              var target = result.el;
              var tr = target.getBoundingClientRect();
              var cx = Math.round(tr.left + tr.width / 2);
              var cy = Math.round(tr.top + tr.height / 2);
              return { ok: true, needClick: true, clickX: cx, clickY: cy, clicked: candidates[k].text.slice(0, 40), method: 'name-match', clickChain: result.chain, targetCls: (target.className || '').toString().slice(0, 50), targetW: Math.round(tr.width), targetH: Math.round(tr.height) };
            }
          }
        }
        // 策略B：回退到第一个候选项（任意在线客服）
        if (candidates.length > 0) {
          var result0 = findClickableAncestor(candidates[0].el);
          var target0 = result0.el;
          var tr0 = target0.getBoundingClientRect();
          var cx0 = Math.round(tr0.left + tr0.width / 2);
          var cy0 = Math.round(tr0.top + tr0.height / 2);
          return { ok: true, needClick: true, clickX: cx0, clickY: cy0, clicked: candidates[0].text.slice(0, 40), method: 'first-online', requestedName: agentName, candidateCount: candidates.length, clickChain: result0.chain, targetCls: (target0.className || '').toString().slice(0, 50), targetW: Math.round(tr0.width), targetH: Math.round(tr0.height) };
        }
        // 诊断：输出 drawer 信息和内部可见元素，便于调整选择器
        var drawerRect = drawer.getBoundingClientRect();
        var diagElements = [];
        var allEls = drawer.querySelectorAll('*');
        for (var d = 0; d < allEls.length && diagElements.length < 40; d++) {
          var el = allEls[d];
          var er = el.getBoundingClientRect();
          if (er.width === 0 || er.height === 0) continue;
          if (er.top < 0 || er.bottom > vh) continue;
          var ec = (el.className || '').toString().slice(0, 80);
          // 同时记录 innerText（前30字符）和 getOwnText（直接文本节点）
          var et = (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
          var ot = getOwnText(el).slice(0, 40);
          var ownLen = ot.replace(/\\s+/g, '').length;
          var fullLen = et.replace(/\\s+/g, '').length;
          diagElements.push({ tag: el.tagName, cls: ec, text: et, ownText: ot, ownLen: ownLen, fullLen: fullLen, pure: ownLen >= fullLen - 3, w: Math.round(er.width), h: Math.round(er.height) });
        }
        return {
          ok: false,
          reason: 'agent-not-found',
          candidateCount: 0,
          drawerInfo: {
            class: (drawer.className || '').toString().slice(0, 100),
            w: Math.round(drawerRect.width),
            h: Math.round(drawerRect.height),
            top: Math.round(drawerRect.top),
            left: Math.round(drawerRect.left),
            childCount: drawer.children.length,
            elements: diagElements,
          },
        };
      })()`)) as { ok: boolean; reason?: string; clicked?: string; method?: string; requestedName?: string; needClick?: boolean; clickX?: number; clickY?: number; clickChain?: unknown; targetCls?: string; targetW?: number; targetH?: number };
      if (!selectResult?.ok) {
        const drawerInfo = (selectResult as { drawerInfo?: unknown }).drawerInfo;
        this.logger?.warn(
          {
            platform: this.platformId,
            agentName: trimmedAgentName,
            reason: selectResult?.reason,
            candidateCount: (selectResult as { candidateCount?: number }).candidateCount,
            drawerInfo,
          },
          '目标客服未找到，且列表无可选项',
        );
        // 控制台单独打印一次完整 drawerInfo，便于在日志中查看 DOM 结构
        if (drawerInfo) {
          console.error('[TRANSFER_DIAG] drawerInfo:', JSON.stringify(drawerInfo, null, 2));
        }
        return { ok: false, reason: 'agent-not-found', detail: selectResult?.reason, drawerInfo };
      }
      this.logger?.info(
        {
          platform: this.platformId,
          agentName: trimmedAgentName,
          clicked: selectResult.clicked,
          method: selectResult.method,
          clickX: selectResult.clickX,
          clickY: selectResult.clickY,
          targetCls: selectResult.targetCls,
          targetW: selectResult.targetW,
          targetH: selectResult.targetH,
          clickChain: selectResult.clickChain,
        },
        '已选中目标客服，准备 sendInputEvent 点击',
      );

      // 步骤 5.5：用 sendInputEvent 模拟真实 OS 鼠标点击（isTrusted=true，React 才会响应 onClick）
      // 合成 MouseEvent 的 isTrusted=false，飞鸽 React 不响应 onClick，导致点击后抽屉关闭
      if (selectResult.needClick && selectResult.clickX !== undefined && selectResult.clickY !== undefined) {
        const clickX = selectResult.clickX;
        const clickY = selectResult.clickY;
        this.logger?.info(
          { platform: this.platformId, clickX, clickY, targetCls: selectResult.targetCls },
          'sendInputEvent 真实点击客服项',
        );
        // 真实 mousedown + mouseup（OS 级别事件，isTrusted=true）
        // 注意：飞鸽 React 仅响应 isTrusted=true 的真实事件，合成 MouseEvent 被忽略
        try {
          await this.webContents.sendInputEvent({ type: 'mouseDown', x: clickX, y: clickY, button: 'left', clickCount: 1 });
          await new Promise((r) => setTimeout(r, 80));
          await this.webContents.sendInputEvent({ type: 'mouseUp', x: clickX, y: clickY, button: 'left', clickCount: 1 });
        } catch (e) {
          this.logger?.error(
            { platform: this.platformId, clickX, clickY, err: String(e), errJson: JSON.stringify(e) },
            'sendInputEvent 点击异常',
          );
          throw e;
        }
        // 等待 React 处理点击和 UI 更新
        await new Promise((r) => setTimeout(r, 800));
        // 检查 drawer 是否还在
        const drawerCheck = (await this.webContents.executeJavaScript(`(function(){
          var divs = document.querySelectorAll('div');
          for (var j = 0; j < divs.length; j++) {
            var r = divs[j].getBoundingClientRect();
            if (r.width < 200 || r.height < 100 || r.width > 1000) continue;
            var t = (divs[j].innerText || '').trim();
            if (t.indexOf('转接会话') >= 0 && t.length < 3000) return { drawerStillOpen: true };
          }
          return { drawerStillOpen: false };
        })()`)) as { drawerStillOpen: boolean };
        this.logger?.info(
          {
            platform: this.platformId,
            clickX,
            clickY,
            drawerStillOpen: drawerCheck?.drawerStillOpen,
          },
          'sendInputEvent 点击后检查抽屉状态',
        );
        if (!drawerCheck?.drawerStillOpen) {
          // 抽屉已关闭：飞鸽点击客服项后会自动关闭抽屉表示转移成功
          // 不再需要步骤 6（输入备注）和步骤 7（点击确认）
          this.logger?.info(
            { platform: this.platformId, clickX, clickY, clicked: selectResult.clicked },
            '点击客服项后抽屉已关闭，转移会话成功',
          );
          return { ok: true };
        }
        // 抽屉还开着：说明该客服项需要进一步操作（输入备注 + 点击确认）
        this.logger?.info(
          { platform: this.platformId, clickX, clickY },
          '点击后抽屉仍打开，继续走备注+确认流程',
        );
      }

      // 步骤 6：在备注输入框输入转接原因（可选，失败不阻断）
      if (remark && remark.trim().length > 0) {
        await new Promise((r) => setTimeout(r, 800));
        const remarkResult = (await this.webContents.executeJavaScript(`(function(){
          var drawer = null;
          var divs = document.querySelectorAll('div');
          for (var j = 0; j < divs.length; j++) {
            var r = divs[j].getBoundingClientRect();
            if (r.width < 200 || r.height < 100 || r.width > 1000) continue;
            var t = (divs[j].innerText || '').trim();
            if (t.indexOf('转接会话') >= 0 && t.length < 3000) { drawer = divs[j]; break; }
          }
          if (!drawer) return { ok: false, reason: 'drawer-not-found' };
          var remark = ${JSON.stringify(remark.slice(0, 200))};

          // 策略A：找含"备注"/"原因"placeholder 的 textarea
          var textareas = drawer.querySelectorAll('textarea');
          for (var i = 0; i < textareas.length; i++) {
            var ph = (textareas[i].placeholder || '').toLowerCase();
            var r2 = textareas[i].getBoundingClientRect();
            if (r2.width === 0) continue;
            if (ph.indexOf('备注') >= 0 || ph.indexOf('原因') >= 0 || ph.indexOf('说明') >= 0) {
              var ns = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
              ns.call(textareas[i], remark);
              textareas[i].dispatchEvent(new Event('input', { bubbles: true }));
              textareas[i].dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true, method: 'placeholder' };
            }
          }
          // 策略B：取抽屉中第一个可见的 textarea（排除搜索框）
          for (var j = 0; j < textareas.length; j++) {
            var r3 = textareas[j].getBoundingClientRect();
            if (r3.width === 0) continue;
            var ph2 = (textareas[j].placeholder || '').toLowerCase();
            if (ph2.indexOf('搜索') >= 0 || ph2.indexOf('客服') >= 0) continue;
            var ns2 = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            ns2.call(textareas[j], remark);
            textareas[j].dispatchEvent(new Event('input', { bubbles: true }));
            textareas[j].dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, method: 'first-textarea' };
          }
          return { ok: false, reason: 'no-remark-input' };
        })()`)) as { ok: boolean; reason?: string };
        if (!remarkResult?.ok) {
          this.logger?.warn({ platform: this.platformId, reason: remarkResult?.reason }, '备注输入失败（不阻断流程）');
        }
      }

      // 步骤 7：点击确认按钮提交转接
      await new Promise((r) => setTimeout(r, 600));
      const confirmResult = (await this.webContents.executeJavaScript(`(function(){
        var drawer = null;
        var divs = document.querySelectorAll('div');
        var vh = window.innerHeight, vw = window.innerWidth;
        for (var j = 0; j < divs.length; j++) {
          var r = divs[j].getBoundingClientRect();
          if (r.width < 200 || r.height < 100 || r.width > 1000) continue;
          // 抽屉必须在视口内可见（避免匹配到滚出视口的聊天面板容器）
          if (r.top < 0 || r.bottom > vh + 50 || r.left < -50 || r.right > vw + 50) continue;
          var t = (divs[j].innerText || '').trim();
          if (t.indexOf('转接会话') >= 0 && t.length < 3000) { drawer = divs[j]; break; }
        }
        if (!drawer) return { ok: false, reason: 'drawer-not-found' };

        var btns = drawer.querySelectorAll('button, [role=button], .auxo-btn, [class*=btn]');
        // 策略A：找 primary 按钮
        for (var i = 0; i < btns.length; i++) {
          var r2 = btns[i].getBoundingClientRect();
          if (r2.width === 0) continue;
          var cls = (btns[i].className || '').toString();
          var t = (btns[i].innerText || '').trim();
          if (cls.indexOf('primary') >= 0 || cls.indexOf('Primary') >= 0) {
            if (t.indexOf('取消') >= 0 || t.indexOf('返回') >= 0) continue;
            try { btns[i].click(); } catch(e) {}
            return { ok: true, text: t.slice(0, 20) };
          }
        }
        // 策略B：找文本含"确认"/"确定"/"转接"的按钮
        var keywords = ['确认转接', '确定', '确认', '转接'];
        for (var k = 0; k < keywords.length; k++) {
          for (var j = 0; j < btns.length; j++) {
            var r3 = btns[j].getBoundingClientRect();
            if (r3.width === 0) continue;
            var t2 = (btns[j].innerText || '').trim();
            if (t2 === keywords[k]) {
              try { btns[j].click(); } catch(e) {}
              return { ok: true, text: t2 };
            }
          }
        }
        return { ok: false, reason: 'no-confirm-button' };
      })()`)) as { ok: boolean; reason?: string; text?: string };
      if (!confirmResult?.ok) {
        this.logger?.warn({ platform: this.platformId, reason: confirmResult?.reason }, '确认按钮点击失败');
        return { ok: false, reason: 'confirm-failed', detail: confirmResult?.reason };
      }
      this.logger?.info({ platform: this.platformId, buttonText: confirmResult.text }, '已点击确认按钮');

      // 步骤 8：验证转接成功（等待抽屉关闭，最多 5 秒）
      await new Promise((r) => setTimeout(r, 2000));
      const verifyResult = (await this.webContents.executeJavaScript(`(function(){
        var divs = document.querySelectorAll('div');
        var vh = window.innerHeight, vw = window.innerWidth;
        for (var j = 0; j < divs.length; j++) {
          var r = divs[j].getBoundingClientRect();
          if (r.width < 200 || r.height < 100 || r.width > 1000) continue;
          // 抽屉必须在视口内可见（避免匹配到滚出视口的聊天面板容器）
          if (r.top < 0 || r.bottom > vh + 50 || r.left < -50 || r.right > vw + 50) continue;
          var t = (divs[j].innerText || '').trim();
          if (t.indexOf('转接会话') >= 0 && t.length < 3000) {
            return { ok: false, reason: 'drawer-still-open' };
          }
        }
        return { ok: true };
      })()`)) as { ok: boolean; reason?: string };
      if (!verifyResult?.ok) {
        this.logger?.warn({ platform: this.platformId }, '转接抽屉未关闭，可能转接未成功');
        return { ok: false, reason: 'verify-failed', detail: 'drawer-still-open' };
      }

      this.logger?.info({ platform: this.platformId, agentName }, '飞鸽转接到指定专员成功');
      return { ok: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ platform: this.platformId, agentName, err: errMsg }, 'transferToAgent 异常');
      return { ok: false, reason: 'exception', detail: errMsg };
    } finally {
      // 恢复扫描器：transferToAgent 已结束（成功/失败/异常），允许扫描器继续工作
      this.transferInProgress = false;
    }
  }

  /**
   * 检测当前会话的订单信息
   *
   * 从飞鸽客服页面右侧订单面板提取订单信息（订单号、商品、金额等），
   * 用于备注前让买家确认订单。
   *
   * 流程：
   * 1. 点击"订单"标签页
   * 2. 提取订单面板中的文本信息
   * 3. 解析订单号、商品名、规格、金额等关键字段
   *
   * 返回订单信息字符串，失败时返回空字符串
   */
  async detectOrderInfo(): Promise<string> {
    if (!this.webContents || this.webContents.isDestroyed() || !this.connected) {
      return '';
    }

    try {
      // 步骤1：点击"订单"标签页
      const tabScript = `
(function() {
  var tabs = document.querySelectorAll('span, div, a, button, li');
  for (var i = 0; i < tabs.length; i++) {
    var t = tabs[i];
    if (t.offsetParent === null) continue;
    if (t.children.length > 2) continue;
    var text = (t.innerText || t.textContent || '').trim();
    if (text === '订单' || text === '订单信息') {
      t.click();
      return true;
    }
  }
  return false;
})()
      `;
      await this.webContents.executeJavaScript(tabScript);
      await new Promise((r) => setTimeout(r, 1200));

      // 步骤2：提取右侧面板订单信息
      const extractScript = `
(function() {
  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null && el.tagName !== 'BODY') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function isInRightPanel(el) {
    var r = el.getBoundingClientRect();
    return r.left > window.innerWidth * 0.4 && r.width < 600;
  }

  // 策略A：查找包含"订单号"/"订单编号"关键词的元素，提取其父容器的文本
  var orderNoEls = document.querySelectorAll('span, div, p, label, td, li');
  var fullText = '';
  for (var i = 0; i < orderNoEls.length; i++) {
    var el = orderNoEls[i];
    if (!isVisible(el) || !isInRightPanel(el)) continue;
    if (el.children.length > 0) continue;
    var t = (el.innerText || el.textContent || '').trim();
    if (t.indexOf('订单号') >= 0 || t.indexOf('订单编号') >= 0) {
      // 向上查找最近的有较多文本的容器
      var container = el.parentElement;
      for (var depth = 0; depth < 5 && container; depth++) {
        var containerText = (container.innerText || container.textContent || '').trim();
        if (containerText.length > 30 && containerText.length < 1500) {
          fullText = containerText;
          break;
        }
        container = container.parentElement;
      }
      if (fullText) break;
    }
  }

  // 策略B：如果策略A没找到，回退到查找右侧面板中最长的文本
  if (!fullText) {
    var panelTexts = [];
    var allEls = document.querySelectorAll('div, section');
    for (var j = 0; j < allEls.length; j++) {
      var e = allEls[j];
      if (!isVisible(e) || !isInRightPanel(e)) continue;
      var text = (e.innerText || e.textContent || '').trim();
      if (text.length > 20 && text.length < 2000) {
        // 包含订单相关关键词
        if (text.indexOf('订单') >= 0 || text.indexOf('商品') >= 0 || text.indexOf('实付') >= 0) {
          panelTexts.push(text);
        }
      }
    }
    panelTexts.sort(function(a, b) { return b.length - a.length; });
    fullText = panelTexts[0] || '';
  }

  if (!fullText) return '';

  // 解析关键字段
  var info = [];

  // 订单号：匹配"订单号"、"订单编号"后的数字串
  var orderNoMatch = fullText.match(/订单(?:编号|号)[：:\\s]*([A-Za-z0-9\\-]+)/);
  if (orderNoMatch) info.push('订单号: ' + orderNoMatch[1]);

  // 订单状态：按优先级匹配，未完结状态优先（避免同时匹配"待发货"和"已完成"）
  // 未完结状态：待付款、待发货、已发货（待收货）、待收货、配送中、运输中、退款中、退款待处理、售后中、换货中
  // 已完结状态：已完成、已收货、已关闭、已取消、退款成功、退款失败、售后完成
  var statusPatterns = [
    { re: /待付款/, label: '待付款（未完结）', priority: 1 },
    { re: /待发货/, label: '待发货（未完结）', priority: 1 },
    { re: /待收货/, label: '待收货（未完结）', priority: 1 },
    // 使用负向预查排除"已发货已收货/已签收"等已完成情况
    { re: /已发货(?!已)/, label: '已发货（未完结）', priority: 1 },
    { re: /配送中|运输中|运送中/, label: '配送中（未完结）', priority: 1 },
    { re: /退款中|退款待处理|退款申请中|退款审核中/, label: '退款处理中（未完结）', priority: 1 },
    { re: /售后中|售后处理中|售后申请中/, label: '售后处理中（未完结）', priority: 1 },
    { re: /换货中|换货处理中/, label: '换货处理中（未完结）', priority: 1 },
    { re: /已完成|已收货|交易成功/, label: '已完成', priority: 2 },
    { re: /已关闭|已取消/, label: '已取消', priority: 2 },
    { re: /退款成功/, label: '退款成功', priority: 2 },
    { re: /退款失败|退款驳回/, label: '退款失败', priority: 2 },
    { re: /售后完成/, label: '售后完成', priority: 2 },
  ];
  var matchedStatus = [];
  var matchedPriority = 99;  // 当前已匹配状态的优先级（1=未完结，2=已完结）
  for (var si = 0; si < statusPatterns.length; si++) {
    if (statusPatterns[si].re.test(fullText)) {
      // 优先级更高的状态（数字更小）覆盖优先级低的状态
      if (statusPatterns[si].priority < matchedPriority) {
        matchedStatus = [statusPatterns[si].label];
        matchedPriority = statusPatterns[si].priority;
      } else if (statusPatterns[si].priority === matchedPriority) {
        matchedStatus.push(statusPatterns[si].label);
      }
    }
  }
  if (matchedStatus.length > 0) {
    info.push('订单状态: ' + matchedStatus.join(', '));
  }

  // 商品名称：匹配"商品"后的文本
  var productMatch = fullText.match(/商品(?:名称)?[：:\\s]*([^\\n\\r]+)/);
  if (productMatch) info.push('商品: ' + productMatch[1].trim());

  // 金额：匹配"金额"、"实付"、"总价"后的数字
  var amountMatch = fullText.match(/(?:金额|实付|总价|付款)[：:\\s]*[￥¥]?(\\d+\\.?\\d*)/);
  if (amountMatch) info.push('金额: ¥' + amountMatch[1]);

  // 规格：匹配"规格"、"颜色"、"尺寸"后的文本
  var specMatch = fullText.match(/(?:规格|颜色|尺寸|型号)[：:\\s]*([^\\n\\r]+)/);
  if (specMatch) info.push('规格: ' + specMatch[1].trim());

  // 数量
  var qtyMatch = fullText.match(/数量[：:\\s]*(\\d+)/);
  if (qtyMatch) info.push('数量: ' + qtyMatch[1]);

  // 收件人
  var nameMatch = fullText.match(/收件人[：:\\s]*([^\\n\\r]+)/);
  if (nameMatch) info.push('收件人: ' + nameMatch[1].trim());

  // 物流单号
  var logisticsMatch = fullText.match(/(?:物流单号|快递单号|运单号)[：:\\s]*([A-Za-z0-9\\-]+)/);
  if (logisticsMatch) info.push('物流单号: ' + logisticsMatch[1]);

  // 物流公司
  var companyMatch = fullText.match(/(?:物流公司|快递公司|承运商)[：:\\s]*([^\\n\\r]+)/);
  if (companyMatch) info.push('物流公司: ' + companyMatch[1].trim());

  // 如果没解析到关键字段，返回原始文本（截取前500字符）
  if (info.length === 0) {
    return '订单面板内容: ' + fullText.slice(0, 500);
  }

  return info.join('\\n');
})()
      `;

      const result = (await this.webContents.executeJavaScript(extractScript)) as string;
      this.logger?.info(
        { platform: this.platformId, orderInfo: result?.slice(0, 200) },
        '检测到订单信息',
      );
      return result || '';
    } catch (e) {
      this.logger?.warn(
        { platform: this.platformId, err: e instanceof Error ? e.message : String(e) },
        '检测订单信息失败',
      );
      return '';
    }
  }

  /**
   * 使用 sendInputEvent 在指定坐标输入文本（模拟真实键盘输入）
   */
  async inputAtPosition(x: number, y: number, text: string): Promise<void> {
    if (!this.webContents || this.webContents.isDestroyed()) return;

    // 点击目标位置
    void this.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    void this.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 300));

    // 逐字输入
    for (const ch of text) {
      void this.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      await new Promise((r) => setTimeout(r, 30));
    }
  }
}
