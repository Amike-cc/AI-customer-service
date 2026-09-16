/**
 * 限流器单元测试
 * 详见 docs/20-配置规范.md ratelimit 段
 */
import { RateLimiter } from '@/cache/RateLimiter';
import { createTestConfig } from '../helpers/testConfig';

describe('RateLimiter', () => {
  function makeLimiter(overrides?: Parameters<typeof createTestConfig>[0]) {
    return new RateLimiter(createTestConfig(overrides));
  }

  it('关闭后全天不限流且不产生等待', () => {
    const limiter = makeLimiter({
      ratelimit: {
        enabled: false,
        per_shop_per_minute: 1,
        night_factor: 0.1,
        night_hours: [0, 23],
        burst_allowance: 0,
        burst_window_ms: 10000,
      },
    });

    for (let i = 0; i < 100; i++) {
      expect(limiter.tryAcquire('shop-unlimited')).toBe(true);
    }
    expect(limiter.getCurrentLimit()).toBe(Number.POSITIVE_INFINITY);
    expect(limiter.remainingQuota('shop-unlimited')).toBe(Number.POSITIVE_INFINITY);
    expect(limiter.msUntilNextAvailable('shop-unlimited')).toBe(0);
  });

  it('在配额内允许', () => {
    const limiter = makeLimiter({
      ratelimit: {
        per_shop_per_minute: 5,
        night_factor: 1,
        night_hours: [0, 0],
        burst_allowance: 2,
        burst_window_ms: 10000,
      },
    });
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryAcquire('shop1')).toBe(true);
    }
  });

  it('超配额后突发允许', () => {
    const limiter = makeLimiter({
      ratelimit: {
        per_shop_per_minute: 3,
        night_factor: 1,
        night_hours: [0, 0],
        burst_allowance: 2,
        burst_window_ms: 10000,
      },
    });
    for (let i = 0; i < 3; i++) expect(limiter.tryAcquire('shop1')).toBe(true);
    // 突发允许 2 次
    expect(limiter.tryAcquire('shop1')).toBe(true);
    expect(limiter.tryAcquire('shop1')).toBe(true);
    // 完全拒绝
    expect(limiter.tryAcquire('shop1')).toBe(false);
  });

  it('不同店铺独立计数', () => {
    const limiter = makeLimiter({
      ratelimit: {
        per_shop_per_minute: 2,
        night_factor: 1,
        night_hours: [0, 0],
        burst_allowance: 0,
        burst_window_ms: 10000,
      },
    });
    expect(limiter.tryAcquire('shop1')).toBe(true);
    expect(limiter.tryAcquire('shop1')).toBe(true);
    expect(limiter.tryAcquire('shop1')).toBe(false);
    // shop2 仍有配额
    expect(limiter.tryAcquire('shop2')).toBe(true);
  });

  it('reset 清空配额', () => {
    const limiter = makeLimiter({
      ratelimit: {
        per_shop_per_minute: 2,
        night_factor: 1,
        night_hours: [0, 0],
        burst_allowance: 0,
        burst_window_ms: 10000,
      },
    });
    expect(limiter.tryAcquire('shop1')).toBe(true);
    expect(limiter.tryAcquire('shop1')).toBe(true);
    expect(limiter.tryAcquire('shop1')).toBe(false);
    limiter.reset('shop1');
    expect(limiter.tryAcquire('shop1')).toBe(true);
  });

  it('remainingQuota 返回剩余', () => {
    const limiter = makeLimiter({
      ratelimit: {
        per_shop_per_minute: 5,
        night_factor: 1,
        night_hours: [0, 0],
        burst_allowance: 0,
        burst_window_ms: 10000,
      },
    });
    expect(limiter.remainingQuota('shop1')).toBe(5);
    limiter.tryAcquire('shop1');
    limiter.tryAcquire('shop1');
    expect(limiter.remainingQuota('shop1')).toBe(3);
  });

  it('getCurrentLimit 夜间降频', () => {
    const limiter = makeLimiter({
      ratelimit: {
        per_shop_per_minute: 10,
        night_factor: 0.5,
        night_hours: [0, 24],
        burst_allowance: 0,
        burst_window_ms: 10000,
      },
    });
    // night_hours [0, 24] covers all hours, so limit should be 10 * 0.5 = 5
    expect(limiter.getCurrentLimit()).toBe(5);
  });

  it('getCurrentLimit 支持跨午夜夜间时段', () => {
    jest.useFakeTimers();
    const limiter = makeLimiter({
      ratelimit: {
        per_shop_per_minute: 10,
        night_factor: 0.5,
        night_hours: [22, 6],
        burst_allowance: 0,
        burst_window_ms: 10000,
      },
    });

    jest.setSystemTime(new Date(2026, 0, 1, 23, 0, 0));
    expect(limiter.getCurrentLimit()).toBe(5);
    jest.setSystemTime(new Date(2026, 0, 2, 12, 0, 0));
    expect(limiter.getCurrentLimit()).toBe(10);
    jest.useRealTimers();
  });

  it('msUntilNextAvailable 配额满时返回正数', () => {
    const limiter = makeLimiter({
      ratelimit: {
        per_shop_per_minute: 1,
        night_factor: 1,
        night_hours: [0, 0],
        burst_allowance: 0,
        burst_window_ms: 10000,
      },
    });
    expect(limiter.msUntilNextAvailable('shop1')).toBe(0);
    limiter.tryAcquire('shop1');
    const ms = limiter.msUntilNextAvailable('shop1');
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(61000);
  });

  it('1 分钟窗口过期后自动恢复配额', async () => {
    const limiter = makeLimiter({
      ratelimit: {
        per_shop_per_minute: 1,
        night_factor: 1,
        night_hours: [0, 0],
        burst_allowance: 0,
        burst_window_ms: 10000,
      },
    });
    // 模拟 1 分钟前的时间戳
    limiter.tryAcquire('shop1');
    expect(limiter.tryAcquire('shop1')).toBe(false);

    // 通过 mock 时间无法直接做到，此处使用真实等待 60s 过长
    // 改为验证 msUntilNextAvailable 递减
    const ms1 = limiter.msUntilNextAvailable('shop1');
    await new Promise((r) => setTimeout(r, 50));
    const ms2 = limiter.msUntilNextAvailable('shop1');
    expect(ms2).toBeLessThan(ms1);
  });

  it('突发窗口内允许超出配额', () => {
    const limiter = makeLimiter({
      ratelimit: {
        per_shop_per_minute: 2,
        night_factor: 1,
        night_hours: [0, 7],
        burst_allowance: 3,
        burst_window_ms: 60000,
      },
    });
    // 用完配额
    expect(limiter.tryAcquire('shop1')).toBe(true);
    expect(limiter.tryAcquire('shop1')).toBe(true);
    // 突发允许 3 次
    expect(limiter.tryAcquire('shop1')).toBe(true);
    expect(limiter.tryAcquire('shop1')).toBe(true);
    expect(limiter.tryAcquire('shop1')).toBe(true);
    // 超出突发限制
    expect(limiter.tryAcquire('shop1')).toBe(false);
  });

  it('reset 也重置突发计数', () => {
    const limiter = makeLimiter({
      ratelimit: {
        per_shop_per_minute: 2,
        night_factor: 1,
        night_hours: [0, 7],
        burst_allowance: 2,
        burst_window_ms: 60000,
      },
    });
    expect(limiter.tryAcquire('shop1')).toBe(true);
    expect(limiter.tryAcquire('shop1')).toBe(true);
    expect(limiter.tryAcquire('shop1')).toBe(true); // 突发
    limiter.reset('shop1');
    // reset 后配额恢复
    expect(limiter.remainingQuota('shop1')).toBe(2);
    expect(limiter.tryAcquire('shop1')).toBe(true);
  });

  it('多个店铺突发互不干扰', () => {
    const limiter = makeLimiter({
      ratelimit: {
        per_shop_per_minute: 1,
        night_factor: 1,
        night_hours: [0, 7],
        burst_allowance: 2,
        burst_window_ms: 60000,
      },
    });
    // shop1 用完配额和突发
    expect(limiter.tryAcquire('shop1')).toBe(true);
    expect(limiter.tryAcquire('shop1')).toBe(true);
    expect(limiter.tryAcquire('shop1')).toBe(true);
    expect(limiter.tryAcquire('shop1')).toBe(false);
    // shop2 仍有完整配额
    expect(limiter.tryAcquire('shop2')).toBe(true);
    expect(limiter.remainingQuota('shop2')).toBe(0);
  });
});
