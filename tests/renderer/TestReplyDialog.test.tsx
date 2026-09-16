import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../renderer/src/components/common/Toast';
import { TestReplyDialog } from '../../renderer/src/components/shops/TestReplyDialog';
import type { ShopListItem, TestReplyResult } from '../../renderer/src/types/api';

const shop: ShopListItem = {
  shopId: 'shop-preview-001',
  shopName: '安全测试店',
  platform: 'feige',
  enabled: true,
  autoReply: true,
  loginStatus: 'logged_in',
  lastLoginAt: Date.now(),
  createdAt: Date.now(),
  updatedAt: Date.now(),
  state: 'Healthy',
  stateRecord: null,
};

const previewResult: TestReplyResult = {
  shopId: shop.shopId,
  reply: '您好，这里是只读预览回复。',
  matchedRule: 'greeting',
  sensitiveHits: [],
  tokenInput: 12,
  tokenOutput: 8,
  latencyMs: 120,
  pipeline: [
    { step: 'rule_match', status: 'ok', detail: 'greeting' },
    { step: 'send_message', status: 'skip', detail: 'preview only' },
  ],
};

describe('TestReplyDialog', () => {
  const testReply = jest.fn();
  const sendReply = jest.fn();
  const onClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    testReply.mockResolvedValue(previewResult);
    (window as any).api = {
      test: { reply: testReply },
      shop: { sendReply },
      view: {
        hideForModal: jest.fn().mockResolvedValue(undefined),
        restoreAfterModal: jest.fn().mockResolvedValue(undefined),
      },
    };
  });

  function renderDialog() {
    return render(
      <ToastProvider>
        <TestReplyDialog shop={shop} onClose={onClose} />
      </ToastProvider>,
    );
  }

  it('exposes dialog semantics and a visible preview-only safety notice', () => {
    renderDialog();

    expect(screen.getByRole('dialog', { name: /测试回复.*安全测试店/ })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('仅生成回复预览，不会发送给真实买家。');
    expect(screen.queryByRole('button', { name: /发送/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '执行测试' })).toBeDisabled();
  });

  it('uses the preview API and never calls the real message-send API', async () => {
    renderDialog();
    const messageInput = screen.getByRole('textbox', { name: '模拟买家消息' });
    fireEvent.change(messageInput, { target: { value: '  你好，有现货吗？  ' } });
    fireEvent.click(screen.getByRole('button', { name: '执行测试' }));

    await waitFor(() => {
      expect(testReply).toHaveBeenCalledWith(shop.shopId, '你好，有现货吗？');
    });
    expect(sendReply).not.toHaveBeenCalled();
    expect(await screen.findByText('您好，这里是只读预览回复。')).toBeInTheDocument();
    expect(screen.getByText('send_message')).toBeInTheDocument();
    expect(screen.getByText('preview only')).toBeInTheDocument();
  });
});
