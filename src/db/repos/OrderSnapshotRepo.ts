/**
 * 订单快照 Repository（只读缓存）
 *
 * 工作台订单入口只读展示摘要和平台原页 URL，不提供发货/退款/改价等交易写操作。
 *
 * 表结构（见 Database.migrate）：
 *   order_snapshots(shop_id, session_id, order_ref, summary, platform_url,
 *                   captured_at, PRIMARY KEY(shop_id, session_id, order_ref))
 */
import type SqliteDatabase from 'better-sqlite3';

export interface OrderSnapshot {
  shopId: string;
  sessionId: string;
  orderRef: string;
  summary: string;
  platformUrl: string | null;
  capturedAt: number;
}

interface Row {
  shop_id: string;
  session_id: string;
  order_ref: string;
  summary: string;
  platform_url: string | null;
  captured_at: number;
}

export class OrderSnapshotRepo {
  constructor(private db: SqliteDatabase.Database) {}

  get(shopId: string, sessionId: string, orderRef: string): OrderSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT * FROM order_snapshots
         WHERE shop_id = ? AND session_id = ? AND order_ref = ? LIMIT 1`,
      )
      .get(shopId, sessionId, orderRef) as Row | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** 按订单号或摘要检索缓存订单，供全局搜索使用；只读，不触发平台请求。 */
  search(shopIds: string[], keyword: string, limit: number): OrderSnapshot[] {
    if (shopIds.length === 0 || !keyword.trim() || limit <= 0) return [];
    const placeholders = shopIds.map(() => '?').join(',');
    const pattern = `%${keyword.trim()}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM order_snapshots
         WHERE shop_id IN (${placeholders})
           AND (order_ref LIKE ? OR summary LIKE ?)
         ORDER BY captured_at DESC LIMIT ?`,
      )
      .all(...shopIds, pattern, pattern, Math.min(limit, 100)) as Row[];
    return rows.map((row) => this.mapRow(row));
  }

  upsert(input: {
    shopId: string;
    sessionId: string;
    orderRef: string;
    summary: string;
    platformUrl?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO order_snapshots
           (shop_id, session_id, order_ref, summary, platform_url, captured_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, session_id, order_ref) DO UPDATE SET
           summary = excluded.summary,
           platform_url = excluded.platform_url,
           captured_at = excluded.captured_at`,
      )
      .run(
        input.shopId,
        input.sessionId,
        input.orderRef,
        input.summary,
        input.platformUrl ?? null,
        Date.now(),
      );
  }

  deleteByShop(shopId: string): number {
    return Number(
      this.db.prepare('DELETE FROM order_snapshots WHERE shop_id = ?').run(shopId).changes,
    );
  }

  private mapRow(r: Row): OrderSnapshot {
    return {
      shopId: r.shop_id,
      sessionId: r.session_id,
      orderRef: r.order_ref,
      summary: r.summary,
      platformUrl: r.platform_url,
      capturedAt: r.captured_at,
    };
  }
}
