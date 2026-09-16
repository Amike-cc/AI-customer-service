/**
 * 学习模式 Repository
 * 存储从优质对话中提取的可复用模式与学习管道运行记录
 */
import type SqliteDatabase from 'better-sqlite3';

export interface LearnedPattern {
  id: number;
  shopId: string;
  questionPattern: string;
  answerTemplate: string;
  questionHash: string;
  matchCount: number;
  feedbackSum: number;
  avgQuality: number;
  sourceAuditIds: string | null;
  status: 'active' | 'deprecated';
  createdAt: number;
  updatedAt: number;
}

export interface LearnedPatternInput {
  shopId: string;
  questionPattern: string;
  answerTemplate: string;
  questionHash: string;
  avgQuality: number;
  sourceAuditIds?: string;
}

export interface LearningRunRecord {
  id: number;
  shopId: string | null;
  startedAt: number;
  completedAt: number;
  collectedCount: number;
  extractedCount: number;
  validatedCount: number;
  status: 'running' | 'completed' | 'failed';
  errorMessage: string | null;
  metricsJson: string | null;
}

export interface LearningRunInput {
  shopId: string | null;
  startedAt: number;
  completedAt: number;
  collectedCount: number;
  extractedCount: number;
  validatedCount: number;
  status: 'running' | 'completed' | 'failed';
  errorMessage?: string;
  metricsJson?: string;
}

export class LearningRepo {
  constructor(private db: SqliteDatabase.Database) {}

  addPattern(input: LearnedPatternInput): number {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO learned_patterns
         (shop_id, question_pattern, answer_template, question_hash,
          match_count, feedback_sum, avg_quality, source_audit_ids,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, 'active', ?, ?)`,
    );
    const result = stmt.run(
      input.shopId,
      input.questionPattern,
      input.answerTemplate,
      input.questionHash,
      input.avgQuality,
      input.sourceAuditIds ?? null,
      now,
      now,
    );
    return Number(result.lastInsertRowid);
  }

  listPatterns(shopId: string, status?: 'active' | 'deprecated'): LearnedPattern[] {
    const sql = status
      ? `SELECT id, shop_id AS shopId, question_pattern AS questionPattern,
           answer_template AS answerTemplate, question_hash AS questionHash,
           match_count AS matchCount, feedback_sum AS feedbackSum,
           avg_quality AS avgQuality, source_audit_ids AS sourceAuditIds,
           status, created_at AS createdAt, updated_at AS updatedAt
         FROM learned_patterns WHERE shop_id = ? AND status = ?
         ORDER BY avg_quality DESC`
      : `SELECT id, shop_id AS shopId, question_pattern AS questionPattern,
           answer_template AS answerTemplate, question_hash AS questionHash,
           match_count AS matchCount, feedback_sum AS feedbackSum,
           avg_quality AS avgQuality, source_audit_ids AS sourceAuditIds,
           status, created_at AS createdAt, updated_at AS updatedAt
         FROM learned_patterns WHERE shop_id = ?
         ORDER BY avg_quality DESC`;
    const params = status ? [shopId, status] : [shopId];
    return this.db.prepare(sql).all(...params) as LearnedPattern[];
  }

  listAllActivePatterns(): LearnedPattern[] {
    return this.db
      .prepare(
        `SELECT id, shop_id AS shopId, question_pattern AS questionPattern,
           answer_template AS answerTemplate, question_hash AS questionHash,
           match_count AS matchCount, feedback_sum AS feedbackSum,
           avg_quality AS avgQuality, source_audit_ids AS sourceAuditIds,
           status, created_at AS createdAt, updated_at AS updatedAt
         FROM learned_patterns WHERE status = 'active'
         ORDER BY avg_quality DESC`,
      )
      .all() as LearnedPattern[];
  }

  getPatternByHash(shopId: string, hash: string): LearnedPattern | null {
    const row = this.db
      .prepare(
        `SELECT id, shop_id AS shopId, question_pattern AS questionPattern,
           answer_template AS answerTemplate, question_hash AS questionHash,
           match_count AS matchCount, feedback_sum AS feedbackSum,
           avg_quality AS avgQuality, source_audit_ids AS sourceAuditIds,
           status, created_at AS createdAt, updated_at AS updatedAt
         FROM learned_patterns WHERE shop_id = ? AND question_hash = ?`,
      )
      .get(shopId, hash) as LearnedPattern | undefined;
    return row ?? null;
  }

  updatePatternStats(id: number, matchCount: number, feedbackSum: number): void {
    this.db
      .prepare(
        `UPDATE learned_patterns
         SET match_count = ?, feedback_sum = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(matchCount, feedbackSum, Date.now(), id);
  }

  updatePatternQuality(id: number, avgQuality: number, answerTemplate: string, sourceAuditIds: string): void {
    this.db
      .prepare(
        `UPDATE learned_patterns
         SET avg_quality = ?, answer_template = ?, source_audit_ids = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(avgQuality, answerTemplate, sourceAuditIds, Date.now(), id);
  }

  incrementMatchCount(id: number): void {
    this.db
      .prepare(
        `UPDATE learned_patterns
         SET match_count = match_count + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  addFeedback(id: number, rating: number): void {
    this.db
      .prepare(
        `UPDATE learned_patterns
         SET feedback_sum = feedback_sum + ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(rating, Date.now(), id);
  }

  deprecatePattern(id: number): void {
    this.db
      .prepare(
        `UPDATE learned_patterns SET status = 'deprecated', updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  deprecateStalePatterns(olderThanMs: number): number {
    const threshold = Date.now() - olderThanMs;
    const result = this.db
      .prepare(
        `UPDATE learned_patterns
         SET status = 'deprecated', updated_at = ?
         WHERE status = 'active' AND match_count = 0 AND created_at < ?`,
      )
      .run(Date.now(), threshold);
    return Number(result.changes);
  }

  countActivePatterns(shopId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM learned_patterns WHERE shop_id = ? AND status = 'active'`,
      )
      .get(shopId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  addRun(input: LearningRunInput): number {
    const stmt = this.db.prepare(
      `INSERT INTO learning_runs
         (shop_id, started_at, completed_at, collected_count, extracted_count,
          validated_count, status, error_message, metrics_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      input.shopId,
      input.startedAt,
      input.completedAt,
      input.collectedCount,
      input.extractedCount,
      input.validatedCount,
      input.status,
      input.errorMessage ?? null,
      input.metricsJson ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  updateRun(
    id: number,
    updates: {
      completedAt?: number;
      collectedCount?: number;
      extractedCount?: number;
      validatedCount?: number;
      status?: 'running' | 'completed' | 'failed';
      errorMessage?: string;
      metricsJson?: string;
    },
  ): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (updates.completedAt !== undefined) {
      sets.push('completed_at = ?');
      params.push(updates.completedAt);
    }
    if (updates.collectedCount !== undefined) {
      sets.push('collected_count = ?');
      params.push(updates.collectedCount);
    }
    if (updates.extractedCount !== undefined) {
      sets.push('extracted_count = ?');
      params.push(updates.extractedCount);
    }
    if (updates.validatedCount !== undefined) {
      sets.push('validated_count = ?');
      params.push(updates.validatedCount);
    }
    if (updates.status !== undefined) {
      sets.push('status = ?');
      params.push(updates.status);
    }
    if (updates.errorMessage !== undefined) {
      sets.push('error_message = ?');
      params.push(updates.errorMessage);
    }
    if (updates.metricsJson !== undefined) {
      sets.push('metrics_json = ?');
      params.push(updates.metricsJson);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE learning_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  listRuns(shopId?: string | null, limit = 10): LearningRunRecord[] {
    const sql = shopId
      ? `SELECT id, shop_id AS shopId, started_at AS startedAt, completed_at AS completedAt,
           collected_count AS collectedCount, extracted_count AS extractedCount,
           validated_count AS validatedCount, status, error_message AS errorMessage,
           metrics_json AS metricsJson
         FROM learning_runs WHERE shop_id = ? ORDER BY started_at DESC LIMIT ?`
      : `SELECT id, shop_id AS shopId, started_at AS startedAt, completed_at AS completedAt,
           collected_count AS collectedCount, extracted_count AS extractedCount,
           validated_count AS validatedCount, status, error_message AS errorMessage,
           metrics_json AS metricsJson
         FROM learning_runs ORDER BY started_at DESC LIMIT ?`;
    const params = shopId ? [shopId, limit] : [limit];
    return this.db.prepare(sql).all(...params) as LearningRunRecord[];
  }
}
