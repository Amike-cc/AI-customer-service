/**
 * 会话草稿 Repository
 *
 * 按 shopId + sessionId 保存人工草稿，切换会话后仍可恢复，互不串草稿。
 *
 * 表结构（见 Database.migrate）：
 *   conversation_drafts(shop_id, session_id, draft, updated_at)
 */
import type SqliteDatabase from 'better-sqlite3';

export interface ConversationDraft {
  shopId: string;
  sessionId: string;
  draft: string;
  updatedAt: number;
}

interface Row {
  shop_id: string;
  session_id: string;
  draft: string;
  updated_at: number;
}

export class ConversationDraftRepo {
  constructor(private db: SqliteDatabase.Database) {}

  get(shopId: string, sessionId: string): ConversationDraft | null {
    const row = this.db
      .prepare(
        `SELECT * FROM conversation_drafts WHERE shop_id = ? AND session_id = ? LIMIT 1`,
      )
      .get(shopId, sessionId) as Row | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** 保存草稿；空草稿删除记录，避免堆积 */
  save(shopId: string, sessionId: string, draft: string): void {
    if (!draft) {
      this.delete(shopId, sessionId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO conversation_drafts (shop_id, session_id, draft, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(shop_id, session_id) DO UPDATE SET
           draft = excluded.draft,
           updated_at = excluded.updated_at`,
      )
      .run(shopId, sessionId, draft, Date.now());
  }

  delete(shopId: string, sessionId: string): void {
    this.db
      .prepare('DELETE FROM conversation_drafts WHERE shop_id = ? AND session_id = ?')
      .run(shopId, sessionId);
  }

  deleteByShop(shopId: string): number {
    return Number(
      this.db.prepare('DELETE FROM conversation_drafts WHERE shop_id = ?').run(shopId).changes,
    );
  }

  private mapRow(r: Row): ConversationDraft {
    return {
      shopId: r.shop_id,
      sessionId: r.session_id,
      draft: r.draft,
      updatedAt: r.updated_at,
    };
  }
}
