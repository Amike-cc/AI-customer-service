/**
 * 暂存消息 Repository
 *
 * 存储非工作时间收到的买家消息，工作时间开始后由 WorkTimePolicy 批量取出处理。
 *
 * 表结构（见 Database.migrate）：
 *   pending_messages(id, shop_id, session_id, buyer_name, message_text,
 *                    received_at, processed_at)
 */
import type SqliteDatabase from 'better-sqlite3';

export interface PendingMessage {
  id: number;
  shopId: string;
  sessionId: string;
  buyerName: string;
  messageText: string;
  /** 原始消息接收时间戳 */
  receivedAt: number;
  /** 处理完成时间戳，未处理为 null */
  processedAt: number | null;
}

interface PendingMessageRow {
  id: number;
  shop_id: string;
  session_id: string;
  buyer_name: string;
  message_text: string;
  received_at: number;
  processed_at: number | null;
}

export class PendingMessageRepo {
  constructor(private db: SqliteDatabase.Database) {}

  /** 新增一条暂存消息，返回自增 id */
  add(msg: Omit<PendingMessage, 'id' | 'processedAt'>): number {
    const stmt = this.db.prepare(
      `INSERT INTO pending_messages
         (shop_id, session_id, buyer_name, message_text, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    );
    const result = stmt.run(
      msg.shopId,
      msg.sessionId,
      msg.buyerName,
      msg.messageText,
      msg.receivedAt,
    );
    return Number(result.lastInsertRowid);
  }

  /** 查询指定店铺未处理的暂存消息，按 FIFO 顺序 */
  listPending(shopId: string, limit = 100): PendingMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_messages
         WHERE shop_id = ? AND processed_at IS NULL
         ORDER BY received_at ASC
         LIMIT ?`,
      )
      .all(shopId, limit) as PendingMessageRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /** 统计指定店铺未处理消息数 */
  countPending(shopId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM pending_messages
         WHERE shop_id = ? AND processed_at IS NULL`,
      )
      .get(shopId) as { cnt: number };
    return row.cnt;
  }

  /** 标记为已处理 */
  markProcessed(id: number): void {
    this.db
      .prepare(`UPDATE pending_messages SET processed_at = ? WHERE id = ?`)
      .run(Date.now(), id);
  }

  /** 清理指定时间之前的已处理消息（默认 7 天） */
  cleanup(shopId: string, beforeTs: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM pending_messages
         WHERE shop_id = ? AND processed_at IS NOT NULL AND processed_at < ?`,
      )
      .run(shopId, beforeTs);
    return result.changes;
  }

  /** 清理指定店铺全部暂存消息（用于店铺删除） */
  deleteAll(shopId: string): number {
    const result = this.db
      .prepare(`DELETE FROM pending_messages WHERE shop_id = ?`)
      .run(shopId);
    return result.changes;
  }

  private mapRow(r: PendingMessageRow): PendingMessage {
    return {
      id: r.id,
      shopId: r.shop_id,
      sessionId: r.session_id,
      buyerName: r.buyer_name,
      messageText: r.message_text,
      receivedAt: r.received_at,
      processedAt: r.processed_at,
    };
  }
}
