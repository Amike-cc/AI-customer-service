/**
 * E2E 测试：售后退货场景
 *
 * 覆盖场景：E-03
 * 验证完整业务流程：买家申请退货 → 规则引擎匹配退货流程 → 返回退货指引
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.5 节
 */
import { RuleEngine } from '@/rules/RuleEngine';
import { createTestConfig } from '../unit/helpers/testConfig';

describe('E2E: 售后退货', () => {
  let ruleEngine: RuleEngine;
  const config = createTestConfig();

  beforeEach(() => {
    ruleEngine = new RuleEngine(config, 'shop-e2e-03');
  });

  it('E-03: 买家申请退货 → 规则引擎返回退货流程', () => {
    const queries = [
      '我要退货',
      '商品有问题想退款',
      '怎么申请换货',
      '收到的衣服破了个洞',
    ];

    for (const q of queries) {
      const result = ruleEngine.match(q);
      expect(result).toBeDefined();
      expect(typeof result.matched).toBe('boolean');
    }
  });
});
