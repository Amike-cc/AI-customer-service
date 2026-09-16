/**
 * E2E 测试：限流降级场景
 *
 * 覆盖场景：E-07
 * 验证完整业务流程：单店 1 分钟内 11 次请求 → 第 11 次被 RateLimiter 拒绝
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.5 节、第 20 章配置规范
 */
import { RateLimiter } from '@/cache/RateLimiter';
import { createTestConfig } from '../unit/helpers/testConfig';

describe('E2E: 限流降级', () => {
  let limiter: RateLimiter;
  const config = createTestConfig({
    ratelimit: {
      per_shop_per_minute: 10,
      night_factor: 1.0,
      night_hours: [0, 0],
      burst_allowance: 0,
      burst_window_ms: 10000,
    },
  });

  beforeEach(() => {
    limiter = new RateLimiter(config);
  });

  it('E-07: 单店 1 分钟内前 10 次请求通过，第 11 次被拒绝', () => {
    const shopId = 'shop-e2e-07';

    const results: boolean[] = [];
    for (let i = 0; i < 11; i++) {
      results.push(limiter.tryAcquire(shopId));
    }

    // 前 10 次通过
    expect(results.slice(0, 10).every((r) => r === true)).toBe(true);
    // 第 11 次被拒绝
    expect(results[10]).toBe(false);
  });

  it('E-07b: 不同店铺限流互不影响', () => {
    const shopA = 'shop-e2e-07a';
    const shopB = 'shop-e2e-07b';

    // shopA 跑满 10 次
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryAcquire(shopA)).toBe(true);
    }
    // shopA 第 11 次被拒
    expect(limiter.tryAcquire(shopA)).toBe(false);

    // shopB 应仍可获取
    expect(limiter.tryAcquire(shopB)).toBe(true);
  });
});
