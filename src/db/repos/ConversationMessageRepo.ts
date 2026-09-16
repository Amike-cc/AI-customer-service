/**
 * 平台消息 Repository
 *
 * 统一工作台的独立平台消息模型。以 messageId 幂等写入，保留方向、来源和回执。
 * 与 conversation_context（仅用于 LLM 上下文）区分开。
 *
 * 表结构（见 Database.migrate）：
 *   conversation_messages(id, shop_id, session_id, message_id, direction,
 *                         source, content, status, platform_ref, created_at)
 */
import type SqliteDatabase from 'better-sqlite3';

export type MessageDirection = 'in' | 'out';

export interface ConversationMessageRecord {
  id: number;
  shopId: string;
  sessionId: string;
  messageId: string;
  direction: MessageDirection;
  source: string;
  content: string;
  status: string;
  platformRef: string | null;
  createdAt: number;
}

export interface PlatformSessionSummary {
  sessionId: string;
  lastMessageAt: number;
  messageCount: number;
  /** 最近一条平台消息方向，用于会话未读筛选。 */
  lastDirection?: MessageDirection;
  /** 会话是否出现过人工发送消息。 */
  hasManual?: boolean;
}

interface Row {
  id: number;
  shop_id: string;
  session_id: string;
  message_id: string;
  direction: string;
  source: string;
  content: string;
  status: string;
  platform_ref: string | null;
  created_at: number;
}

/**
 * 合并 LLM 上下文会话与平台消息会话，得到工作台会话列表（纯函数，便于单测）。
 * 同一 sessionId 取较新的 lastMessageAt，messageCount 相加。
 */
export function mergePlatformSessions(
  contextSessions: PlatformSessionSummary[],
  messageSessions: PlatformSessionSummary[],
  limit = 50,
): PlatformSessionSummary[] {
  const merged = new Map<string, PlatformSessionSummary>();
  for (const s of contextSessions) {
    merged.set(s.sessionId, { ...s });
  }
  for (const m of messageSessions) {
    const prev = merged.get(m.sessionId);
    if (!prev) {
      merged.set(m.sessionId, { ...m });
    } else {
      const messageIsNewer = m.lastMessageAt >= prev.lastMessageAt;
      prev.lastMessageAt = Math.max(prev.lastMessageAt, m.lastMessageAt);
      prev.messageCount += m.messageCount;
      if (messageIsNewer && m.lastDirection !== undefined) prev.lastDirection = m.lastDirection;
      if ('hasManual' in m || 'hasManual' in prev) prev.hasManual = Boolean(prev.hasManual || m.hasManual);
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .slice(0, limit);
}

export class ConversationMessageRepo {
  constructor(private db: SqliteDatabase.Database) {}

  /** 按 messageId 幂等写入，重复写入不产生新行也不覆盖已有内容 */
  upsert(input: {
    shopId: string;
    sessionId: string;
    messageId: string;
    direction: MessageDirection;
    source: string;
    content: string;
    status?: string;
    platformRef?: string;
    createdAt?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO conversation_messages
           (shop_id, session_id, message_id, direction, source, content, status, platform_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, session_id, message_id) DO NOTHING`,
      )
      .run(
        input.shopId,
        input.sessionId,
        input.messageId,
        input.direction,
        input.source,
        input.content,
        input.status ?? 'sent',
        input.platformRef ?? null,
        input.createdAt ?? Date.now(),
      );
  }

  /** 按会话查询消息，afterMessageId 用于断线补齐（按 id 递增翻页） */
  listBySession(
    shopId: string,
    sessionId: string,
    limit = 100,
    afterId?: number,
  ): ConversationMessageRecord[] {
    const rows = afterId
      ? (this.db
          .prepare(
            `SELECT * FROM conversation_messages
             WHERE shop_id = ? AND session_id = ? AND id > ?
             ORDER BY id ASC LIMIT ?`,
          )
          .all(shopId, sessionId, afterId, limit) as Row[])
      : (this.db
          .prepare(
            `SELECT * FROM conversation_messages
             WHERE shop_id = ? AND session_id = ?
             ORDER BY id DESC LIMIT ?`,
          )
          .all(shopId, sessionId, limit) as Row[]);
    return rows.map((r) => this.mapRow(r));
  }

  /** 按会话聚合最近消息（用于工作台会话列表） */
  listRecentSessions(
    shopId: string,
    limit = 50,
  ): PlatformSessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT session_id AS sessionId,
                MAX(created_at) AS lastMessageAt,
                COUNT(*) AS messageCount,
                (SELECT direction FROM conversation_messages AS latest
                 WHERE latest.shop_id = conversation_messages.shop_id
                   AND latest.session_id = conversation_messages.session_id
                 ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1) AS lastDirection,
                MAX(CASE WHEN source = 'manual' THEN 1 ELSE 0 END) AS hasManual
         FROM conversation_messages
         WHERE shop_id = ?
         GROUP BY session_id
         ORDER BY lastMessageAt DESC
         LIMIT ?`,
      )
      .all(shopId, limit) as Array<{
        sessionId: string;
        lastMessageAt: number;
        messageCount: number;
        lastDirection: MessageDirection | null;
        hasManual: number;
      }>;
    return rows.map((row) => ({
        sessionId: row.sessionId,
        lastMessageAt: row.lastMessageAt,
        messageCount: row.messageCount,
        ...(row.lastDirection ? { lastDirection: row.lastDirection } : {}),
        hasManual: row.hasManual === 1,
      }));
  }

  search(shopId: string, keyword: string, limit = 50): ConversationMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_messages
         WHERE shop_id = ? AND content LIKE ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(shopId, `%${keyword}%`, limit) as Row[];
    return rows.map((r) => this.mapRow(r));
  }

  deleteByShop(shopId: string): number {
    return Number(
      this.db.prepare('DELETE FROM conversation_messages WHERE shop_id = ?').run(shopId).changes,
    );
  }

  private mapRow(r: Row): ConversationMessageRecord {
    return {
      id: r.id,
      shopId: r.shop_id,
      sessionId: r.session_id,
      messageId: r.message_id,
      direction: r.direction as MessageDirection,
      source: r.source,
      content: r.content,
      status: r.status,
      platformRef: r.platform_ref,
      createdAt: r.created_at,
    };
  }
}
