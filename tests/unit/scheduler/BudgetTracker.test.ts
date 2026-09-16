/**
 * BudgetTracker 单元测试
 */
import { BudgetTracker } from '@/scheduler/BudgetTracker';
import { createTestConfig } from '../helpers/testConfig';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

describe('BudgetTracker', () => {
  function makeTracker(overrides?: Parameters<typeof createTestConfig>[0]) {
    // 传入 null 禁用持久化：测试共享 ./test-data 目录，持久化会互相污染
    return new BudgetTracker(createTestConfig(overrides), null);
  }

  it('记录成本后日成本增加', () => {
    const tracker = makeTracker();
    tracker.record({
      shopId: 'shop1',
      costYuan: 1.5,
      tokens: 1000,
      timestamp: Date.now(),
      tier: 'tier3',
      provider: 'deepseek',
    });
    expect(tracker.getDailyCost('shop1')).toBe(1.5);
  });

  it('全局日成本累加', () => {
    const tracker = makeTracker();
    tracker.record({ shopId: 'shop1', costYuan: 1, tokens: 100, timestamp: Date.now(), tier: 'tier3', provider: 'deepseek' });
    tracker.record({ shopId: 'shop2', costYuan: 2, tokens: 200, timestamp: Date.now(), tier: 'tier2', provider: 'qwen' });
    expect(tracker.getGlobalDailyCost()).toBe(3);
  });

  it('店铺超预算检测', () => {
    const tracker = makeTracker({
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
    tracker.record({ shopId: 'shop1', costYuan: 6, tokens: 500, timestamp: Date.now(), tier: 'tier3', provider: 'deepseek' });
    expect(tracker.isShopOverBudget('shop1')).toBe(true);
  });

  it('优先级影响预算限额', () => {
    const tracker = makeTracker({
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
    tracker.setShopPriority('shop1', 'high');
    tracker.record({ shopId: 'shop1', costYuan: 6, tokens: 500, timestamp: Date.now(), tier: 'tier3', provider: 'deepseek' });
    expect(tracker.isShopOverBudget('shop1')).toBe(false);

    tracker.setShopPriority('shop2', 'low');
    tracker.record({ shopId: 'shop2', costYuan: 3, tokens: 300, timestamp: Date.now(), tier: 'tier2', provider: 'qwen' });
    expect(tracker.isShopOverBudget('shop2')).toBe(true);
  });

  it('全局预算超限检测', () => {
    const tracker = makeTracker({
      scheduler: {
        enabled: true,
        token_bucket: { daily_budget_yuan: 50, reserve_ratio: 0.2 },
        budget: {
          global_daily_yuan: 10,
          global_monthly_yuan: 2000,
          per_shop_daily_yuan: 5,
          warn_threshold: 0.8,
          critical_threshold: 1.0,
        },
        default_priority: 'normal',
      },
    });
    tracker.record({ shopId: 'shop1', costYuan: 11, tokens: 500, timestamp: Date.now(), tier: 'tier3', provider: 'deepseek' });
    expect(tracker.isGlobalOverBudget()).toBe(true);
  });

  it('跨日重启时保留当月成本并清零日成本', () => {
    jest.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-'));
    const stateFile = path.join(dir, 'budget.json');
    try {
      jest.setSystemTime(new Date('2026-08-12T10:00:00+08:00'));
      const first = new BudgetTracker(createTestConfig(), stateFile);
      first.record({
        shopId: 'shop1', costYuan: 3, tokens: 100, timestamp: Date.now(), tier: 'tier2', provider: 'qwen',
      });

      jest.setSystemTime(new Date('2026-08-13T10:00:00+08:00'));
      const restarted = new BudgetTracker(createTestConfig(), stateFile);
      expect(restarted.getGlobalDailyCost()).toBe(0);
      expect(restarted.getDailyCost('shop1')).toBe(0);
      expect(restarted.getGlobalMonthlyCost()).toBe(3);
    } finally {
      jest.useRealTimers();
      fs.removeSync(dir);
    }
  });
});
