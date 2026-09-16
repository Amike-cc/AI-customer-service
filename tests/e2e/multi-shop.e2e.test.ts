/**
 * E2E 测试：多店铺并发场景
 *
 * 覆盖场景：E-11
 * 验证完整业务流程：两个店铺同时收到消息 → 各自 RuleEngine/RateLimiter 独立处理
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.5 节、第 7 章状态机与进程模型
 */
import { RuleEngine } from '@/rules/RuleEngine';
import { RateLimiter } from '@/cache/RateLimiter';
import { createTestConfig } from '../unit/helpers/testConfig';

describe('E2E: 多店铺并发', () => {
  const config = createTestConfig({
    ratelimit: {
      per_shop_per_minute: 10,
      night_factor: 1.0,
      night_hours: [0, 0],
      burst_allowance: 0,
      burst_window_ms: 10000,
    },
  });

  it('E-11: 两个店铺的 RuleEngine 互不影响', () => {
    const engineA = new RuleEngine(config, 'shop-e2e-11a');
    const engineB = new RuleEngine(config, 'shop-e2e-11b');

    const resultA = engineA.match('转人工');
    const resultB = engineB.match('你好');

    expect(resultA.matched).toBe(true);
    expect(resultA.ruleName).toBe('human_service');

    expect(resultB.matched).toBe(true);
    expect(resultB.ruleName).toBe('greeting');
  });

  it('E-11b: 两个店铺的 RateLimiter 配额独立', () => {
    const limiter = new RateLimiter(config);
    const shopA = 'shop-e2e-11a';
    const shopB = 'shop-e2e-11b';

    // shopA 用完配额
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryAcquire(shopA)).toBe(true);
    }
    expect(limiter.tryAcquire(shopA)).toBe(false);

    // shopB 仍有完整配额
    expect(limiter.tryAcquire(shopB)).toBe(true);
    expect(limiter.remainingQuota(shopB)).toBe(9);
  });

  it('E-11c: 并发处理不同店铺的消息', () => {
    const engineA = new RuleEngine(config, 'shop-e2e-11c');
    const engineB = new RuleEngine(config, 'shop-e2e-11d');

    const messages = [
      { shop: 'shop-e2e-11c', engine: engineA, msg: '多少钱', expected: 'price_inquiry' },
      { shop: 'shop-e2e-11d', engine: engineB, msg: '什么时候发货', expected: 'shipping_time' },
      { shop: 'shop-e2e-11c', engine: engineA, msg: '退货', expected: 'return_policy' },
      { shop: 'shop-e2e-11d', engine: engineB, msg: '有货吗', expected: 'stock_inquiry' },
    ];

    const results = messages.map((m) => ({
      shop: m.shop,
      result: m.engine.match(m.msg),
      expected: m.expected,
    }));

    for (const r of results) {
      expect(r.result.matched).toBe(true);
      expect(r.result.ruleName).toBe(r.expected);
    }
  });
});
