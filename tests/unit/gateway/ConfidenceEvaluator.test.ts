/**
 * ConfidenceEvaluator 单元测试
 */
import { ConfidenceEvaluator } from '@/gateway/ConfidenceEvaluator';

describe('ConfidenceEvaluator', () => {
  const evaluator = new ConfidenceEvaluator();

  const baseParams = {
    content: '这是一条正常回复，内容完整。',
    finishReason: 'stop' as const,
    truncated: false,
    model: 'deepseek-v4-flash',
    tier: 'tier3' as const,
    maxTokens: 1024,
  };

  it('finishReason=stop 时高分', () => {
    const score = evaluator.evaluate({ ...baseParams });
    expect(score).toBeGreaterThan(0.8);
  });

  it('finishReason=length（截断）时低分', () => {
    const score = evaluator.evaluate({
      ...baseParams,
      finishReason: 'length',
      truncated: true,
    });
    expect(score).toBeLessThan(0.75);
  });

  it('回复含不确定语言时降低置信度', () => {
    const score = evaluator.evaluate({
      ...baseParams,
      content: '这个可能不确定，建议咨询人工客服。',
    });
    expect(score).toBeLessThan(0.85);
  });

  it('回复以句号结尾时结构分高', () => {
    const score1 = evaluator.evaluate({
      ...baseParams,
      content: '这是完整回复。',
    });
    const score2 = evaluator.evaluate({
      ...baseParams,
      content: '这是中途断句，',
    });
    expect(score1).toBeGreaterThan(score2);
  });

  it('tier3 的 tierScore 高于 tier1', () => {
    const score3 = evaluator.evaluate({ ...baseParams, tier: 'tier3' });
    const score1 = evaluator.evaluate({ ...baseParams, tier: 'tier1' });
    expect(score3).toBeGreaterThan(score1);
  });

  it('回复过短时低分', () => {
    const score = evaluator.evaluate({
      ...baseParams,
      content: '好',
    });
    expect(score).toBeLessThan(0.8);
  });

  it('shouldUpgrade 正确判断', () => {
    const thresholds = { tier1: 0.75, tier2: 0.70, tier3: 0.60 };
    expect(evaluator.shouldUpgrade(0.5, 'tier1', thresholds)).toBe(true);
    expect(evaluator.shouldUpgrade(0.8, 'tier1', thresholds)).toBe(false);
  });
});
