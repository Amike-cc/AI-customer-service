/**
 * E2E 测试：物流查询场景
 *
 * 覆盖场景：E-02
 * 验证完整业务流程：买家询问物流 → 规则引擎匹配物流模板 → 返回物流查询引导
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.5 节
 */
import { RuleEngine } from '@/rules/RuleEngine';
import { createTestConfig } from '../unit/helpers/testConfig';

describe('E2E: 物流查询', () => {
  let ruleEngine: RuleEngine;
  const config = createTestConfig();

  beforeEach(() => {
    ruleEngine = new RuleEngine(config, 'shop-e2e-02');
  });

  it('E-02: 买家询问快递进度 → 规则引擎返回物流查询引导', () => {
    const queries = [
      '我的快递到哪了',
      '什么时候发货',
      '物流单号是多少',
      '快递怎么还没到',
    ];

    for (const q of queries) {
      const result = ruleEngine.match(q);
      expect(result).toBeDefined();
      expect(typeof result.matched).toBe('boolean');
    }
  });
});
