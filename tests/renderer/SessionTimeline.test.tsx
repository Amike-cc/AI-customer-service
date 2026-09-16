/**
 * 统一工作台消息时间线测试（UI-SESSION-001）
 *
 * 覆盖：会话列表渲染、消息渲染方向、草稿持久化、发送幂等键、实时推送去重。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../renderer/src/components/common/Toast';
import { SessionTimeline } from '../../renderer/src/components/workspace/SessionTimeline';
import type { PlatformMessage } from '../../renderer/src/types/api';

const SHOP_ID = 'shop-1';

const platformSessions = [
  { sessionId: 'buyer-A', lastMessageAt: 2000, messageCount: 2 },
  { sessionId: 'buyer-B', lastMessageAt: 1000, messageCount: 1 },
];

const messagesA: PlatformMessage[] = [
  {
    id: 1, shopId: SHOP_ID, sessionId: 'buyer-A', messageId: 'm1',
    direction: 'in', source: 'buyer', content: '在吗', status: 'received',
    platformRef: null, createdAt: 1000,
  },
  {
    id: 2, shopId: SHOP_ID, sessionId: 'buyer-A', messageId: 'm2',
    direction: 'out', source: 'ai', content: '在的', status: 'sent',
    platformRef: null, createdAt: 2000,
  },
];

describe('SessionTimeline', () => {
  let platformSessionsFn: jest.Mock;
  let streamFn: jest.Mock;
  let draftFn: jest.Mock;
  let sendTextFn: jest.Mock;
  let sendAttachmentFn: jest.Mock;
  let onMessageCb: ((data: unknown) => void) | null;

  beforeEach(() => {
    jest.clearAllMocks();
    onMessageCb = null;
    platformSessionsFn = jest.fn().mockResolvedValue(platformSessions);
    streamFn = jest.fn().mockResolvedValue(messagesA);
    draftFn = jest.fn().mockResolvedValue({ ok: true, draft: '' });
    sendTextFn = jest.fn().mockResolvedValue({ ok: true, status: 'sent', clientMessageId: 'x' });
    sendAttachmentFn = jest.fn().mockResolvedValue({ ok: true, status: 'manual_only', message: '请在平台页面发送' });
    (window as any).api = {
      conversation: {
        platformSessions: platformSessionsFn,
        stream: streamFn,
        draft: draftFn,
        sendText: sendTextFn,
        sendAttachment: sendAttachmentFn,
        onMessage: (cb: (data: unknown) => void) => {
          onMessageCb = cb;
          return () => { onMessageCb = null; };
        },
      },
      order: {
        capture: jest.fn().mockResolvedValue({ ok: true, snapshot: { orderRef: 'ORD-1', summary: '蓝色卫衣 1 件' } }),
      },
      buyer: {
        profile: jest.fn().mockResolvedValue({ ok: true, profile: { buyerName: 'buyer-A', vipLevel: 1, tags: ['老客'], consultationCount: 2, conversionCount: 1 } }),
      },
      kb: {
        listTemplates: jest.fn().mockResolvedValue([{ id: 'tpl-1', scenario: '欢迎语', content: '您好，很高兴为您服务', category: 'greeting' }]),
      },
      product: {
        list: jest.fn().mockResolvedValue([{ product_id: 'p-1', name: '蓝色卫衣', sku: 'SKU-1', variants: [{ price: 99 }] }]),
      },
    };
  });

  function renderTimeline() {
    return render(
      <ToastProvider>
        <SessionTimeline shopId={SHOP_ID} />
      </ToastProvider>,
    );
  }

  it('加载并渲染会话列表与当前会话消息', async () => {
    renderTimeline();
    expect(await screen.findByRole('tab', { name: /buyer-A/ })).toBeInTheDocument();
    expect(await screen.findByText('在吗')).toBeInTheDocument();
    expect(await screen.findByText('在的')).toBeInTheDocument();
    expect(streamFn).toHaveBeenCalledWith(SHOP_ID, 'buyer-A', undefined, 200);
  });

  it('切换会话时重新加载消息', async () => {
    renderTimeline();
    const tabB = await screen.findByRole('tab', { name: /buyer-B/ });
    streamFn.mockResolvedValue([]);
    fireEvent.click(tabB);
    await waitFor(() => {
      expect(streamFn).toHaveBeenCalledWith(SHOP_ID, 'buyer-B', undefined, 200);
    });
  });

  it('输入草稿时按 shopId+sessionId 持久化', async () => {
    renderTimeline();
    const input = await screen.findByLabelText('回复输入框');
    fireEvent.change(input, { target: { value: '您好' } });
    await waitFor(() => {
      expect(draftFn).toHaveBeenCalledWith(SHOP_ID, 'buyer-A', '您好');
    });
  });

  it('发送时携带幂等 clientMessageId 并清空草稿', async () => {
    renderTimeline();
    const input = await screen.findByLabelText('回复输入框');
    fireEvent.change(input, { target: { value: '请稍等' } });
    fireEvent.click(screen.getByRole('button', { name: '发送回复' }));

    await waitFor(() => {
      expect(sendTextFn).toHaveBeenCalledTimes(1);
    });
    const [shopId, sessionId, text, clientMessageId] = sendTextFn.mock.calls[0];
    expect(shopId).toBe(SHOP_ID);
    expect(sessionId).toBe('buyer-A');
    expect(text).toBe('请稍等');
    // 幂等键必须存在，否则重试会重复发送
    expect(typeof clientMessageId).toBe('string');
    expect(clientMessageId.length).toBeGreaterThan(0);
  });

  it('实时推送的重复 messageId 只插入一次', async () => {
    renderTimeline();
    await screen.findByText('在吗');
    act(() => {
      // 与已渲染的 m1 相同 messageId，不应重复渲染
      onMessageCb?.({ ...messagesA[0] });
    });
    expect(screen.getAllByText('在吗')).toHaveLength(1);
  });

  it('实时推送新会话的新消息会追加到时间线', async () => {
    renderTimeline();
    await screen.findByText('在吗');
    act(() => {
      onMessageCb?.({
        id: 9, shopId: SHOP_ID, sessionId: 'buyer-A', messageId: 'm-new',
        direction: 'in', source: 'buyer', content: '新消息来了', status: 'received',
        platformRef: null, createdAt: 3000,
      });
    });
    expect(await screen.findByText('新消息来了')).toBeInTheDocument();
  });

  it('发送失败时提示错误', async () => {
    sendTextFn.mockResolvedValue({ ok: false, error: '发送失败' });
    renderTimeline();
    const input = await screen.findByLabelText('回复输入框');
    fireEvent.change(input, { target: { value: '测试' } });
    fireEvent.click(screen.getByRole('button', { name: '发送回复' }));
    expect(await screen.findByText('发送失败')).toBeInTheDocument();
  });

  it('选择附件时调用平台附件接口并提示人工发送边界', async () => {
    const view = renderTimeline();
    await screen.findByText('在吗');
    const file = new File(['image'], '商品图.png', { type: 'image/png' });
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect(sendAttachmentFn).toHaveBeenCalledWith(SHOP_ID, 'buyer-A', {
        name: '商品图.png',
        size: file.size,
        type: 'image/png',
      });
    });
    expect(await screen.findByText('请在平台页面发送')).toBeInTheDocument();
  });

  it('点击表情按钮会把表情写入当前草稿', async () => {
    renderTimeline();
    await screen.findByText('在吗');
    fireEvent.click(screen.getByRole('button', { name: '插入表情' }));
    await waitFor(() => {
      expect(draftFn).toHaveBeenCalledWith(SHOP_ID, 'buyer-A', '🙂');
    });
  });

  it('订单和买家按钮加载当前会话上下文', async () => {
    renderTimeline();
    await screen.findByText('在吗');
    fireEvent.click(screen.getAllByRole('button', { name: '订单' })[0]);
    expect(await screen.findByText('蓝色卫衣 1 件')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭上下文面板' }));
    fireEvent.click(screen.getByRole('button', { name: '买家' }));
    expect(await screen.findByText(/VIP 1/)).toBeInTheDocument();
  });

  it('更多菜单可以刷新会话或打开平台原页', async () => {
    const onOpenPlatform = jest.fn();
    render(
      <ToastProvider>
        <SessionTimeline shopId={SHOP_ID} onOpenPlatform={onOpenPlatform} />
      </ToastProvider>,
    );
    await screen.findByText('在吗');
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '打开平台原页' }));
    expect(onOpenPlatform).toHaveBeenCalledTimes(1);
  });

  it('快捷回复推荐可以直接填入草稿', async () => {
    renderTimeline();
    await screen.findByText('在吗');
    fireEvent.click(await screen.findByRole('button', { name: /欢迎语/ }));
    await waitFor(() => {
      expect(draftFn).toHaveBeenCalledWith(SHOP_ID, 'buyer-A', '您好，很高兴为您服务');
    });
  });

  it('店铺未登录时显示平台登录引导', async () => {
    const onOpenPlatform = jest.fn();
    render(
      <ToastProvider>
        <SessionTimeline
          shopId={SHOP_ID}
          shop={{ shopName: '测试店', platform: 'feige', loginStatus: 'logged_out' } as any}
          onOpenPlatform={onOpenPlatform}
        />
      </ToastProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('抖店店铺尚未登录');
    fireEvent.click(screen.getByRole('button', { name: '去平台登录' }));
    expect(onOpenPlatform).toHaveBeenCalledTimes(1);
  });

  it('右侧面板收起时提供接待控制恢复入口', async () => {
    const onToggleControlPanel = jest.fn();
    render(
      <ToastProvider>
        <SessionTimeline
          shopId={SHOP_ID}
          showControlPanelButton
          onToggleControlPanel={onToggleControlPanel}
        />
      </ToastProvider>,
    );
    const button = await screen.findByRole('button', { name: '接待控制' });
    fireEvent.click(button);
    expect(onToggleControlPanel).toHaveBeenCalledTimes(1);
  });
});
