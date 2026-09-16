/**
 * 平台注册表单元测试
 */
import {
  getPlatform,
  getAllPlatforms,
  getPlatformSelectors,
  getPlatformLoginDetection,
  type PlatformId,
} from '@/platform';

const ALL_PLATFORM_IDS: PlatformId[] = ['feige', 'pinduoduo', 'kuaishou', 'weixin'];

describe('平台注册表', () => {
  describe('getPlatform', () => {
    it.each(ALL_PLATFORM_IDS)('%s 返回非空平台定义', (id) => {
      const platform = getPlatform(id);
      expect(platform).toBeDefined();
      expect(platform.id).toBe(id);
      expect(platform.name).toBeTruthy();
      expect(platform.defaultWebUrl).toBeTruthy();
    });

    it('未知平台 ID 抛出错误', () => {
      expect(() => getPlatform('unknown' as PlatformId)).toThrow('Unknown platform');
    });
  });

  describe('getAllPlatforms', () => {
    it('返回四个平台', () => {
      const platforms = getAllPlatforms();
      expect(platforms).toHaveLength(4);
      const ids = platforms.map((p) => p.id);
      expect(ids).toEqual(ALL_PLATFORM_IDS);
    });
  });

  describe('选择器完整性', () => {
    it.each(ALL_PLATFORM_IDS)('%s 选择器完整', (id) => {
      const selectors = getPlatformSelectors(id);
      expect(selectors.messageSelectors).toBeDefined();
      expect(selectors.messageSelectors.length).toBeGreaterThan(0);
      expect(selectors.inputSelector).toBeTruthy();
      expect(selectors.sendButtonSelectors.length).toBeGreaterThan(0);
      expect(selectors.sendButtonTexts.length).toBeGreaterThan(0);
      expect(selectors.sellerClassPatterns.length).toBeGreaterThan(0);
      expect(selectors.buyerClassPatterns.length).toBeGreaterThan(0);
      expect(selectors.systemClassPatterns.length).toBeGreaterThan(0);
      expect(selectors.sessionIdExtractor).toBeTruthy();
      expect(selectors.closeDialogTexts.length).toBeGreaterThan(0);
      expect(selectors.conversationItemSelectors.length).toBeGreaterThan(0);
      expect(selectors.unreadIndicatorSelectors.length).toBeGreaterThan(0);
      expect(selectors.excludeSelectors).toBeTruthy();
    });
  });

  describe('登录检测完整性', () => {
    it.each(ALL_PLATFORM_IDS)('%s 登录检测完整', (id) => {
      const detection = getPlatformLoginDetection(id);
      expect(detection.loginPageUrlPatterns.length).toBeGreaterThan(0);
      expect(detection.loggedInDomSelectors.length).toBeGreaterThan(0);
      expect(detection.loginExpiredTexts.length).toBeGreaterThan(0);
      expect(detection.navigationGuardBaseUrl).toBeTruthy();
      expect(detection.requestHeaderDomains.length).toBeGreaterThan(0);
    });
  });

  describe('getPlatformSelectors', () => {
    it('飞鸽与拼多多选择器不同', () => {
      const feige = getPlatformSelectors('feige');
      const pdd = getPlatformSelectors('pinduoduo');
      expect(feige.messageSelectors).not.toEqual(pdd.messageSelectors);
    });

    it('拼多多选择器包含 Element UI 特定类', () => {
      const pdd = getPlatformSelectors('pinduoduo');
      const allSelectors = JSON.stringify(pdd);
      expect(allSelectors).toContain('chat-item-box');
      expect(allSelectors).toContain('bottom-message');
      expect(allSelectors).toContain('chat-message-content');
    });

    it('快手选择器包含快语平台特定类', () => {
      const ks = getPlatformSelectors('kuaishou');
      expect(ks.sendButtonTexts).toContain('发送 Enter');
      expect(ks.sendButtonTexts).toContain('发送(Enter)');
      expect(ks.excludeSelectors).toContain('quick-reply');
    });

    it('微信选择器包含 WeUI 特定类', () => {
      const wx = getPlatformSelectors('weixin');
      const allSelectors = JSON.stringify(wx);
      expect(allSelectors).toContain('weui-desktop');
      expect(wx.sellerClassPatterns).toContain('weui-desktop-message__self');
    });
  });

  describe('getPlatformLoginDetection', () => {
    it('飞鸽登录检测与其他平台不同', () => {
      const feige = getPlatformLoginDetection('feige');
      const pdd = getPlatformLoginDetection('pinduoduo');
      expect(feige.navigationGuardBaseUrl).toContain('jinritemai');
      expect(pdd.navigationGuardBaseUrl).toContain('pinduoduo');
    });
  });

  describe('抖店新版会话 DOM', () => {
    it('包含新版 auxo 会话项选择器和工作台登录特征', () => {
      const selectors = getPlatformSelectors('feige');
      expect(selectors.conversationItemSelectors).toContain('.auxo-dropdown-trigger');
      expect(selectors.conversationItemSelectors.indexOf('.auxo-dropdown-trigger')).toBeLessThan(
        selectors.conversationItemSelectors.indexOf('[class*="session"]'),
      );
      expect(selectors.unreadIndicatorSelectors).not.toContain('[class*="badge"]');
      const detection = getPlatformLoginDetection('feige');
      expect(detection.loggedInDomSelectors).toEqual(expect.arrayContaining(['.chatd-root', '#rootContainer']));
    });
  });

  describe('微信小店登录状态修复', () => {
    it('loginPageUrlPatterns 不包含 shop 子串（避免误匹配默认 URL）', () => {
      const wx = getPlatformLoginDetection('weixin');
      expect(wx.loginPageUrlPatterns).not.toContain('shop');
      expect(wx.loginPageUrlPatterns).not.toContain('scan');
    });

    it('loginPageUrlRegexps 配置了精确的登录页正则', () => {
      const wx = getPlatformLoginDetection('weixin');
      expect(wx.loginPageUrlRegexps).toBeDefined();
      expect(wx.loginPageUrlRegexps!.length).toBeGreaterThan(0);
      // 验证正则能匹配登录页 URL
      const regexp = new RegExp(wx.loginPageUrlRegexps![0], 'i');
      expect(regexp.test('https://store.weixin.qq.com/login')).toBe(true);
      // 验证正则不误匹配默认客服 URL
      expect(regexp.test('https://store.weixin.qq.com/shop/kf')).toBe(false);
    });

    it('allowedAuthDomains 包含 OAuth 回调域名', () => {
      const wx = getPlatformLoginDetection('weixin');
      expect(wx.allowedAuthDomains).toBeDefined();
      expect(wx.allowedAuthDomains!.some((d) => d.includes('open.weixin.qq.com'))).toBe(true);
    });
  });

  describe('快手小店 Shadow DOM 穿透', () => {
    it('requiresShadowDomTraversal 为 true', () => {
      const ks = getPlatformLoginDetection('kuaishou');
      expect(ks.requiresShadowDomTraversal).toBe(true);
    });

    it('loginPageUrlRegexps 配置了登录页正则', () => {
      const ks = getPlatformLoginDetection('kuaishou');
      expect(ks.loginPageUrlRegexps).toBeDefined();
      expect(ks.loginPageUrlRegexps!.length).toBeGreaterThan(0);
    });

    it('allowedAuthDomains 包含 passport 域名', () => {
      const ks = getPlatformLoginDetection('kuaishou');
      expect(ks.allowedAuthDomains).toBeDefined();
      expect(ks.allowedAuthDomains!.some((d) => d.includes('passport.kuaishou.com'))).toBe(true);
    });

    it('expiredResponseUrlPatterns 配置了 API 监控', () => {
      const ks = getPlatformLoginDetection('kuaishou');
      expect(ks.expiredResponseUrlPatterns).toBeDefined();
      expect(ks.expiredResponseUrlPatterns!.length).toBeGreaterThan(0);
    });
  });

  describe('全平台 allowedAuthDomains 完整性', () => {
    it.each(ALL_PLATFORM_IDS)('%s 配置了 allowedAuthDomains', (id) => {
      const detection = getPlatformLoginDetection(id);
      expect(detection.allowedAuthDomains).toBeDefined();
      expect(detection.allowedAuthDomains!.length).toBeGreaterThan(0);
    });
  });
});
