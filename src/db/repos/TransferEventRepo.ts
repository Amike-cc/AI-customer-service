/**
 * 转接事件 Repository
 *
 * 持久化 requested / succeeded / failed / manual_only 事件，
 * 区分页面级转接（feige adapter）与通用人工接管。
 *
 * 表结构（见 Database.migrate）：
 *   transfer_events(id, shop_id, session_id, event_id, status, kind,
 *                   operator, reason, created_at)
 */
import type SqliteDatabase from 'better-sqlite3';

export type TransferEventStatus = 'requested' | 'succeeded' | 'failed' | 'manual_only';
export type TransferKind = 'page_transfer' | 'manual_takeover';

export interface TransferEvent {
  id: number;
  shopId: string;
  sessionId: string;
  eventId: string;
  status: TransferEventStatus;
  kind: TransferKind;
  operator: string | null;
  reason: string | null;
  createdAt: number;
}

interface Row {
  id: number;
  shop_id: string;
  session_id: string;
  event_id: string;
  status: string;
  kind: string;
  operator: string | null;
  reason: string | null;
  created_at: number;
}

export class TransferEventRepo {
  constructor(private db: SqliteDatabase.Database) {}

  /** 事件与通知使用同一个 eventId，重复写入幂等 */
  add(input: {
    shopId: string;
    sessionId: string;
    eventId: string;
    status: TransferEventStatus;
    kind: TransferKind;
    operator?: string;
    reason?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO transfer_events
           (shop_id, session_id, event_id, status, kind, operator, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, event_id) DO UPDATE SET
           status = excluded.status,
           reason = excluded.reason`,
      )
      .run(
        input.shopId,
        input.sessionId,
        input.eventId,
        input.status,
        input.kind,
        input.operator ?? null,
        input.reason ?? null,
        Date.now(),
      );
  }

  listBySession(shopId: string, sessionId: string, limit = 50): TransferEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM transfer_events
         WHERE shop_id = ? AND session_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(shopId, sessionId, limit) as Row[];
    return rows.map((r) => this.mapRow(r));
  }

  listByShop(shopId: string, limit = 100): TransferEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM transfer_events WHERE shop_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(shopId, limit) as Row[];
    return rows.map((r) => this.mapRow(r));
  }

  deleteByShop(shopId: string): number {
    return Number(
      this.db.prepare('DELETE FROM transfer_events WHERE shop_id = ?').run(shopId).changes,
    );
  }

  private mapRow(r: Row): TransferEvent {
    return {
      id: r.id,
      shopId: r.shop_id,
      sessionId: r.session_id,
      eventId: r.event_id,
      status: r.status as TransferEventStatus,
      kind: r.kind as TransferKind,
      operator: r.operator,
      reason: r.reason,
      createdAt: r.created_at,
    };
  }
}
