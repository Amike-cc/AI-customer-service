/**
 * 规则引擎单元测试
 * 详见 docs/开发文档-v2.md §10.2 §10.6
 */
import { RuleEngine } from '@/rules/RuleEngine';
import { createTestConfig } from '../helpers/testConfig';
import fs from 'fs-extra';
import path from 'path';

describe('RuleEngine', () => {
  let engine: RuleEngine;

  beforeEach(() => {
    engine = new RuleEngine(createTestConfig());
  });

  it('空字符串/单字符 → 默认应答', () => {
    const r1 = engine.match('');
    expect(r1.matched).toBe(true);
    expect(r1.ruleName).toBe('empty_short');

    const r2 = engine.match('a');
    expect(r2.matched).toBe(true);
    expect(r2.ruleName).toBe('empty_short');
  });

  it('问候语匹配', () => {
    for (const text of ['你好', '您好', 'hi', 'hello', '哈喽', '在吗', '在不在']) {
      const r = engine.match(text);
      expect(r.matched).toBe(true);
      expect(r.ruleName).toBe('greeting');
      expect(r.answer).toContain('您好');
    }
  });

  it('感谢匹配', () => {
    for (const text of ['谢谢', '感谢', '多谢', 'thanks', 'thx']) {
      const r = engine.match(text);
      expect(r.matched).toBe(true);
      expect(r.ruleName).toBe('thanks');
    }
  });

  it('纯表情/标点匹配', () => {
    const r = engine.match('😊👍');
    expect(r.matched).toBe(true);
    expect(r.ruleName).toBe('emoji_only');
  });

  it('发货时间匹配', () => {
    for (const text of ['什么时候发货', '几天能到货', '多久能送达']) {
      const r = engine.match(text);
      expect(r.matched).toBe(true);
      expect(r.ruleName).toBe('shipping_time');
    }
  });

  it('无匹配返回 matched=false', () => {
    const r = engine.match('今天天气真好啊');
    expect(r.matched).toBe(false);
    expect(r.answer).toBeUndefined();
  });

  it('优先级排序（问候语优先于 emoji_only）', () => {
    // "你好😊" 应优先匹配 greeting
    const r = engine.match('你好😊');
    expect(r.matched).toBe(true);
    expect(r.ruleName).toBe('greeting');
  });

  it('前后空白 trim 后匹配', () => {
    const r = engine.match('   你好   ');
    expect(r.matched).toBe(true);
    expect(r.ruleName).toBe('greeting');
  });

  it('listRules 返回所有规则', () => {
    const rules = engine.listRules();
    expect(rules.length).toBeGreaterThan(0);
    // 验证规则按优先级排序
    for (let i = 1; i < rules.length; i++) {
      expect(rules[i - 1].priority).toBeGreaterThanOrEqual(rules[i].priority);
    }
  });

  it('reloadRules 不报错', () => {
    expect(() => engine.reloadRules()).not.toThrow();
  });

  it('只读初始化不会为店铺复制全局规则文件', () => {
    const shopId = `readonly-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const shopRulePath = path.resolve(
      process.cwd(),
      'config',
      'rules',
      'common',
      shopId,
      'custom-rules.json',
    );

    const shopEngine = new RuleEngine(createTestConfig(), shopId);

    expect(shopEngine.listRules().length).toBeGreaterThan(0);
    expect(fs.pathExistsSync(shopRulePath)).toBe(false);
  });

  it('禁用规则不参与匹配', () => {
    const rules = engine.listRules();
    // 至少有一个规则
    const firstRule = rules[0];
    // 直接修改内部规则状态来测试禁用逻辑
    // 通过 addRule 添加一个禁用的规则
    const testName = `test_disabled_${Date.now()}`;
    engine.addRule({
      name: testName,
      pattern: '独一无二的测试文本xyz',
      answer: '禁用规则不应匹配',
      priority: 999,
      enabled: false,
      source: 'custom',
    });
    engine.reloadRules();
    // 即使高优先级，禁用规则也不匹配
    const r = engine.match('独一无二的测试文本xyz');
    // 禁用规则不应该匹配，但可能匹配到 empty_short
    expect(r.ruleName).not.toBe(testName);
    // 清理
    engine.deleteRule(testName);
  });

  it('addRule 添加后立即可匹配', () => {
    const testName = `test_add_${Date.now()}`;
    engine.addRule({
      name: testName,
      pattern: '测试添加规则',
      answer: '添加成功',
      priority: 100,
      enabled: true,
      source: 'custom',
    });
    const r = engine.match('测试添加规则');
    expect(r.matched).toBe(true);
    expect(r.ruleName).toBe(testName);
    engine.deleteRule(testName);
  });

  it('deleteRule 删除后不再匹配', () => {
    const testName = `test_del_${Date.now()}`;
    engine.addRule({
      name: testName,
      pattern: '测试删除规则',
      answer: '待删除',
      priority: 100,
      enabled: true,
      source: 'custom',
    });
    engine.deleteRule(testName);
    const r = engine.match('测试删除规则');
    expect(r.ruleName).not.toBe(testName);
  });

  it('updateRule 更新规则内容', () => {
    const testName = `test_update_${Date.now()}`;
    engine.addRule({
      name: testName,
      pattern: '原始匹配文本',
      answer: '原始回复',
      priority: 50,
      enabled: true,
      source: 'custom',
    });
    engine.updateRule(testName, {
      pattern: '更新后的匹配文本',
      answer: '更新后的回复',
    });
    const r = engine.match('更新后的匹配文本');
    expect(r.matched).toBe(true);
    expect(r.answer).toBe('更新后的回复');
    engine.deleteRule(testName);
  });
});
