/**
 * ShopConfigRepo 单元测试
 * 覆盖店铺配置查询、多平台字段映射、enabled 过滤等场景
 */
import { createMockDatabase } from '../helpers/mockDb';
import { ShopConfigRepo } from '@/db/repos/ShopConfigRepo';

describe('ShopConfigRepo', () => {
  let db: any;
  let repo: ShopConfigRepo;

  beforeEach(() => {
    db = createMockDatabase();
    db.exec(`
      CREATE TABLE shop_config (
        shop_id TEXT PRIMARY KEY,
        shop_name TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'feige',
        feige_client_path TEXT NOT NULL,
        window_title_pattern TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        auto_reply INTEGER NOT NULL DEFAULT 1,
        login_status TEXT NOT NULL DEFAULT 'logged_out',
        last_login_at INTEGER,
        transfer_target TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    repo = new ShopConfigRepo(db);
  });

  describe('add / get', () => {
    it('新增店铺后可按 ID 查询', () => {
      repo.add({
        shopId: '1001',
        shopName: '测试店',
        platform: 'pinduoduo',
        enabled: true,
        autoReply: true,
        loginStatus: 'logged_out',
        lastLoginAt: null,
      });
      const got = repo.get('1001');
      expect(got).not.toBeNull();
      expect(got!.shopId).toBe('1001');
      expect(got!.shopName).toBe('测试店');
      expect(got!.platform).toBe('pinduoduo');
      expect(got!.enabled).toBe(true);
    });

    it('不存在的店铺返回 null', () => {
      expect(repo.get('not-exist')).toBeNull();
    });
  });

  describe('list', () => {
    it('只返回 enabled=1 的店铺', () => {
      repo.add({ shopId: '1', shopName: 'A', platform: 'feige', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.add({ shopId: '2', shopName: 'B', platform: 'kuaishou', enabled: false, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.add({ shopId: '3', shopName: 'C', platform: 'weixin', enabled: true, autoReply: false, loginStatus: 'logged_in', lastLoginAt: 123 });

      const list = repo.list();
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.shopId).sort()).toEqual(['1', '3']);
    });

    it('无数据时返回空数组', () => {
      expect(repo.list()).toEqual([]);
    });

    it('返回所有平台字段正确映射', () => {
      repo.add({ shopId: '1', shopName: '拼多多店', platform: 'pinduoduo', enabled: true, autoReply: false, loginStatus: 'logged_in', lastLoginAt: 999 });
      const list = repo.list();
      expect(list[0].platform).toBe('pinduoduo');
      expect(list[0].autoReply).toBe(false);
      expect(list[0].loginStatus).toBe('logged_in');
      expect(list[0].lastLoginAt).toBe(999);
    });
  });

  describe('setEnabled', () => {
    it('禁用后 list 不再返回', () => {
      repo.add({ shopId: '1', shopName: 'A', platform: 'feige', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.setEnabled('1', false);
      expect(repo.list()).toHaveLength(0);
      // get 仍可查询（不依赖 enabled）
      expect(repo.get('1')).not.toBeNull();
    });
  });

  describe('setAutoReply', () => {
    it('切换自动回复标志', () => {
      repo.add({ shopId: '1', shopName: 'A', platform: 'feige', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.setAutoReply('1', false);
      expect(repo.get('1')!.autoReply).toBe(false);
    });
  });

  describe('setLoginStatus', () => {
    it('设置 logged_in 时更新 lastLoginAt', () => {
      repo.add({ shopId: '1', shopName: 'A', platform: 'feige', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.setLoginStatus('1', 'logged_in');
      const got = repo.get('1')!;
      expect(got.loginStatus).toBe('logged_in');
      expect(got.lastLoginAt).not.toBeNull();
    });

    it('设置 logged_out 时清空 lastLoginAt', () => {
      repo.add({ shopId: '1', shopName: 'A', platform: 'feige', enabled: true, autoReply: true, loginStatus: 'logged_in', lastLoginAt: 123 });
      repo.setLoginStatus('1', 'logged_out');
      const got = repo.get('1')!;
      expect(got.loginStatus).toBe('logged_out');
      expect(got.lastLoginAt).toBeNull();
    });
  });

  describe('rename', () => {
    it('更新店铺名称', () => {
      repo.add({ shopId: '1', shopName: '旧名', platform: 'feige', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.rename('1', '新名');
      expect(repo.get('1')!.shopName).toBe('新名');
    });
  });

  describe('delete', () => {
    it('删除后查询返回 null', () => {
      repo.add({ shopId: '1', shopName: 'A', platform: 'feige', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.delete('1');
      expect(repo.get('1')).toBeNull();
      expect(repo.list()).toHaveLength(0);
    });
  });

  describe('mapRow platform 默认值', () => {
    it('空 platform 字段回退到 feige', () => {
      // 直接插入 platform 为空字符串的情况
      db.prepare(
        `INSERT INTO shop_config (shop_id, shop_name, platform, feige_client_path, enabled, auto_reply, login_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('1', 'A', '', '', 1, 1, 'logged_out', 100, 100);
      const got = repo.get('1')!;
      expect(got.platform).toBe('feige');
    });
  });

  describe('多场景边界测试', () => {
    it('多店铺按 shop_id 升序返回', () => {
      repo.add({ shopId: '300', shopName: 'C', platform: 'feige', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.add({ shopId: '100', shopName: 'A', platform: 'feige', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.add({ shopId: '200', shopName: 'B', platform: 'feige', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      const list = repo.list();
      expect(list.map((s) => s.shopId)).toEqual(['100', '200', '300']);
    });

    it('重复 add 同一 shopId 触发 ON CONFLICT 更新 shop_name', () => {
      repo.add({ shopId: '1', shopName: '旧名', platform: 'feige', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.add({ shopId: '1', shopName: '新名', platform: 'pinduoduo', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      const got = repo.get('1')!;
      expect(got.shopName).toBe('新名');
      expect(got.platform).toBe('pinduoduo');
      expect(repo.list()).toHaveLength(1);
    });

    it('禁用后重新启用 list 恢复返回', () => {
      repo.add({ shopId: '1', shopName: 'A', platform: 'feige', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.setEnabled('1', false);
      expect(repo.list()).toHaveLength(0);
      repo.setEnabled('1', true);
      expect(repo.list()).toHaveLength(1);
    });

    it('多平台混合查询全部返回', () => {
      repo.add({ shopId: '1', shopName: '飞鸽店', platform: 'feige', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.add({ shopId: '2', shopName: '拼多多店', platform: 'pinduoduo', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.add({ shopId: '3', shopName: '快手店', platform: 'kuaishou', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.add({ shopId: '4', shopName: '微信店', platform: 'weixin', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      const list = repo.list();
      expect(list).toHaveLength(4);
      const platforms = list.map((s) => s.platform);
      expect(platforms).toContain('feige');
      expect(platforms).toContain('pinduoduo');
      expect(platforms).toContain('kuaishou');
      expect(platforms).toContain('weixin');
    });

    it('全部禁用时 list 返回空但 get 仍可查', () => {
      repo.add({ shopId: '1', shopName: 'A', platform: 'feige', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.add({ shopId: '2', shopName: 'B', platform: 'feige', enabled: true, autoReply: true, loginStatus: 'logged_out', lastLoginAt: null });
      repo.setEnabled('1', false);
      repo.setEnabled('2', false);
      expect(repo.list()).toHaveLength(0);
      expect(repo.get('1')).not.toBeNull();
      expect(repo.get('2')).not.toBeNull();
    });
  });
});
