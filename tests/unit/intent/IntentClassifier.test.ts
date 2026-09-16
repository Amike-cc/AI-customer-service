/**
 * IntentClassifier 单元测试
 * 详见 src/intent/IntentClassifier.ts
 */
import { IntentClassifier } from '@/intent/IntentClassifier';
import { createTestConfig } from '../helpers/testConfig';
import type { AppLogger } from '@/logging/logger';
import type { ChatMessage } from '@/deepseek/DeepSeekClient';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as AppLogger;

describe('IntentClassifier', () => {
  let classifier: IntentClassifier;

  beforeEach(() => {
    classifier = new IntentClassifier(createTestConfig(), mockLogger);
  });

  describe('10种意图分类', () => {
    it('问候类 — 你好', () => {
      const result = classifier.classify('你好', []);
      expect(result.category).toBe('greeting');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('商品咨询 — 尺码', () => {
      const result = classifier.classify('这个有什么尺码', []);
      expect(result.category).toBe('product_inquiry');
    });

    it('购买意图 — 下单', () => {
      const result = classifier.classify('我要下单', []);
      expect(result.category).toBe('purchase_intent');
    });

    it('售后类 — 退货', () => {
      const result = classifier.classify('我要退货', []);
      expect(result.category).toBe('after_sales');
    });

    it('物流类 — 快递到货', () => {
      const result = classifier.classify('快递什么时候到', []);
      expect(result.category).toBe('logistics');
    });

    it('投诉类 — 投诉', () => {
      const result = classifier.classify('我要投诉', []);
      expect(result.category).toBe('complaint');
    });

    it('人工请求 — 转人工', () => {
      const result = classifier.classify('转人工', []);
      expect(result.category).toBe('human_request');
    });

    it('FAQ类 — 怎么使用', () => {
      const result = classifier.classify('怎么使用', []);
      expect(result.category).toBe('faq');
    });

    it('闲聊类 — 谢谢', () => {
      const result = classifier.classify('谢谢', []);
      expect(result.category).toBe('chitchat');
    });

    it('未知类 — 无关键词匹配', () => {
      const result = classifier.classify('asdfghjkl', []);
      expect(result.category).toBe('unknown');
      expect(result.confidence).toBe(0);
      expect(result.entities).toEqual([]);
    });
  });

  describe('实体提取', () => {
    it('价格实体 — 100元', () => {
      const result = classifier.classify('这个100元', []);
      const priceEntity = result.entities.find((e) => e.type === 'price');
      expect(priceEntity).toBeDefined();
      expect(priceEntity!.value).toBe('100元');
    });

    it('订单号实体 — 15位以上数字', () => {
      const result = classifier.classify('退货订单123456789012345', []);
      const orderEntity = result.entities.find((e) => e.type === 'order_id');
      expect(orderEntity).toBeDefined();
      expect(orderEntity!.value).toBe('123456789012345');
    });

    it('无实体时返回空数组', () => {
      const result = classifier.classify('你好', []);
      expect(result.entities).toEqual([]);
    });
  });

  describe('负面词降权', () => {
    it('greeting 被"退货"降权后 after_sales 胜出', () => {
      const result = classifier.classify('你好，我要退货', []);
      expect(result.category).toBe('after_sales');
    });

    it('product_inquiry 被"退货"降权', () => {
      const result = classifier.classify('这个尺码我要退货', []);
      expect(result.category).toBe('after_sales');
    });
  });

  describe('历史修正', () => {
    const historyWithReturn: ChatMessage[] = [
      { role: 'user', content: '我要退货' },
      { role: 'assistant', content: '好的，请提供订单号' },
    ];

    it('无关键词消息时通过历史修正识别意图', () => {
      const result = classifier.classify('帮我处理一下', historyWithReturn);
      expect(result.category).toBe('after_sales');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('history_weight=0 时禁用历史修正', () => {
      const config = createTestConfig({
        intent: {
          ...createTestConfig().intent,
          history_weight: 0,
        },
      });
      const cls = new IntentClassifier(config, mockLogger);
      const result = cls.classify('帮我处理一下', historyWithReturn);
      expect(result.category).toBe('unknown');
      expect(result.confidence).toBe(0);
    });

    it('空历史时不触发历史修正', () => {
      const result = classifier.classify('帮我处理一下', []);
      expect(result.category).toBe('unknown');
    });

    it('历史中无用户消息时不触发修正', () => {
      const historyOnlyAssistant: ChatMessage[] = [
        { role: 'assistant', content: '你好，有什么可以帮您' },
      ];
      const result = classifier.classify('帮我处理一下', historyOnlyAssistant);
      expect(result.category).toBe('unknown');
    });
  });

  describe('置信度计算', () => {
    it('置信度按 score/(score+1) 平滑计算', () => {
     const result = classifier.classify('谢谢', []);
      // 平滑公式 score/(score+1)，'谢谢'命中 chitchat 得分6，置信度 = 6/7
      expect(result.confidence).toBeCloseTo(6 / 7, 3);
   });

    it('置信度不超过1', () => {
      const result = classifier.classify('你好', []);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });
});
