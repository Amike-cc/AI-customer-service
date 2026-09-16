/**
 * 平台注册表
 */
import type { PlatformSelectors, PlatformLoginDetection, PlatformDefinition } from './types';

// ============ 飞鸽选择器 ============
export const feigeSelectors: PlatformSelectors = {
  sessionIdExtractor: `(function(){window.__feigeGetSessionId=function(){try{
    var selectors=[
      '.auxo-dropdown-trigger[aria-selected="true"]',
      '.auxo-dropdown-trigger[class*="active"]',
      '.auxo-dropdown-trigger[class*="selected"]',
      '[class*="conversationCard"][class*="active"]',
      '[class*="chat-item"][class*="active"]'
    ];
    var ignored=/^(当前会话|最近联系|平台消息|会话搜索|商品|订单|快捷短语|最近常用|个人短语|团队短语)$/;
    function normalize(el){
      var lines=(el.innerText||el.textContent||'').split(/\\n/).map(function(v){return v.trim();}).filter(Boolean);
      for(var i=0;i<lines.length;i++){
        if(lines[i].length>=1&&lines[i].length<=80&&!ignored.test(lines[i])&&!/^\\d{1,2}[\\/:月-]\\d{1,2}/.test(lines[i])) return lines[i];
      }
      return '';
    }
    for(var s=0;s<selectors.length;s++){
      var nodes=document.querySelectorAll(selectors[s]);
      for(var i=0;i<nodes.length;i++){
        var r=nodes[i].getBoundingClientRect();
        if(r.width<=0||r.height<=0) continue;
        var value=normalize(nodes[i]);
        if(value) return value;
      }
    }
    return 'default';
  }catch(e){return 'default';}}})()`,
  messageSelectors: ['[class*="messageIsMe"]', '[class*="messageNotMe"]', '[class*="leaveMessage"]', '[class*="message"]', '[class*="msg"]', '[class*="chat"]', '[class*="bubble"]', '[class*="conversation"]'],
  excludeSelectors: 'auxo-message|ant-message|notification|toast|drawer|modal|tooltip|not-?a-?message|i-icon-transfer',
  inputSelector: 'textarea[placeholder*="发送给"], [contenteditable="true"], textarea',
  sendButtonSelectors: ['[class*="xyr2h3Spq6gTVjER"]', '[class*="nADeEUpSWFT1d"]', '[class*="send"]', 'button[class*="send"]'],
  sendButtonTexts: ['发送', '发送', 'Send', '回复'],
  sellerClassPatterns: ['messageIsMe', 'self', 'seller', 'mine', 'right', 'chatd-self', 'chatd-right', 'chatd-seller'],
  buyerClassPatterns: ['messageNotMe', 'other', 'buyer', 'left'],
  systemClassPatterns: ['system', 'chatd-system', 'notice'],
  closeDialogTexts: ['取消', '关闭', '关闭弹窗', 'Close', 'Cancel'],
  conversationItemSelectors: ['.pigeonChatScrollBox .auxo-dropdown-trigger', '.auxo-dropdown-trigger', '[class*="conversationCard"]', '[class*="chat-item"]', '[class*="session"]'],
  // 新版抖店每个联系人都带空的 auxo-badge 装饰节点，不能将泛 badge 当作未读依据。
  unreadIndicatorSelectors: ['[class*="unread"]', '[class*="count"]', '[class*="has-new"]', '[aria-label*="未读"]'],
};

// ============ 拼多多选择器 ============
export const pinduoduoSelectors: PlatformSelectors = {
  sessionIdExtractor: `(function(){window.__feigeGetSessionId=function(){try{var el=document.querySelector(".chat-item-box.active,[class*=active]");if(el)return el.textContent.trim().substring(0,30)||"default";return"default"}catch(e){return"default"}}})()`,
  messageSelectors: ['[class*="chat-item-box"]', '[class*="bottom-message"]', '[class*="chat-message-content"]', '[class*="message"]', '[class*="msg"]'],
  excludeSelectors: 'notification|toast|drawer|modal|tooltip|popup',
  inputSelector: 'textarea, [contenteditable="true"]',
  sendButtonSelectors: ['[class*="send"]', 'button[class*="send"]'],
  sendButtonTexts: ['发送', 'Send'],
  sellerClassPatterns: ['self', 'seller', 'mine', 'right'],
  buyerClassPatterns: ['other', 'buyer', 'left'],
  systemClassPatterns: ['system', 'notice'],
  closeDialogTexts: ['取消', '关闭', 'Close', 'Cancel'],
  conversationItemSelectors: ['[class*="chat-item-box"]', '[class*="conversation"]'],
  unreadIndicatorSelectors: ['[class*="unread"]', '[class*="badge"]'],
};

// ============ 快手选择器 ============
export const kuaishouSelectors: PlatformSelectors = {
  sessionIdExtractor: `(function(){window.__feigeGetSessionId=function(){try{var el=document.querySelector("[class*=SessionBaseCard].active");if(el)return el.textContent.trim().substring(0,30)||"default";return"default"}catch(e){return"default"}}})()`,
  messageSelectors: ['[class*="chat"]', '[class*="msg"]', '[class*="message"]', '[class*="bubble"]'],
  excludeSelectors: 'notification|toast|drawer|modal|tooltip|quick-reply',
  inputSelector: 'textarea, [contenteditable="true"]',
  sendButtonSelectors: ['[class*="send"]', 'button[class*="send"]'],
  sendButtonTexts: ['发送 Enter', '发送(Enter)', '发送', 'Send'],
  sellerClassPatterns: ['self', 'seller', 'mine', 'right'],
  buyerClassPatterns: ['other', 'buyer', 'left'],
  systemClassPatterns: ['system', 'notice'],
  closeDialogTexts: ['取消', '关闭', 'Close', 'Cancel'],
  conversationItemSelectors: ['[class*=SessionBaseCard]', '[class*="chat-item"]'],
  unreadIndicatorSelectors: ['[class*="unread"]', '[class*="badge"]'],
};

// ============ 微信选择器 ============
export const weixinSelectors: PlatformSelectors = {
  sessionIdExtractor: `(function(){window.__feigeGetSessionId=function(){try{var el=document.querySelector("[class*=conv-item].active");if(el)return el.textContent.trim().substring(0,30)||"default";return"default"}catch(e){return"default"}}})()`,
  messageSelectors: ['[class*="weui-desktop"]', '[class*="message"]', '[class*="msg"]', '[class*="chat"]'],
  excludeSelectors: 'notification|toast|drawer|modal|tooltip',
  inputSelector: 'textarea, [contenteditable="true"]',
  sendButtonSelectors: ['[class*="send"]', 'button[class*="send"]'],
  sendButtonTexts: ['发送', 'Send'],
  sellerClassPatterns: ['weui-desktop-message__self', 'self', 'seller', 'mine', 'right'],
  buyerClassPatterns: ['weui-desktop-message__other', 'other', 'buyer', 'left'],
  systemClassPatterns: ['system', 'notice'],
  closeDialogTexts: ['取消', '关闭', 'Close', 'Cancel'],
  conversationItemSelectors: ['[class*="conv-item"]', '[class*="conversation"]'],
  unreadIndicatorSelectors: ['[class*="unread"]', '[class*="badge"]'],
};

// Alias generic selectors
export const genericSelectors: PlatformSelectors = feigeSelectors;

// ============ 登录检测配置 ============
export const genericLoginDetection: PlatformLoginDetection = {
  loginPageUrlPatterns: ['login', 'signin', 'passport', 'sso'],
  loginPageUrl: '',
  loggedInDomSelectors: ['[class*="avatar"]', '[class*="user"]', '[class*="account"]'],
  loginExpiredTexts: ['登录过期', '请重新登录', '登录失效', '重新登录', '身份过期'],
  requestHeaderDomains: [],
  navigationGuardBaseUrl: 'https://example.com',
  allowedAuthDomains: ['example.com'],
};

export const feigeLoginDetection: PlatformLoginDetection = {
  loginPageUrlPatterns: ['login', 'signin', 'passport', 'sso'],
  loginPageUrl: 'https://im.jinritemai.com/pc_seller_v2/main/login',
  loggedInDomSelectors: ['.chatd-root', '.chatd-default', '#rootContainer', '[class*="chatd-root"]', '[class*="avatar"]', '[class*="userInfo"]'],
  loginExpiredTexts: ['登录过期', '请重新登录', '登录失效', '重新登录', '身份过期', 'token expired', 'session expired'],
  requestHeaderDomains: ['*://*.jinritemai.com/*'],
  navigationGuardBaseUrl: 'https://im.jinritemai.com',
  allowedAuthDomains: ['jinritemai.com'],
  shopNameScript: '',
};

export const pinduoduoLoginDetection: PlatformLoginDetection = {
  loginPageUrlPatterns: ['login', 'signin', 'passport', 'sso'],
  loginPageUrl: 'https://mms.pinduoduo.com/login',
  loggedInDomSelectors: ['[class*="avatar"]', '[class*="user"]'],
  loginExpiredTexts: ['登录过期', '请重新登录', '登录失效', '重新登录', '身份过期'],
  requestHeaderDomains: ['*://*.pinduoduo.com/*'],
  navigationGuardBaseUrl: 'https://mms.pinduoduo.com',
  allowedAuthDomains: ['pinduoduo.com'],
  requiresShadowDomTraversal: false,
};

export const kuaishouLoginDetection: PlatformLoginDetection = {
  loginPageUrlPatterns: ['login', 'signin', 'passport', 'sso'],
  loginPageUrl: 'https://login.kwaixiaodian.com',
  loggedInDomSelectors: ['[class*="avatar"]', '[class*="user"]'],
  loginExpiredTexts: ['登录过期', '请重新登录', '登录失效', '重新登录', '身份过期'],
  requestHeaderDomains: ['*://*.kwaixiaodian.com/*'],
  navigationGuardBaseUrl: 'https://im.kwaixiaodian.com',
  allowedAuthDomains: ['passport.kuaishou.com', 'kwaixiaodian.com'],
  requiresShadowDomTraversal: true,
  loginPageUrlRegexps: ['login\\.kwaixiaodian\\.com'],
  expiredResponseUrlPatterns: ['/rest/infra/n/logout'],
};

export const weixinLoginDetection: PlatformLoginDetection = {
  loginPageUrlPatterns: ['login'],
  loginPageUrl: '',
  loggedInDomSelectors: ['[class*="avatar"]', '[class*="user"]'],
  loginExpiredTexts: ['登录过期', '请重新登录', '登录失效', '重新登录', '二维码已过期'],
  requestHeaderDomains: ['*://*.weixin.qq.com/*'],
  navigationGuardBaseUrl: 'https://store.weixin.qq.com',
  allowedAuthDomains: ['open.weixin.qq.com', 'weixin.qq.com'],
  requiresShadowDomTraversal: false,
  loginPageUrlRegexps: ['store\\.weixin\\.qq\\.com/(login|connect)'],
};

// ============ 平台注册 ============
const platforms: Record<string, PlatformDefinition> = {};

platforms['feige'] = {
  id: 'feige', name: '飞鸽', icon: 'bird',
  defaultWebUrl: 'https://im.jinritemai.com/pc_seller_v2/main/workspace',
  selectors: feigeSelectors, loginDetection: feigeLoginDetection,
};

platforms['pinduoduo'] = {
  id: 'pinduoduo', name: '拼多多', icon: 'pinduoduo',
  defaultWebUrl: 'https://mms.pinduoduo.com/chat-merchant/index.html',
  selectors: pinduoduoSelectors, loginDetection: pinduoduoLoginDetection,
};

platforms['kuaishou'] = {
  id: 'kuaishou', name: '快手', icon: 'kuaishou',
  defaultWebUrl: 'https://im.kwaixiaodian.com/workbench',
  selectors: kuaishouSelectors, loginDetection: kuaishouLoginDetection,
};

platforms['weixin'] = {
  id: 'weixin', name: '微信', icon: 'weixin',
  defaultWebUrl: 'https://store.weixin.qq.com/shop?redirect_url=%2Fkf',
  selectors: weixinSelectors, loginDetection: weixinLoginDetection,
};

export function getPlatform(id: string): PlatformDefinition {
  const def = platforms[id];
  if (!def) throw new Error('Unknown platform: ' + id);
  return def;
}

export function getAllPlatforms(): PlatformDefinition[] {
  return Object.values(platforms);
}

export function getPlatformSelectors(platformId: string): PlatformSelectors {
  return getPlatform(platformId).selectors;
}

export function getPlatformLoginDetection(platformId: string): PlatformLoginDetection {
  return getPlatform(platformId).loginDetection;
}
