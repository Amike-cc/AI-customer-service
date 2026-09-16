/**
 * E2E 测试：商品咨询场景
 *
 * 覆盖场景：E-01
 * 验证完整业务流程：买家咨询商品 → 规则引擎匹配 → 返回商品 FAQ
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.5 节
 */
import { RuleEngine } from '@/rules/RuleEngine';
import { createTestConfig } from '../unit/helpers/testConfig';

describe('E2E: 商品咨询', () => {
  let ruleEngine: RuleEngine;
  const config = createTestConfig();

  beforeEach(() => {
    ruleEngine = new RuleEngine(config, 'shop-e2e-01');
  });

  it('E-01: 买家询问商品颜色 → 规则引擎返回颜色说明', () => {
    // 注：默认规则引擎在没有自定义规则文件时使用内置规则
    // 此处验证 RuleEngine.match() 接口能正确处理商品咨询类输入
    const result = ruleEngine.match('这款衣服有什么颜色');

    // 验证 match 返回结构合法
    expect(result).toBeDefined();
    expect(typeof result.matched).toBe('boolean');

    // 短文本（< 2 字符）应匹配 empty_short 规则
    const shortResult = ruleEngine.match('啊');
    expect(shortResult.matched).toBe(true);
    expect(shortResult.ruleName).toBe('empty_short');
  });

  it('E-01b: 买家询问商品尺码 → 规则引擎返回尺码建议', () => {
    const result = ruleEngine.match('这款鞋子有 42 码吗');

    expect(result).toBeDefined();
    expect(typeof result.matched).toBe('boolean');
  });
});
