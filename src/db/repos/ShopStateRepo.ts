/**
 * 店铺状态 Repository
 * 详见 docs/17-数据持久化与配置管理.md §17.4.2
 */
import type SqliteDatabase from 'better-sqlite3';
import type { StateName } from '../../state/ShopStateMachine';

export interface ShopStateRecord {
  shopId: string;
  currentState: StateName;
  previousState: string | null;
  enteredAt: number;
  silentWaitCount: number;
  cdpRecoverAttempts: number;
  lastMessageAt: number | null;
  contextVersion: number;
  unreadCount: number;
  updatedAt: number;
}

export class ShopStateRepo {
  constructor(private db: SqliteDatabase.Database) {}

  upsert(record: Omit<ShopStateRecord, 'updatedAt' | 'unreadCount'> & { unreadCount?: number }): void {
    const stmt = this.db.prepare(
      `INSERT INTO shop_state (shop_id, current_state, previous_state, entered_at,
        silent_wait_count, cdp_recover_attempts, last_message_at, context_version, unread_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(shop_id) DO UPDATE SET
         current_state = excluded.current_state,
         previous_state = excluded.previous_state,
         entered_at = excluded.entered_at,
         silent_wait_count = excluded.silent_wait_count,
         cdp_recover_attempts = excluded.cdp_recover_attempts,
         last_message_at = excluded.last_message_at,
         context_version = excluded.context_version,
         unread_count = excluded.unread_count,
         updated_at = excluded.updated_at`,
    );
    stmt.run(
      record.shopId,
      record.currentState,
      record.previousState,
      record.enteredAt,
      record.silentWaitCount,
      record.cdpRecoverAttempts,
      record.lastMessageAt,
      record.contextVersion,
      record.unreadCount ?? 0,
      Date.now(),
    );
  }

  get(shopId: string): ShopStateRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM shop_state WHERE shop_id = ?`);
    const row = stmt.get(shopId) as
      | {
          shop_id: string;
          current_state: string;
          previous_state: string | null;
          entered_at: number;
          silent_wait_count: number;
          cdp_recover_attempts: number;
          last_message_at: number | null;
          context_version: number;
          unread_count: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      shopId: row.shop_id,
      currentState: row.current_state as StateName,
      previousState: row.previous_state,
      enteredAt: row.entered_at,
      silentWaitCount: row.silent_wait_count,
      cdpRecoverAttempts: row.cdp_recover_attempts,
      lastMessageAt: row.last_message_at,
      contextVersion: row.context_version,
      unreadCount: row.unread_count ?? 0,
      updatedAt: row.updated_at,
    };
  }

  updateLastMessageAt(shopId: string, timestamp: number): void {
    this.db
      .prepare(`UPDATE shop_state SET last_message_at = ?, updated_at = ? WHERE shop_id = ?`)
      .run(timestamp, Date.now(), shopId);
  }

  incrementUnread(shopId: string): void {
    this.db
      .prepare(`UPDATE shop_state SET unread_count = unread_count + 1, updated_at = ? WHERE shop_id = ?`)
      .run(Date.now(), shopId);
  }

  markRead(shopId: string): void {
    this.db
      .prepare(`UPDATE shop_state SET unread_count = 0, updated_at = ? WHERE shop_id = ?`)
      .run(Date.now(), shopId);
  }

  delete(shopId: string): void {
    this.db.prepare(`DELETE FROM shop_state WHERE shop_id = ?`).run(shopId);
  }
}
