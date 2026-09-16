/**
 * LearningRepo 单元测试
 */
import { createMockDatabase } from '../helpers/mockDb';
import { LearningRepo } from '@/db/repos/LearningRepo';

describe('LearningRepo', () => {
  let db: any;
  let repo: LearningRepo;

  beforeEach(() => {
    db = createMockDatabase();
    db.exec(`
      CREATE TABLE learned_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        question_pattern TEXT NOT NULL,
        answer_template TEXT NOT NULL,
        question_hash TEXT NOT NULL,
        match_count INTEGER DEFAULT 0,
        feedback_sum INTEGER DEFAULT 0,
        avg_quality REAL DEFAULT 0,
        source_audit_ids TEXT,
        status TEXT DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(shop_id, question_hash)
      );
      CREATE TABLE learning_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        collected_count INTEGER NOT NULL,
        extracted_count INTEGER NOT NULL,
        validated_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        metrics_json TEXT
      );
    `);
    repo = new LearningRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('addPattern写入模式', () => {
    const id = repo.addPattern({
      shopId: 'shop1',
      questionPattern: '退款多久到账',
      answerTemplate: '退款3-5天到账',
      questionHash: 'hash1',
      avgQuality: 0.85,
    });
    expect(id).toBeGreaterThan(0);
  });

  it('listPatterns按店铺查询', () => {
    repo.addPattern({
      shopId: 'shop1',
      questionPattern: '问题1',
      answerTemplate: '回复1',
      questionHash: 'hash1',
      avgQuality: 0.8,
    });
    repo.addPattern({
      shopId: 'shop2',
      questionPattern: '问题2',
      answerTemplate: '回复2',
      questionHash: 'hash2',
      avgQuality: 0.9,
    });

    const shop1Patterns = repo.listPatterns('shop1');
    expect(shop1Patterns.length).toBe(1);
    expect(shop1Patterns[0].shopId).toBe('shop1');
  });

  it('listPatterns按status筛选', () => {
    const id = repo.addPattern({
      shopId: 'shop1',
      questionPattern: '问题1',
      answerTemplate: '回复1',
      questionHash: 'hash1',
      avgQuality: 0.8,
    });
    repo.deprecatePattern(id);

    const activePatterns = repo.listPatterns('shop1', 'active');
    expect(activePatterns.length).toBe(0);

    const deprecatedPatterns = repo.listPatterns('shop1', 'deprecated');
    expect(deprecatedPatterns.length).toBe(1);
  });

  it('getPatternByHash查询', () => {
    repo.addPattern({
      shopId: 'shop1',
      questionPattern: '问题1',
      answerTemplate: '回复1',
      questionHash: 'hash1',
      avgQuality: 0.8,
    });

    const pattern = repo.getPatternByHash('shop1', 'hash1');
    expect(pattern).not.toBeNull();
    expect(pattern!.questionPattern).toBe('问题1');
  });

  it('getPatternByHash不存在返回null', () => {
    const pattern = repo.getPatternByHash('shop1', 'nonexistent');
    expect(pattern).toBeNull();
  });

  it('incrementMatchCount递增命中次数', () => {
    const id = repo.addPattern({
      shopId: 'shop1',
      questionPattern: '问题1',
      answerTemplate: '回复1',
      questionHash: 'hash1',
      avgQuality: 0.8,
    });

    repo.incrementMatchCount(id);
    repo.incrementMatchCount(id);
    repo.incrementMatchCount(id);

    const patterns = repo.listPatterns('shop1');
    expect(patterns[0].matchCount).toBe(3);
  });

  it('addFeedback累计反馈', () => {
    const id = repo.addPattern({
      shopId: 'shop1',
      questionPattern: '问题1',
      answerTemplate: '回复1',
      questionHash: 'hash1',
      avgQuality: 0.8,
    });

    repo.addFeedback(id, 1);
    repo.addFeedback(id, 1);
    repo.addFeedback(id, -1);

    const patterns = repo.listPatterns('shop1');
    expect(patterns[0].feedbackSum).toBe(1);
  });

  it('deprecatePattern标记降级', () => {
    const id = repo.addPattern({
      shopId: 'shop1',
      questionPattern: '问题1',
      answerTemplate: '回复1',
      questionHash: 'hash1',
      avgQuality: 0.8,
    });

    repo.deprecatePattern(id);
    const patterns = repo.listPatterns('shop1');
    expect(patterns[0].status).toBe('deprecated');
  });

  it('deprecateStalePatterns降级过期未命中模式', () => {
    const oldTime = Date.now() - 31 * 86400000;
    db.prepare(
      `INSERT INTO learned_patterns (shop_id, question_pattern, answer_template, question_hash, match_count, feedback_sum, avg_quality, status, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0.8, 'active', ?, ?)`,
    ).run('shop1', '问题1', '回复1', 'hash1', oldTime, oldTime);

    const deprecated = repo.deprecateStalePatterns(30 * 86400000);
    expect(deprecated).toBe(1);

    const patterns = repo.listPatterns('shop1');
    expect(patterns[0].status).toBe('deprecated');
  });

  it('deprecateStalePatterns不降级有命中的模式', () => {
    const oldTime = Date.now() - 31 * 86400000;
    db.prepare(
      `INSERT INTO learned_patterns (shop_id, question_pattern, answer_template, question_hash, match_count, feedback_sum, avg_quality, status, created_at, updated_at) VALUES (?, ?, ?, ?, 5, 0, 0.8, 'active', ?, ?)`,
    ).run('shop1', '问题1', '回复1', 'hash1', oldTime, oldTime);

    const deprecated = repo.deprecateStalePatterns(30 * 86400000);
    expect(deprecated).toBe(0);
  });

  it('countActivePatterns统计活跃模式数', () => {
    repo.addPattern({
      shopId: 'shop1',
      questionPattern: '问题1',
      answerTemplate: '回复1',
      questionHash: 'hash1',
      avgQuality: 0.8,
    });
    repo.addPattern({
      shopId: 'shop1',
      questionPattern: '问题2',
      answerTemplate: '回复2',
      questionHash: 'hash2',
      avgQuality: 0.8,
    });

    expect(repo.countActivePatterns('shop1')).toBe(2);
  });

  it('addRun和updateRun', () => {
    const runId = repo.addRun({
      shopId: 'shop1',
      startedAt: Date.now(),
      completedAt: 0,
      collectedCount: 0,
      extractedCount: 0,
      validatedCount: 0,
      status: 'running',
    });

    repo.updateRun(runId, {
      completedAt: Date.now(),
      collectedCount: 10,
      extractedCount: 3,
      validatedCount: 1,
      status: 'completed',
    });

    const runs = repo.listRuns(null, 10);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].collectedCount).toBe(10);
    expect(runs[0].extractedCount).toBe(3);
  });

  it('listRuns按店铺查询', () => {
    repo.addRun({
      shopId: 'shop1',
      startedAt: Date.now(),
      completedAt: Date.now(),
      collectedCount: 5,
      extractedCount: 2,
      validatedCount: 0,
      status: 'completed',
    });
    repo.addRun({
      shopId: 'shop2',
      startedAt: Date.now(),
      completedAt: Date.now(),
      collectedCount: 3,
      extractedCount: 1,
      validatedCount: 0,
      status: 'completed',
    });

    const shop1Runs = repo.listRuns('shop1', 10);
    expect(shop1Runs.length).toBe(1);
    expect(shop1Runs[0].shopId).toBe('shop1');
  });

  it('相同hash不重复插入（UNIQUE约束）', () => {
    repo.addPattern({
      shopId: 'shop1',
      questionPattern: '问题1',
      answerTemplate: '回复1',
      questionHash: 'hash1',
      avgQuality: 0.8,
    });

    expect(() => {
      repo.addPattern({
        shopId: 'shop1',
        questionPattern: '问题1',
        answerTemplate: '回复2',
        questionHash: 'hash1',
        avgQuality: 0.9,
      });
    }).toThrow();
  });

  it('listAllActivePatterns查询全部', () => {
    repo.addPattern({
      shopId: 'shop1',
      questionPattern: '问题1',
      answerTemplate: '回复1',
      questionHash: 'hash1',
      avgQuality: 0.8,
    });
    repo.addPattern({
      shopId: 'shop2',
      questionPattern: '问题2',
      answerTemplate: '回复2',
      questionHash: 'hash2',
      avgQuality: 0.9,
    });

    const all = repo.listAllActivePatterns();
    expect(all.length).toBe(2);
  });
});
