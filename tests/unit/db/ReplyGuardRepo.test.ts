import { ReplyGuardRepo } from '@/db/repos/ReplyGuardRepo';
import { createMockDatabase } from '../helpers/mockDb';

describe('ReplyGuardRepo', () => {
  let db: ReturnType<typeof createMockDatabase>;
  let repo: ReplyGuardRepo;

  beforeEach(() => {
    db = createMockDatabase();
    db.exec(`
      CREATE TABLE reply_delivery_guard (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_key TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        message_text TEXT NOT NULL,
        source_message_id TEXT,
        replied_at INTEGER NOT NULL,
        UNIQUE(shop_id, session_id, message_key)
      )
    `);
    repo = new ReplyGuardRepo(db);
  });

  afterEach(() => db.close());

  it('按消息 ID 精确命中已成功回复记录', () => {
    repo.add({
      shopId: 'shop-1',
      sessionId: 'buyer-1',
      messageKey: 'message-key-1',
      textHash: 'text-hash-1',
      messageText: '什么时候发货',
      sourceMessageId: 'platform-id-1',
      repliedAt: 5000,
    });

    expect(repo.has('shop-1', 'buyer-1', 'message-key-1', 'other-hash', 6000)).toBe(true);
    expect(repo.has('shop-1', 'buyer-2', 'message-key-1', 'text-hash-1', 0)).toBe(false);
  });

  it('文本兜底只在指定时间窗口内命中', () => {
    repo.add({
      shopId: 'shop-1',
      sessionId: 'buyer-1',
      messageKey: 'legacy-key',
      textHash: 'same-text',
      messageText: '有货吗',
      repliedAt: 5000,
    });

    expect(repo.has('shop-1', 'buyer-1', 'new-id', 'same-text', 4000)).toBe(true);
    expect(repo.has('shop-1', 'buyer-1', 'new-id', 'same-text', 6000)).toBe(false);
  });
});
