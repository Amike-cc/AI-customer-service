/**
 * ComplexityAssessor 单元测试
 * 详见 src/intent/ComplexityAssessor.ts
 */
import { ComplexityAssessor } from '@/intent/ComplexityAssessor';
import { createTestConfig } from '../helpers/testConfig';
import type { IntentResult } from '@/intent/types';
import type { ChatMessage } from '@/deepseek/DeepSeekClient';

function makeIntent(category: IntentResult['category'] = 'greeting'): IntentResult {
  return { category, confidence: 0.8, entities: [] };
}

describe('ComplexityAssessor', () => {
  let assessor: ComplexityAssessor;

  beforeEach(() => {
    assessor = new ComplexityAssessor(createTestConfig());
  });

  describe('5维评分模型', () => {
    it('简单消息 — 无触发维度', () => {
      const result = assessor.assess('你好', makeIntent('greeting'), []);
      expect(result.level).toBe('simple');
      expect(result.score).toBeLessThan(0.3);
      expect(result.shouldEscalate).toBe(false);
      expect(result.reasons).toEqual([]);
    });

    it('多问题检测 — 2个问号', () => {
      const result = assessor.assess('尺码是什么？怎么发货？', makeIntent('product_inquiry'), []);
      expect(result.reasons).toContain('multi_question');
      expect(result.score).toBeGreaterThanOrEqual(0.3);
    });

    it('多问题检测 — 2个逗号', () => {
      const result = assessor.assess('尺码，颜色，材质', makeIntent('product_inquiry'), []);
      expect(result.reasons).toContain('multi_question');
    });

    it('情绪挫折检测', () => {
      const result = assessor.assess('气死我了', makeIntent('complaint'), []);
      expect(result.reasons).toContain('emotional_frustration');
    });

    it('订单上下文检测', () => {
      const result = assessor.assess('订单123456789012345', makeIntent('after_sales'), []);
      expect(result.reasons).toContain('order_context');
    });

    it('重复升级检测', () => {
      const result = assessor.assess('退货', makeIntent('after_sales'), [], true);
      expect(result.reasons).toContain('repeated_escalation');
      expect(result.score).toBeGreaterThanOrEqual(0.3);
    });

    it('低置信度历史检测', () => {
      const history: ChatMessage[] = [
        { role: 'assistant', content: '建议咨询人工客服' },
      ];
      const result = assessor.assess('怎么办', makeIntent('unknown'), history);
      expect(result.reasons).toContain('low_confidence_history');
    });
  });

  describe('3级复杂度判定', () => {
    it('complex — 多维度叠加 score >= 0.6', () => {
      const result = assessor.assess(
        '这是什么？怎么处理？气死我了',
        makeIntent('complaint'),
        [],
        true,
      );
      expect(result.score).toBeGreaterThanOrEqual(0.6);
      expect(result.level).toBe('complex');
    });

    it('moderate — 单维度 score >= 0.3 且 < 0.6', () => {
      const result = assessor.assess('尺码是什么？怎么发货？', makeIntent('product_inquiry'), []);
      expect(result.score).toBeGreaterThanOrEqual(0.3);
      expect(result.score).toBeLessThan(0.6);
      expect(result.level).toBe('moderate');
    });

    it('simple — score < 0.3', () => {
      const result = assessor.assess('你好', makeIntent('greeting'), []);
      expect(result.level).toBe('simple');
    });
  });

  describe('升级判定', () => {
    it('投诉类自动升级 — 无论分数', () => {
      const result = assessor.assess('我要投诉', makeIntent('complaint'), []);
      expect(result.shouldEscalate).toBe(true);
    });

    it('分数未达阈值不升级', () => {
      const result = assessor.assess('你好', makeIntent('greeting'), []);
      expect(result.shouldEscalate).toBe(false);
    });

    it('分数达到阈值触发升级', () => {
      const config = createTestConfig({
        intent: {
          ...createTestConfig().intent,
          complexity_threshold: 0.3,
        },
      });
      const strict = new ComplexityAssessor(config);
      const result = strict.assess('尺码是什么？怎么发货？', makeIntent('product_inquiry'), []);
      expect(result.score).toBeGreaterThanOrEqual(0.3);
      expect(result.shouldEscalate).toBe(true);
    });
  });

  describe('分数上限', () => {
    it('score 不超过 1.0', () => {
      const result = assessor.assess(
        '这是什么？怎么处理？气死骗子差评举报',
        makeIntent('complaint'),
        [{ role: 'assistant', content: '建议咨询人工' }],
        true,
      );
      expect(result.score).toBeLessThanOrEqual(1.0);
    });
  });
});
