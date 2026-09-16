import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IntentPanel } from '../../renderer/src/components/analytics/IntentPanel';
import { ToastProvider } from '../../renderer/src/components/common/Toast';
import type { EscalationStats, IntentClassificationRecord, ShopListItem } from '../../renderer/src/types/api';

const now = 2_000_000_000_000;

const shop: ShopListItem = {
  shopId: '10001',
  shopName: '测试店铺',
  platform: 'feige',
  feigeClientPath: '',
  enabled: true,
  autoReply: true,
  loginStatus: 'logged_in',
  lastLoginAt: now,
  transferTarget: null,
  createdAt: now,
  updatedAt: now,
  state: 'Healthy',
  stateRecord: null,
};

const recentRecord: IntentClassificationRecord = {
  id: 1,
  shopId: shop.shopId,
  sessionId: 'session-new',
  userMessage: '新消息：商品什么时候发货？',
  category: 'logistics',
  confidence: 0.92,
  complexityLevel: 'low',
  complexityScore: 0.2,
  entities: null,
  shouldEscalate: 0,
  createdAt: now - 60_000,
};

const oldRecord: IntentClassificationRecord = {
  ...recentRecord,
  id: 2,
  sessionId: 'session-old',
  userMessage: '两天前的旧消息',
  createdAt: now - 2 * 86_400_000,
};

const stats: EscalationStats = {
  categoryStats: [
    { category: 'logistics', count: 3 },
    { category: 'complaint', count: 1 },
  ],
  escalationStats: [
    { status: 'pending', count: 2 },
    { status: 'resolved', count: 1 },
  ],
};

function renderPanel(
  recent = jest.fn().mockResolvedValue([recentRecord, oldRecord]),
  loadStats = jest.fn().mockResolvedValue(stats),
) {
  const api = { intent: { recent, stats: loadStats } };
  (window as any).api = api;
  render(
    <ToastProvider>
      <IntentPanel shops={[shop]} />
    </ToastProvider>,
  );
  return api;
}

describe('IntentPanel', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('labels selectors, filters recent records to the selected range, and exposes chart/table semantics', async () => {
    const api = renderPanel();

    expect(await screen.findByText(recentRecord.userMessage)).toBeInTheDocument();
    expect(screen.queryByText(oldRecord.userMessage)).not.toBeInTheDocument();
    expect(screen.getByLabelText('意图分析店铺')).toHaveValue(shop.shopId);
    expect(screen.getByLabelText('意图分析时间范围')).toHaveValue('86400000');
    expect(api.intent.stats).toHaveBeenCalledWith(shop.shopId, now - 86_400_000);

    expect(screen.getByRole('img', { name: /意图总数 4/ })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '物流数量' })).toHaveAttribute('aria-valuenow', '3');
    expect(
      screen.getByText('测试店铺在近 24 小时内最近的意图分类记录，最多 100 条', {
        selector: 'caption',
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '消息' })).toHaveAttribute('scope', 'col');
    expect(screen.getByRole('rowheader', { name: recentRecord.userMessage })).toHaveAttribute('scope', 'row');
    expect(screen.getByRole('region', { name: '最近意图分类记录，可横向滚动' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByText(/最近更新/)).toContainHTML('<time');
  });

  it('keeps the last successful data visible and marks it stale when refresh fails', async () => {
    const recent = jest.fn().mockResolvedValue([recentRecord]);
    const loadStats = jest.fn().mockResolvedValue(stats);
    renderPanel(recent, loadStats);

    expect(await screen.findByText(recentRecord.userMessage)).toBeInTheDocument();
    recent.mockRejectedValueOnce(new Error('网络不可用'));
    loadStats.mockRejectedValueOnce(new Error('网络不可用'));

    fireEvent.click(screen.getByRole('button', { name: '刷新测试店铺的意图分析数据' }));

    expect(await screen.findByText(/数据可能已过期/)).toBeInTheDocument();
    expect(screen.getByText(recentRecord.userMessage)).toBeInTheDocument();
    expect(screen.getByText(/最近更新/)).toBeInTheDocument();
  });

  it('uses filter-specific empty copy and reloads when the time range changes', async () => {
    const recent = jest.fn().mockResolvedValue([]);
    const loadStats = jest.fn().mockResolvedValue({ categoryStats: [], escalationStats: [] });
    renderPanel(recent, loadStats);

    expect(await screen.findByText('当前店铺在近 24 小时内暂无意图分类数据。')).toBeInTheDocument();
    expect(screen.getByText('当前店铺在近 24 小时内暂无意图分类记录。')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('意图分析时间范围'), {
      target: { value: '604800000' },
    });

    await waitFor(() => {
      expect(loadStats).toHaveBeenLastCalledWith(shop.shopId, now - 604_800_000);
    });
    expect(await screen.findByText('当前店铺在近 7 天内暂无意图分类数据。')).toBeInTheDocument();
    expect(screen.getByText('当前店铺在近 7 天内暂无意图分类记录。')).toBeInTheDocument();
  });
});
