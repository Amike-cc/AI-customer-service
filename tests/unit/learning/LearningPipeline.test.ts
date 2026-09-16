/**
 * LearningPipeline 单元测试
 */
import { createMockDatabase } from '../helpers/mockDb';
import { LearningPipeline } from '@/learning/LearningPipeline';
import { QualityEvaluator } from '@/learning/QualityEvaluator';
import { PatternMatcher } from '@/learning/PatternMatcher';
import { AuditRepo } from '@/db/repos/AuditRepo';
import { QualityRepo } from '@/db/repos/QualityRepo';
import { LearningRepo } from '@/db/repos/LearningRepo';
import { FeedbackRepo } from '@/db/repos/FeedbackRepo';
import { createTestConfig } from '../helpers/testConfig';
import { createLogger } from '@/logging/logger';
import { DEFAULT_QUALITY_WEIGHTS } from '@/learning/types';

describe('LearningPipeline', () => {
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

  function addAuditRecord(
    shopId: string,
    userMessage: string,
    aiReply: string,
    modelVersion: string,
    confidence: number,
    latencyMs: number,
    sessionId: string = 'session1',
  ): number {
    return auditRepo.add({
      shopId,
      sessionId,
      userMessage,
      aiReply,
      modelVersion,
      promptHash: 'hash',
      confidence,
      latencyMs,
    });
  }

  it('空审计数据时运行成功，无模式提取', async () => {
    const result = await pipeline.run('shop1');
    expect(result.collectedCount).toBe(0);
    expect(result.extractedCount).toBe(0);
    const runs = learningRepo.listRuns(null, 10);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('completed');
  });

  it('高质量对话被提取为模式', async () => {
    const messages = ['退款多久到账', '退款多久到账？', '退款多久到账!'];
    for (let i = 0; i < 3; i++) {
      addAuditRecord(
        'shop1',
        messages[i],
        '亲，退款一般3-5个工作日到账，请耐心等待哦~',
        'deepseek:tier3',
        0.9,
        800,
      );
    }

    const result = await pipeline.run('shop1');
    expect(result.collectedCount).toBe(3);
    expect(result.extractedCount).toBe(1);

    const patterns = learningRepo.listPatterns('shop1', 'active');
    expect(patterns.length).toBe(1);
    expect(patterns[0].answerTemplate).toContain('退款');
    expect(patterns[0].avgQuality).toBeGreaterThan(0.6);
  });

  it('cache/rule来源的审计记录不被采集', async () => {
    addAuditRecord('shop1', '问题1', '回复1', 'cache:exact', 0.5, 100);
    addAuditRecord('shop1', '问题2', '回复2', 'rule:greeting', 0.9, 100);
    addAuditRecord('shop1', '问题3', '回复3', 'deepseek:tier3', 0.9, 800);

    const result = await pipeline.run('shop1');
    expect(result.collectedCount).toBe(1);
  });

  it('无效占位会话不会进入学习管道', async () => {
    addAuditRecord(
      'shop1',
      '亲，您好！很高兴为您服务',
      '亲，您好！很高兴为您服务，请问有什么可以帮您？',
      'deepseek:tier3',
      0.9,
      800,
      '会话',
    );

    const result = await pipeline.run('shop1');
    expect(result.collectedCount).toBe(0);
  });

  it('误采集的客服自身回复回声不会进入学习管道', async () => {
    addAuditRecord(
      'shop1',
      '亲，您好！很高兴为您服务，请问有什么可以帮您？\n00:15:29\n未读',
      '亲，您好！很高兴为您服务，请问有什么可以帮您？',
      'deepseek:tier3',
      0.9,
      800,
    );

    const result = await pipeline.run('shop1');
    expect(result.collectedCount).toBe(1);
    expect(result.cleanedCount).toBe(0);
  });

  it('敏感词命中的记录被过滤', async () => {
    addAuditRecord(
      'shop1',
      '问题1',
      '加微信',
      'deepseek:tier3:sensitive_blocked',
      0.9,
      800,
    );

    const result = await pipeline.run('shop1');
    expect(result.collectedCount).toBe(1);
    expect(result.cleanedCount).toBe(0);
  });

  it('低质量记录不提取模式', async () => {
    for (let i = 0; i < 3; i++) {
      addAuditRecord(
        'shop1',
        '问题相同' + i,
        '短',
        'deepseek:tier3',
        0.1,
        4900,
      );
    }

    const result = await pipeline.run('shop1');
    expect(result.collectedCount).toBe(3);
    expect(result.extractedCount).toBe(0);
  });

  it('不足minSamples的记录不提取模式', async () => {
    addAuditRecord('shop1', '退款多久到账', '退款3-5天到账', 'deepseek:tier3', 0.9, 800);

    const result = await pipeline.run('shop1');
    expect(result.collectedCount).toBe(1);
    expect(result.extractedCount).toBe(0);
  });

  it('相同问题hash去重，保留最新', async () => {
    addAuditRecord('shop1', '退款多久到账', '退款一般3-5天到账，请耐心等待', 'deepseek:tier3', 0.9, 800);
    addAuditRecord('shop1', '退款多久到账', '退款通常3-5个工作日到账', 'deepseek:tier3', 0.9, 800);
    addAuditRecord('shop1', '退款多久到账', '退款会在3-5天内到账', 'deepseek:tier3', 0.9, 800);

    const result = await pipeline.run('shop1');
    expect(result.collectedCount).toBe(3);
    expect(result.cleanedCount).toBe(1);
  });

  it('运行记录写入learning_runs', async () => {
    await pipeline.run('shop1');
    const runs = learningRepo.listRuns(null, 10);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].collectedCount).toBeDefined();
    expect(runs[0].extractedCount).toBeDefined();
  });

  it('提取后PatternMatcher可匹配', async () => {
    const messages = ['退款多久到账', '退款多久到账？', '退款多久到账!'];
    for (let i = 0; i < 3; i++) {
      addAuditRecord(
        'shop1',
        messages[i],
        '亲，退款一般3-5个工作日到账，请耐心等待哦~',
        'deepseek:tier3',
        0.9,
        800,
      );
    }

    await pipeline.run('shop1');
    patternMatcher.reload('shop1');

    const matchResult = patternMatcher.match('shop1', '退款多久到账');
    expect(matchResult.matched).toBe(true);
    expect(matchResult.answer).toContain('退款');
  });

  it('多次运行更新已有模式（质量更高时）', async () => {
    const messages1 = ['退款多久到账', '退款多久到账？', '退款多久到账!'];
    for (let i = 0; i < 3; i++) {
      addAuditRecord(
        'shop1',
        messages1[i],
        '一般回复',
        'deepseek:tier3',
        0.7,
        1500,
      );
    }
    await pipeline.run('shop1');

    const messages2 = ['退款多久到账。', '退款多久到账~', '退款多久到账 '];
    for (let i = 0; i < 3; i++) {
      addAuditRecord(
        'shop1',
        messages2[i],
        '亲，您好！感谢您的咨询。退款一般3-5个工作日到账，请您耐心等待。如有其他问题，欢迎随时联系我们的客服团队，我们将竭诚为您服务。',
        'deepseek:tier3',
        0.95,
        500,
      );
    }
    const result = await pipeline.run('shop1');

    const patterns = learningRepo.listPatterns('shop1', 'active');
    expect(patterns.length).toBe(1);
    expect(patterns[0].avgQuality).toBeGreaterThan(0.7);
  });

  it('start/stop定时器', () => {
    pipeline.start();
    pipeline.stop();
  });
});
