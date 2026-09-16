/**
 * 视觉消息建模与未回复判定测试（VISION-DATA-001）
 *
 * 背景：视觉 OCR 修好后该路径才真正生效，此前存在两个缺陷：
 *   1) buildVisualMessage 硬编码 from='buyer'，卖家气泡也被当成买家消息；
 *   2) runVisualPoll 只把买家消息传给 findUnrepliedBuyerMessages，
 *      使"最后一条买家消息之后有无卖家回复"的判断恒为未回复，
 *      导致同一气泡被反复回复（仅靠 replyGuard 兜底）。
 */
import { ShopInstance } from '@/shop/ShopInstance';
import type { ShopSupervisorDeps } from '@/shop/ShopSupervisor';
import { createTestConfig } from '../helpers/testConfig';

function makeDeps(): jest.Mocked<ShopSupervisorDeps> {
  return {
    config: createTestConfig(),
    db: {
      shops: { get: jest.fn().mockReturnValue(null), setAutoReply: jest.fn() },
      audit: { add: jest.fn(), listRecent: jest.fn().mockReturnValue([]) },
      shopState: { upsert: jest.fn(), incrementUnread: jest.fn(), markRead: jest.fn() },
      shopBusiness: {
        getOrDefault: jest.fn().mockReturnValue({
          deliveryAddress: '',
          deliveryTime: '',
          freightInsurance: false,
          expressCompanies: [],
          freeShipping: false,
          freeShippingCondition: '',
          mainCategory: '',
          agentMappings: {},
        }),
      },
      conversation: {} as any,
      metrics: {} as any,
      feedback: {} as any,
      quality: {} as any,
      learning: {} as any,
      intent: {} as any,
      agent: {} as any,
      replyGuard: { has: jest.fn().mockReturnValue(false), add: jest.fn(), cleanup: jest.fn() },
      outbox: {
        findByClientMessageId: jest.fn().mockReturnValue(null),
        enqueue: jest.fn().mockReturnValue({ created: true, record: { status: 'queued' } }),
        markStatus: jest.fn(),
      },
      conversationMessages: { upsert: jest.fn() },
      conversationDrafts: { get: jest.fn(), save: jest.fn() },
      transferEvents: { add: jest.fn() },
      orderSnapshots: { get: jest.fn(), upsert: jest.fn() },
      prepare: jest.fn(),
      transaction: jest.fn((fn: () => any) => fn()),
    } as any,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
    metrics: { inc: jest.fn() } as any,
    alertManager: { fire: jest.fn(), on: jest.fn(), emit: jest.fn() } as any,
    visionClient: {} as any,
    deepseekClient: {} as any,
    orchestrator: {} as any,
    ruleEngine: { reloadRules: jest.fn() } as any,
    sensitiveChecker: { check: jest.fn().mockReturnValue({ passed: true, hits: [] }), sanitize: jest.fn((s: string) => s) } as any,
    webviewManager: { getLoginStatus: jest.fn().mockReturnValue('logged_in') } as any,
    rateLimiter: { tryAcquire: jest.fn().mockReturnValue(true) } as any,
    lruCache: { invalidateShop: jest.fn() } as any,
    humanSimulator: { getReplyDelayMs: jest.fn().mockReturnValue(0) } as any,
  } as jest.Mocked<ShopSupervisorDeps>;
}

describe('视觉消息建模与未回复判定', () => {
  let instance: any;

  beforeEach(() => {
    // 直接构造 ShopInstance，避免 start() 触发真实 webview 挂载。
    // 这里只测纯逻辑方法（buildVisualMessage / findUnrepliedBuyerMessages），
    // 它们不依赖 webview 连接。
    instance = new ShopInstance(
      { shopId: 'visual-shop', shopName: '视觉测试店', platform: 'feige', autoReply: true } as any,
      makeDeps() as any,
    );
  });

  const bbox = (y: number): [number, number, number, number] => [0, y, 100, y + 20];

  it('买家气泡 from=buyer，卖家气泡 from=seller', () => {
    const buyer = instance.buildVisualMessage({ bbox: bbox(10), text: '在吗', isBuyer: true });
    const seller = instance.buildVisualMessage({ bbox: bbox(60), text: '在的', isBuyer: false });
    expect(buyer.from).toBe('buyer');
    expect(seller.from).toBe('seller');
  });

  it('sessionId 按店铺隔离，messageId 稳定且区分不同气泡', () => {
    const a1 = instance.buildVisualMessage({ bbox: bbox(10), text: '在吗', isBuyer: true });
    const a2 = instance.buildVisualMessage({ bbox: bbox(10), text: '在吗', isBuyer: true });
    const b = instance.buildVisualMessage({ bbox: bbox(60), text: '在吗', isBuyer: true });
    expect(a1.sessionId).toBe('visual:visual-shop');
    // 同一气泡每次轮询得到相同 id（幂等去重的前提）
    expect(a1.messageId).toBe(a2.messageId);
    // 不同位置、相同文本得到不同 id（避免误去重）
    expect(a1.messageId).not.toBe(b.messageId);
  });

  it('买家消息后有卖家回复时判定为已回复', () => {
    const messages = [
      instance.buildVisualMessage({ bbox: bbox(10), text: '在吗', isBuyer: true }),
      instance.buildVisualMessage({ bbox: bbox(60), text: '在的', isBuyer: false }),
    ];
    expect(instance.findUnrepliedBuyerMessages(messages)).toEqual([]);
  });

  it('最后一条为买家消息且其后无卖家回复时判定为未回复', () => {
    const messages = [
      instance.buildVisualMessage({ bbox: bbox(10), text: '在吗', isBuyer: true }),
      instance.buildVisualMessage({ bbox: bbox(60), text: '在的', isBuyer: false }),
      instance.buildVisualMessage({ bbox: bbox(110), text: '还有货吗', isBuyer: true }),
    ];
    const unreplied = instance.findUnrepliedBuyerMessages(messages);
    expect(unreplied).toHaveLength(1);
    expect(unreplied[0].text).toBe('还有货吗');
  });
});
