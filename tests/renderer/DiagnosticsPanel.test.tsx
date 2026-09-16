import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../renderer/src/components/common/Toast';
import { DiagnosticsPanel } from '../../renderer/src/components/config/DiagnosticsPanel';
import type { ShopListItem } from '../../renderer/src/types/api';

const mockShops: ShopListItem[] = [
  {
    shopId: 'shop-001',
    shopName: '测试店铺A',
    platform: 'pinduoduo',
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
  },
  {
    shopId: 'shop-002',
    shopName: '微信小店B',
    platform: 'weixin',
    feigeClientPath: '',
    enabled: true,
    autoReply: false,
    loginStatus: 'logged_out',
    lastLoginAt: null,
    transferTarget: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: null,
    stateRecord: null,
  },
];

const buildApiMock = () => {
  const api: Record<string, any> = {
    diagnose: {
      run: jest.fn().mockResolvedValue({
        results: [],
        total: 0,
        pass: 0,
        warn: 0,
        fail: 0,
        skip: 0,
        healthScore: 100,
        runAt: Date.now(),
      }),
    },
    diagnostic: {
      checkAutoReply: jest.fn().mockResolvedValue({ ok: false, error: 'not stubbed' }),
      systemHealth: jest.fn().mockResolvedValue({ ok: false, error: 'not stubbed' }),
    },
    shop: {
      list: jest.fn().mockResolvedValue(mockShops),
      onStateChanged: jest.fn().mockReturnValue(() => {}),
      onLoginStatusChanged: jest.fn().mockReturnValue(() => {}),
      onNameUpdated: jest.fn().mockReturnValue(() => {}),
      getActiveShop: jest.fn().mockResolvedValue({ shopId: null }),
    },
  };
  return api;
};

beforeEach(() => {
  localStorage.clear();
  (window as any).api = buildApiMock();
});

async function renderWithProviders(ui: React.ReactElement) {
  const result = render(<ToastProvider>{ui}</ToastProvider>);
  await screen.findByText('测试店铺A (pinduoduo)');
  return result;
}

describe('DiagnosticsPanel', () => {
  it('renders system diagnostics header and run button', async () => {
    await renderWithProviders(<DiagnosticsPanel />);
    expect(screen.getByText('系统诊断')).toBeInTheDocument();
    expect(screen.getByText('运行诊断')).toBeInTheDocument();
  });

  it('完整显示并复制多行模型文件详情', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    (window as any).api.diagnose.run.mockResolvedValue({
      results: [{
        id: 'paddle_models',
        name: 'PaddleOCR 模型',
        category: 'models',
        status: 'pass',
        message: '核心模型完整',
        detail: 'PP-OCRv6_medium_det: 完整\nPP-OCRv6_medium_rec: 完整\nUVDoc: 完整',
      }],
      total: 1,
      pass: 1,
      warn: 0,
      fail: 0,
      skip: 0,
      healthScore: 100,
      runAt: Date.now(),
    });

    await renderWithProviders(<DiagnosticsPanel />);
    fireEvent.click(screen.getByText('运行诊断'));
    expect(await screen.findByText(/PP-OCRv6_medium_det/)).toHaveTextContent('UVDoc: 完整');
    fireEvent.click(screen.getByText('复制报告'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain('PP-OCRv6_medium_rec: 完整');
  });

  it('renders auto-reply diagnostics section with shop selector', async () => {
    await renderWithProviders(<DiagnosticsPanel />);
    expect(screen.getByText('自动回复诊断')).toBeInTheDocument();
    expect(screen.getByText('选择店铺...')).toBeInTheDocument();
  });

  it('populates shop options from useShops', async () => {
    await renderWithProviders(<DiagnosticsPanel />);
    await waitFor(() => {
      expect(screen.getByText('测试店铺A (pinduoduo)')).toBeInTheDocument();
      expect(screen.getByText('微信小店B (weixin)')).toBeInTheDocument();
    });
  });

  it('warns when checking without selecting a shop', async () => {
    await renderWithProviders(<DiagnosticsPanel />);
    fireEvent.click(screen.getByText('检查配置'));
    await waitFor(() => {
      expect(screen.getByText('请先选择店铺')).toBeInTheDocument();
    });
  });

  it('calls checkAutoReply and shows report when shop is selected', async () => {
    (window as any).api.diagnostic.checkAutoReply.mockResolvedValue({
      ok: true,
      report: {
        shopId: 'shop-001',
        shopName: '测试店铺A',
        platform: 'pinduoduo',
        autoReply: true,
        loginStatus: 'logged_in',
        hasShop: true,
        state: 'Healthy',
        apiKeyConfigured: true,
        apiKeyPreview: 'sk-1234****abcd',
        ruleCount: 28,
        platformUrl: 'https://mms.pinduoduo.com/chat-merchant/index.html#/',
        issues: [],
      },
    });

    await renderWithProviders(<DiagnosticsPanel />);
    await waitFor(() => {
      expect(screen.getByText('测试店铺A (pinduoduo)')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'shop-001' } });
    fireEvent.click(screen.getByText('检查配置'));

    await waitFor(() => {
      expect(screen.getByText('测试店铺A')).toBeInTheDocument();
      expect(screen.getByText('pinduoduo')).toBeInTheDocument();
      expect(screen.getByText('已开启')).toBeInTheDocument();
      expect(screen.getByText('已登录')).toBeInTheDocument();
      expect(screen.getByText('28 条')).toBeInTheDocument();
    });
    expect((window as any).api.diagnostic.checkAutoReply).toHaveBeenCalledWith('shop-001');
  });

  it('displays issues list when report contains issues', async () => {
    (window as any).api.diagnostic.checkAutoReply.mockResolvedValue({
      ok: true,
      report: {
        shopId: 'shop-002',
        shopName: '微信小店B',
        platform: 'weixin',
        autoReply: false,
        loginStatus: 'logged_out',
        hasShop: false,
        state: null,
        apiKeyConfigured: false,
        apiKeyPreview: '未配置',
        ruleCount: 0,
        platformUrl: 'https://store.weixin.qq.com/shop/kf',
        issues: ['自动回复已关闭', '平台登录已过期', 'DeepSeek API Key 未配置', '店铺未启动', '规则引擎无规则'],
      },
    });

    await renderWithProviders(<DiagnosticsPanel />);
    await waitFor(() => {
      expect(screen.getByText('微信小店B (weixin)')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'shop-002' } });
    fireEvent.click(screen.getByText('检查配置'));

    await waitFor(() => {
      expect(screen.getByText('发现问题')).toBeInTheDocument();
      expect(screen.getByText('自动回复已关闭')).toBeInTheDocument();
      expect(screen.getByText('平台登录已过期')).toBeInTheDocument();
      expect(screen.getByText('DeepSeek API Key 未配置')).toBeInTheDocument();
    });
  });

  it('shows error toast when checkAutoReply fails', async () => {
    (window as any).api.diagnostic.checkAutoReply.mockResolvedValue({
      ok: false,
      error: '店铺不存在',
    });

    await renderWithProviders(<DiagnosticsPanel />);
    await waitFor(() => {
      expect(screen.getByText('测试店铺A (pinduoduo)')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'shop-001' } });
    fireEvent.click(screen.getByText('检查配置'));

    await waitFor(() => {
      expect(screen.getByText('检查失败: 店铺不存在')).toBeInTheDocument();
    });
  });
});

describe('SystemHealthOverview', () => {
  it('renders system health section with refresh button', async () => {
    await renderWithProviders(<DiagnosticsPanel />);
    expect(screen.getByText('系统健康概览')).toBeInTheDocument();
    expect(screen.getByText('刷新')).toBeInTheDocument();
  });

  it('shows placeholder before refresh is clicked', async () => {
    await renderWithProviders(<DiagnosticsPanel />);
    expect(screen.getByText('点击"刷新"获取系统健康概览')).toBeInTheDocument();
  });

  it('calls systemHealth and shows overview after refresh', async () => {
    (window as any).api.diagnostic.systemHealth.mockResolvedValue({
      ok: true,
      health: {
        uptime: 3661,
        pid: 12345,
        memory: { heapUsed: 52428800, heapTotal: 104857600, rss: 157286400, external: 1048576 },
        database: {
          walMode: 'wal',
          dbSizeBytes: 1048576,
          tableCounts: { shop_config: 2, audit_log: 150, feedback: 30, learned_patterns: 5, metric_points: 1000, escalation_records: 3 },
        },
        cache: { totalEntries: 42, shopEntries: { 'shop-001': 30, 'shop-002': 12 }, totalHitCount: 100, oldestCreatedAt: Date.now() - 60000 },
        deepseek: { apiKeyConfigured: true, circuitState: 'closed', consecutiveFailures: 0, circuitOpenedAt: 0 },
        shops: [
          { shopId: 'shop-001', shopName: '测试店铺A', platform: 'pinduoduo', autoReply: true, loginStatus: 'logged_in', state: 'Healthy' },
          { shopId: 'shop-002', shopName: '微信小店B', platform: 'weixin', autoReply: false, loginStatus: 'logged_out', state: null },
        ],
        metrics: { apiCalls: 100, messagesReceived: 50, repliesSent: 48, replyFailed: 2, sensitiveBlocked: 1, avgApiLatency: 850 },
        timestamp: Date.now(),
      },
    });

    await renderWithProviders(<DiagnosticsPanel />);

    const refreshBtn = screen.getByRole('button', { name: /刷新/ });
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(screen.getByText('运行时')).toBeInTheDocument();
      expect(screen.getByText('1h 1m 1s')).toBeInTheDocument();
      expect(screen.getByText('12345')).toBeInTheDocument();
    });
    expect(screen.getByText('数据库')).toBeInTheDocument();
    expect(screen.getByText('wal')).toBeInTheDocument();
    expect(screen.getByText('150 行')).toBeInTheDocument();
    expect(screen.getByText('缓存 & API')).toBeInTheDocument();
    expect(screen.getByText('正常')).toBeInTheDocument();
    expect(screen.getByText('过去 1 小时指标')).toBeInTheDocument();
    expect(screen.getByText('850ms')).toBeInTheDocument();
    expect(screen.getByText('店铺状态 (2)')).toBeInTheDocument();
    expect((window as any).api.diagnostic.systemHealth).toHaveBeenCalled();
  });

  it('shows error toast when systemHealth fails', async () => {
    (window as any).api.diagnostic.systemHealth.mockResolvedValue({
      ok: false,
      error: '数据库连接失败',
    });

    await renderWithProviders(<DiagnosticsPanel />);

    const refreshBtn = screen.getByRole('button', { name: /刷新/ });
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(screen.getByText('获取系统健康概览失败: 数据库连接失败')).toBeInTheDocument();
    });
  });

  it('displays circuit breaker open state correctly', async () => {
    (window as any).api.diagnostic.systemHealth.mockResolvedValue({
      ok: true,
      health: {
        uptime: 100,
        pid: 12345,
        memory: { heapUsed: 1000, heapTotal: 2000, rss: 3000, external: 100 },
        database: { walMode: 'wal', dbSizeBytes: 5000, tableCounts: {} },
        cache: { totalEntries: 0, shopEntries: {}, totalHitCount: 0, oldestCreatedAt: null },
        deepseek: { apiKeyConfigured: true, circuitState: 'open', consecutiveFailures: 5, circuitOpenedAt: Date.now() },
        shops: [],
        metrics: { apiCalls: 0, messagesReceived: 0, repliesSent: 0, replyFailed: 0, sensitiveBlocked: 0, avgApiLatency: 0 },
        timestamp: Date.now(),
      },
    });

    await renderWithProviders(<DiagnosticsPanel />);

    const refreshBtn = screen.getByRole('button', { name: /刷新/ });
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(screen.getByText('已熔断')).toBeInTheDocument();
      expect(screen.getByText('连续失败次数')).toBeInTheDocument();
    });
  });
});
