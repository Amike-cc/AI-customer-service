/**
 * AI 回复审计 Repository
 * 详见 docs/17-数据持久化与配置管理.md §17.4.4
 * 合规要求：保留 6 个月
 */
import { createHash } from 'crypto';
import type SqliteDatabase from 'better-sqlite3';

export interface AuditRecord {
  shopId: string;
  sessionId: string;
  userMessage: string;
  aiReply: string;
  modelVersion: string;
  promptHash: string;
  productId?: string;
  tokenInput?: number;
  tokenOutput?: number;
  latencyMs?: number;
  confidence?: number;
}

export interface AuditRecordWithMeta extends AuditRecord {
  id: number;
  createdAt: number;
  prevHash?: string | null;
}

export interface ChainVerifyResult {
  valid: boolean;
  brokenAt?: number;
}

export class AuditRepo {
  constructor(private db: SqliteDatabase.Database) {}

  add(record: AuditRecord): number {
    const createdAt = Date.now();

    const lastRow = this.db
      .prepare(
        `SELECT prev_hash AS prevHash FROM ai_reply_audit
         WHERE shop_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(record.shopId) as { prevHash: string | null } | undefined;
    const prevHash = lastRow?.prevHash ?? '';

    const hashInput = [
      record.shopId,
      record.sessionId,
      record.userMessage,
      record.aiReply,
      String(createdAt),
      prevHash,
    ].join('|');
    const currentHash = createHash('sha256').update(hashInput).digest('hex');

    const stmt = this.db.prepare(
      `INSERT INTO ai_reply_audit (shop_id, session_id, user_message, ai_reply,
        model_version, prompt_hash, product_id, token_input, token_output,
        latency_ms, confidence, created_at, prev_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      record.shopId,
      record.sessionId,
      record.userMessage,
      record.aiReply,
      record.modelVersion,
      record.promptHash,
      record.productId ?? null,
      record.tokenInput ?? null,
      record.tokenOutput ?? null,
      record.latencyMs ?? null,
      record.confidence ?? null,
      createdAt,
      currentHash,
    );
    return Number(result.lastInsertRowid);
  }

  /** 按 id 精确查询审计记录（含所属店铺，用于反馈归属校验） */
  findById(id: number): AuditRecordWithMeta | null {
    const row = this.db
      .prepare(
        `SELECT id, shop_id AS shopId, session_id AS sessionId, user_message AS userMessage,
           ai_reply AS aiReply, model_version AS modelVersion, prompt_hash AS promptHash,
           product_id AS productId, token_input AS tokenInput, token_output AS tokenOutput,
           latency_ms AS latencyMs, confidence, created_at AS createdAt, prev_hash AS prevHash
         FROM ai_reply_audit WHERE id = ? LIMIT 1`,
      )
      .get(id) as AuditRecordWithMeta | undefined;
    return row ?? null;
  }

  /** 查询指定店铺最近的审计记录 */
  listRecent(shopId: string, limit: number = 50): AuditRecordWithMeta[] {
    return this.db
      .prepare(
        `SELECT id, shop_id AS shopId, session_id AS sessionId, user_message AS userMessage,
           ai_reply AS aiReply, model_version AS modelVersion, prompt_hash AS promptHash,
           product_id AS productId, token_input AS tokenInput, token_output AS tokenOutput,
           latency_ms AS latencyMs, confidence, created_at AS createdAt, prev_hash AS prevHash
         FROM ai_reply_audit WHERE shop_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(shopId, limit) as AuditRecordWithMeta[];
  }

  /** 查询指定店铺自某时间点起的审计记录（用于学习管道采集） */
  listRecentSince(shopId: string, sinceMs: number, limit: number = 1000): AuditRecordWithMeta[] {
    return this.db
      .prepare(
        `SELECT id, shop_id AS shopId, session_id AS sessionId, user_message AS userMessage,
           ai_reply AS aiReply, model_version AS modelVersion, prompt_hash AS promptHash,
           product_id AS productId, token_input AS tokenInput, token_output AS tokenOutput,
           latency_ms AS latencyMs, confidence, created_at AS createdAt, prev_hash AS prevHash
         FROM ai_reply_audit
         WHERE shop_id = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(shopId, sinceMs, limit) as AuditRecordWithMeta[];
  }

  /** 查询所有店铺自某时间点起的审计记录（用于学习管道采集全部店铺） */
  listSince(sinceMs: number): AuditRecordWithMeta[] {
    return this.db
      .prepare(
        `SELECT id, shop_id AS shopId, session_id AS sessionId, user_message AS userMessage,
           ai_reply AS aiReply, model_version AS modelVersion, prompt_hash AS promptHash,
           product_id AS productId, token_input AS tokenInput, token_output AS tokenOutput,
           latency_ms AS latencyMs, confidence, created_at AS createdAt, prev_hash AS prevHash
         FROM ai_reply_audit
         WHERE created_at >= ?
         ORDER BY created_at DESC`,
      )
      .all(sinceMs) as AuditRecordWithMeta[];
  }

  /** 验证审计链哈希完整性 */
  verifyChain(shopId: string, limit: number = 100): ChainVerifyResult {
    const records = this.db
      .prepare(
        `SELECT id, shop_id AS shopId, session_id AS sessionId, user_message AS userMessage,
           ai_reply AS aiReply, created_at AS createdAt, prev_hash AS prevHash
         FROM ai_reply_audit WHERE shop_id = ? ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(shopId, limit) as Array<{
        id: number;
        shopId: string;
        sessionId: string;
        userMessage: string;
        aiReply: string;
        createdAt: number;
        prevHash: string | null;
      }>;

    let expectedPrevHash = '';
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (i === 0) {
        // 链头记录：cleanup() 清理旧记录后，最早存活记录的 prev_hash 指向已删除前驱，
        // 从空串起算必然不匹配导致永久假阳性。因此链头不验证 prevHash（其本身仍参与下一条的哈希），
        // 中间记录的篡改依然会被检测。
        expectedPrevHash = r.prevHash ?? '';
        continue;
      }
      const hashInput = [
        r.shopId,
        r.sessionId,
        r.userMessage,
        r.aiReply,
        String(r.createdAt),
        expectedPrevHash,
      ].join('|');
      const computedHash = createHash('sha256').update(hashInput).digest('hex');
      if (computedHash !== r.prevHash) {
        return { valid: false, brokenAt: r.id };
      }
      expectedPrevHash = r.prevHash!;
    }
    return { valid: true };
  }

  /** 清理过期审计记录（合规要求保留 180 天） */
  cleanup(olderThanMs: number): number {
    const threshold = Date.now() - olderThanMs;
    // 原子清理：先删引用 audit 的子表（dialogue_feedback/quality_scores 外键无级联，
    // 不先删会触发 SQLITE_CONSTRAINT_FOREIGNKEY 导致清理永久失败）
    const cleanup = this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM dialogue_feedback WHERE audit_id IN (
             SELECT id FROM ai_reply_audit WHERE created_at < ?
           )`,
        )
        .run(threshold);
      this.db
        .prepare(
          `DELETE FROM quality_scores WHERE audit_id IN (
             SELECT id FROM ai_reply_audit WHERE created_at < ?
           )`,
        )
        .run(threshold);
      return Number(
        this.db.prepare(`DELETE FROM ai_reply_audit WHERE created_at < ?`).run(threshold).changes,
      );
    });
    return cleanup();
  }

  /**
   * 查询自指定时间起的平均 API 延迟（毫秒）
   * 直接从 ai_reply_audit.latency_ms 字段计算，比通过 metrics 表的
   * api_latency_ms_avg 聚合更准确（每条调用一个真实延迟值，非按 flush 平均）
   */
  avgLatencySince(sinceMs: number, shopId?: string): number {
    const sql = shopId
      ? `SELECT AVG(latency_ms) AS avg FROM ai_reply_audit
         WHERE shop_id = ? AND created_at >= ? AND latency_ms IS NOT NULL`
      : `SELECT AVG(latency_ms) AS avg FROM ai_reply_audit
         WHERE created_at >= ? AND latency_ms IS NOT NULL`;
    const params = shopId ? [shopId, sinceMs] : [sinceMs];
    const row = this.db.prepare(sql).get(...params) as { avg: number | null };
    return row.avg ? Math.round(row.avg) : 0;
  }

  /**
   * 查询自指定时间起的总回复数（用于辅助 metrics.summary 准确性）
   * 从 ai_reply_audit 表统计，每行代表一次真实 AI 回复
   */
  countSince(sinceMs: number, shopId?: string): number {
    const sql = shopId
      ? `SELECT COUNT(*) AS cnt FROM ai_reply_audit
         WHERE shop_id = ? AND created_at >= ?`
      : `SELECT COUNT(*) AS cnt FROM ai_reply_audit
         WHERE created_at >= ?`;
    const params = shopId ? [shopId, sinceMs] : [sinceMs];
    const row = this.db.prepare(sql).get(...params) as { cnt: number };
    return row.cnt ?? 0;
  }
}
