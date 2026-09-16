/**
 * 店铺配置 Repository
 */
import type SqliteDatabase from 'better-sqlite3';
import type { PlatformId } from '../../platform';

export type LoginStatus = 'logged_out' | 'logging_in' | 'logged_in';

export interface ShopConfig {
  shopId: string;
  shopName: string;
  platform: PlatformId;
  windowTitlePattern?: string;
  enabled: boolean;
  autoReply: boolean;
  loginStatus: LoginStatus;
  lastLoginAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface ShopConfigRow {
  shop_id: string;
  shop_name: string;
  platform: string;
  feige_client_path: string;
  window_title_pattern: string | null;
  enabled: number;
  auto_reply: number;
  login_status: string;
  last_login_at: number | null;
  created_at: number;
  updated_at: number;
}

export class ShopConfigRepo {
  constructor(private db: SqliteDatabase.Database) {}

  add(config: Omit<ShopConfig, 'createdAt' | 'updatedAt'>): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO shop_config (shop_id, shop_name, platform, feige_client_path, window_title_pattern, enabled, auto_reply, login_status, last_login_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id) DO UPDATE SET
           shop_name = excluded.shop_name,
           platform = excluded.platform,
           window_title_pattern = excluded.window_title_pattern,
           enabled = excluded.enabled,
           auto_reply = COALESCE(excluded.auto_reply, shop_config.auto_reply),
           updated_at = excluded.updated_at`,
      )
      .run(
        config.shopId,
        config.shopName,
        config.platform,
        '',
        config.windowTitlePattern ?? null,
        config.enabled ? 1 : 0,
        config.autoReply ? 1 : 0,
        config.loginStatus,
        config.lastLoginAt,
        now,
        now,
      );
  }

  get(shopId: string): ShopConfig | null {
    const row = this.db
      .prepare(`SELECT * FROM shop_config WHERE shop_id = ?`)
      .get(shopId) as ShopConfigRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  list(): ShopConfig[] {
    const rows = this.db
      .prepare(`SELECT * FROM shop_config WHERE enabled = 1 ORDER BY shop_id`)
      .all() as ShopConfigRow[];
    return rows.map((r) => this.mapRow(r));
  }

  setEnabled(shopId: string, enabled: boolean): void {
    this.db
      .prepare(`UPDATE shop_config SET enabled = ?, updated_at = ? WHERE shop_id = ?`)
      .run(enabled ? 1 : 0, Date.now(), shopId);
  }

  setAutoReply(shopId: string, autoReply: boolean): void {
    this.db
      .prepare(`UPDATE shop_config SET auto_reply = ?, updated_at = ? WHERE shop_id = ?`)
      .run(autoReply ? 1 : 0, Date.now(), shopId);
  }

  setLoginStatus(shopId: string, status: LoginStatus): void {
    this.db
      .prepare(`UPDATE shop_config SET login_status = ?, last_login_at = ?, updated_at = ? WHERE shop_id = ?`)
      .run(status, status === 'logged_in' ? Date.now() : null, Date.now(), shopId);
  }

  rename(shopId: string, newName: string): void {
    this.db
      .prepare(`UPDATE shop_config SET shop_name = ?, updated_at = ? WHERE shop_id = ?`)
      .run(newName, Date.now(), shopId);
  }

  delete(shopId: string): void {
    this.db.prepare(`DELETE FROM shop_config WHERE shop_id = ?`).run(shopId);
  }

  private mapRow(r: ShopConfigRow): ShopConfig {
    return {
      shopId: r.shop_id,
      shopName: r.shop_name,
      platform: (r.platform || 'feige') as PlatformId,
      windowTitlePattern: r.window_title_pattern ?? undefined,
      enabled: r.enabled === 1,
      autoReply: r.auto_reply === 1,
      loginStatus: r.login_status as LoginStatus,
      lastLoginAt: r.last_login_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
