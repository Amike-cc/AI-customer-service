/**
 * QualityEvaluator 单元测试
 */
import { QualityEvaluator } from '@/learning/QualityEvaluator';
import { DEFAULT_QUALITY_WEIGHTS } from '@/learning/types';

describe('QualityEvaluator', () => {
  let evaluator: QualityEvaluator;

  beforeEach(() => {
    evaluator = new QualityEvaluator(DEFAULT_QUALITY_WEIGHTS);
  });

  it('高置信度 + 低延迟 + 良好结构 + 无反馈 → overall 应较高', () => {
    const result = evaluator.evaluate({
      confidence: 0.9,
      latencyMs: 500,
      reply: '亲，您好！这款商品的材质是纯棉的，非常舒适透气哦~如有其他问题随时问我。',
      modelVersion: 'deepseek:tier3',
      feedbackRating: null,
    });
    expect(result.confidence).toBe(0.9);
    expect(result.latency).toBe(0.9);
    expect(result.structure).toBeGreaterThan(0.5);
    expect(result.safety).toBe(1.0);
    expect(result.feedback).toBe(0.5);
    expect(result.overall).toBeGreaterThan(0.75);
  });

  it('confidence=0 → confidence维度为0', () => {
    const result = evaluator.evaluate({
      confidence: 0,
      reply: '测试回复内容，长度足够',
      modelVersion: 'deepseek:tier3',
    });
    expect(result.confidence).toBe(0);
  });

  it('confidence=1 → confidence维度为1', () => {
    const result = evaluator.evaluate({
      confidence: 1,
      reply: '测试回复内容，长度足够',
      modelVersion: 'deepseek:tier3',
    });
    expect(result.confidence).toBe(1);
  });

  it('latencyMs=5000 → latency维度为0', () => {
    const result = evaluator.evaluate({
      confidence: 0.5,
      latencyMs: 5000,
      reply: '测试回复',
      modelVersion: 'deepseek:tier3',
    });
    expect(result.latency).toBe(0);
  });

  it('latencyMs=0 → latency维度为0.5（无延迟数据）', () => {
    const result = evaluator.evaluate({
      confidence: 0.5,
      latencyMs: 0,
      reply: '测试回复',
      modelVersion: 'deepseek:tier3',
    });
    expect(result.latency).toBe(0.5);
  });

  it('latencyMs=1000 → latency维度为0.8', () => {
    const result = evaluator.evaluate({
      confidence: 0.5,
      latencyMs: 1000,
      reply: '测试回复',
      modelVersion: 'deepseek:tier3',
    });
    expect(result.latency).toBeCloseTo(0.8, 5);
  });

  it('回复长度50-500字 → structure含长度分', () => {
    const reply = '亲，您好！'.repeat(20);
    const result = evaluator.evaluate({
      confidence: 0.5,
      reply,
      modelVersion: 'deepseek:tier3',
    });
    expect(result.structure).toBeGreaterThan(0.3);
  });

  it('空回复 → structure为0', () => {
    const result = evaluator.evaluate({
      confidence: 0.5,
      reply: '',
      modelVersion: 'deepseek:tier3',
    });
    expect(result.structure).toBe(0);
  });

  it('modelVersion含sensitive_blocked → safety为0', () => {
    const result = evaluator.evaluate({
      confidence: 0.5,
      reply: '测试回复',
      modelVersion: 'deepseek:tier3:sensitive_blocked',
    });
    expect(result.safety).toBe(0);
  });

  it('正常modelVersion → safety为1', () => {
    const result = evaluator.evaluate({
      confidence: 0.5,
      reply: '测试回复',
      modelVersion: 'deepseek:tier3',
    });
    expect(result.safety).toBe(1.0);
  });

  it('feedbackRating=1（赞）→ feedback为1.0', () => {
    const result = evaluator.evaluate({
      confidence: 0.5,
      reply: '测试回复',
      modelVersion: 'deepseek:tier3',
      feedbackRating: 1,
    });
    expect(result.feedback).toBe(1.0);
  });

  it('feedbackRating=-1（踩）→ feedback为0', () => {
    const result = evaluator.evaluate({
      confidence: 0.5,
      reply: '测试回复',
      modelVersion: 'deepseek:tier3',
      feedbackRating: -1,
    });
    expect(result.feedback).toBe(0);
  });

  it('feedbackRating=null → feedback为0.5', () => {
    const result = evaluator.evaluate({
      confidence: 0.5,
      reply: '测试回复',
      modelVersion: 'deepseek:tier3',
      feedbackRating: null,
    });
    expect(result.feedback).toBe(0.5);
  });

  it('overall在0-1之间', () => {
    const result = evaluator.evaluate({
      confidence: 0.5,
      latencyMs: 2000,
      reply: '测试回复',
      modelVersion: 'deepseek:tier3',
    });
    expect(result.overall).toBeGreaterThanOrEqual(0);
    expect(result.overall).toBeLessThanOrEqual(1);
  });

  it('加权计算正确', () => {
    const result = evaluator.evaluate({
      confidence: 1,
      latencyMs: 0,
      reply: '好的！',
      modelVersion: 'deepseek:tier3',
      feedbackRating: 1,
    });
    const expected =
      1 * 0.30 + 0.5 * 0.15 + result.structure * 0.15 + 1 * 0.20 + 1 * 0.20;
    expect(result.overall).toBeCloseTo(expected, 5);
  });

  it('confidence为null → 默认0.5', () => {
    const result = evaluator.evaluate({
      confidence: null,
      reply: '测试回复',
      modelVersion: 'deepseek:tier3',
    });
    expect(result.confidence).toBe(0.5);
  });

  it('latencyMs为null → 默认0.5', () => {
    const result = evaluator.evaluate({
      confidence: 0.5,
      latencyMs: null,
      reply: '测试回复',
      modelVersion: 'deepseek:tier3',
    });
    expect(result.latency).toBe(0.5);
  });
});
