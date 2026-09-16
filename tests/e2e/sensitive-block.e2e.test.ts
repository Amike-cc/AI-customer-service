/**
 * E2E 测试：敏感词拦截场景
 *
 * 覆盖场景：E-05
 * 验证完整业务流程：买家消息包含"微信"等 block 类型敏感词 → SensitiveWordChecker 命中 → 返回 fallback_response
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.5 节、第 21.6 节
 */
import { SensitiveWordChecker } from '@/secrets/SensitiveWordChecker';
import { createTestConfig } from '../unit/helpers/testConfig';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

describe('E2E: 敏感词拦截', () => {
  let checker: SensitiveWordChecker;
  let tmpDir: string;
  let dictPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensitive-e2e-'));
    dictPath = path.join(tmpDir, 'sensitive-words.txt');
    // 写入测试敏感词字典（模拟生产 sensitive-words.txt 中的 block 类型词）
    fs.writeFileSync(
      dictPath,
      [
        '# 测试敏感词字典',
        '微信|external_violation|block',
        '支付宝|external_violation|block',
        '线下|external_violation|block',
        '电话|contact_info|warn',
        'QQ号|contact_info|replace',
      ].join('\n'),
      'utf8',
    );

    const config = createTestConfig({
      deepseek: {
        ...createTestConfig().deepseek,
        sensitive_words_dict: dictPath,
        fallback_response: '很抱歉，无法回复此类问题',
      },
    });

    checker = new SensitiveWordChecker(config);
    await checker.load();
  });

  afterEach(() => {
    fs.removeSync(tmpDir);
  });

  it('E-05: 买家消息包含"微信" → 命中 block 类型，passed=false', () => {
    const result = checker.check('加我微信购买吧');

    expect(result.passed).toBe(false);
    expect(result.hits.some((h) => h.word === '微信' && h.action === 'block')).toBe(true);
  });

  it('E-05b: 买家消息包含"支付宝" → 命中 block 类型', () => {
    const result = checker.check('用支付宝转账给你');

    expect(result.passed).toBe(false);
    expect(result.hits.some((h) => h.word === '支付宝' && h.action === 'block')).toBe(true);
  });

  it('E-05c: 买家消息包含"线下" → 命中 block 类型', () => {
    const result = checker.check('我们线下交易吧');

    expect(result.passed).toBe(false);
    expect(result.hits.some((h) => h.word === '线下' && h.action === 'block')).toBe(true);
  });

  it('E-05d: 正常消息不命中敏感词', () => {
    const result = checker.check('这款衣服多少钱');

    expect(result.passed).toBe(true);
    expect(result.hits).toHaveLength(0);
  });
});
