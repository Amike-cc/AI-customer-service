import type SqliteDatabase from 'better-sqlite3';

export interface ReplyGuardInput {
  shopId: string;
  sessionId: string;
  messageKey: string;
  textHash: string;
  messageText: string;
  sourceMessageId?: string;
  repliedAt?: number;
}

/** Persistent record of buyer messages whose replies were actually sent. */
export class ReplyGuardRepo {
  constructor(private db: SqliteDatabase.Database) {}

  has(
    shopId: string,
    sessionId: string,
    messageKey: string,
    textHash: string,
    textMatchSince: number,
  ): boolean {
    const exact = this.db
      .prepare(
        `SELECT 1
         FROM reply_delivery_guard
         WHERE shop_id = ? AND session_id = ? AND message_key = ?
         LIMIT 1`,
      )
      .get(shopId, sessionId, messageKey);
    if (exact) return true;

    const recentTextMatch = this.db
      .prepare(
        `SELECT 1
         FROM reply_delivery_guard
         WHERE shop_id = ? AND session_id = ? AND text_hash = ? AND replied_at >= ?
         LIMIT 1`,
      )
      .get(shopId, sessionId, textHash, textMatchSince);
    return !!recentTextMatch;
  }

  add(input: ReplyGuardInput): void {
    this.db
      .prepare(
        `INSERT INTO reply_delivery_guard
           (shop_id, session_id, message_key, text_hash, message_text,
            source_message_id, replied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, session_id, message_key) DO UPDATE SET
           text_hash = excluded.text_hash,
           message_text = excluded.message_text,
           source_message_id = excluded.source_message_id,
           replied_at = excluded.replied_at`,
      )
      .run(
        input.shopId,
        input.sessionId,
        input.messageKey,
        input.textHash,
        input.messageText,
        input.sourceMessageId ?? null,
        input.repliedAt ?? Date.now(),
      );
  }

  cleanup(olderThanMs: number): number {
    const threshold = Date.now() - olderThanMs;
    return Number(
      this.db.prepare('DELETE FROM reply_delivery_guard WHERE replied_at < ?').run(threshold)
        .changes,
    );
  }

  /** 查询 replyGuard 记录的回复时间戳，不存在返回 null */
  getRepliedAt(shopId: string, sessionId: string, messageKey: string): number | null {
    const row = this.db
      .prepare(
        `SELECT replied_at AS repliedAt
         FROM reply_delivery_guard
         WHERE shop_id = ? AND session_id = ? AND message_key = ?
         LIMIT 1`,
      )
      .get(shopId, sessionId, messageKey) as { repliedAt: number } | undefined;
    return row?.repliedAt ?? null;
  }

  /**
   * 查询 replyGuard 记录的回复时间戳（先按 messageKey 精确查，再按 textHash 模糊查）。
   *
   * 需要双路径查询的原因：loadReplyGuardsFromAudit 重建记录时不带 messageId，
   * 导致 messageKey 基于 text:textHash 生成，与视觉轮询带 messageId 时基于 id:messageId
   * 生成的 messageKey 不同。has() 通过 textHash 后备匹配能找到记录，但 getRepliedAt
   * 按 messageKey 查询会返回 null。
   */
  getRepliedAtAny(
    shopId: string,
    sessionId: string,
    messageKey: string,
    textHash: string,
  ): number | null {
    const exact = this.db
      .prepare(
        `SELECT replied_at AS repliedAt
         FROM reply_delivery_guard
         WHERE shop_id = ? AND session_id = ? AND message_key = ?
         LIMIT 1`,
      )
      .get(shopId, sessionId, messageKey) as { repliedAt: number } | undefined;
    if (exact) return exact.repliedAt;

    const byHash = this.db
      .prepare(
        `SELECT replied_at AS repliedAt
         FROM reply_delivery_guard
         WHERE shop_id = ? AND session_id = ? AND text_hash = ?
         ORDER BY replied_at DESC
         LIMIT 1`,
      )
      .get(shopId, sessionId, textHash) as { repliedAt: number } | undefined;
    return byHash?.repliedAt ?? null;
  }

  /** 删除指定 replyGuard 记录（按 messageKey 和 textHash 同时清除） */
  deleteAny(
    shopId: string,
    sessionId: string,
    messageKey: string,
    textHash: string,
  ): boolean {
    const r1 = this.db
      .prepare(
        `DELETE FROM reply_delivery_guard
         WHERE shop_id = ? AND session_id = ? AND message_key = ?`,
      )
      .run(shopId, sessionId, messageKey);
    const r2 = this.db
      .prepare(
        `DELETE FROM reply_delivery_guard
         WHERE shop_id = ? AND session_id = ? AND text_hash = ?`,
      )
      .run(shopId, sessionId, textHash);
    return r1.changes > 0 || r2.changes > 0;
  }

  /** 删除指定 replyGuard 记录（用于清除陈旧的误判记录） */
  delete(shopId: string, sessionId: string, messageKey: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM reply_delivery_guard
         WHERE shop_id = ? AND session_id = ? AND message_key = ?`,
      )
      .run(shopId, sessionId, messageKey);
    return result.changes > 0;
  }
}
