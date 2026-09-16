/**
 * 故障注入测试：资源耗尽与预算控制
 *
 * 覆盖场景：
 * - C-12: LruCache 大量操作后定时器/资源正确清理（内存泄漏防护）
 * - C-19: 预算超限时 ResourceScheduler 拒绝请求
 * - C-20: 令牌桶耗尽时调度器降级到更便宜的 Tier
 *
 * 对应文档：docs/开发文档-综合版.md §12.4 节、第 15 节 Token 测算与成本控制 */
import { LruCache } from '@/cache/LruCache';
import { ContextManager } from '@/cache/ContextManager';
import { ConversationContextRepo } from '@/db/repos/ConversationContextRepo';
import { ShopStateRepo } from '@/db/repos/ShopStateRepo';
import { ResourceScheduler } from '@/scheduler/ResourceScheduler';
import { CostTokenBucket } from '@/scheduler/CostTokenBucket';
import { BudgetTracker } from '@/scheduler/BudgetTracker';
import { PrioritySelector } from '@/scheduler/PrioritySelector';
import { createMockDatabase } from '../unit/helpers/mockDb';
import { createTestConfig } from '../unit/helpers/testConfig';
import { createLogger } from '@/logging/logger';

function makeMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  } as any;
}

function makeMockMetrics() {
  return {
    inc: jest.fn(),
    set: jest.fn(),
    observe: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
  } as any;
}

describe('Chaos: 资源耗尽与预算控制', () => {
  describe('C-12: LruCache + ContextManager 大量操作后资源清理', () => {
    let db: ReturnType<typeof createMockDatabase>;
    let logger: ReturnType<typeof createLogger>;
    let conversationRepo: ConversationContextRepo;
    let shopStateRepo: ShopStateRepo;

    beforeEach(() => {
      db = createMockDatabase();
      db.exec(`
        CREATE TABLE conversation_context (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_id TEXT NOT NULL, session_id TEXT NOT NULL,
          role TEXT NOT NULL, content TEXT NOT NULL,
          product_id TEXT, token_count INTEGER, created_at INTEGER NOT NULL
        );
        CREATE TABLE shop_state (
          shop_id TEXT PRIMARY KEY, current_state TEXT NOT NULL,
          entered_at INTEGER NOT NULL, last_message_at INTEGER,
          unread_count INTEGER DEFAULT 0, updated_at INTEGER NOT NULL
        );
      `);
      logger = createLogger(createTestConfig());
      conversationRepo = new ConversationContextRepo(db as any);
      shopStateRepo = new ShopStateRepo(db as any);
    });

    it('LruCache 5000 次写入后全局条目数受控', () => {
      const config = createTestConfig({
        cache: {
          ttl_ms: 3600000,
          max_entries_per_shop: 50,
          max_entries_global: 200,
          invalidate_on_product_update: true,
        },
      });
      const cache = new LruCache(config);

      for (let i = 0; i < 5000; i++) {
        const shopId = `shop-${i % 10}`;
        cache.set(shopId, `question-${i}`, `answer-${i}`);
      }

      const stats = cache.getStats();
      expect(stats.totalEntries).toBeLessThanOrEqual(200);
    });

    it('ContextManager 多轮操作后 clearAllTimers 正确清理', () => {
      const config = createTestConfig();
      const ctx = new ContextManager(
        config,
        { conversation: conversationRepo, shopState: shopStateRepo } as any,
        logger,
      );

      for (let i = 0; i < 100; i++) {
        ctx.addUserMessage('shop-c12', 'sess-1', `消息 ${i}`);
        ctx.addAssistantMessage('shop-c12', 'sess-1', `回复 ${i}`);
      }

      ctx.clearAllTimers();
      // 验证清理后仍可正常查询
    const messages = ctx.getRecentMessages('shop-c12', 'sess-1');
      expect(messages.length).toBeGreaterThan(0);
    });
  });

  describe('C-19: 预算超限拒绝请求', () => {
    it('店铺日预算超限后 ResourceScheduler 返回 shop_daily_budget_exceeded', async () => {
      const config = createTestConfig({
        scheduler: {
          ...createTestConfig().scheduler,
          budget: {
            per_shop_daily_yuan: 1.0,
            global_daily_yuan: 100.0,
          },
        },
      });
      const budgetTracker = new BudgetTracker(config, null);
      const scheduler = new ResourceScheduler({
        tokenBucket: new CostTokenBucket(config),
        budgetTracker,
        prioritySelector: new PrioritySelector(config),
        metrics: makeMockMetrics(),
        logger: makeMockLogger(),
        config,
      });

      // 记录超过预算的成本
    budgetTracker.record({
        shopId: 'shop-c19',
        costYuan: 1.5,
        tokens: 1000,
        tier: 'tier3',
        provider: 'deepseek',
        timestamp: Date.now(),
      });

      const decision = await scheduler.acquire({
        shopId: 'shop-c19',
        tier: 'tier3',
        estimatedCostYuan: 0.1,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.rejectReason).toBe('shop_daily_budget_exceeded');
    });

    it('全局日预算超限后返回 global_daily_budget_exceeded', async () => {
      const config = createTestConfig({
        scheduler: {
          ...createTestConfig().scheduler,
          budget: {
            per_shop_daily_yuan: 100.0,
            global_daily_yuan: 5.0,
          },
        },
      });
      const budgetTracker = new BudgetTracker(config, null);
      const scheduler = new ResourceScheduler({
        tokenBucket: new CostTokenBucket(config),
        budgetTracker,
        prioritySelector: new PrioritySelector(config),
        metrics: makeMockMetrics(),
        logger: makeMockLogger(),
        config,
      });

      budgetTracker.record({
        shopId: 'shop-a',
        costYuan: 3.0,
        tokens: 1000,
        tier: 'tier3',
        provider: 'deepseek',
        timestamp: Date.now(),
      });
      budgetTracker.record({
        shopId: 'shop-b',
        costYuan: 3.0,
        tokens: 1000,
        tier: 'tier3',
        provider: 'deepseek',
        timestamp: Date.now(),
      });

      const decision = await scheduler.acquire({
        shopId: 'shop-c',
        tier: 'tier3',
        estimatedCostYuan: 0.1,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.rejectReason).toBe('global_daily_budget_exceeded');
    });
  });

  describe('C-20: 令牌桶耗尽触发 Tier 降级', () => {
    it('Tier3 预算不足时降级到更便宜的 Tier1', async () => {
      const config = createTestConfig({
        scheduler: {
          ...createTestConfig().scheduler,
          token_bucket: {
            daily_budget_yuan: 2.0,
            reserve_ratio: 0.1,
          },
          budget: {
            per_shop_daily_yuan: 100.0,
            global_daily_yuan: 100.0,
          },
        },
      });
      const tokenBucket = new CostTokenBucket(config);
      const budgetTracker = new BudgetTracker(config, null);
      const scheduler = new ResourceScheduler({
        tokenBucket,
        budgetTracker,
        prioritySelector: new PrioritySelector(config),
        metrics: makeMockMetrics(),
        logger: makeMockLogger(),
        config,
      });

      // 消耗大部分令牌
      tokenBucket.consume(1.9);

      // 请求 Tier3 但预算不足以支付 0.5 元
    const decision = await scheduler.acquire({
        shopId: 'shop-c20',
        tier: 'tier3',
        estimatedCostYuan: 0.5,
      });

      // 应降级到更便宜的 tier 或允许（由 reserve_ratio 兜底）
    expect(decision.allowed).toBe(true);
      expect(['tier1', 'tier2']).toContain(decision.allocatedTier);
    });

    it('令牌桶完全耗尽且无 reserve 时拒绝请求', async () => {
      const config = createTestConfig({
        scheduler: {
          ...createTestConfig().scheduler,
          token_bucket: {
            daily_budget_yuan: 1.0,
            reserve_ratio: 0.0,
          },
          budget: {
            per_shop_daily_yuan: 100.0,
            global_daily_yuan: 100.0,
          },
        },
      });
      const tokenBucket = new CostTokenBucket(config);
      const budgetTracker = new BudgetTracker(config, null);
      const scheduler = new ResourceScheduler({
        tokenBucket,
        budgetTracker,
        prioritySelector: new PrioritySelector(config),
        metrics: makeMockMetrics(),
        logger: makeMockLogger(),
        config,
      });

      tokenBucket.consume(1.0);

      const decision = await scheduler.acquire({
        shopId: 'shop-c20b',
        tier: 'tier3',
        estimatedCostYuan: 10.0,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.rejectReason).toBe('insufficient_budget');
    });
  });
});
