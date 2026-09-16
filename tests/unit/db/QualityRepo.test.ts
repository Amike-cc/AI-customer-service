/**
 * QualityRepo 单元测试
 */
import { createMockDatabase } from '../helpers/mockDb';
import { QualityRepo } from '@/db/repos/QualityRepo';

describe('QualityRepo', () => {
  let db: any;
  let repo: QualityRepo;

  beforeEach(() => {
    db = createMockDatabase();
    db.exec(`
      CREATE TABLE ai_reply_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_message TEXT NOT NULL,
        ai_reply TEXT NOT NULL,
        model_version TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        product_id TEXT,
        token_input INTEGER,
        token_output INTEGER,
        latency_ms INTEGER,
        confidence REAL,
        created_at INTEGER NOT NULL,
        prev_hash TEXT
      );
      CREATE TABLE quality_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_id INTEGER NOT NULL,
        shop_id TEXT NOT NULL,
        confidence_score REAL NOT NULL,
        latency_score REAL NOT NULL,
        structure_score REAL NOT NULL,
        safety_score REAL NOT NULL,
        feedback_score REAL NOT NULL,
        overall_score REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    repo = new QualityRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  function createAuditId(shopId: string = 'shop1'): number {
    return db.prepare(
      `INSERT INTO ai_reply_audit (shop_id, session_id, user_message, ai_reply, model_version, prompt_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(shopId, 's1', 'msg', 'reply', 'model', 'hash', Date.now()).lastInsertRowid as number;
  }

  it('add写入评分', () => {
    const auditId = createAuditId();
    const id = repo.add({
      auditId,
      shopId: 'shop1',
      confidenceScore: 0.9,
      latencyScore: 0.8,
      structureScore: 0.7,
      safetyScore: 1.0,
      feedbackScore: 0.5,
      overallScore: 0.8,
    });
    expect(id).toBeGreaterThan(0);
  });

  it('listByShop按店铺查询', () => {
    const auditId1 = createAuditId('shop1');
    const auditId2 = createAuditId('shop2');

    repo.add({
      auditId: auditId1,
      shopId: 'shop1',
      confidenceScore: 0.9,
      latencyScore: 0.8,
      structureScore: 0.7,
      safetyScore: 1.0,
      feedbackScore: 0.5,
      overallScore: 0.8,
    });
    repo.add({
      auditId: auditId2,
      shopId: 'shop2',
      confidenceScore: 0.5,
      latencyScore: 0.4,
      structureScore: 0.3,
      safetyScore: 1.0,
      feedbackScore: 0.5,
      overallScore: 0.4,
    });

    const shop1Scores = repo.listByShop('shop1');
    expect(shop1Scores.length).toBe(1);
    expect(shop1Scores[0].overallScore).toBe(0.8);
  });

  it('listTopQuality按质量筛选', () => {
    const auditId1 = createAuditId();
    const auditId2 = createAuditId();

    repo.add({
      auditId: auditId1,
      shopId: 'shop1',
      confidenceScore: 0.9,
      latencyScore: 0.9,
      structureScore: 0.9,
      safetyScore: 1.0,
      feedbackScore: 1.0,
      overallScore: 0.95,
    });
    repo.add({
      auditId: auditId2,
      shopId: 'shop1',
      confidenceScore: 0.3,
      latencyScore: 0.3,
      structureScore: 0.3,
      safetyScore: 1.0,
      feedbackScore: 0.0,
      overallScore: 0.3,
    });

    const topScores = repo.listTopQuality('shop1', 0.8, 10);
    expect(topScores.length).toBe(1);
    expect(topScores[0].overallScore).toBe(0.95);
  });

  it('updateFeedbackScore更新反馈分数', () => {
    const auditId = createAuditId();
    repo.add({
      auditId,
      shopId: 'shop1',
      confidenceScore: 0.9,
      latencyScore: 0.8,
      structureScore: 0.7,
      safetyScore: 1.0,
      feedbackScore: 0.5,
      overallScore: 0.8,
    });

    repo.updateFeedbackScore(auditId, 1.0);

    const scores = repo.listByShop('shop1');
    expect(scores[0].feedbackScore).toBe(1.0);
  });

  it('getAvgOverall计算平均分', () => {
    const auditId1 = createAuditId();
    const auditId2 = createAuditId();

    repo.add({
      auditId: auditId1,
      shopId: 'shop1',
      confidenceScore: 0.9,
      latencyScore: 0.8,
      structureScore: 0.7,
      safetyScore: 1.0,
      feedbackScore: 0.5,
      overallScore: 0.8,
    });
    repo.add({
      auditId: auditId2,
      shopId: 'shop1',
      confidenceScore: 0.5,
      latencyScore: 0.4,
      structureScore: 0.3,
      safetyScore: 1.0,
      feedbackScore: 0.5,
      overallScore: 0.4,
    });

    const avg = repo.getAvgOverall('shop1');
    expect(avg).toBeCloseTo(0.6, 5);
  });
});
