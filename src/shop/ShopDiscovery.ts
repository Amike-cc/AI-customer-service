/**
 * 店铺发现模块（简化版）
 *
 * 网页版架构下不再需要自动发现飞鸽桌面客户端。
 * 店铺由用户通过 UI 手动添加，持久化到数据库。
 */
import type { AppLogger } from '../logging/logger';
import type { Config } from '../config/schema';
import type { Database } from '../db/Database';
import type { ShopConfig } from '../db/repos/ShopConfigRepo';

export interface DiscoveredShop {
  shopId: string;
  shopName: string;
  accountName: string;
  accountId: string;
  sessionPartitionKey: string;
  pid: number | null;
}

export class ShopDiscovery {
  constructor(
    private config: Config,
    private db: Database,
    private logger: AppLogger,
  ) {}

  /**
   * 网页版架构下不再需要自动发现，返回空列表。
   * 店铺由用户通过 UI 手动添加。
   */
  async discover(): Promise<{
    installPath: string | null;
    feigeRunning: boolean;
    shops: DiscoveredShop[];
  }> {
    return { installPath: null, feigeRunning: false, shops: [] };
  }

  /**
   * 将发现的店铺持久化到数据库（upsert），并返回 ShopConfig
   */
  async persistShop(discovered: DiscoveredShop): Promise<ShopConfig> {
    const shopConfig: Omit<ShopConfig, 'createdAt' | 'updatedAt'> = {
      shopId: discovered.shopId,
      shopName: discovered.shopName,
      platform: 'feige',
      windowTitlePattern: `*[商家]${discovered.shopName}*`,
      enabled: true,
      autoReply: true,
      loginStatus: 'logged_out',
      lastLoginAt: null,
    };

    this.db.shops.add(shopConfig);
    this.logger.info({ shopId: discovered.shopId, shopName: discovered.shopName }, '店铺已注册');
    const saved = this.db.shops.get(discovered.shopId);
    // 防御：add 失败（如约束冲突）时 get 返回 undefined，调用方解引用会崩溃
    if (!saved) {
      throw new Error(`店铺注册后读回失败 shopId=${discovered.shopId}`);
    }
    return saved;
  }

  /**
   * 网页版架构下不再监听 config.json 变化。
   */
  watchConfig(_onChange: () => void): import('fs').FSWatcher | null {
    return null;
  }
}
