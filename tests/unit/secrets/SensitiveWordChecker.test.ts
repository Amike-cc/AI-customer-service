/**
 * 敏感词检测器单元测试
 */
import { SensitiveWordChecker } from '@/secrets/SensitiveWordChecker';
import { createTestConfig } from '../helpers/testConfig';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

describe('SensitiveWordChecker', () => {
  let tmpDir: string;
  let dictPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sensitive-test-'));
    dictPath = path.join(tmpDir, 'dict.txt');
    await fs.writeFile(
      dictPath,
      ['微信|contact|block', '手机号|phone|warn', '差评|review|replace'].join('\n'),
      'utf8',
    );
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  function makeChecker() {
    const config = createTestConfig({
      deepseek: {
        api_url: 'https://api.deepseek.com/v1/chat/completions',
        model: 'deepseek-v4-flash',
        temperature: 0.2,
        max_tokens: 800,
        top_p: 0.9,
        timeout_ms: 8000,
        stream: false,
        retry_count: 1,
        retry_interval_ms: 100,
        context_rounds: 5,
        context_idle_clear_ms: 300000,
        fallback_response: 'fallback',
        prompt_template: '',
        sensitive_words_dict: dictPath,
        balance: {
          warn_threshold_yuan: 10,
          critical_threshold_yuan: 2,
          check_interval_ms: 3600000,
        },
      },
    });
    return new SensitiveWordChecker(config);
  }

  it('加载字典后可检测', async () => {
    const checker = makeChecker();
    await checker.load();
    const r = checker.check('请加我微信详谈');
    expect(r.passed).toBe(false);
    expect(r.hits.some((h) => h.word === '微信')).toBe(true);
  });

  it('block 类型命中 → passed=false', async () => {
    const checker = makeChecker();
    await checker.load();
    const r = checker.check('我的微信号是 xxx');
    expect(r.passed).toBe(false);
    expect(r.hits[0].action).toBe('block');
  });

  it('warn 类型命中 → passed=true', async () => {
    const checker = makeChecker();
    await checker.load();
    const r = checker.check('留下手机号');
    expect(r.passed).toBe(true);
    expect(r.hits.some((h) => h.action === 'warn')).toBe(true);
  });

  it('replace 类型命中 → passed=true', async () => {
    const checker = makeChecker();
    await checker.load();
    const r = checker.check('我要给差评');
    expect(r.passed).toBe(true);
    expect(r.hits.some((h) => h.action === 'replace')).toBe(true);
  });

  it('无命中返回 passed=true', async () => {
    const checker = makeChecker();
    await checker.load();
    const r = checker.check('普通咨询内容');
    expect(r.passed).toBe(true);
    expect(r.hits).toHaveLength(0);
  });

  it('多处命中全部返回', async () => {
    const checker = makeChecker();
    await checker.load();
    const r = checker.check('微信 手机号 微信');
    expect(r.hits.length).toBeGreaterThanOrEqual(3);
  });

  it('字典文件不存在时为空，全部通过', async () => {
    const config = createTestConfig({
      deepseek: {
        api_url: 'https://api.deepseek.com/v1/chat/completions',
        model: 'deepseek-v4-flash',
        temperature: 0.2,
        max_tokens: 800,
        top_p: 0.9,
        timeout_ms: 8000,
        stream: false,
        retry_count: 1,
        retry_interval_ms: 100,
        context_rounds: 5,
        context_idle_clear_ms: 300000,
        fallback_response: 'fallback',
        prompt_template: '',
        sensitive_words_dict: '/nonexistent/path.txt',
        balance: {
          warn_threshold_yuan: 10,
          critical_threshold_yuan: 2,
          check_interval_ms: 3600000,
        },
      },
    });
    const checker = new SensitiveWordChecker(config);
    await checker.load();
    const r = checker.check('微信');
    expect(r.passed).toBe(true);
  });
});
