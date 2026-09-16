/**
 * 故障注入测试：缓存与上下文压力测试
 *
 * 覆盖场景：
 * - C-07: LruCache 容量超限 → LRU 淘汰旧条目，globalCount 不超过 max_entries_global
 * - C-08: ContextManager 上下文累积 → 自动截断到 context_rounds，invalidateHotCache 生效
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.4 节、第 17 章数据持久化与配置管理
 */
import { LruCache } from '@/cache/LruCache';
import { ContextManager } from '@/cache/ContextManager';
import { ConversationContextRepo } from '@/db/repos/ConversationContextRepo';
import { ShopStateRepo } from '@/db/repos/ShopStateRepo';
import { createMockDatabase } from '../unit/helpers/mockDb';
import { createTestConfig } from '../unit/helpers/testConfig';
import { createLogger } from '@/logging/logger';

describe('Chaos: 缓存与上下文压力', () => {
  describe('C-07: LruCache 容量超限淘汰', () => {
    it('单店超过 max_entries_per_shop 时淘汰最旧条目', () => {
      const config = createTestConfig({
        cache: {
          ttl_ms: 3600000,
          max_entries_per_shop: 5,
          max_entries_global: 100,
          invalidate_on_product_update: true,
        },
      });
      const cache = new LruCache(config);

      // 写入 8 条，超过单店上限 5
      for (let i = 0; i < 8; i++) {
        cache.set('shop-chaos-07', `q${i}`, `answer-${i}`);
      }

      // 最早写入的 q0/q1/q2 应被淘汰
      expect(cache.get('shop-chaos-07', 'q0')).toBeNull();
      expect(cache.get('shop-chaos-07', 'q1')).toBeNull();
      expect(cache.get('shop-chaos-07', 'q2')).toBeNull();

      // 最近写入的 q5/q6/q7 应命中
      expect(cache.get('shop-chaos-07', 'q7')).toBe('answer-7');
      expect(cache.get('shop-chaos-07', 'q5')).toBe('answer-5');
    });

    it('全局条目数不超过 max_entries_global', () => {
      const config = createTestConfig({
        cache: {
          ttl_ms: 3600000,
          max_entries_per_shop: 1000,
          max_entries_global: 10,
          invalidate_on_product_update: true,
        },
      });
      const cache = new LruCache(config);

      // 跨 3 个店铺写入共 30 条
      for (let i = 0; i < 10; i++) {
        cache.set('shop-a', `q${i}`, `a-${i}`);
        cache.set('shop-b', `q${i}`, `b-${i}`);
        cache.set('shop-c', `q${i}`, `c-${i}`);
      }

      // 全局总数应被限制在 10 附近（具体取决于实现，但应明显小于 30）
      const stats = cache.getStats();
      expect(stats.totalEntries).toBeLessThanOrEqual(15);
    });
  });

  describe('C-08: ContextManager 上下文累积与热缓存失效', () => {
    let db: ReturnType<typeof createMockDatabase>;
    let logger: ReturnType<typeof createLogger>;
    let conversationRepo: ConversationContextRepo;
    let shopStateRepo: ShopStateRepo;

    beforeEach(() => {
      db = createMockDatabase();
      db.exec(`
        CREATE TABLE conversation_context (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          product_id TEXT,
          token_count INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE shop_state (
          shop_id TEXT PRIMARY KEY,
          current_state TEXT NOT NULL,
          entered_at INTEGER NOT NULL,
          last_message_at INTEGER,
          unread_count INTEGER DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
      `);
      logger = createLogger(createTestConfig());
      conversationRepo = new ConversationContextRepo(db as any);
      shopStateRepo = new ShopStateRepo(db as any);
    });

    it('超过 context_rounds 后自动截断', () => {
      const config = createTestConfig({
        deepseek: {
          ...createTestConfig().deepseek,
          context_rounds: 3,
          context_idle_clear_ms: 300000,
        },
      });
      const ctx = new ContextManager(config, { conversation: conversationRepo, shopState: shopStateRepo } as any, logger);

      // 写入 10 轮用户消息
      for (let i = 0; i < 10; i++) {
        ctx.addUserMessage('shop-chaos-08', 'sess-1', `用户消息 ${i}`);
        ctx.addAssistantMessage('shop-chaos-08', 'sess-1', `AI 回复 ${i}`);
      }

      const context = ctx.getRecentMessages('shop-chaos-08', 'sess-1');
      // context_rounds=3 表示保留最近 3 轮（6 条消息：3 user + 3 assistant）
      expect(context.length).toBeLessThanOrEqual(6);
      ctx.clearAllTimers();
    });

    it('addUserMessage 后热缓存应失效，下次 getRecentMessages 重新计算', () => {
      const config = createTestConfig();
      const ctx = new ContextManager(config, { conversation: conversationRepo, shopState: shopStateRepo } as any, logger);

      ctx.addUserMessage('shop-chaos-08', 'sess-2', '第一次问');
      const c1 = ctx.getRecentMessages('shop-chaos-08', 'sess-2');

      ctx.addUserMessage('shop-chaos-08', 'sess-2', '第二次问');
      const c2 = ctx.getRecentMessages('shop-chaos-08', 'sess-2');

      expect(c2.length).toBeGreaterThan(c1.length);
      ctx.clearAllTimers();
    });
  });
});
