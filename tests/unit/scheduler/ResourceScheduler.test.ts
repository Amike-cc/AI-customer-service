/**
 * ResourceScheduler 单元测试
 */
import { ResourceScheduler } from '@/scheduler/ResourceScheduler';
import { CostTokenBucket } from '@/scheduler/CostTokenBucket';
import { BudgetTracker } from '@/scheduler/BudgetTracker';
import { PrioritySelector } from '@/scheduler/PrioritySelector';
import { createTestConfig } from '../helpers/testConfig';
import type { MetricsCollector } from '@/monitor/MetricsCollector';
import type { AppLogger } from '@/logging/logger';

function makeScheduler(overrides?: Parameters<typeof createTestConfig>[0]) {
  const config = createTestConfig(overrides);
  const metrics = {
    inc: jest.fn(),
    set: jest.fn(),
    observe: jest.fn(),
  } as unknown as MetricsCollector;
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as AppLogger;
  const tokenBucket = new CostTokenBucket(config);
  const budgetTracker = new BudgetTracker(config, null);
  const prioritySelector = new PrioritySelector(config);
  const scheduler = new ResourceScheduler({
    tokenBucket,
    budgetTracker,
    prioritySelector,
    metrics,
    logger,
    config,
  });
  return { scheduler, tokenBucket, budgetTracker, prioritySelector };
}

describe('ResourceScheduler', () => {
  it('预算充足时允许执行', async () => {
    const { scheduler } = makeScheduler();
    const decision = await scheduler.acquire({
      shopId: 'shop1',
      estimatedTokens: 500,
      estimatedCostYuan: 0.5,
      tier: 'tier3',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.allocatedTier).toBe('tier3');
  });

  it('全局预算超限时拒绝', async () => {
    const { scheduler, budgetTracker } = makeScheduler({
      scheduler: {
        enabled: true,
        token_bucket: { daily_budget_yuan: 50, reserve_ratio: 0.2 },
        budget: {
          global_daily_yuan: 5,
          global_monthly_yuan: 2000,
          per_shop_daily_yuan: 5,
          warn_threshold: 0.8,
          critical_threshold: 1.0,
        },
        default_priority: 'normal',
      },
    });
    budgetTracker.record({
      shopId: 'shop1',
      costYuan: 6,
      tokens: 1000,
      timestamp: Date.now(),
      tier: 'tier3',
      provider: 'deepseek',
    });
    const decision = await scheduler.acquire({
      shopId: 'shop1',
      estimatedTokens: 500,
      estimatedCostYuan: 0.5,
      tier: 'tier3',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.rejectReason).toBe('global_daily_budget_exceeded');
  });

  it('店铺预算超限时拒绝', async () => {
    const { scheduler, budgetTracker } = makeScheduler({
      scheduler: {
        enabled: true,
        token_bucket: { daily_budget_yuan: 50, reserve_ratio: 0.2 },
        budget: {
          global_daily_yuan: 100,
          global_monthly_yuan: 2000,
          per_shop_daily_yuan: 1,
          warn_threshold: 0.8,
          critical_threshold: 1.0,
        },
        default_priority: 'normal',
      },
    });
    budgetTracker.record({
      shopId: 'shop1',
      costYuan: 2,
      tokens: 500,
      timestamp: Date.now(),
      tier: 'tier3',
      provider: 'deepseek',
    });
    const decision = await scheduler.acquire({
      shopId: 'shop1',
      estimatedTokens: 500,
      estimatedCostYuan: 0.5,
      tier: 'tier3',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.rejectReason).toBe('shop_daily_budget_exceeded');
  });

  it('令牌桶不足时降级到更便宜层级', async () => {
    const { scheduler, tokenBucket } = makeScheduler({
      scheduler: {
        enabled: true,
        token_bucket: { daily_budget_yuan: 1, reserve_ratio: 0.1 },
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
    tokenBucket.tryConsume(0.9);
    const decision = await scheduler.acquire({
      shopId: 'shop1',
      estimatedTokens: 5000,
      estimatedCostYuan: 0.5,
      tier: 'tier3',
    });
    expect(decision.allowed).toBe(true);
    expect(['tier1', 'tier2']).toContain(decision.allocatedTier);
  });

  it('recordCost 记录成本', () => {
    const { scheduler, budgetTracker } = makeScheduler();
    scheduler.recordCost({
      shopId: 'shop1',
      costYuan: 1.5,
      tokens: 1000,
      timestamp: Date.now(),
      tier: 'tier3',
      provider: 'deepseek',
    });
    expect(scheduler.getDailyCost('shop1')).toBe(1.5);
    expect(budgetTracker.getGlobalDailyCost()).toBe(1.5);
  });

  it('为并发请求原子预留预算，完成前不会重复放行同一余额', async () => {
    const { scheduler } = makeScheduler({
      scheduler: {
        enabled: true,
        token_bucket: { daily_budget_yuan: 10, reserve_ratio: 0.2 },
        budget: {
          global_daily_yuan: 10,
          global_monthly_yuan: 100,
          per_shop_daily_yuan: 1,
          warn_threshold: 0.8,
          critical_threshold: 1,
        },
        default_priority: 'normal',
      },
    });

    const first = await scheduler.acquire({
      shopId: 'shop1', estimatedTokens: 100, estimatedCostYuan: 0.6, tier: 'tier1',
    });
    const second = await scheduler.acquire({
      shopId: 'shop1', estimatedTokens: 100, estimatedCostYuan: 0.6, tier: 'tier1',
    });

    expect(first.allowed).toBe(true);
    expect(first.reservationId).toBeDefined();
    expect(second.allowed).toBe(false);
    expect(second.rejectReason).toBe('shop_daily_budget_exceeded');

    scheduler.releaseReservation(first.reservationId);
    const afterRelease = await scheduler.acquire({
      shopId: 'shop1', estimatedTokens: 100, estimatedCostYuan: 0.6, tier: 'tier1',
    });
    expect(afterRelease.allowed).toBe(true);
    scheduler.releaseReservation(afterRelease.reservationId);
  });

  it('执行月预算上限', async () => {
    const { scheduler, budgetTracker } = makeScheduler({
      scheduler: {
        enabled: true,
        token_bucket: { daily_budget_yuan: 50, reserve_ratio: 0.2 },
        budget: {
          global_daily_yuan: 100,
          global_monthly_yuan: 1,
          per_shop_daily_yuan: 10,
          warn_threshold: 0.8,
          critical_threshold: 1,
        },
        default_priority: 'normal',
      },
    });
    budgetTracker.record({
      shopId: 'shop1', costYuan: 0.8, tokens: 100, timestamp: Date.now(), tier: 'tier1', provider: 'qwen',
    });

    const decision = await scheduler.acquire({
      shopId: 'shop1', estimatedTokens: 100, estimatedCostYuan: 0.3, tier: 'tier1',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.rejectReason).toBe('global_monthly_budget_exceeded');
  });

  it('scheduler 禁用时不执行预算拒绝', async () => {
    const { scheduler, budgetTracker } = makeScheduler({
      scheduler: {
        enabled: false,
        token_bucket: { daily_budget_yuan: 1, reserve_ratio: 0.2 },
        budget: {
          global_daily_yuan: 1,
          global_monthly_yuan: 1,
          per_shop_daily_yuan: 1,
          warn_threshold: 0.8,
          critical_threshold: 1,
        },
        default_priority: 'normal',
      },
    });
    budgetTracker.record({
      shopId: 'shop1', costYuan: 10, tokens: 100, timestamp: Date.now(), tier: 'tier3', provider: 'deepseek',
    });
    const decision = await scheduler.acquire({
      shopId: 'shop1', estimatedTokens: 100, estimatedCostYuan: 10, tier: 'tier3',
    });
    expect(decision).toEqual({ allowed: true, allocatedTier: 'tier3' });
  });

  it('热重载后使用新的预算配置', async () => {
    const { scheduler } = makeScheduler();
    const nextConfig = createTestConfig({
      scheduler: {
        enabled: true,
        token_bucket: { daily_budget_yuan: 50, reserve_ratio: 0.2 },
        budget: {
          global_daily_yuan: 0.1,
          global_monthly_yuan: 1,
          per_shop_daily_yuan: 0.1,
          warn_threshold: 0.8,
          critical_threshold: 1,
        },
        default_priority: 'normal',
      },
    });
    scheduler.updateConfig(nextConfig);
    const decision = await scheduler.acquire({
      shopId: 'shop1', estimatedTokens: 100, estimatedCostYuan: 0.2, tier: 'tier1',
    });
    expect(decision.allowed).toBe(false);
  });
});
