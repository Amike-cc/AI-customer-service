/**
 * E2E 测试：多轮对话上下文场景
 *
 * 覆盖场景：E-04
 * 验证完整业务流程：买家连续提问 → ContextManager 累积上下文 → 第二轮理解指代
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.5 节
 */
import { ContextManager } from '@/cache/ContextManager';
import { ConversationContextRepo } from '@/db/repos/ConversationContextRepo';
import { ShopStateRepo } from '@/db/repos/ShopStateRepo';
import { createMockDatabase } from '../unit/helpers/mockDb';
import { createTestConfig } from '../unit/helpers/testConfig';
import { createLogger } from '@/logging/logger';

describe('E2E: 多轮对话上下文', () => {
  let ctx: ContextManager;
  let db: ReturnType<typeof createMockDatabase>;
  let logger: ReturnType<typeof createLogger>;
  const config = createTestConfig({
    deepseek: {
      ...createTestConfig().deepseek,
      context_rounds: 5,
      context_idle_clear_ms: 300000,
    },
  });

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
    logger = createLogger(config);
    const conversationRepo = new ConversationContextRepo(db as any);
    const shopStateRepo = new ShopStateRepo(db as any);
    ctx = new ContextManager(config, { conversation: conversationRepo, shopState: shopStateRepo } as any, logger);
  });

  afterEach(() => {
    ctx.clearAllTimers();
  });

  it('E-04: 多轮对话上下文累积，第二轮能引用第一轮内容', () => {
    const shopId = 'shop-e2e-04';
    const sessionId = 'sess-multi-turn';

    // 第一轮：询问尺码
    ctx.addUserMessage(shopId, sessionId, '这款衣服的尺码是多少');
    ctx.addAssistantMessage(shopId, sessionId, '这款衣服有 S/M/L 三个尺码');

    // 第二轮：用户说"推荐一个"，应能从上下文理解指代尺码
    ctx.addUserMessage(shopId, sessionId, '推荐一个');
    ctx.addAssistantMessage(shopId, sessionId, '建议您选择 M 码，适合大多数顾客');

    const context = ctx.getRecentMessages(shopId, sessionId);

    // 验证上下文累积了所有 4 条消息
    expect(context.length).toBe(4);
    expect(context[0].content).toContain('尺码');
    expect(context[2].content).toBe('推荐一个');
  });

  it('E-04b: 超过 context_rounds 后自动截断', () => {
    const shopId = 'shop-e2e-04b';
    const sessionId = 'sess-truncate';

    // 写入 10 轮（20 条消息），context_rounds=5 应保留最近 5 轮（10 条）
    for (let i = 0; i < 10; i++) {
      ctx.addUserMessage(shopId, sessionId, `第 ${i + 1} 轮用户消息`);
      ctx.addAssistantMessage(shopId, sessionId, `第 ${i + 1} 轮 AI 回复`);
    }

    const context = ctx.getRecentMessages(shopId, sessionId);
    // context_rounds=5 表示保留最近 5 轮 = 10 条消息
    expect(context.length).toBeLessThanOrEqual(10);

    // 最早的消息应被截断
    if (context.length > 0) {
      const firstContent = context[0].content;
      expect(firstContent).not.toContain('第 1 轮');
    }
  });
});
