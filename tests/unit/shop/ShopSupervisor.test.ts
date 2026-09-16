/**
 * ShopSupervisor 单元测试
 */
import { ShopSupervisor, type ShopSupervisorDeps } from '@/shop/ShopSupervisor';
import { createTestConfig } from '../helpers/testConfig';

describe('ShopSupervisor', () => {
  let deps: jest.Mocked<ShopSupervisorDeps>;
  let supervisor: ShopSupervisor;
  let mockWebContents: any;

  beforeEach(() => {
    mockWebContents = {
      executeJavaScript: jest.fn().mockResolvedValue(undefined),
      sendInputEvent: jest.fn().mockResolvedValue(undefined),
      isDestroyed: jest.fn().mockReturnValue(false),
      isCrashed: jest.fn().mockReturnValue(false),
      reload: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      id: 1,
      session: {} as any,
    };

    const config = createTestConfig();
    deps = {
      config,
      db: {
        shops: { setAutoReply: jest.fn() },
        audit: { add: jest.fn(), listRecent: jest.fn().mockReturnValue([]) },
        shopState: { upsert: jest.fn(), incrementUnread: jest.fn(), markRead: jest.fn() },
        shopBusiness: {
          getOrDefault: jest.fn().mockReturnValue({
            deliveryAddress: '',
            deliveryTime: '',
            freightInsurance: '',
            expressCompanies: '',
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
        replyGuard: {
          has: jest.fn().mockReturnValue(false),
          add: jest.fn(),
          cleanup: jest.fn(),
        },
        outbox: {
          findByClientMessageId: jest.fn().mockReturnValue(null),
          enqueue: jest.fn().mockReturnValue({ created: true, record: { status: 'queued' } }),
          markStatus: jest.fn(),
          listBySession: jest.fn().mockReturnValue([]),
          recoverStuckSending: jest.fn().mockReturnValue(0),
          cleanup: jest.fn().mockReturnValue(0),
        },
        conversationMessages: {
          upsert: jest.fn(),
          listBySession: jest.fn().mockReturnValue([]),
          search: jest.fn().mockReturnValue([]),
        },
        conversationDrafts: { get: jest.fn().mockReturnValue(null), save: jest.fn(), delete: jest.fn() },
        transferEvents: { add: jest.fn(), listBySession: jest.fn().mockReturnValue([]), listByShop: jest.fn().mockReturnValue([]) },
        orderSnapshots: { get: jest.fn().mockReturnValue(null), upsert: jest.fn() },
        prepare: jest.fn(),
        transaction: jest.fn((fn: () => any) => fn()),
        close: jest.fn(),
        migrate: jest.fn(),
      } as any,
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        trace: jest.fn(),
      },
      metrics: { inc: jest.fn(), set: jest.fn(), observe: jest.fn(), on: jest.fn(), off: jest.fn() } as any,
      alertManager: { fire: jest.fn(), on: jest.fn(), emit: jest.fn() } as any,
      visionClient: {} as any,
      deepseekClient: {} as any,
      orchestrator: {} as any,
      ruleEngine: { reloadRules: jest.fn() } as any,
      sensitiveChecker: { check: jest.fn().mockReturnValue({ passed: true, hits: [] }), sanitize: jest.fn((s: string) => s) } as any,
      webviewManager: {
        ensureView: jest.fn().mockResolvedValue(mockWebContents),
        removeView: jest.fn(),
        getLoginStatus: jest.fn().mockReturnValue('logged_in'),
      } as any,
      rateLimiter: { tryAcquire: jest.fn().mockReturnValue(true), reset: jest.fn() } as any,
      lruCache: { get: jest.fn(), set: jest.fn(), getSemantic: jest.fn(), invalidateShop: jest.fn() } as any,
      humanSimulator: { getReplyDelayMs: jest.fn().mockReturnValue(100) } as any,
    };
    supervisor = new ShopSupervisor(deps);
  });

  describe('基础操作', () => {
    it('初始时 shopCount 为 0', () => {
      expect(supervisor.shopCount).toBe(0);
    });

    it('hasShop 返回 false 对于不存在的店铺', () => {
      expect(supervisor.hasShop('123')).toBe(false);
    });

    it('getShopState 返回 null 对于不存在的店铺', () => {
      expect(supervisor.getShopState('123')).toBeNull();
    });

    it('stopShop 对不存在的店铺幂等', async () => {
      await expect(supervisor.stopShop('123')).resolves.toBeUndefined();
    });
  });

  describe('startShop / stopShop', () => {
    it('startShop 创建实例并启动', async () => {
      const shopConfig = { shopId: '123', shopName: '测试店', platform: 'feige' as const, autoReply: true } as any;
      await supervisor.startShop(shopConfig);
      expect(supervisor.hasShop('123')).toBe(true);
      expect(supervisor.shopCount).toBe(1);
    });

    it('重复启动同一店铺抛出错误', async () => {
      const shopConfig = { shopId: '123', shopName: '测试店', platform: 'feige' as const, autoReply: true } as any;
      await supervisor.startShop(shopConfig);
      await expect(supervisor.startShop(shopConfig)).rejects.toThrow('已启动');
    });

    it('stopShop 停止并清理', async () => {
      const shopConfig = { shopId: '123', shopName: '测试店', platform: 'feige' as const, autoReply: true } as any;
      await supervisor.startShop(shopConfig);
      await supervisor.stopShop('123');
      expect(supervisor.hasShop('123')).toBe(false);
      expect(supervisor.shopCount).toBe(0);
    });

    it('startShop 失败时回滚', async () => {
      deps.webviewManager.ensureView = jest.fn().mockRejectedValueOnce(new Error('连接失败'));
      const shopConfig = { shopId: '456', shopName: '失败店', platform: 'feige' as const, autoReply: true } as any;
      await expect(supervisor.startShop(shopConfig)).rejects.toThrow('连接失败');
      expect(supervisor.hasShop('456')).toBe(false);
    });
  });

  describe('stopAll', () => {
    it('停止所有店铺', async () => {
      const shop1 = { shopId: '1', shopName: '店1', platform: 'feige' as const, autoReply: true } as any;
      const shop2 = { shopId: '2', shopName: '店2', platform: 'feige' as const, autoReply: true } as any;
      await supervisor.startShop(shop1);
      await supervisor.startShop(shop2);
      await supervisor.stopAll();
      expect(supervisor.shopCount).toBe(0);
    });
  });

  describe('setAutoReply', () => {
    it('更新 DB 中的自动回复标记', () => {
      supervisor.setAutoReply('123', false);
      expect(deps.db.shops.setAutoReply).toHaveBeenCalledWith('123', false);
      expect(deps.logger.info).toHaveBeenCalled();
    });
  });

  describe('reloadAllRules', () => {
    it('调用 ruleEngine.reloadRules()', () => {
      supervisor.reloadAllRules();
      expect(deps.ruleEngine.reloadRules).toHaveBeenCalled();
    });
  });

  describe('testReply', () => {
    it('未启动店铺抛出错误', async () => {
      await expect(supervisor.testReply('999', '你好')).rejects.toThrow('未启动');
    });
  });

  describe('executeScriptOnShop', () => {
    it('未启动店铺抛出错误', async () => {
      await expect(supervisor.executeScriptOnShop('999', '1+1')).rejects.toThrow('未启动');
    });
  });

  describe('hasShopStarted', () => {
    it('已启动店铺返回 true', async () => {
      const shopConfig = { shopId: '123', shopName: '测试店', platform: 'feige' as const, autoReply: true } as any;
      await supervisor.startShop(shopConfig);
      expect(supervisor.hasShopStarted('123')).toBe(true);
    });
  });

  describe('setActiveShop', () => {
    it('调用所有店铺实例的 setBackgroundMode', async () => {
      const shopConfig1 = { shopId: '111', shopName: '店1', platform: 'feige' as const, autoReply: true } as any;
      const shopConfig2 = { shopId: '222', shopName: '店2', platform: 'feige' as const, autoReply: true } as any;
      await supervisor.startShop(shopConfig1);
      await supervisor.startShop(shopConfig2);

      // 通过访问 private 字段获取实例的 spy
      const instances = (supervisor as any).shops as Map<string, any>;
      const spy1 = jest.spyOn(instances.get('111'), 'setBackgroundMode');
      const spy2 = jest.spyOn(instances.get('222'), 'setBackgroundMode');

      supervisor.setActiveShop('111');
      expect(spy1).toHaveBeenCalledWith(false);
      expect(spy2).toHaveBeenCalledWith(true);

      spy1.mockRestore();
      spy2.mockRestore();
    });

    it('shopId 为 null 时所有店铺进入后台模式', async () => {
      const shopConfig1 = { shopId: '111', shopName: '店1', platform: 'feige' as const, autoReply: true } as any;
      await supervisor.startShop(shopConfig1);
      const instances = (supervisor as any).shops as Map<string, any>;
      const spy = jest.spyOn(instances.get('111'), 'setBackgroundMode');

      supervisor.setActiveShop(null);
      expect(spy).toHaveBeenCalledWith(true);
      spy.mockRestore();
    });

    it('不存在的店铺不会抛错', () => {
      expect(() => supervisor.setActiveShop('nonexistent')).not.toThrow();
    });
  });

  describe('买家连续消息合并', () => {
    async function startMessageTestInstance() {
      const shopConfig = { shopId: 'latest-shop', shopName: '消息测试店', platform: 'feige' as const, autoReply: true } as any;
      await supervisor.startShop(shopConfig);
      const instances = (supervisor as any).shops as Map<string, any>;
      const instance = instances.get('latest-shop');
      const context = instance.contextManager;
      jest.spyOn(context, 'addUserMessage').mockImplementation(() => {});
      jest.spyOn(context, 'addAssistantMessage').mockImplementation(() => {});
      jest.spyOn(context, 'removeLastUserMessage').mockImplementation(() => true);
      jest.spyOn(instance, 'sleep').mockResolvedValue(undefined);
      jest.spyOn(instance, 'generateReply').mockImplementation(async (msg: { text: string }) => `回复:${msg.text}`);
      const sendReply = jest.spyOn(instance, 'sendReply').mockResolvedValue(true);
      return { instance, sendReply, context };
    }

    it('同一会话连续多条消息只回复最后一条', async () => {
      const { instance, sendReply, context } = await startMessageTestInstance();
      const base = { sessionId: 'buyer-1', from: 'buyer' as const };

      const first = instance.handleIncomingMessage({ ...base, text: '第一条', timestamp: 1000 });
      void instance.handleIncomingMessage({ ...base, text: '第二条', timestamp: 1001 });
      void instance.handleIncomingMessage({ ...base, text: '最后一条', timestamp: 1002 });
      await first;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(instance.generateReply).toHaveBeenCalledTimes(1);
      expect(instance.generateReply).toHaveBeenCalledWith(
        expect.objectContaining({ text: '最后一条', timestamp: 1002 }),
        expect.any(Object),
      );
      expect(sendReply).toHaveBeenCalledTimes(1);
      expect(sendReply).toHaveBeenCalledWith('回复:最后一条', { expectedSessionId: 'buyer-1' });
      expect(context.addUserMessage).toHaveBeenCalledTimes(1);
      expect(context.addUserMessage).toHaveBeenCalledWith('latest-shop', 'buyer-1', '最后一条', undefined);
    });

    it('同一条买家消息重复检测不会重复回复', async () => {
      const { instance, sendReply } = await startMessageTestInstance();
      const message = { sessionId: 'buyer-2', from: 'buyer' as const, text: '只回复一次', timestamp: 2000 };

      await instance.handleIncomingMessage(message);
      await instance.handleIncomingMessage({ ...message, timestamp: 2999 });

      expect(sendReply).toHaveBeenCalledTimes(1);
    });

    it('平台消息 ID 相同时刷新时间戳也只回复一次', async () => {
      const { instance, sendReply } = await startMessageTestInstance();
      const base = {
        sessionId: 'buyer-message-id',
        from: 'buyer' as const,
        text: '有货吗',
        messageId: 'platform-msg-100',
      };

      await instance.handleIncomingMessage({ ...base, timestamp: 1000 });
      await instance.handleIncomingMessage({ ...base, timestamp: Date.now() });

      expect(sendReply).toHaveBeenCalledTimes(1);
    });

    it('不同会话中消息 ID 不同的相同文本可分别回复', async () => {
      const { instance, sendReply } = await startMessageTestInstance();
      // 使用不同会话避免会话级冷却期（15s）阻塞第二条消息
      await instance.handleIncomingMessage({
        sessionId: 'buyer-repeat-text-a',
        from: 'buyer' as const,
        text: '还有吗',
        messageId: 'msg-1',
        timestamp: 1000,
      });
      await instance.handleIncomingMessage({
        sessionId: 'buyer-repeat-text-b',
        from: 'buyer' as const,
        text: '还有吗',
        messageId: 'msg-2',
        timestamp: 2000,
      });

      expect(sendReply).toHaveBeenCalledTimes(2);
    });

    it('发送成功后写入持久去重账本', async () => {
      const { instance } = await startMessageTestInstance();

      await instance.handleIncomingMessage({
        sessionId: 'buyer-ledger',
        from: 'buyer',
        text: '什么时候发货',
        messageId: 'msg-ledger-1',
        timestamp: 3000,
      });

      expect(deps.db.replyGuard.add).toHaveBeenCalledWith(
        expect.objectContaining({
          shopId: 'latest-shop',
          sessionId: 'buyer-ledger',
          messageText: '什么时候发货',
          sourceMessageId: 'msg-ledger-1',
        }),
      );
    });

    it('持久去重账本命中时不会再次回复', async () => {
      const { instance, sendReply } = await startMessageTestInstance();
      (deps.db.replyGuard.has as jest.Mock).mockReturnValue(true);

      await instance.handleIncomingMessage({
        sessionId: 'buyer-ledger-hit',
        from: 'buyer',
        text: '什么时候发货',
        messageId: 'msg-ledger-hit',
        timestamp: Date.now(),
      });

      expect(sendReply).not.toHaveBeenCalled();
      expect(deps.metrics.inc).toHaveBeenCalledWith(
        'duplicate_reply_blocked_total',
        1,
        undefined,
        'latest-shop',
      );
    });

    it('误判为买家消息的自身回复回声不会触发回复', async () => {
      const { instance, sendReply } = await startMessageTestInstance();
      const buyerMessage = { sessionId: 'buyer-echo', from: 'buyer' as const, text: '哪里发货', timestamp: 4000 };
      await instance.handleIncomingMessage(buyerMessage);

      await instance.handleIncomingMessage({
        sessionId: 'buyer-echo',
        from: 'buyer',
        text: '回复:哪里发货\n00:10:11\n已读',
        timestamp: 4001,
      });

      expect(sendReply).toHaveBeenCalledTimes(1);
      expect(deps.metrics.inc).toHaveBeenCalledWith(
        'self_reply_echo_blocked_total',
        1,
        undefined,
        'latest-shop',
      );
    });

    it('重启后从审计记录恢复自身回复回声防护', async () => {
      (deps.db.audit as any).listRecent = jest.fn().mockReturnValue([
        {
          shopId: 'audit-shop',
          sessionId: 'buyer-audit',
          userMessage: '哪里发货',
          aiReply: '亲，订单会从就近仓库发出。',
          modelVersion: 'deepseek',
          promptHash: 'hash',
          createdAt: Date.now() - 1000,
        },
      ]);
      const shopConfig = { shopId: 'audit-shop', shopName: '审计测试店', platform: 'feige' as const, autoReply: true } as any;
      await supervisor.startShop(shopConfig);
      const instances = (supervisor as any).shops as Map<string, any>;
      const instance = instances.get('audit-shop');
      const sendReply = jest.spyOn(instance, 'sendReply').mockResolvedValue(true);

      await instance.handleIncomingMessage({
        sessionId: 'buyer-audit',
        from: 'buyer',
        text: '亲，订单会从就近仓库发出。\n00:12:00\n未读',
        timestamp: Date.now(),
      });

      expect(sendReply).not.toHaveBeenCalled();
    });

    it('AI 生成期间收到新消息时取消旧回复', async () => {
      const { instance, sendReply, context } = await startMessageTestInstance();
      let resolveOldReply: ((reply: string) => void) | undefined;
      instance.generateReply.mockImplementation((msg: { text: string }) => {
        if (msg.text === '旧消息') {
          return new Promise<string>((resolve) => {
            resolveOldReply = resolve;
          });
        }
        return Promise.resolve(`回复:${msg.text}`);
      });
      const base = { sessionId: 'buyer-3', from: 'buyer' as const };

      const oldProcessing = instance.handleIncomingMessage({ ...base, text: '旧消息', timestamp: 3000 });
      await Promise.resolve();
      await Promise.resolve();
      expect(resolveOldReply).toBeDefined();

      void instance.handleIncomingMessage({ ...base, text: '最新消息', timestamp: 3001 });
      resolveOldReply?.('回复:旧消息');
      await oldProcessing;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(sendReply).toHaveBeenCalledTimes(1);
      expect(sendReply).toHaveBeenCalledWith('回复:最新消息', { expectedSessionId: 'buyer-3' });
      expect(context.removeLastUserMessage).toHaveBeenCalledWith('latest-shop', 'buyer-3', '旧消息');
    });
  });

  describe('发送闸门（SAFE-TAKEOVER-001 / SAFE-AI-OFF-001）', () => {
    async function startGateInstance() {
      const shopConfig = { shopId: 'gate-shop', shopName: '闸门测试店', platform: 'feige' as const, autoReply: true } as any;
      await supervisor.startShop(shopConfig);
      const instances = (supervisor as any).shops as Map<string, any>;
      const instance = instances.get('gate-shop');
      const context = instance.contextManager;
      jest.spyOn(context, 'addUserMessage').mockImplementation(() => {});
      jest.spyOn(context, 'addAssistantMessage').mockImplementation(() => {});
      jest.spyOn(context, 'removeLastUserMessage').mockImplementation(() => true);
      jest.spyOn(instance, 'sleep').mockResolvedValue(undefined);
      return { instance };
    }

    it('ManualMode 下收到新消息不调用 generateReply', async () => {
      const { instance } = await startGateInstance();
      const generateReply = jest.spyOn(instance, 'generateReply').mockResolvedValue('回复');
      const sendReply = jest.spyOn(instance, 'sendReply').mockResolvedValue(true);
      await instance.manualTakeover();
      expect(instance.currentState).toBe('ManualMode');

      await instance.handleIncomingMessage({
        sessionId: 'buyer-gate-1',
        from: 'buyer',
        text: '在吗',
        timestamp: Date.now(),
      });

      expect(generateReply).not.toHaveBeenCalled();
      expect(sendReply).not.toHaveBeenCalled();
    });

    it('生成期间关闭 AI，发送前闸门阻止自动发送', async () => {
      const { instance } = await startGateInstance();
      let resolveReply: ((v: string) => void) | undefined;
      jest.spyOn(instance, 'generateReply').mockImplementation(() => new Promise<string>((resolve) => {
        resolveReply = resolve;
      }));
      const sendReply = jest.spyOn(instance, 'sendReply').mockResolvedValue(true);

      const processing = instance.handleIncomingMessage({
        sessionId: 'buyer-gate-2',
        from: 'buyer',
        text: '这个多少钱',
        timestamp: Date.now(),
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(resolveReply).toBeDefined();

      // 生成进行中关闭 AI：controlEpoch 递增，在途回复必须在发送前失效
      instance.setAutoReplyFlag(false);
      resolveReply?.('回复内容');
      await processing;

      expect(sendReply).not.toHaveBeenCalled();
    });

    it('生成期间人工接管，发送前闸门阻止自动发送', async () => {
      const { instance } = await startGateInstance();
      let resolveReply: ((v: string) => void) | undefined;
      jest.spyOn(instance, 'generateReply').mockImplementation(() => new Promise<string>((resolve) => {
        resolveReply = resolve;
      }));
      const sendReply = jest.spyOn(instance, 'sendReply').mockResolvedValue(true);

      const processing = instance.handleIncomingMessage({
        sessionId: 'buyer-gate-3',
        from: 'buyer',
        text: '有货吗',
        timestamp: Date.now(),
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(resolveReply).toBeDefined();

      await instance.manualTakeover();
      resolveReply?.('有货的');
      await processing;

      expect(sendReply).not.toHaveBeenCalled();
    });

    it('接管完成后状态已进入 ManualMode（等待状态转换）', async () => {
      const { instance } = await startGateInstance();
      await instance.manualTakeover();
      expect(instance.currentState).toBe('ManualMode');
      await instance.manualRelease();
      expect(instance.currentState).not.toBe('ManualMode');
    });
  });

  describe('人工发送幂等（MSG-SESSION-001）', () => {
    async function startManualInstance() {
      const shopConfig = { shopId: 'manual-shop', shopName: '人工发送店', platform: 'feige' as const, autoReply: true } as any;
      await supervisor.startShop(shopConfig);
      const instances = (supervisor as any).shops as Map<string, any>;
      return instances.get('manual-shop');
    }

    it('相同 clientMessageId 已 sent 时直接返回 duplicate，不重复发送', async () => {
      const instance = await startManualInstance();
      const sendReply = jest.spyOn(instance, 'sendReply').mockResolvedValue(true);
      (deps.db.outbox.findByClientMessageId as jest.Mock).mockReturnValue({
        status: 'sent',
        clientMessageId: 'cmid-1',
      });

      const result = await instance.sendManualReply('你好', {
        sessionId: 's1',
        clientMessageId: 'cmid-1',
      });

      expect(result.status).toBe('duplicate');
      expect(sendReply).not.toHaveBeenCalled();
    });

    it('首次发送写入 outbox 并标记 sent', async () => {
      const instance = await startManualInstance();
      jest.spyOn(instance, 'sendReply').mockResolvedValue(true);
      (deps.db.outbox.findByClientMessageId as jest.Mock).mockReturnValue(null);
      (deps.db.outbox.enqueue as jest.Mock).mockReturnValue({ created: true, record: { status: 'queued' } });

      const result = await instance.sendManualReply('你好', {
        sessionId: 's1',
        clientMessageId: 'cmid-2',
      });

      expect(result.status).toBe('sent');
      expect(deps.db.outbox.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ clientMessageId: 'cmid-2', shopId: 'manual-shop' }),
      );
      expect(deps.db.outbox.markStatus).toHaveBeenCalledWith('manual-shop', 'cmid-2', 'sent');
    });

    it('发送失败时 outbox 标记 failed 并抛错', async () => {
      const instance = await startManualInstance();
      jest.spyOn(instance, 'sendReply').mockResolvedValue(false);
      (deps.db.outbox.findByClientMessageId as jest.Mock).mockReturnValue(null);
      (deps.db.outbox.enqueue as jest.Mock).mockReturnValue({ created: true, record: { status: 'queued' } });

      await expect(
        instance.sendManualReply('你好', { sessionId: 's1', clientMessageId: 'cmid-3' }),
      ).rejects.toThrow('回复发送失败');
      expect(deps.db.outbox.markStatus).toHaveBeenCalledWith(
        'manual-shop',
        'cmid-3',
        'failed',
        expect.any(String),
      );
    });
  });
});
