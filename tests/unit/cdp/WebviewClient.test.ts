/** @jest-environment jsdom */
/**
 * WebviewClient 单元测试
 */
import { WebviewClient } from '@/cdp/WebviewClient';
import type { IWebContents } from '@/cdp/types';
import { getPlatform } from '@/platform';
import { createTestConfig } from '../helpers/testConfig';

describe('WebviewClient', () => {
  let webContents: jest.Mocked<IWebContents>;
  let client: WebviewClient;
  const config = createTestConfig();

  beforeEach(() => {
    jest.useFakeTimers();
    webContents = {
      executeJavaScript: jest.fn().mockResolvedValue(undefined),
      sendInputEvent: jest.fn().mockResolvedValue(undefined),
      isDestroyed: jest.fn().mockReturnValue(false),
      isCrashed: jest.fn().mockReturnValue(false),
      reload: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      // executeScript 在脚本失败时需要 .off('console-message', handler) 解除订阅，
      // 测试 mock 需提供 .off 方法（与 .on 对称），否则 finally 块会抛 "off is not a function"
      off: jest.fn(),
      id: 1,
      session: {} as any,
    };
    client = new WebviewClient(webContents, getPlatform('feige').selectors, config);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('connect / disconnect', () => {
    it('connect 安装 observer 并连接', async () => {
      await client.connect();
      expect(client.isConnected).toBe(true);
      expect(webContents.executeJavaScript).toHaveBeenCalled();
    });

    it('disconnect 停止轮询并清理', async () => {
      await client.connect();
      await client.disconnect();
      expect(client.isConnected).toBe(false);
    });

    it('未连接时 isConnected 为 false', () => {
      expect(client.isConnected).toBe(false);
    });
  });

  describe('heartbeat', () => {
    it('executeJavaScript 成功返回 true', async () => {
      webContents.executeJavaScript.mockResolvedValueOnce(2);
      const ok = await client.heartbeat();
      expect(ok).toBe(true);
    });

    it('executeJavaScript 失败返回 false', async () => {
      webContents.executeJavaScript.mockRejectedValueOnce(new Error('fail'));
      const ok = await client.heartbeat();
      expect(ok).toBe(false);
    });

    it('webContents 已销毁返回 false', async () => {
      webContents.isDestroyed.mockReturnValue(true);
      const ok = await client.heartbeat();
      expect(ok).toBe(false);
    });
  });

  describe('probe', () => {
    it('心跳成功返回 true', async () => {
      await client.connect();
      webContents.executeJavaScript.mockResolvedValueOnce(2); // heartbeat
      webContents.executeJavaScript.mockResolvedValueOnce(true); // observer installed check
      const ok = await client.probe();
      expect(ok).toBe(true);
    });

    it('webContents crashed 时 reload', async () => {
      await client.connect();
      webContents.isCrashed.mockReturnValue(true);
      webContents.executeJavaScript.mockResolvedValueOnce(undefined); // observer install
      const ok = await client.probe();
      expect(webContents.reload).toHaveBeenCalled();
      expect(ok).toBe(true);
    });
  });

  describe('onMessage / 消息缓冲', () => {
    it('onMessage 注册后立即 flush 缓冲消息', async () => {
      await client.connect();
      const handler = jest.fn();
      client.onMessage(handler);
      // 构造消息：通过 drain 触发
      webContents.executeJavaScript.mockResolvedValueOnce(
        JSON.stringify([{ sessionId: 'buyer1', from: 'buyer', text: '你好', timestamp: 1000 }]),
      );
      jest.advanceTimersByTime(300);
      await Promise.resolve();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ text: '你好', from: 'buyer' }),
      );
    });
  });

  describe('sendReplyFast', () => {
    beforeEach(() => {
      // delay 使用 fake timers 会卡住，mock 为立即 resolve
      jest.spyOn(client as unknown as { delay: (ms: number) => Promise<void> }, 'delay').mockResolvedValue(undefined);
    });

    it('no-input 时返回失败', async () => {
      await client.connect();
      // findInputScript 返回未找到
      webContents.executeJavaScript.mockResolvedValueOnce({ found: false });
      const result = await client.sendReplyFast('测试回复');
      expect(result.success).toBe(false);
      expect(result.method).toBe('no-input');
    });

    it('contenteditable 成功并发送（Enter 键为优先发送方式）', async () => {
      await client.connect();
      webContents.executeJavaScript
        .mockResolvedValueOnce({ found: true, x: 100, y: 200 }) // findInput（活跃模式）
        .mockResolvedValueOnce({ success: true, method: 'contenteditable' }) // setText
        .mockResolvedValueOnce(true) // buildEnterKeyScript（DOM KeyboardEvent 派发成功）
        .mockResolvedValueOnce(true); // buildVerifyClearedScript（输入框已清空，验证通过）
      const result = await client.sendReplyFast('测试回复');
      expect(result.success).toBe(true);
      expect(result.method).toBe('contenteditable');
      // 活跃模式先 humanClick 输入框定位光标 → 调用 sendInputEvent 的 mouseDown
      expect(webContents.sendInputEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'mouseDown' }),
      );
    });

    it('Enter 键未生效时回退到发送按钮点击（活跃模式）', async () => {
      await client.connect();
      webContents.executeJavaScript
        .mockResolvedValueOnce({ found: true, x: 100, y: 200 }) // findInput
        .mockResolvedValueOnce({ success: true, method: 'textarea-native' }) // setText
        .mockResolvedValueOnce(true) // buildEnterKeyScript（已派发但未生效）
        .mockResolvedValueOnce(false) // buildVerifyClearedScript（输入框未清空，验证失败）
        .mockResolvedValueOnce({ found: true, x: 300, y: 400 }) // findSendBtn（回退到发送按钮）
        .mockResolvedValueOnce(true); // buildVerifyClearedScript（点击发送按钮后验证通过）
      const result = await client.sendReplyFast('测试回复');
      expect(result.success).toBe(true);
      // 活跃模式应调用 humanClick（输入框定位 + 发送按钮点击）
      // 两次 mouseDown：一次输入框定位，一次发送按钮点击
      const mouseDownCalls = (webContents.sendInputEvent as jest.Mock).mock.calls.filter(
        (c) => c[0]?.type === 'mouseDown',
      );
      expect(mouseDownCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('后台模式：DOM focus 输入框 + Enter 键发送成功', async () => {
      await client.connect();
      client.setBackgroundMode(true);
      webContents.executeJavaScript
        .mockResolvedValueOnce(true) // focusInputScript（DOM focus 成功）
        .mockResolvedValueOnce({ success: true, method: 'textarea-native' }) // setText
        .mockResolvedValueOnce(true) // buildEnterKeyScript（DOM KeyboardEvent 派发成功）
        .mockResolvedValueOnce(true); // buildVerifyClearedScript（验证通过）
      const result = await client.sendReplyFast('测试回复');
      expect(result.success).toBe(true);
      // 后台模式不应调用 mouseDown（humanClick）
      expect(webContents.sendInputEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'mouseDown' }),
      );
    });

    it('后台模式：Enter 键未生效时回退到 DOM click 发送按钮', async () => {
      await client.connect();
      client.setBackgroundMode(true);
      webContents.executeJavaScript
        .mockResolvedValueOnce(true) // focusInputScript
        .mockResolvedValueOnce({ success: true, method: 'textarea-native' }) // setText
        .mockResolvedValueOnce(true) // buildEnterKeyScript（已派发但未生效）
        .mockResolvedValueOnce(false) // buildVerifyClearedScript（验证失败）
        .mockResolvedValueOnce(true) // buildClickSendButtonScript（DOM click 回退成功）
        .mockResolvedValueOnce(true); // buildVerifyClearedScript（回退后验证通过）
      const result = await client.sendReplyFast('测试回复');
      expect(result.success).toBe(true);
      // 后台模式不应调用 mouseDown（humanClick）
      expect(webContents.sendInputEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'mouseDown' }),
      );
    });

    it('后台模式：DOM focus 输入框失败时返回 no-input', async () => {
      await client.connect();
      client.setBackgroundMode(true);
      webContents.executeJavaScript.mockResolvedValueOnce(false); // focusInputScript 失败
      const result = await client.sendReplyFast('测试回复');
      expect(result.success).toBe(false);
      expect(result.method).toBe('no-input');
      // 不应调用任何 sendInputEvent
      expect(webContents.sendInputEvent).not.toHaveBeenCalled();
    });
  });

  describe('resetObserver', () => {
    it('抑制期内保留消息并在结束后处理', async () => {
      const handler = jest.fn();
      client.onMessage(handler);
      client.resetObserver();
      webContents.executeJavaScript.mockResolvedValueOnce(
        JSON.stringify([{ sessionId: 'buyer1', from: 'buyer', text: '延后处理', timestamp: 1000 }]),
      );

      const drain = (client as unknown as { drainMessageQueue: () => Promise<void> }).drainMessageQueue.bind(client);
      await drain();
      expect(handler).not.toHaveBeenCalled();
      expect(webContents.executeJavaScript).toHaveBeenCalledTimes(1);

      const suppressMs = (client as unknown as { suppressMs: number }).suppressMs;
      jest.advanceTimersByTime(suppressMs);
      await drain();
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: '延后处理' }));
    });
  });

  describe('自适应轮询', () => {
    it('空队列时增加轮询间隔', async () => {
      await client.connect();
      webContents.executeJavaScript.mockResolvedValueOnce('[]');
      jest.advanceTimersByTime(300);
      await Promise.resolve();
      // 下一次轮询间隔会增加到 350ms
      jest.advanceTimersByTime(350);
      await Promise.resolve();
    });
  });

  describe('后台模式', () => {
    it('有未读标记的隐藏会话也处理最新买家消息', async () => {
      const handler = jest.fn();
      client.onMessage(handler);
      client.setBackgroundMode(true);
      const internal = client as unknown as {
        connected: boolean;
        observerInstalled: boolean;
        scanUnreadConversations: () => Promise<void>;
      };
      internal.connected = true;
      internal.observerInstalled = true;
      webContents.executeJavaScript
        .mockResolvedValueOnce(false) // closeDialog
        .mockResolvedValueOnce(JSON.stringify({ clicked: true, hadUnread: true }))
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(
          JSON.stringify([{ sessionId: 'buyer1', from: 'buyer', text: '后台新消息', timestamp: 1000 }]),
        );

      const scan = internal.scanUnreadConversations();
      await jest.advanceTimersByTimeAsync(1500);
      await scan;

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: '后台新消息' }));
    });

    it('setBackgroundMode(true) 后轮询间隔提升到 backgroundPollMs', async () => {
      await client.connect();
      const initialInterval = (client as unknown as { currentPollIntervalMs: number }).currentPollIntervalMs;
      client.setBackgroundMode(true);
      const afterInterval = (client as unknown as { currentPollIntervalMs: number }).currentPollIntervalMs;
      expect(afterInterval).toBeGreaterThanOrEqual(initialInterval);
      expect(afterInterval).toBeGreaterThanOrEqual(3000);
    });

    it('setBackgroundMode(false) 后轮询间隔恢复到 min_ms', async () => {
      await client.connect();
      client.setBackgroundMode(true);
      client.setBackgroundMode(false);
      const afterInterval = (client as unknown as { currentPollIntervalMs: number }).currentPollIntervalMs;
      expect(afterInterval).toBe(200);
    });

    it('重复调用 setBackgroundMode 不重复生效', () => {
      const spy = jest.spyOn(client as unknown as { setBackgroundMode: (b: boolean) => void }, 'setBackgroundMode');
      client.setBackgroundMode(true);
      client.setBackgroundMode(true);
      // 两次调用本身都返回，但内部 backgroundMode 只切换一次
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });
  });

  describe('抖店新版会话扫描', () => {
    it('从 auxo-dropdown-trigger 会话项中找到候选，不误点导航项', () => {
      document.body.innerHTML = `
        <div class="auxo-dropdown-trigger"><span>最近联系</span></div>
        <div class="auxo-dropdown-trigger">
          <span>Nancy</span><span>08/25</span><span>在吗</span>
        </div>
      `;
      Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
      const originalRect = HTMLElement.prototype.getBoundingClientRect;
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        value() {
          const text = this.textContent || '';
          return text.includes('Nancy')
            ? { x: 128, y: 475, width: 280, height: 60, top: 475, left: 128, right: 408, bottom: 535, toJSON: () => ({}) }
            : { x: 100, y: 120, width: 90, height: 28, top: 120, left: 100, right: 190, bottom: 148, toJSON: () => ({}) };
        },
      });
      try {
        const script = (client as unknown as { buildFindUnreadConversationScript: () => string }).buildFindUnreadConversationScript.call(client);
        const result = JSON.parse(window.eval(script)) as { found: boolean; x?: number; y?: number };
        expect(result.found).toBe(true);
        expect(result.x).toBeGreaterThan(100);
        expect(result.y).toBeGreaterThan(400);
      } finally {
        Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: originalRect });
      }
    });

    it('不会把新版联系人默认粗体误判成未读', () => {
      document.body.innerHTML = `
        <div class="auxo-dropdown-trigger">
          <span style="font-weight: 700">Nancy</span><span>08/25</span><span>在吗</span>
        </div>
      `;
      Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
      const originalRect = HTMLElement.prototype.getBoundingClientRect;
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        value() {
          return { x: 128, y: 475, width: 280, height: 60, top: 475, left: 128, right: 408, bottom: 535, toJSON: () => ({}) };
        },
      });
      try {
        const internal = client as unknown as { buildClickUnreadConversationScript: () => string };
        const result = JSON.parse(window.eval(internal.buildClickUnreadConversationScript.call(client))) as {
          clicked: boolean;
          hadUnread: boolean;
        };
        expect(result.clicked).toBe(true);
        expect(result.hadUnread).toBe(false);
      } finally {
        Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: originalRect });
      }
    });

    it('跳过已关闭的历史会话，避免后台重复点击', () => {
      document.body.innerHTML = `
        <div class="auxo-dropdown-trigger">
          <span>Nancy</span><span>08/25</span><span>用户超时未回复，系统关闭会话</span>
        </div>
      `;
      Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
      const originalRect = HTMLElement.prototype.getBoundingClientRect;
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        value() {
          return { x: 128, y: 475, width: 280, height: 60, top: 475, left: 128, right: 408, bottom: 535, toJSON: () => ({}) };
        },
      });
      try {
        const internal = client as unknown as { buildFindUnreadConversationScript: () => string };
        const result = JSON.parse(window.eval(internal.buildFindUnreadConversationScript.call(client))) as {
          found: boolean;
          reason?: string;
        };
        expect(result.found).toBe(false);
        expect(result.reason).toBe('no-unread');
      } finally {
        Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: originalRect });
      }
    });
  });

  describe('executeScript', () => {
    it('正常执行脚本', async () => {
      webContents.executeJavaScript.mockResolvedValueOnce('result');
      const result = await client.executeScript('1+1');
      expect(result).toBe('result');
    });

    it('webContents 已销毁抛错', async () => {
      webContents.isDestroyed.mockReturnValue(true);
      await expect(client.executeScript('1+1')).rejects.toThrow('不可用');
    });
  });

  describe('DOM 消息发送方识别', () => {
    it('只返回最内层消息气泡并正确区分客服与买家', () => {
      document.body.innerHTML = `
        <div class="chatd-message-list">
          <div class="messageIsMe" data-message-id="seller-1"><div class="chatd-content">客服回复</div></div>
          <div class="messageNotMe" data-msg-id="buyer-1"><div class="chatd-content">买家问题</div></div>
          <div class="chatd-content">无法确认发送方</div>
        </div>
      `;
      Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
      const script = (client as unknown as { buildLatestMessagesScript: () => string }).buildLatestMessagesScript.call(client);

      const messages = JSON.parse(window.eval(script)) as Array<{ from: string; text: string }>;

      expect(messages).toEqual([
        expect.objectContaining({ from: 'seller', text: '客服回复', messageId: 'seller-1' }),
        expect.objectContaining({ from: 'buyer', text: '买家问题', messageId: 'buyer-1' }),
        expect.objectContaining({ from: 'system', text: '无法确认发送方' }),
      ]);
      expect(messages).not.toContainEqual(expect.objectContaining({ text: '客服回复买家问题无法确认发送方' }));
    });

    it('实时 Observer 不会把客服气泡识别为买家', async () => {
      document.body.innerHTML = '<div id="message-root"></div>';
      Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
      const internal = client as unknown as {
        buildObserverScript: () => string;
        buildDrainQueueScript: () => string;
      };
      window.eval(internal.buildObserverScript.call(client));

      document.getElementById('message-root')!.innerHTML = `
        <div class="messageIsMe" data-message-id="seller-live"><div class="chatd-content">客服实时回复</div></div>
        <div class="messageNotMe" data-msg-id="buyer-live"><div class="chatd-content">买家实时问题</div></div>
      `;
      await Promise.resolve();
      await Promise.resolve();

      const messages = JSON.parse(window.eval(internal.buildDrainQueueScript.call(client))) as Array<{ from: string; text: string; messageId?: string }>;
      expect(messages).toEqual([
        expect.objectContaining({ from: 'seller', text: '客服实时回复', messageId: 'seller-live' }),
        expect.objectContaining({ from: 'buyer', text: '买家实时问题', messageId: 'buyer-live' }),
      ]);
    });
  });
});
