/**
 * 故障注入测试：敏感词检测与上下文持久恢复
 *
 * 覆盖场景：
 * - C-13: 敏感词全量检测（block/warn/replace 三种动作）
 * - C-18: ContextManager 重启后从 DB 恢复上下文
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.4 节、第 17 章数据持久化
 */
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { SensitiveWordChecker } from '@/secrets/SensitiveWordChecker';
import { ContextManager } from '@/cache/ContextManager';
import { ConversationContextRepo } from '@/db/repos/ConversationContextRepo';
import { ShopStateRepo } from '@/db/repos/ShopStateRepo';
import { createMockDatabase } from '../unit/helpers/mockDb';
import { createTestConfig } from '../unit/helpers/testConfig';
import { createLogger } from '@/logging/logger';

describe('Chaos: 敏感词检测与上下文恢复', () => {
  describe('C-13: 敏感词全量检测', () => {
    let checker: SensitiveWordChecker;
    let tempFile: string;

    beforeEach(async () => {
      tempFile = path.join(os.tmpdir(), `sensitive-chaos-${Date.now()}.txt`);
      await fs.writeFile(
        tempFile,
        [
          '# 敏感词测试字典',
          '微信|contact|block',
          '支付宝|payment|block',
          '线下|payment|block',
          'QQ号|contact|warn',
          '电话号码|contact|replace',
          '',
        ].join('\n'),
        'utf8',
      );

      const config = createTestConfig({
        deepseek: {
          ...createTestConfig().deepseek,
          sensitive_words_dict: tempFile,
        },
      });
      checker = new SensitiveWordChecker(config);
      await checker.load();
    });

    afterEach(async () => {
      await fs.remove(tempFile).catch(() => {});
    });

    it('block 类型敏感词使检查不通过', () => {
      const result = checker.check('加我微信购买吧');
      expect(result.passed).toBe(false);
      expect(result.hits.some((h) => h.word === '微信' && h.action === 'block')).toBe(true);
    });

    it('多个 block 词同时命中', () => {
      const result = checker.check('加微信，支付宝转账，线下交易');
      expect(result.passed).toBe(false);
      const blockHits = result.hits.filter((h) => h.action === 'block');
      expect(blockHits.length).toBeGreaterThanOrEqual(3);
    });

    it('warn 类型词不阻止通过', () => {
      const result = checker.check('留个QQ号吧');
      expect(result.passed).toBe(true);
      expect(result.hits.some((h) => h.word === 'QQ号' && h.action === 'warn')).toBe(true);
    });

    it('replace 类型词被替换为星号', () => {
      const sanitized = checker.sanitize('我的电话号码是123456');
      expect(sanitized).toContain('*');
      expect(sanitized).not.toContain('电话号码');
    });

    it('无敏感词的文本通过检查', () => {
      const result = checker.check('这款商品有黑色和白色可选');
      expect(result.passed).toBe(true);
      expect(result.hits).toHaveLength(0);
    });

    it('reload 后字典更新生效', async () => {
      await fs.writeFile(
        tempFile,
        ['微信|contact|block', '淘宝|platform|block', ''].join('\n'),
        'utf8',
      );
      await checker.reload();

      const result = checker.check('去淘宝买吧');
      expect(result.passed).toBe(false);
      expect(result.hits.some((h) => h.word === '淘宝')).toBe(true);
    });
  });

  describe('C-18: ContextManager 重启后从 DB 恢复上下文', () => {
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

    it('写入消息后新 ContextManager 实例可从 DB 读取历史', () => {
      const config = createTestConfig();
      const ctx1 = new ContextManager(
        config,
        { conversation: conversationRepo, shopState: shopStateRepo } as any,
        logger,
      );

      ctx1.addUserMessage('shop-c18', 'sess-1', '这件衣服有XL码吗');
      ctx1.addAssistantMessage('shop-c18', 'sess-1', '有的，XL码现货');
      ctx1.addUserMessage('shop-c18', 'sess-1', '多少钱');
      ctx1.clearAllTimers();

      // 模拟重启：用同一个 DB 创建新的 ContextManager
      const ctx2 = new ContextManager(
        config,
        { conversation: conversationRepo, shopState: shopStateRepo } as any,
        logger,
      );

      const messages = ctx2.getRecentMessages('shop-c18', 'sess-1');
      expect(messages.length).toBeGreaterThanOrEqual(3);
      expect(messages.some((m) => m.content === '这件衣服有XL码吗')).toBe(true);
      expect(messages.some((m) => m.content === '多少钱')).toBe(true);
      ctx2.clearAllTimers();
    });

    it('多会话上下文独立恢复', () => {
      const config = createTestConfig();
      const ctx1 = new ContextManager(
        config,
        { conversation: conversationRepo, shopState: shopStateRepo } as any,
        logger,
      );

      ctx1.addUserMessage('shop-c18', 'sess-a', '会话A第一条');
      ctx1.addUserMessage('shop-c18', 'sess-b', '会话B第一条');
      ctx1.addUserMessage('shop-c18', 'sess-a', '会话A第二条');
      ctx1.clearAllTimers();

      const ctx2 = new ContextManager(
        config,
        { conversation: conversationRepo, shopState: shopStateRepo } as any,
        logger,
      );

      const msgsA = ctx2.getRecentMessages('shop-c18', 'sess-a');
      const msgsB = ctx2.getRecentMessages('shop-c18', 'sess-b');

      expect(msgsA.length).toBeGreaterThanOrEqual(2);
      expect(msgsB.length).toBeGreaterThanOrEqual(1);
      expect(msgsA.every((m) => m.content.includes('会话A'))).toBe(true);
      expect(msgsB.every((m) => m.content.includes('会话B'))).toBe(true);
      ctx2.clearAllTimers();
    });
  });
});
