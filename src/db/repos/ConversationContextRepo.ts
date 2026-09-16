/**
 * 对话上下文 Repository
 * 详见 docs/17-数据持久化与配置管理.md §17.4.1
 */
import type SqliteDatabase from 'better-sqlite3';

export interface ConversationMessage {
  id: number;
  shopId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  productId?: string;
  tokenCount?: number;
  createdAt: number;
}

export class ConversationContextRepo {
  constructor(private db: SqliteDatabase.Database) {}

  add(msg: Omit<ConversationMessage, 'id' | 'createdAt'>): number {
    const stmt = this.db.prepare(
      `INSERT INTO conversation_context (shop_id, session_id, role, content, product_id, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      msg.shopId,
      msg.sessionId,
      msg.role,
      msg.content,
      msg.productId ?? null,
      msg.tokenCount ?? null,
      Date.now(),
    );
    return Number(result.lastInsertRowid);
  }

  /** 获取最近 N 轮对话（user+assistant 配对算 1 轮） */
  getRecent(shopId: string, sessionId: string, rounds: number): ConversationMessage[] {
    const stmt = this.db.prepare(
      `SELECT * FROM conversation_context
       WHERE shop_id = ? AND session_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    );
    const rows = stmt.all(shopId, sessionId, rounds * 2) as Array<Omit<ConversationMessage, 'shopId' | 'sessionId'> & {
      shop_id: string;
      session_id: string;
      product_id: string | null;
      token_count: number | null;
      created_at: number;
    }>;
    return rows
      .map((r) => ({
        id: r.id,
        shopId: r.shop_id,
        sessionId: r.session_id,
        role: r.role as ConversationMessage['role'],
        content: r.content,
        productId: r.product_id ?? undefined,
        tokenCount: r.token_count ?? undefined,
        createdAt: r.created_at,
      }))
      .reverse();
  }

  /** 获取会话最后一条消息时间 */
  getLastMessageAt(shopId: string, sessionId: string): number | null {
    const stmt = this.db.prepare(
      `SELECT MAX(created_at) AS last_at FROM conversation_context WHERE shop_id = ? AND session_id = ?`,
    );
    const row = stmt.get(shopId, sessionId) as { last_at: number | null };
    return row.last_at;
  }

  /** 列出店铺的所有会话（按最后活跃时间排序），供 UI 会话查看器使用 */
  listSessions(
    shopId: string,
    limit: number = 50,
  ): Array<{
    sessionId: string;
    messageCount: number;
    lastMessageAt: number;
    productId: string | null;
    lastDirection?: 'in' | 'out';
  }> {
    const rows = this.db
      .prepare(
        `SELECT session_id, COUNT(*) AS message_count, MAX(created_at) AS last_message_at, MAX(product_id) AS product_id
                ,(SELECT role FROM conversation_context AS latest
                  WHERE latest.shop_id = conversation_context.shop_id
                    AND latest.session_id = conversation_context.session_id
                  ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1) AS last_role
         FROM conversation_context WHERE shop_id = ?
         GROUP BY session_id ORDER BY last_message_at DESC LIMIT ?`,
      )
      .all(shopId, limit) as Array<{
        session_id: string;
        message_count: number;
        last_message_at: number;
        product_id: string | null;
        last_role: string | null;
      }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      messageCount: r.message_count,
      lastMessageAt: r.last_message_at,
      productId: r.product_id,
      ...(r.last_role ? { lastDirection: r.last_role === 'user' ? ('in' as const) : ('out' as const) } : {}),
    }));
  }

  /** 获取指定会话的完整消息列表（分页，正向排序），供 UI 会话查看器使用 */
  listMessages(
    shopId: string,
    sessionId: string,
    limit: number = 100,
    offset: number = 0,
  ): ConversationMessage[] {
    const stmt = this.db.prepare(
      `SELECT * FROM conversation_context
       WHERE shop_id = ? AND session_id = ?
       ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`,
    );
    const rows = stmt.all(shopId, sessionId, limit, offset) as Array<
      Omit<ConversationMessage, 'shopId' | 'sessionId'> & {
        shop_id: string;
        session_id: string;
        product_id: string | null;
        token_count: number | null;
        created_at: number;
      }
    >;
    return rows.map((r) => ({
      id: r.id,
      shopId: r.shop_id,
      sessionId: r.session_id,
      role: r.role as ConversationMessage['role'],
      content: r.content,
      productId: r.product_id ?? undefined,
      tokenCount: r.token_count ?? undefined,
      createdAt: r.created_at,
    }));
  }

  /** 搜索指定店铺的消息内容（跨会话） */
  searchMessages(
    shopId: string,
    keyword: string,
    limit: number = 100,
  ): ConversationMessage[] {
    // 转义 LIKE 通配符，避免搜索输入 %/_ 时匹配全部消息
    const escaped = keyword.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    const stmt = this.db.prepare(
      `SELECT * FROM conversation_context
       WHERE shop_id = ? AND content LIKE ? ESCAPE '\\'
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    );
    const rows = stmt.all(shopId, `%${escaped}%`, limit) as Array<
      Omit<ConversationMessage, 'shopId' | 'sessionId'> & {
        shop_id: string;
        session_id: string;
        product_id: string | null;
        token_count: number | null;
        created_at: number;
      }
    >;
    return rows.map((r) => ({
      id: r.id,
      shopId: r.shop_id,
      sessionId: r.session_id,
      role: r.role as ConversationMessage['role'],
      content: r.content,
      productId: r.product_id ?? undefined,
      tokenCount: r.token_count ?? undefined,
      createdAt: r.created_at,
    }));
  }

  /** 清空指定会话上下文 */
  clear(shopId: string, sessionId: string, reason: string = 'manual'): number {
    // 删除与日志写入原子执行，避免中途崩溃导致日志缺失
    const clear = this.db.transaction(() => {
      const result = this.db
        .prepare(`DELETE FROM conversation_context WHERE shop_id = ? AND session_id = ?`)
        .run(shopId, sessionId);
      this.db
        .prepare(
          `INSERT INTO context_clear_log (shop_id, session_id, reason, cleared_at) VALUES (?, ?, ?, ?)`,
        )
        .run(shopId, sessionId, reason, Date.now());
      return Number(result.changes);
    });
    return clear();
  }

  /** 清空指定店铺所有会话上下文 */
  clearAll(shopId: string, reason: string = 'shop_reset'): number {
    // 删除与日志写入原子执行，与 clear() 保持一致
    const clear = this.db.transaction(() => {
      const result = this.db.prepare(`DELETE FROM conversation_context WHERE shop_id = ?`).run(shopId);
      this.db
        .prepare(
          `INSERT INTO context_clear_log (shop_id, session_id, reason, cleared_at) VALUES (?, ?, ?, ?)`,
        )
        .run(shopId, '*', reason, Date.now());
      return Number(result.changes);
    });
    return clear();
  }

  /** 删除指定会话中最后一条匹配内容的用户消息（消息撤回时调用） */
  removeLastUserMessage(shopId: string, sessionId: string, content: string): number {
    const stmt = this.db.prepare(
      `DELETE FROM conversation_context
       WHERE id = (
         SELECT id FROM conversation_context
         WHERE shop_id = ? AND session_id = ? AND role = 'user' AND content = ?
         ORDER BY created_at DESC, id DESC LIMIT 1
       )`,
    );
    return Number(stmt.run(shopId, sessionId, content).changes);
  }

  /** 清理过期上下文（超过指定时长未活跃） */
  cleanupIdle(idleMs: number): number {
    const threshold = Date.now() - idleMs;
    const stmt = this.db.prepare(
      `DELETE FROM conversation_context
       WHERE shop_id || ':' || session_id IN (
         SELECT shop_id || ':' || session_id FROM conversation_context
         GROUP BY shop_id, session_id
         HAVING MAX(created_at) < ?
       )`,
    );
    return Number(stmt.run(threshold).changes);
  }
}
