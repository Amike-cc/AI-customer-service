import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ToastProvider } from '../../renderer/src/components/common/Toast';
import { WorkspacePanel } from '../../renderer/src/components/workspace/WorkspacePanel';

const baseShop = {
  shopId: 'shop-1',
  shopName: '测试店',
  platform: 'feige',
  loginStatus: 'logged_out',
  autoReply: false,
  state: 'Healthy',
} as any;

function renderPanel(shop = baseShop) {
  return render(
    <ToastProvider>
      <WorkspacePanel
        shop={shop}
        autoReply={shop.autoReply}
        onSetAutoReply={jest.fn()}
        onTakeover={jest.fn()}
        onRelease={jest.fn()}
      />
    </ToastProvider>,
  );
}

describe('WorkspacePanel', () => {
  beforeEach(() => {
    (window as any).api = {
      workspace: {
        getSnapshot: jest.fn().mockResolvedValue({
          ok: true,
          snapshot: {
            shopId: 'shop-1',
            shopName: '测试店',
            platform: 'feige',
            autoReply: false,
            loginStatus: 'logged_out',
            state: 'Healthy',
            manualMode: false,
            unreadCount: 0,
            capturedAt: Date.now(),
          },
        }),
      },
      transfer: {
        history: jest.fn().mockResolvedValue([]),
      },
    };
  });

  it('未登录时禁止开启 AI 并提示先登录平台', async () => {
    renderPanel();
    const aiButton = await screen.findByRole('button', { name: /已关闭/ });
    expect(aiButton).toBeDisabled();
    expect(screen.getByText('请先登录平台，再开启 AI 自动回复。')).toBeInTheDocument();
  });

  it('已登录时允许开启 AI', async () => {
    const shop = { ...baseShop, loginStatus: 'logged_in' };
    (window as any).api.workspace.getSnapshot.mockResolvedValue({
      ok: true,
      snapshot: {
        shopId: 'shop-1',
        shopName: '测试店',
        platform: 'feige',
        autoReply: false,
        loginStatus: 'logged_in',
        state: 'Healthy',
        manualMode: false,
        unreadCount: 0,
        capturedAt: Date.now(),
      },
    });
    renderPanel(shop);
    expect(await screen.findByRole('button', { name: /已关闭/ })).not.toBeDisabled();
    expect(screen.queryByText('请先登录平台，再开启 AI 自动回复。')).not.toBeInTheDocument();
  });
});
