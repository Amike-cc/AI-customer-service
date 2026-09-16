/**
 * E2E 测试：转人工场景
 *
 * 覆盖场景：E-10
 * 验证完整业务流程：买家要求转人工 → 规则引擎匹配 human_service → 返回转接提示
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.5 节、第 9.2 节规则引擎
 */
import { RuleEngine } from '@/rules/RuleEngine';
import { createTestConfig } from '../unit/helpers/testConfig';

describe('E2E: 转人工', () => {
  let ruleEngine: RuleEngine;
  const config = createTestConfig();

  beforeEach(() => {
    ruleEngine = new RuleEngine(config, 'shop-e2e-10');
  });

  it('E-10: 买家输入"转人工" → 匹配 human_service 规则', () => {
    const result = ruleEngine.match('转人工');

    expect(result.matched).toBe(true);
    expect(result.ruleName).toBe('human_service');
    expect(result.answer).toContain('人工');
  });

  it('E-10b: 买家输入"找真人客服" → 匹配 human_service 规则', () => {
    const result = ruleEngine.match('找真人客服');

    expect(result.matched).toBe(true);
    expect(result.ruleName).toBe('human_service');
  });

  it('E-10c: 买家输入"不想和机器人说话" → 匹配 human_service 规则', () => {
    const result = ruleEngine.match('我不想和机器人说话');

    expect(result.matched).toBe(true);
    expect(result.ruleName).toBe('human_service');
  });

  it('E-10d: 售后问题也引导转人工', () => {
    const result = ruleEngine.match('我要退货退款');

    expect(result.matched).toBe(true);
    expect(result.ruleName).toBe('return_policy');
    expect(result.answer).toContain('人工');
  });
});
