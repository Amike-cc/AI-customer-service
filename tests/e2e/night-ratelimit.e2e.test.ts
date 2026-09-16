/**
 * E2E 测试：夜间限流场景
 *
 * 覆盖场景：E-12
 * 验证完整业务流程：全天关闭限流 → 所有请求直接放行
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.5 节、第 20 章配置规范
 */
import { RateLimiter } from '@/cache/RateLimiter';
import { createTestConfig } from '../unit/helpers/testConfig';

describe('E2E: 夜间限流', () => {
  it('E-12: 全天关闭限流后额度为无限', () => {
    const config = createTestConfig({
      ratelimit: {
        enabled: false,
        per_shop_per_minute: 10,
        night_factor: 1.0,
        night_hours: [0, 0],
        burst_allowance: 0,
        burst_window_ms: 10000,
      },
    });
    const limiter = new RateLimiter(config);
    expect(limiter.getCurrentLimit()).toBe(Number.POSITIVE_INFINITY);
  });

  it('E-12b: 全天关闭限流后连续请求全部放行', () => {
    const config = createTestConfig({
      ratelimit: {
        enabled: false,
        per_shop_per_minute: 10,
        night_factor: 1.0,
        night_hours: [0, 0],
        burst_allowance: 0,
        burst_window_ms: 10000,
      },
    });
    const limiter = new RateLimiter(config);
    const limit = limiter.getCurrentLimit();

    let accepted = 0;
    for (let i = 0; i < 15; i++) {
      if (limiter.tryAcquire('shop-e2e-12')) accepted++;
    }

    expect(limit).toBe(Number.POSITIVE_INFINITY);
    expect(accepted).toBe(15);
  });

  it('E-12c: night_hours 配置为全天 → 持续降频', () => {
    const config = createTestConfig({
      ratelimit: {
        per_shop_per_minute: 10,
        night_factor: 0.7,
        night_hours: [0, 24],
        burst_allowance: 0,
        burst_window_ms: 10000,
      },
    });
    const limiter = new RateLimiter(config);

    // 0-24 覆盖全天，所以始终降频
    expect(limiter.getCurrentLimit()).toBe(7); // 10 * 0.7 = 7
  });

  it('E-12d: night_factor 为 1.0 时不降频', () => {
    const config = createTestConfig({
      ratelimit: {
        per_shop_per_minute: 10,
        night_factor: 1.0,
        night_hours: [0, 24],
        burst_allowance: 0,
        burst_window_ms: 10000,
      },
    });
    const limiter = new RateLimiter(config);

    expect(limiter.getCurrentLimit()).toBe(10);
  });
});
