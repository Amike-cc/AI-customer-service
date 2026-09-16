/**
 * PatternMatcher 单元测试
 */
import { createHash } from 'crypto';
import { createMockDatabase } from '../helpers/mockDb';
import { PatternMatcher } from '@/learning/PatternMatcher';
import { LearningRepo } from '@/db/repos/LearningRepo';
import { normalizeQuestion } from '@/cache/similarity';
import { createTestConfig } from '../helpers/testConfig';
import { createLogger } from '@/logging/logger';

function hashQuestion(question: string): string {
  return createHash('md5').update(normalizeQuestion(question)).digest('hex');
}

describe('PatternMatcher', () => {
  let db: any;
  let learningRepo: LearningRepo;
  let patternMatcher: PatternMatcher;

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
    `);
    learningRepo = new LearningRepo(db);
    const config = createTestConfig();
    const logger = createLogger(config, []);
    patternMatcher = new PatternMatcher({
      learningRepo,
      config,
      logger,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('无模式时返回未匹配', () => {
    const result = patternMatcher.match('shop1', '退款多久到账');
    expect(result.matched).toBe(false);
  });

  it('精确匹配命中', () => {
    learningRepo.addPattern({
      shopId: 'shop1',
      questionPattern: '退款多久到账',
      answerTemplate: '退款一般3-5个工作日到账',
      questionHash: hashQuestion('退款多久到账'),
      avgQuality: 0.9,
    });
    patternMatcher.reload('shop1');

    const result = patternMatcher.match('shop1', '退款多久到账');
    expect(result.matched).toBe(true);
    expect(result.answer).toBe('退款一般3-5个工作日到账');
    expect(result.matchType).toBe('exact');
    expect(result.patternId).toBeDefined();
  });

  it('语义匹配命中相似问题', () => {
    learningRepo.addPattern({
      shopId: 'shop1',
      questionPattern: '退款多久到账',
      answerTemplate: '退款一般3-5个工作日到账',
      questionHash: hashQuestion('退款多久到账'),
      avgQuality: 0.9,
    });
    patternMatcher.reload('shop1');

    const result = patternMatcher.match('shop1', '退款多久到账了');
    expect(result.matched).toBe(true);
    expect(result.matchType).toBe('semantic');
    expect(result.similarity).toBeGreaterThanOrEqual(0.5);
  });

  it('不相似问题不匹配', () => {
    learningRepo.addPattern({
      shopId: 'shop1',
      questionPattern: '退款多久能到账',
      answerTemplate: '退款一般3-5个工作日到账',
      questionHash: hashQuestion('退款多久能到账'),
      avgQuality: 0.9,
    });
    patternMatcher.reload('shop1');

    const result = patternMatcher.match('shop1', '请问有蓝色吗');
    expect(result.matched).toBe(false);
  });

  it('跨店铺隔离', () => {
    learningRepo.addPattern({
      shopId: 'shop1',
      questionPattern: '退款多久到账',
      answerTemplate: 'shop1的回复',
      questionHash: hashQuestion('退款多久到账'),
      avgQuality: 0.9,
    });
    patternMatcher.reload('shop1');

    const result = patternMatcher.match('shop2', '退款多久到账');
    expect(result.matched).toBe(false);
  });

  it('命中后matchCount递增', () => {
    const id = learningRepo.addPattern({
      shopId: 'shop1',
      questionPattern: '退款多久到账',
      answerTemplate: '退款一般3-5个工作日到账',
      questionHash: hashQuestion('退款多久到账'),
      avgQuality: 0.9,
    });
    patternMatcher.reload('shop1');

    patternMatcher.match('shop1', '退款多久到账');
    patternMatcher.match('shop1', '退款多久到账');

    const patterns = learningRepo.listPatterns('shop1');
    expect(patterns[0].matchCount).toBe(2);
  });

  it('recordFeedback更新feedbackSum', () => {
    const id = learningRepo.addPattern({
      shopId: 'shop1',
      questionPattern: '退款多久到账',
      answerTemplate: '退款一般3-5个工作日到账',
      questionHash: hashQuestion('退款多久到账'),
      avgQuality: 0.9,
    });
    patternMatcher.reload('shop1');

    patternMatcher.recordFeedback(id, 1);
    patternMatcher.recordFeedback(id, 1);
    patternMatcher.recordFeedback(id, -1);

    const patterns = learningRepo.listPatterns('shop1');
    expect(patterns[0].feedbackSum).toBe(1);
  });

  it('reload后加载最新模式', () => {
    learningRepo.addPattern({
      shopId: 'shop1',
      questionPattern: '问题1',
      answerTemplate: '回复1',
      questionHash: hashQuestion('问题1'),
      avgQuality: 0.8,
    });
    patternMatcher.reload('shop1');
    expect(patternMatcher.match('shop1', '问题1').matched).toBe(true);

    learningRepo.addPattern({
      shopId: 'shop1',
      questionPattern: '问题2',
      answerTemplate: '回复2',
      questionHash: hashQuestion('问题2'),
      avgQuality: 0.8,
    });
    patternMatcher.reload('shop1');
    expect(patternMatcher.match('shop1', '问题2').matched).toBe(true);
  });

  it('loadAll加载所有店铺', () => {
    learningRepo.addPattern({
      shopId: 'shop1',
      questionPattern: '问题1',
      answerTemplate: '回复1',
      questionHash: hashQuestion('问题1'),
      avgQuality: 0.8,
    });
    learningRepo.addPattern({
      shopId: 'shop2',
      questionPattern: '问题2',
      answerTemplate: '回复2',
      questionHash: hashQuestion('问题2'),
      avgQuality: 0.8,
    });
    patternMatcher.loadAll();

    expect(patternMatcher.match('shop1', '问题1').matched).toBe(true);
    expect(patternMatcher.match('shop2', '问题2').matched).toBe(true);
  });

  it('deprecated模式不被加载', () => {
    const id = learningRepo.addPattern({
      shopId: 'shop1',
      questionPattern: '问题1',
      answerTemplate: '回复1',
      questionHash: hashQuestion('问题1'),
      avgQuality: 0.8,
    });
    learningRepo.deprecatePattern(id);
    patternMatcher.reload('shop1');

    expect(patternMatcher.match('shop1', '问题1').matched).toBe(false);
  });
});
