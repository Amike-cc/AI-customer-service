import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ShopListItem } from '../../renderer/src/types/api';

// Mock lazy-loaded sub-panels to avoid deep dependency issues
jest.mock('../../renderer/src/components/config/ConfigPanel', () => ({
  ConfigPanel: () => <div>系统配置管理</div>,
}));
jest.mock('../../renderer/src/components/products/ProductManager', () => ({
  ProductManager: () => <div>商品管理</div>,
}));
jest.mock('../../renderer/src/components/rules/RuleManager', () => ({
  RuleManager: () => <div>规则引擎管理</div>,
}));
jest.mock('../../renderer/src/components/knowledge/KnowledgeBase', () => ({
  KnowledgeBase: () => <div>知识库管理</div>,
}));
jest.mock('../../renderer/src/components/logs/LogAlertPanel', () => ({
  LogAlertPanel: () => <div>日志告警面板</div>,
}));
jest.mock('../../renderer/src/components/sessions/SessionViewer', () => ({
  SessionViewer: () => <div>会话查看</div>,
}));
jest.mock('../../renderer/src/components/audit/AuditLogViewer', () => ({
  AuditLogViewer: () => <div>审计日志</div>,
}));
jest.mock('../../renderer/src/components/analytics/IntentPanel', () => ({
  IntentPanel: () => <div>意图分析</div>,
}));
jest.mock('../../renderer/src/components/analytics/AgentPanel', () => ({
  AgentPanel: () => <div>人工坐席</div>,
}));
jest.mock('../../renderer/src/components/learning/LearningPanel', () => ({
  LearningPanel: () => <div>学习系统</div>,
}));
jest.mock('../../renderer/src/components/analytics/MetricsPanel', () => ({
  MetricsPanel: () => <div>运营指标</div>,
}));
jest.mock('../../renderer/src/components/monitor/HealthDashboard', () => ({
  HealthDashboard: () => <div>健康监控</div>,
}));

import { SettingsPanel } from '../../renderer/src/components/settings/SettingsPanel';

const mockShops: ShopListItem[] = [
  {
    shopId: '1234567890123',
    shopName: '测试店铺A',
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
];

beforeEach(() => {
  localStorage.clear();
  (window as any).api = {
    config: { get: jest.fn().mockResolvedValue({}) },
    log: { subscribe: jest.fn().mockResolvedValue({ ok: true }), history: jest.fn().mockResolvedValue({ entries: [], total: 0 }) },
    alert: { list: jest.fn().mockResolvedValue([]) },
    shop: { list: jest.fn().mockResolvedValue(mockShops) },
    rule: { list: jest.fn().mockResolvedValue([]) },
    kb: {
      getPrompt: jest.fn().mockResolvedValue(''),
      getSensitiveWords: jest.fn().mockResolvedValue([]),
      listTemplates: jest.fn().mockResolvedValue([]),
      getCategoryStats: jest.fn().mockResolvedValue([]),
    },
    product: { list: jest.fn().mockResolvedValue([]) },
    learning: {
      patterns: jest.fn().mockResolvedValue([]),
      runs: jest.fn().mockResolvedValue([]),
      stats: jest.fn().mockResolvedValue({ totalPatterns: 0, activePatterns: 0, totalMatches: 0, avgQuality: 0, positiveFeedback: 0, negativeFeedback: 0 }),
    },
    metrics: { summary: jest.fn().mockResolvedValue(null), history: jest.fn().mockResolvedValue(null) },
    intent: { recent: jest.fn().mockResolvedValue([]), stats: jest.fn().mockResolvedValue({ categoryStats: [], escalationStats: [] }) },
    agent: { list: jest.fn().mockResolvedValue([]), queue: jest.fn().mockResolvedValue([]) },
    escalation: { list: jest.fn().mockResolvedValue([]) },
    conversation: { sessions: jest.fn().mockResolvedValue([]) },
    audit: { list: jest.fn().mockResolvedValue([]) },
    diagnose: { health: jest.fn().mockResolvedValue({ status: 'ok', uptime: 0, memory: { heapUsed: 0, heapTotal: 0 } }) },
    db: { backup: jest.fn().mockResolvedValue({ ok: true, path: '/tmp/backup.db' }) },
    update: {
      getState: jest.fn().mockResolvedValue({ status: 'not-available', currentVersion: '2.0.0' }),
      check: jest.fn(), download: jest.fn(), install: jest.fn(), onStateChanged: jest.fn(() => () => {}),
    },
  };
});

describe('SettingsPanel', () => {
  it('honors an initial tab requested by workspace navigation', async () => {
    render(<SettingsPanel shops={mockShops} initialTab="products" />);
    const tab = await screen.findByRole('tab', { name: /^商品管理/ });
    expect(tab).toHaveAttribute('aria-selected', 'true');
  });

  it('should render all 13 customer-service tabs', async () => {
    render(<SettingsPanel shops={mockShops} />);
    await screen.findByText('系统配置管理');
    const tabs = [
      '系统配置', '商品管理', '规则引擎', '知识库', '日志告警',
      '会话查看', '审计日志', '意图分析', '人工坐席', '学习系统',
      '运营指标', '软件更新', '健康监控',
    ];
    for (const label of tabs) {
      expect(screen.getByRole('tab', { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('tab')).toHaveLength(13);
  });

  it('should link the selected tab to its tabpanel', async () => {
    render(<SettingsPanel shops={mockShops} />);
    await screen.findByText('系统配置管理');

    const tab = screen.getByRole('tab', { name: /^系统配置/ });
    const panel = screen.getByRole('tabpanel', { name: /^系统配置/ });
    expect(tab).toHaveAttribute('id', 'settings-tab-config');
    expect(tab).toHaveAttribute('aria-controls', 'settings-panel-config');
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(tab).toHaveAttribute('tabindex', '0');
    expect(panel).toHaveAttribute('id', 'settings-panel-config');
    expect(panel).toHaveAttribute('aria-labelledby', 'settings-tab-config');
  });

  it('should switch tab on click', async () => {
    render(<SettingsPanel shops={mockShops} />);
    fireEvent.click(screen.getByRole('tab', { name: /^规则引擎/ }));
    expect(await screen.findByText('规则引擎管理')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^规则引擎/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: /^规则引擎/ })).toHaveAttribute(
      'aria-labelledby',
      'settings-tab-rules',
    );
  });

  it('should persist tab selection to localStorage', async () => {
    render(<SettingsPanel shops={mockShops} />);
    fireEvent.click(screen.getByRole('tab', { name: /^知识库/ }));
    expect(await screen.findByText('知识库管理')).toBeInTheDocument();
    expect(localStorage.getItem('settingsTab')).toBe('knowledge');
  });

  it('should restore tab from localStorage', async () => {
    localStorage.setItem('settingsTab', 'logs');
    render(<SettingsPanel shops={mockShops} />);
    expect(await screen.findByText('日志告警面板')).toBeInTheDocument();
  });

  it('should ignore invalid localStorage tab value', async () => {
    localStorage.setItem('settingsTab', 'invalid_tab');
    render(<SettingsPanel shops={mockShops} />);
    await waitFor(() => {
      expect(screen.getByText('系统配置管理')).toBeInTheDocument();
    });
  });

  it('supports Arrow keys with wrapping and moves focus with selection', async () => {
    render(<SettingsPanel shops={mockShops} />);
    await screen.findByText('系统配置管理');

    const configTab = screen.getByRole('tab', { name: /^系统配置/ });
    configTab.focus();
    fireEvent.keyDown(configTab, { key: 'ArrowRight' });

    const productTab = screen.getByRole('tab', { name: /^商品管理/ });
    expect(productTab).toHaveFocus();
    expect(productTab).toHaveAttribute('aria-selected', 'true');
    expect(productTab).toHaveAttribute('tabindex', '0');
    expect(configTab).toHaveAttribute('tabindex', '-1');
    await waitFor(() => {
      expect(screen.getByRole('tabpanel', { name: /^商品管理/ })).toHaveTextContent('商品管理');
    });
    expect(localStorage.getItem('settingsTab')).toBe('products');

    fireEvent.keyDown(productTab, { key: 'ArrowLeft' });
    expect(configTab).toHaveFocus();
    expect(configTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(configTab, { key: 'ArrowLeft' });
    const healthTab = screen.getByRole('tab', { name: /^健康监控/ });
    expect(healthTab).toHaveFocus();
    expect(healthTab).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => {
      expect(screen.getByRole('tabpanel', { name: /^健康监控/ })).toHaveTextContent('健康监控');
    });
  });

  it('supports Home and End keyboard navigation', async () => {
    render(<SettingsPanel shops={mockShops} />);
    await screen.findByText('系统配置管理');

    const configTab = screen.getByRole('tab', { name: /^系统配置/ });
    configTab.focus();
    fireEvent.keyDown(configTab, { key: 'End' });

    const healthTab = screen.getByRole('tab', { name: /^健康监控/ });
    expect(healthTab).toHaveFocus();
    expect(healthTab).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => {
      expect(screen.getByRole('tabpanel', { name: /^健康监控/ })).toHaveTextContent('健康监控');
    });

    fireEvent.keyDown(healthTab, { key: 'Home' });
    expect(configTab).toHaveFocus();
    expect(configTab).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => {
      expect(screen.getByRole('tabpanel', { name: /^系统配置/ })).toHaveTextContent('系统配置管理');
    });
  });
});
