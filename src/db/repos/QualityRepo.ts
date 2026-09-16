/**
 * 质量评分 Repository
 * 存储每次 AI 回复的 6 维质量评分快照
 */
import type SqliteDatabase from 'better-sqlite3';

export interface QualityScoreRecord {
  id: number;
  auditId: number;
  shopId: string;
  confidenceScore: number;
  latencyScore: number;
  structureScore: number;
  safetyScore: number;
  feedbackScore: number;
  overallScore: number;
  createdAt: number;
}

export interface QualityScoreInput {
  auditId: number;
  shopId: string;
  confidenceScore: number;
  latencyScore: number;
  structureScore: number;
  safetyScore: number;
  feedbackScore: number;
  overallScore: number;
}

export class QualityRepo {
  constructor(private db: SqliteDatabase.Database) {}

  add(input: QualityScoreInput): number {
    const stmt = this.db.prepare(
      `INSERT INTO quality_scores
         (audit_id, shop_id, confidence_score, latency_score, structure_score,
          safety_score, feedback_score, overall_score, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      input.auditId,
      input.shopId,
      input.confidenceScore,
      input.latencyScore,
      input.structureScore,
      input.safetyScore,
      input.feedbackScore,
      input.overallScore,
      Date.now(),
    );
    return Number(result.lastInsertRowid);
  }

  listByShop(shopId: string, limit = 100): QualityScoreRecord[] {
    return this.db
      .prepare(
        `SELECT id, audit_id AS auditId, shop_id AS shopId,
           confidence_score AS confidenceScore, latency_score AS latencyScore,
           structure_score AS structureScore, safety_score AS safetyScore,
           feedback_score AS feedbackScore, overall_score AS overallScore,
           created_at AS createdAt
         FROM quality_scores WHERE shop_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(shopId, limit) as QualityScoreRecord[];
  }

  listTopQuality(shopId: string, minScore: number, limit = 100): QualityScoreRecord[] {
    return this.db
      .prepare(
        `SELECT id, audit_id AS auditId, shop_id AS shopId,
           confidence_score AS confidenceScore, latency_score AS latencyScore,
           structure_score AS structureScore, safety_score AS safetyScore,
           feedback_score AS feedbackScore, overall_score AS overallScore,
           created_at AS createdAt
         FROM quality_scores
         WHERE shop_id = ? AND overall_score >= ?
         ORDER BY overall_score DESC LIMIT ?`,
      )
      .all(shopId, minScore, limit) as QualityScoreRecord[];
  }

  updateFeedbackScore(auditId: number, feedbackScore: number): void {
    this.db
      .prepare(
        `UPDATE quality_scores SET feedback_score = ? WHERE audit_id = ?`,
      )
      .run(feedbackScore, auditId);
  }

  getAvgOverall(shopId: string): number {
    const row = this.db
      .prepare(
        `SELECT AVG(overall_score) AS avg FROM quality_scores WHERE shop_id = ?`,
      )
      .get(shopId) as { avg: number | null } | undefined;
    return row?.avg ?? 0;
  }
}
