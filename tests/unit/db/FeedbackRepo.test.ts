/**
 * FeedbackRepo 单元测试
 */
import { createMockDatabase } from '../helpers/mockDb';
import { FeedbackRepo } from '@/db/repos/FeedbackRepo';

describe('FeedbackRepo', () => {
  let db: any;
  let repo: FeedbackRepo;

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
      CREATE TABLE dialogue_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_id INTEGER NOT NULL,
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        rating INTEGER NOT NULL,
        comment TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (audit_id) REFERENCES ai_reply_audit(id)
      );
    `);
    repo = new FeedbackRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('add写入反馈', () => {
    const auditId = db.prepare(
      `INSERT INTO ai_reply_audit (shop_id, session_id, user_message, ai_reply, model_version, prompt_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('shop1', 's1', 'msg', 'reply', 'model', 'hash', Date.now()).lastInsertRowid as number;

    const id = repo.add({
      auditId,
      shopId: 'shop1',
      sessionId: 's1',
      rating: 1,
      comment: 'good',
    });
    expect(id).toBeGreaterThan(0);
  });

  it('listByShop按店铺查询', () => {
    const auditId = db.prepare(
      `INSERT INTO ai_reply_audit (shop_id, session_id, user_message, ai_reply, model_version, prompt_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('shop1', 's1', 'msg', 'reply', 'model', 'hash', Date.now()).lastInsertRowid as number;

    repo.add({ auditId, shopId: 'shop1', sessionId: 's1', rating: 1 });
    // 同一 audit 重复反馈 → upsert 更新（新行为：同一 audit 只保留一条反馈，避免准确率重复计数）
    repo.add({ auditId, shopId: 'shop1', sessionId: 's1', rating: -1 });

    const shop1Feedback = repo.listByShop('shop1');
    expect(shop1Feedback.length).toBe(1);
    expect(shop1Feedback[0].rating).toBe(-1);
  });

  it('getByAudit查询审计记录的反馈', () => {
    const auditId = db.prepare(
      `INSERT INTO ai_reply_audit (shop_id, session_id, user_message, ai_reply, model_version, prompt_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('shop1', 's1', 'msg', 'reply', 'model', 'hash', Date.now()).lastInsertRowid as number;

    repo.add({ auditId, shopId: 'shop1', sessionId: 's1', rating: -1, comment: 'bad' });

    const feedback = repo.getByAudit(auditId);
    expect(feedback).not.toBeNull();
    expect(feedback!.rating).toBe(-1);
    expect(feedback!.comment).toBe('bad');
  });

  it('getStats统计赞踩', () => {
    const auditId1 = db.prepare(
      `INSERT INTO ai_reply_audit (shop_id, session_id, user_message, ai_reply, model_version, prompt_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('shop1', 's1', 'msg1', 'reply', 'model', 'hash', Date.now()).lastInsertRowid as number;
    const auditId2 = db.prepare(
      `INSERT INTO ai_reply_audit (shop_id, session_id, user_message, ai_reply, model_version, prompt_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('shop1', 's1', 'msg2', 'reply', 'model', 'hash', Date.now()).lastInsertRowid as number;
    const auditId3 = db.prepare(
      `INSERT INTO ai_reply_audit (shop_id, session_id, user_message, ai_reply, model_version, prompt_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('shop1', 's1', 'msg3', 'reply', 'model', 'hash', Date.now()).lastInsertRowid as number;

    repo.add({ auditId: auditId1, shopId: 'shop1', sessionId: 's1', rating: 1 });
    repo.add({ auditId: auditId2, shopId: 'shop1', sessionId: 's1', rating: 1 });
    repo.add({ auditId: auditId3, shopId: 'shop1', sessionId: 's1', rating: -1 });

    const stats = repo.getStats('shop1');
    expect(stats.total).toBe(3);
    expect(stats.positive).toBe(2);
    expect(stats.negative).toBe(1);
    expect(stats.positiveRate).toBeCloseTo(2 / 3, 5);
  });

  it('无反馈时getStats返回0', () => {
    const stats = repo.getStats('shop1');
    expect(stats.total).toBe(0);
    expect(stats.positiveRate).toBe(0);
  });
});
