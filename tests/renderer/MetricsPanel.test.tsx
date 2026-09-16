import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MetricsPanel } from '../../renderer/src/components/analytics/MetricsPanel';
import { ToastProvider } from '../../renderer/src/components/common/Toast';
import type {
  MetricsHistory,
  MetricsSummary,
  ShopListItem,
} from '../../renderer/src/types/api';

const shop: ShopListItem = {
  shopId: '10001',
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

describe('MetricsPanel', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the same all-shop or selected-shop scope for summary and history', async () => {
    const now = 2_000_000_000_000;
    const since = now - 86_400_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    const summary = jest.fn(
      async (sinceMs: number, shopId?: string): Promise<MetricsSummary> => ({
        since: sinceMs,
        shopId: shopId ?? null,
        apiCalls: 7,
        tokensInput: 12,
        tokensOutput: 5,
        messagesReceived: 9,
        repliesSent: 8,
        replyFailed: 1,
        rateLimitRejected: 0,
        sensitiveBlocked: 0,
        stateTransitions: 3,
        avgApiLatency: 320,
      }),
    );
    const history = jest.fn(
      async (
        metricName: string,
        sinceMs: number,
        untilMs?: number,
        shopId?: string,
      ): Promise<MetricsHistory> => ({
        metricName,
        since: sinceMs,
        until: untilMs ?? now,
        bucketMs: 300_000,
        shopId: shopId ?? null,
        buckets: [],
      }),
    );
    (window as any).api = { metrics: { summary, history } };

    render(
      <ToastProvider>
        <MetricsPanel shops={[shop]} />
      </ToastProvider>,
    );

    await waitFor(() => expect(summary).toHaveBeenCalledWith(since, undefined));
    expect(history).toHaveBeenCalledWith('api_call_total', since, now, undefined);
    expect(screen.getByText('数据范围：全部店铺 · 近 24 小时')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('指标店铺范围'), {
      target: { value: shop.shopId },
    });

    await waitFor(() => expect(summary).toHaveBeenLastCalledWith(since, shop.shopId));
    expect(history).toHaveBeenLastCalledWith('api_call_total', since, now, shop.shopId);
    expect(screen.getByText('数据范围：测试店铺 · 近 24 小时')).toBeInTheDocument();
  });

  it('offers only metric names that are actually persisted', async () => {
    const summary = jest.fn().mockResolvedValue({
      since: 1,
      shopId: null,
      apiCalls: 0,
      tokensInput: 0,
      tokensOutput: 0,
      messagesReceived: 0,
      repliesSent: 0,
      replyFailed: 0,
      rateLimitRejected: 0,
      sensitiveBlocked: 0,
      stateTransitions: 0,
      avgApiLatency: 0,
    });
    const history = jest.fn().mockResolvedValue({
      metricName: 'api_call_total',
      since: 1,
      until: 2,
      bucketMs: 60_000,
      shopId: null,
      buckets: [],
    });
    (window as any).api = { metrics: { summary, history } };

    render(
      <ToastProvider>
        <MetricsPanel shops={[]} />
      </ToastProvider>,
    );

    const metricSelect = await screen.findByLabelText('趋势指标');
    expect(metricSelect).toContainHTML('value="message_received_total"');
    expect(metricSelect).toContainHTML('value="reply_sent_total"');
    expect(metricSelect).not.toContainHTML('value="messages_received_total"');
    expect(metricSelect).not.toContainHTML('value="api_latency_ms"');
  });
});
