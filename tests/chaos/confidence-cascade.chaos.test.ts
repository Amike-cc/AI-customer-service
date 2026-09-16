/**
 * 故障注入测试：置信度评估与级联触发
 *
 * 覆盖场景：
 * - C-11: OCR/模型回复低置信度 → 触发级联升级决策
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.4 节、第 9.6 节模型级联
 */
import { ConfidenceEvaluator } from '@/gateway/ConfidenceEvaluator';
import type { ModelTier } from '@/scheduler/types';

describe('Chaos: 置信度评估与级联触发', () => {
  let evaluator: ConfidenceEvaluator;
  const thresholds: Record<ModelTier, number> = { tier1: 0.75, tier2: 0.70, tier3: 0.60 };

  beforeEach(() => {
    evaluator = new ConfidenceEvaluator();
  });

  describe('C-11: 低置信度触发级联升级', () => {
    it('截断回复（finish_reason=length）置信度低，触发 Tier1 → Tier2 升级', () => {
      const confidence = evaluator.evaluate({
        content: '可能需要',
        finishReason: 'length',
        truncated: true,
        model: 'ollama-qwen',
        tier: 'tier1',
        maxTokens: 1024,
      });

      expect(confidence).toBeLessThan(thresholds.tier1);
      expect(evaluator.shouldUpgrade(confidence, 'tier1', thresholds)).toBe(true);
    });

    it('截断+不确定词语的回复置信度低，触发 Tier2 → Tier3 升级', () => {
      const confidence = evaluator.evaluate({
        content: '可能不确定',
        finishReason: 'length',
        truncated: true,
        model: 'qwen-plus',
        tier: 'tier2',
        maxTokens: 1024,
      });

      expect(confidence).toBeLessThan(thresholds.tier2);
      expect(evaluator.shouldUpgrade(confidence, 'tier2', thresholds)).toBe(true);
    });

    it('高置信度回复不触发升级', () => {
      const confidence = evaluator.evaluate({
        content: '这款商品有黑色、白色、红色三种颜色可选，均现货发售。您可以根据喜好选择，下单后24小时内发货。',
        finishReason: 'stop',
        truncated: false,
        model: 'deepseek-v4-flash',
        tier: 'tier3',
        maxTokens: 1024,
      });

      expect(confidence).toBeGreaterThanOrEqual(thresholds.tier3);
      expect(evaluator.shouldUpgrade(confidence, 'tier3', thresholds)).toBe(false);
    });

    it('极短回复（<10字）置信度低于 Tier1 阈值', () => {
      const confidence = evaluator.evaluate({
        content: '好',
        finishReason: 'stop',
        truncated: false,
        model: 'ollama-qwen',
        tier: 'tier1',
        maxTokens: 1024,
      });

      expect(confidence).toBeLessThan(thresholds.tier1);
      expect(evaluator.shouldUpgrade(confidence, 'tier1', thresholds)).toBe(true);
    });

    it('Tier3 高置信度回复不触发升级（已是最低层）', () => {
      const confidence = evaluator.evaluate({
        content: '您的快递已到达广州转运中心，预计今天下午派送，请保持手机畅通。如有疑问请联系客服。',
        finishReason: 'stop',
        truncated: false,
        model: 'deepseek-v4-flash',
        tier: 'tier3',
        maxTokens: 1024,
      });

      expect(confidence).toBeGreaterThanOrEqual(0.8);
    });
  });
});
