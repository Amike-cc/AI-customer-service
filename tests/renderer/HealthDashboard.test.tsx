import { render, screen, waitFor } from '@testing-library/react';
import { HealthDashboard } from '../../renderer/src/components/monitor/HealthDashboard';
import { ToastProvider } from '../../renderer/src/components/common/Toast';
import type { ShopListItem } from '../../renderer/src/types/api';

const shop: ShopListItem = {
  shopId: 'shop-001',
  shopName: '测试店铺',
  platform: 'feige',
  feigeClientPath: '',
  enabled: true,
  autoReply: true,
  loginStatus: 'logged_in',
  lastLoginAt: Date.now(),
  transferTarget: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  state: 'Healthy',
  stateRecord: null,
};

describe('HealthDashboard', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('queries metrics using a one-hour start timestamp rather than a duration', async () => {
    const now = 2_000_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const summary = jest.fn().mockResolvedValue({
      messagesReceived: 12,
      repliesSent: 11,
      replyFailed: 1,
      rateLimitRejected: 0,
      apiCalls: 7,
      avgApiLatency: 320,
    });
    (window as any).api = { metrics: { summary } };

    render(
      <ToastProvider>
        <HealthDashboard shops={[shop]} />
      </ToastProvider>,
    );

    await screen.findByText('健康监控');
    await waitFor(() => expect(summary).toHaveBeenCalledWith(now - 3_600_000));
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('320ms')).toBeInTheDocument();
  });

  it('does not count a logged-out shop as healthy', async () => {
    (window as any).api = {
      metrics: {
        summary: jest.fn().mockResolvedValue({
          messagesReceived: 0,
          repliesSent: 0,
          replyFailed: 0,
          rateLimitRejected: 0,
          apiCalls: 0,
          avgApiLatency: 0,
        }),
      },
    };

    render(
      <ToastProvider>
        <HealthDashboard shops={[{ ...shop, loginStatus: 'logged_out' }]} />
      </ToastProvider>,
    );

    await screen.findByText('待登录');
    const statCards = document.querySelectorAll('[class*="statCard"]');
    expect(statCards[1]).toHaveTextContent('健康0');
    expect(statCards[2]).toHaveTextContent('异常1');
  });
});
