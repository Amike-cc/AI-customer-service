import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { LlmProviderInfo, LlmProvidersResult } from '../../renderer/src/types/api';

jest.mock('lucide-react', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return new Proxy(
    { __esModule: true },
    {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target];
        const name = String(property);
        return (props: Record<string, unknown>) => React.createElement('span', { ...props, 'data-icon': name });
      },
    },
  );
});

import { LlmProvidersPanel } from '../../renderer/src/components/config/LlmProvidersPanel';

const providers: LlmProviderInfo[] = [
  {
    type: 'deepseek',
    label: 'DeepSeek',
    description: '默认推理模型',
    docsUrl: 'https://example.test/deepseek/docs',
    apiKeysUrl: 'https://example.test/deepseek/keys',
    enabled: true,
    tier: 'tier1',
    model: 'deepseek-chat',
    apiUrl: 'https://api.deepseek.test',
    timeoutMs: 30000,
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    anthropicVersion: null,
    apiKeyConfigured: true,
    registered: true,
    isDefault: true,
    hasOverride: true,
  },
  {
    type: 'qwen',
    label: '通义千问',
    description: '备用中文模型',
    docsUrl: 'https://example.test/qwen/docs',
    apiKeysUrl: 'https://example.test/qwen/keys',
    enabled: true,
    tier: 'tier2',
    model: 'qwen-plus',
    apiUrl: 'https://api.qwen.test',
    timeoutMs: 30000,
    apiKeyEnvVar: 'QWEN_API_KEY',
    anthropicVersion: null,
    apiKeyConfigured: true,
    registered: true,
    isDefault: false,
    hasOverride: true,
  },
  {
    type: 'openai',
    label: 'OpenAI',
    description: '尚未配置的模型',
    docsUrl: 'https://example.test/openai/docs',
    apiKeysUrl: 'https://example.test/openai/keys',
    enabled: false,
    tier: 'tier3',
    model: 'gpt-4o-mini',
    apiUrl: 'https://api.openai.test',
    timeoutMs: 30000,
    apiKeyEnvVar: 'OPENAI_API_KEY',
    anthropicVersion: null,
    apiKeyConfigured: false,
    registered: false,
    isDefault: false,
    hasOverride: false,
  },
];

const result: LlmProvidersResult = {
  ok: true,
  providers,
  defaultProvider: 'deepseek',
  cascade: {
    enabled: true,
    confidence_thresholds: { tier1: 0.5, tier2: 0.7, tier3: 0.9 },
    max_depth: 3,
  },
};

const getLlmProviders = jest.fn();
const updateLlmProvider = jest.fn();
const resetLlmProvider = jest.fn();
const setDefaultLlmProvider = jest.fn();

async function renderPanel(): Promise<void> {
  render(<LlmProvidersPanel />);
  await screen.findByRole('button', { name: '展开 DeepSeek 配置' });
}

describe('LlmProvidersPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getLlmProviders.mockResolvedValue(result);
    updateLlmProvider.mockResolvedValue({ ok: true, requiresRestart: true });
    resetLlmProvider.mockResolvedValue({ ok: true, requiresRestart: true });
    setDefaultLlmProvider.mockResolvedValue({ ok: true, requiresRestart: true });

    (window as any).api = {
      config: {
        getLlmProviders,
        updateLlmProvider,
        resetLlmProvider,
        setDefaultLlmProvider,
        updateLlmApiKey: jest.fn().mockResolvedValue({ ok: true }),
        testLlmProvider: jest.fn().mockResolvedValue({ ok: true, message: '连接成功', latencyMs: 20 }),
      },
      app: { openExternal: jest.fn().mockResolvedValue({ ok: true }) },
      view: {
        hideForModal: jest.fn().mockResolvedValue({ ok: true }),
        restoreAfterModal: jest.fn().mockResolvedValue({ ok: true }),
      },
    };
  });

  it('使用原生展开按钮、switch 和 radio，并暴露完整的焦点与 ARIA 状态', async () => {
    await renderPanel();

    const toggle = screen.getByRole('button', { name: '展开 DeepSeek 配置' });
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'llm-provider-deepseek-details');
    toggle.focus();
    expect(toggle).toHaveFocus();

    const enabledSwitch = screen.getByRole('switch', { name: 'DeepSeek Provider 启用状态' });
    expect(enabledSwitch.tagName).toBe('BUTTON');
    expect(enabledSwitch).toHaveAttribute('aria-checked', 'true');
    expect(enabledSwitch).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: '收起 DeepSeek 配置' })).toBeInTheDocument();

    const tier1 = screen.getByRole('radio', { name: 'Tier1·本地/低延迟' });
    const tier2 = screen.getByRole('radio', { name: 'Tier2·中等' });
    expect(tier1).toBeChecked();
    tier2.focus();
    expect(tier2).toHaveFocus();
    fireEvent.click(tier2);
    expect(tier2).toBeChecked();
    expect(tier1).not.toBeChecked();
  });

  it('阻止直接禁用当前默认 Provider，且不调用更新 IPC', async () => {
    await renderPanel();

    const enabledSwitch = screen.getByRole('switch', { name: 'DeepSeek Provider 启用状态' });
    enabledSwitch.focus();
    expect(enabledSwitch).toHaveFocus();
    fireEvent.click(enabledSwitch);

    expect(updateLlmProvider).not.toHaveBeenCalled();
    expect(screen.getByText('当前默认 Provider 不能直接禁用，请先将其他已启用 Provider 设为默认。')).toBeInTheDocument();
  });

  it('禁用非默认 Provider 前要求确认，并保持原有 IPC 参数', async () => {
    await renderPanel();

    fireEvent.click(screen.getByRole('switch', { name: '通义千问 Provider 启用状态' }));
    const dialog = await screen.findByRole('dialog', { name: '确认禁用 通义千问' });
    expect(updateLlmProvider).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: '确认禁用' }));
    await waitFor(() => {
      expect(updateLlmProvider).toHaveBeenCalledWith('qwen', { enabled: false });
    });
  });

  it('设为默认前要求确认，禁用或未配置的 Provider 保持不可用状态', async () => {
    await renderPanel();

    const qwenToggle = screen.getByRole('button', { name: '展开 通义千问 配置' });
    fireEvent.click(qwenToggle);
    const qwenCard = qwenToggle.closest('article');
    expect(qwenCard).not.toBeNull();
    fireEvent.click(within(qwenCard as HTMLElement).getByRole('button', { name: '设为默认' }));

    const dialog = await screen.findByRole('dialog', { name: '将 通义千问 设为默认 Provider？' });
    expect(setDefaultLlmProvider).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '设为默认' }));
    await waitFor(() => expect(setDefaultLlmProvider).toHaveBeenCalledWith('qwen'));

    const openAiToggle = screen.getByRole('button', { name: '展开 OpenAI 配置' });
    fireEvent.click(openAiToggle);
    const openAiCard = openAiToggle.closest('article');
    const unavailableDefault = within(openAiCard as HTMLElement).getByRole('button', { name: '设为默认' });
    expect(unavailableDefault).toHaveAttribute('aria-disabled', 'true');
    expect(unavailableDefault).toHaveAccessibleDescription('请先启用此 Provider，再将其设为默认。');
    fireEvent.click(unavailableDefault);
    expect(setDefaultLlmProvider).toHaveBeenCalledTimes(1);
  });

  it('重置覆盖配置前要求确认，无覆盖时禁用无效操作', async () => {
    await renderPanel();

    const qwenToggle = screen.getByRole('button', { name: '展开 通义千问 配置' });
    fireEvent.click(qwenToggle);
    const qwenCard = qwenToggle.closest('article');
    fireEvent.click(within(qwenCard as HTMLElement).getByRole('button', { name: '重置为默认' }));

    const dialog = await screen.findByRole('dialog', { name: '重置 通义千问 配置？' });
    expect(resetLlmProvider).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认重置' }));
    await waitFor(() => expect(resetLlmProvider).toHaveBeenCalledWith('qwen'));

    const openAiToggle = screen.getByRole('button', { name: '展开 OpenAI 配置' });
    fireEvent.click(openAiToggle);
    const openAiCard = openAiToggle.closest('article');
    expect(within(openAiCard as HTMLElement).getByRole('button', { name: '已是默认配置' })).toBeDisabled();
    expect(resetLlmProvider).toHaveBeenCalledTimes(1);
  });
});
