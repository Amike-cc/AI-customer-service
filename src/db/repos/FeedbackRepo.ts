/**
 * 对话反馈 Repository
 * 存储用户对 AI 回复的 👍/👎 反馈与文本备注
 */
import type SqliteDatabase from 'better-sqlite3';

export interface FeedbackRecord {
  id: number;
  auditId: number;
  shopId: string;
  sessionId: string;
  rating: number; // 1=赞, -1=踩
  comment: string | null;
  createdAt: number;
}

export interface FeedbackStats {
  total: number;
  positive: number;
  negative: number;
  positiveRate: number; // 0-1
}

export class FeedbackRepo {
  constructor(private db: SqliteDatabase.Database) {}

  add(input: {
    auditId: number;
    shopId: string;
    sessionId: string;
    rating: number;
    comment?: string;
  }): number {
    // 同一 audit 只保留一条反馈（重复 👍/👎 会污染 AccuracyMonitor 统计）：
    // 原子 upsert，避免先查后插的并发竞态
    const stmt = this.db.prepare(
      `INSERT INTO dialogue_feedback (audit_id, shop_id, session_id, rating, comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(audit_id) DO UPDATE SET
         rating = excluded.rating,
         comment = excluded.comment,
         created_at = excluded.created_at`,
    );
    const result = stmt.run(
      input.auditId,
      input.shopId,
      input.sessionId,
      input.rating,
      input.comment ?? null,
      Date.now(),
    );
    return Number(result.lastInsertRowid);
  }

  listByShop(shopId: string, limit = 100): FeedbackRecord[] {
    return this.db
      .prepare(
        `SELECT id, audit_id AS auditId, shop_id AS shopId, session_id AS sessionId,
           rating, comment, created_at AS createdAt
         FROM dialogue_feedback WHERE shop_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(shopId, limit) as FeedbackRecord[];
  }

  getByAudit(auditId: number): FeedbackRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, audit_id AS auditId, shop_id AS shopId, session_id AS sessionId,
           rating, comment, created_at AS createdAt
         FROM dialogue_feedback WHERE audit_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(auditId) as FeedbackRecord | undefined;
    return row ?? null;
  }

  getStats(shopId: string): FeedbackStats {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN rating > 0 THEN 1 ELSE 0 END) AS positive,
           SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END) AS negative
         FROM dialogue_feedback WHERE shop_id = ?`,
      )
      .get(shopId) as { total: number; positive: number | null; negative: number | null } | undefined;

    const total = row?.total ?? 0;
    const positive = row?.positive ?? 0;
    const negative = row?.negative ?? 0;
    return {
      total,
      positive,
      negative,
      positiveRate: total > 0 ? positive / total : 0,
    };
  }
}
