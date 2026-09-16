/**
 * CostTokenBucket 单元测试
 */
import { CostTokenBucket } from '@/scheduler/CostTokenBucket';
import { createTestConfig } from '../helpers/testConfig';

describe('CostTokenBucket', () => {
  function makeBucket(overrides?: Parameters<typeof createTestConfig>[0]) {
    return new CostTokenBucket(createTestConfig(overrides));
  }

  it('初始状态为满桶', () => {
    const bucket = makeBucket({
      scheduler: {
        enabled: true,
        token_bucket: { daily_budget_yuan: 50, reserve_ratio: 0.2 },
        budget: {
          global_daily_yuan: 100,
          global_monthly_yuan: 2000,
          per_shop_daily_yuan: 5,
          warn_threshold: 0.8,
          critical_threshold: 1.0,
        },
        default_priority: 'normal',
      },
    });
    expect(bucket.remaining).toBe(50);
  });

  it('消费后余额减少', () => {
    const bucket = makeBucket({
      scheduler: {
        enabled: true,
        token_bucket: { daily_budget_yuan: 50, reserve_ratio: 0.2 },
        budget: {
          global_daily_yuan: 100,
          global_monthly_yuan: 2000,
          per_shop_daily_yuan: 5,
          warn_threshold: 0.8,
          critical_threshold: 1.0,
        },
        default_priority: 'normal',
      },
    });
    const result = bucket.tryConsume(10);
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(40);
  });

  it('余额不足时消费失败', () => {
    const bucket = makeBucket({
      scheduler: {
        enabled: true,
        token_bucket: { daily_budget_yuan: 50, reserve_ratio: 0.2 },
        budget: {
          global_daily_yuan: 100,
          global_monthly_yuan: 2000,
          per_shop_daily_yuan: 5,
          warn_threshold: 0.8,
          critical_threshold: 1.0,
        },
        default_priority: 'normal',
      },
    });
    const result = bucket.tryConsume(60);
    expect(result.success).toBe(false);
    expect(result.remaining).toBe(50);
  });

  it('peek 不消费', () => {
    const bucket = makeBucket({
      scheduler: {
        enabled: true,
        token_bucket: { daily_budget_yuan: 50, reserve_ratio: 0.2 },
        budget: {
          global_daily_yuan: 100,
          global_monthly_yuan: 2000,
          per_shop_daily_yuan: 5,
          warn_threshold: 0.8,
          critical_threshold: 1.0,
        },
        default_priority: 'normal',
      },
    });
    const before = bucket.remaining;
    bucket.peek(10);
    expect(bucket.remaining).toBe(before);
  });

  it('reset 后恢复满桶', () => {
    const bucket = makeBucket({
      scheduler: {
        enabled: true,
        token_bucket: { daily_budget_yuan: 50, reserve_ratio: 0.2 },
        budget: {
          global_daily_yuan: 100,
          global_monthly_yuan: 2000,
          per_shop_daily_yuan: 5,
          warn_threshold: 0.8,
          critical_threshold: 1.0,
        },
        default_priority: 'normal',
      },
    });
    bucket.tryConsume(30);
    bucket.reset();
    expect(bucket.remaining).toBe(50);
  });
});
