/**
 * 消息 outbox Repository
 *
 * 记录人工/自动发送请求的生命周期，用 clientMessageId 保证幂等：
 * 相同 clientMessageId 的重复请求直接返回原回执，不会向平台重复发送。
 *
 * 表结构（见 Database.migrate）：
 *   message_outbox(id, shop_id, session_id, client_message_id, direction,
 *                  content, status, error, created_at, updated_at, sent_at)
 */
import type SqliteDatabase from 'better-sqlite3';

export type OutboxStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'pending_confirmation';

export interface MessageOutboxRecord {
  id: number;
  shopId: string;
  sessionId: string;
  clientMessageId: string;
  direction: string;
  content: string;
  status: OutboxStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
}

interface OutboxRow {
  id: number;
  shop_id: string;
  session_id: string;
  client_message_id: string;
  direction: string;
  content: string;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
}

export class MessageOutboxRepo {
  constructor(private db: SqliteDatabase.Database) {}

  findByClientMessageId(
    shopId: string,
    clientMessageId: string,
  ): MessageOutboxRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM message_outbox
         WHERE shop_id = ? AND client_message_id = ?
         LIMIT 1`,
      )
      .get(shopId, clientMessageId) as OutboxRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** 原子占位：仅当 clientMessageId 不存在时插入一条 queued 记录。返回是否为新建。 */
  enqueue(input: {
    shopId: string;
    sessionId: string;
    clientMessageId: string;
    direction: string;
    content: string;
  }): { created: boolean; record: MessageOutboxRecord } {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO message_outbox
           (shop_id, session_id, client_message_id, direction, content, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
         ON CONFLICT(shop_id, client_message_id) DO NOTHING`,
      )
      .run(
        input.shopId,
        input.sessionId,
        input.clientMessageId,
        input.direction,
        input.content,
        now,
        now,
      );
    const record = this.findByClientMessageId(input.shopId, input.clientMessageId)!;
    return { created: result.changes > 0, record };
  }

  markStatus(
    shopId: string,
    clientMessageId: string,
    status: OutboxStatus,
    error?: string,
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE message_outbox
         SET status = ?, error = ?, updated_at = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END
         WHERE shop_id = ? AND client_message_id = ?`,
      )
      .run(status, error ?? null, now, status, now, shopId, clientMessageId);
  }

  listBySession(shopId: string, sessionId: string, limit = 100): MessageOutboxRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM message_outbox
         WHERE shop_id = ? AND session_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(shopId, sessionId, limit) as OutboxRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /** 崩溃恢复：把卡在 sending 的记录重置为 pending_confirmation，避免直接重发造成重复消息 */
  recoverStuckSending(olderThanMs: number): number {
    const threshold = Date.now() - olderThanMs;
    const r = this.db
      .prepare(
        `UPDATE message_outbox
         SET status = 'pending_confirmation', updated_at = ?
         WHERE status = 'sending' AND updated_at < ?`,
      )
      .run(Date.now(), threshold);
    return r.changes;
  }

  cleanup(olderThanMs: number): number {
    const threshold = Date.now() - olderThanMs;
    return Number(
      this.db.prepare('DELETE FROM message_outbox WHERE updated_at < ?').run(threshold).changes,
    );
  }

  private mapRow(r: OutboxRow): MessageOutboxRecord {
    return {
      id: r.id,
      shopId: r.shop_id,
      sessionId: r.session_id,
      clientMessageId: r.client_message_id,
      direction: r.direction,
      content: r.content,
      status: r.status as OutboxStatus,
      error: r.error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      sentAt: r.sent_at,
    };
  }
}
