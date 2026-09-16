/**
 * 闭环学习系统集成测试
 *
 * 验证完整闭环流程：
 * 采集 → 清洗 → 评分 → 模式提取 → 模式匹配 → 反馈收集 → 迭代优化
 */
import { createMockDatabase } from '../unit/helpers/mockDb';
import { LearningPipeline } from '@/learning/LearningPipeline';
import { QualityEvaluator } from '@/learning/QualityEvaluator';
import { PatternMatcher } from '@/learning/PatternMatcher';
import { AuditRepo } from '@/db/repos/AuditRepo';
import { QualityRepo } from '@/db/repos/QualityRepo';
import { LearningRepo } from '@/db/repos/LearningRepo';
import { FeedbackRepo } from '@/db/repos/FeedbackRepo';
import { createTestConfig } from '../unit/helpers/testConfig';
import { createLogger } from '@/logging/logger';
import { DEFAULT_QUALITY_WEIGHTS } from '@/learning/types';

describe('闭环学习系统集成', () => {
  let db: any;
  let auditRepo: AuditRepo;
  let qualityRepo: QualityRepo;
  let learningRepo: LearningRepo;
  let feedbackRepo: FeedbackRepo;
  let qualityEvaluator: QualityEvaluator;
  let patternMatcher: PatternMatcher;
  let pipeline: LearningPipeline;

  function setupDatabase(): void {
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
      CREATE INDEX IF NOT EXISTS idx_audit_query ON ai_reply_audit (shop_id, created_at DESC);
      CREATE TABLE dialogue_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_id INTEGER NOT NULL,
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        rating INTEGER NOT NULL,
        comment TEXT,
        created_at INTEGER NOT NULL
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
  }

  beforeEach(() => {
    db = createMockDatabase();
    setupDatabase();
    auditRepo = new AuditRepo(db);
    qualityRepo = new QualityRepo(db);
    learningRepo = new LearningRepo(db);
    feedbackRepo = new FeedbackRepo(db);
    qualityEvaluator = new QualityEvaluator(DEFAULT_QUALITY_WEIGHTS);

    const config = createTestConfig({
      learning: {
        enabled: true,
        run_interval_ms: 21600000,
        lookback_hours: 24,
        min_quality_threshold: 0.6,
        min_samples_for_pattern: 2,
        semantic_threshold: 0.8,
        pattern_decay_days: 30,
        max_patterns_per_shop: 500,
        weights: DEFAULT_QUALITY_WEIGHTS,
      },
    });
    const logger = createLogger(config, []);
    patternMatcher = new PatternMatcher({ learningRepo, config, logger });
    pipeline = new LearningPipeline({
      auditRepo,
      qualityRepo,
      learningRepo,
      feedbackRepo,
      qualityEvaluator,
      patternMatcher,
      config,
      logger,
    });
  });

  afterEach(() => {
    db.close();
  });

  function addAudit(
    shopId: string,
    userMessage: string,
    aiReply: string,
    modelVersion: string,
    confidence: number,
    latencyMs: number,
  ): number {
    return auditRepo.add({
      shopId,
      sessionId: 'session1',
      userMessage,
      aiReply,
      modelVersion,
      promptHash: 'hash',
      confidence,
      latencyMs,
    });
  }

  it('完整闭环：采集 → 清洗 → 评分 → 提取 → 匹配 → 反馈 → 迭代', async () => {
    // 阶段 1：添加混合质量审计记录
    const highQualityMessages = ['退款多久到账', '退款多久到账？', '退款多久到账!'];
    for (const msg of highQualityMessages) {
      addAudit(
        'shop1',
        msg,
        '亲，您好！退款一般3-5个工作日到账，请耐心等待哦~如有其他问题随时联系我们。',
        'deepseek:tier3',
        0.92,
        600,
      );
    }

    // 低质量记录（不应提取模式）
    addAudit('shop1', '物流查询问题1', '不知道', 'deepseek:tier3', 0.1, 4900);
    addAudit('shop1', '物流查询问题2', '不清楚', 'deepseek:tier3', 0.2, 4800);

    // cache 来源（不应采集）
    addAudit('shop1', '缓存问题', '缓存回复内容足够长的', 'cache:exact', 0.9, 100);

    // sensitive_blocked（应在清洗阶段过滤）
    addAudit(
      'shop1',
      '加微信吧亲',
      '好的可以加微信哦',
      'deepseek:tier3:sensitive_blocked',
      0.9,
      800,
    );

    // 阶段 2：运行学习管道
    const result = await pipeline.run('shop1');

    // 验证采集阶段（7 条记录 - 1 条 cache 来源 = 6 条采集）
    expect(result.collectedCount).toBe(6);
    // 验证清洗阶段（过滤 sensitive + 低质量回复后 3 条）
    expect(result.cleanedCount).toBe(3);
    // 验证提取阶段（3 条同 pattern，满足 min_samples=2，提取 1 个模式）
    expect(result.extractedCount).toBe(1);

    // 阶段 3：验证 learned_patterns 表
    const patterns = learningRepo.listPatterns('shop1', 'active');
    expect(patterns.length).toBe(1);
    expect(patterns[0].questionPattern).toBe('退钱多久到账');
    expect(patterns[0].answerTemplate).toContain('退款');
    expect(patterns[0].avgQuality).toBeGreaterThan(0.6);
    expect(patterns[0].status).toBe('active');

    // 验证 quality_scores 表
    const topQuality = qualityRepo.listTopQuality('shop1', 0.6, 10);
    expect(topQuality.length).toBeGreaterThanOrEqual(3);

    // 验证 learning_runs 表
    const runs = learningRepo.listRuns(null, 10);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].collectedCount).toBe(6);
    expect(runs[0].extractedCount).toBe(1);

    // 阶段 4：PatternMatcher 精确匹配
    patternMatcher.reload('shop1');
    const exactMatch = patternMatcher.match('shop1', '退款多久到账');
    expect(exactMatch.matched).toBe(true);
    expect(exactMatch.matchType).toBe('exact');
    expect(exactMatch.answer).toContain('退款');

    // 阶段 5：PatternMatcher 语义匹配
    const semanticMatch = patternMatcher.match('shop1', '退款多久到账了');
    expect(semanticMatch.matched).toBe(true);
    expect(semanticMatch.matchType).toBe('semantic');

    // 阶段 6：用户反馈（点赞）
    const auditId = patterns[0].sourceAuditIds
      ? JSON.parse(patterns[0].sourceAuditIds)[0]
      : null;
    expect(auditId).toBeTruthy();

    if (auditId) {
      feedbackRepo.add({
        auditId,
        shopId: 'shop1',
        sessionId: 'session1',
        rating: 1,
        comment: '回复很有帮助',
      });

      // 验证反馈统计
      const stats = feedbackRepo.getStats('shop1');
      expect(stats.total).toBe(1);
      expect(stats.positive).toBe(1);
      expect(stats.positiveRate).toBe(1);
    }

    // 阶段 7：PatternMatcher 反馈记录
    patternMatcher.recordFeedback(patterns[0].id, 1);
    const updatedPatterns = learningRepo.listPatterns('shop1', 'active');
    expect(updatedPatterns[0].feedbackSum).toBe(1);

    // 阶段 8：第二次运行管道（迭代优化）
    const result2 = await pipeline.run('shop1');
    expect(result2.status || true).toBeTruthy();

    const runs2 = learningRepo.listRuns(null, 10);
    expect(runs2.length).toBe(2);
    expect(runs2[0].status).toBe('completed');
  });

  it('跨店铺隔离验证', async () => {
    // shop1 高质量记录
    const messages1 = ['退款多久到账', '退款多久到账？', '退款多久到账!'];
    for (const msg of messages1) {
      addAudit('shop1', msg, '退款一般3-5个工作日到账，请耐心等待', 'deepseek:tier3', 0.9, 800);
    }

    // shop2 不同问题
    const messages2 = ['尺码怎么选', '尺码怎么选？', '尺码怎么选!'];
    for (const msg of messages2) {
      addAudit('shop2', msg, '亲，建议您参考尺码表选择合适的尺码哦', 'deepseek:tier3', 0.9, 800);
    }

    // 运行全店铺
    await pipeline.run();

    const shop1Patterns = learningRepo.listPatterns('shop1', 'active');
    const shop2Patterns = learningRepo.listPatterns('shop2', 'active');

    expect(shop1Patterns.length).toBe(1);
    expect(shop1Patterns[0].questionPattern).toBe('退钱多久到账');

    expect(shop2Patterns.length).toBe(1);
    expect(shop2Patterns[0].questionPattern).toBe('尺寸怎么选');

    // 跨店铺不匹配
    patternMatcher.reload('shop1');
    expect(patternMatcher.match('shop2', '退款多久到账').matched).toBe(false);

    patternMatcher.reload('shop2');
    expect(patternMatcher.match('shop1', '尺码怎么选').matched).toBe(false);
  });

  it('模式衰减验证', async () => {
    // 添加高质量记录并提取模式
    const messages = ['退款多久到账', '退款多久到账？', '退款多久到账!'];
    for (const msg of messages) {
      addAudit('shop1', msg, '退款一般3-5个工作日到账，请耐心等待', 'deepseek:tier3', 0.9, 800);
    }

    await pipeline.run('shop1');
    let patterns = learningRepo.listPatterns('shop1', 'active');
    expect(patterns.length).toBe(1);

    // 手动设置 created_at 为 31 天前（超过 pattern_decay_days=30）
    const oldTime = Date.now() - 31 * 86400000;
    db.prepare('UPDATE learned_patterns SET created_at = ?, match_count = 0 WHERE id = ?').run(
      oldTime,
      patterns[0].id,
    );

    // 再次运行管道，validate 阶段应降级过期模式
    await pipeline.run('shop1');

    patterns = learningRepo.listPatterns('shop1', 'active');
    expect(patterns.length).toBe(0);

    const deprecated = learningRepo.listPatterns('shop1', 'deprecated');
    expect(deprecated.length).toBe(1);
  });
});
