import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentPanel } from '../../renderer/src/components/analytics/AgentPanel';
import { ToastProvider } from '../../renderer/src/components/common/Toast';
import type { EscalationRecord, HumanAgent, QueueEntry, ShopListItem } from '../../renderer/src/types/api';

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

const agent: HumanAgent = {
  id: 'agent-1',
  shopId: shop.shopId,
  name: '坐席甲',
  status: 'available',
  activeChats: 1,
  maxChats: 4,
  skills: ['售后'],
  lastAssignedAt: now - 60_000,
  detectedAt: now - 120_000,
  updatedAt: now - 60_000,
};

const escalation: EscalationRecord = {
  id: 7,
  shopId: shop.shopId,
  sessionId: 'session-1234567890',
  reason: '买家要求人工处理退款',
  priority: 'high',
  status: 'pending',
  requiredSkills: ['售后'],
  createdAt: now - 30_000,
};

const queueEntry: QueueEntry = {
  escalationId: escalation.id,
  shopId: shop.shopId,
  sessionId: escalation.sessionId,
  priority: escalation.priority,
  reason: escalation.reason,
  requiredSkills: escalation.requiredSkills,
  enqueuedAt: escalation.createdAt,
  estimatedWaitMs: 45_000,
};

function renderPanel(apiOverrides: Record<string, unknown> = {}) {
  const api = {
    agent: {
      list: jest.fn().mockResolvedValue([agent]),
      queue: jest.fn().mockResolvedValue([queueEntry]),
      refresh: jest.fn().mockResolvedValue({ ok: true, agents: [agent] }),
      assign: jest.fn().mockResolvedValue({ ok: true }),
    },
    escalation: {
      list: jest.fn().mockResolvedValue([escalation]),
      resolve: jest.fn().mockResolvedValue({ ok: true }),
    },
    ...apiOverrides,
  };
  (window as any).api = api;

  render(
    <ToastProvider>
      <AgentPanel shops={[shop]} />
    </ToastProvider>,
  );

  return api;
}

describe('AgentPanel', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('provides responsive toolbar labels and accessible table structure', async () => {
    renderPanel();

    expect(await screen.findByText('坐席甲')).toBeInTheDocument();
    expect(screen.getByLabelText('人工坐席店铺')).toHaveValue(shop.shopId);
    expect(screen.getByRole('group', { name: '人工坐席数据工具栏' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新测试店铺的人工坐席数据' })).toBeEnabled();

    const caption = screen.getByText('测试店铺的人工坐席列表，共 1 人', {
      selector: 'caption',
    });
    expect(caption).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '名称' })).toHaveAttribute('scope', 'col');
    expect(screen.getByRole('rowheader', { name: '坐席甲' })).toHaveAttribute('scope', 'row');
    expect(screen.getByRole('region', { name: '人工坐席列表，可横向滚动' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('progressbar', { name: '坐席甲的会话负载' })).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByText(/最近更新/)).toContainHTML('<time');
  });

  it('requires confirmation and prevents duplicate resolve requests for the pending row', async () => {
    let finishResolve!: (value: { ok: boolean }) => void;
    const resolve = jest.fn(
      () =>
        new Promise<{ ok: boolean }>((resolvePromise) => {
          finishResolve = resolvePromise;
        }),
    );
    renderPanel({
      escalation: {
        list: jest.fn().mockResolvedValue([escalation]),
        resolve,
      },
    });

    const resolveRowButton = await screen.findByRole('button', {
      name: '解决升级工单 #7',
    });
    fireEvent.click(resolveRowButton);

    const dialog = screen.getByRole('dialog', { name: '确认解决升级工单' });
    expect(resolve).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/将从待处理列表移除/)).toBeInTheDocument();

    const confirmButton = within(dialog).getByRole('button', { name: '确认解决' });
    fireEvent.click(confirmButton);

    expect(resolve).toHaveBeenCalledWith(escalation.id, '手动确认问题已解决');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(confirmButton).toBeDisabled();
    expect(resolveRowButton).toBeDisabled();
    expect(resolveRowButton).toHaveAttribute('aria-busy', 'true');

    fireEvent.click(confirmButton);
    fireEvent.click(resolveRowButton);
    expect(resolve).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishResolve({ ok: true });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '确认解决升级工单' })).not.toBeInTheDocument();
    });
  });

  it('assigns a pending escalation to the selected available agent', async () => {
    const api = renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: '分配升级工单 #7' }));
    const dialog = screen.getByRole('dialog', { name: '分配客服' });
    fireEvent.change(within(dialog).getByLabelText('选择空闲客服分配给升级工单 #7'), {
      target: { value: agent.id },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认分配' }));

    await waitFor(() => {
      expect(api.agent.assign).toHaveBeenCalledWith(escalation.id, agent.id);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '分配客服' })).not.toBeInTheDocument();
    });
  });

  it('disables unsupported manual assignment and explains empty filtered states', async () => {
    const agentApi = {
      list: jest.fn().mockResolvedValue([]),
      queue: jest.fn().mockResolvedValue([]),
      refresh: jest.fn().mockResolvedValue({ ok: true, agents: [] }),
    };
    renderPanel({
      agent: agentApi,
      escalation: {
        list: jest.fn().mockResolvedValue([escalation]),
        resolve: jest.fn().mockResolvedValue({ ok: true }),
      },
    });

    expect(await screen.findByText('当前版本暂未启用手动分配；你仍可确认问题后将工单标记为已解决。')).toHaveAttribute(
      'role',
      'note',
    );
    expect(screen.getByRole('button', { name: '分配升级工单 #7' })).toBeDisabled();
    expect(screen.getByText('当前店铺暂无坐席记录。点击“刷新数据”重新加载。')).toBeInTheDocument();
    expect(screen.getByText('当前店铺暂无实时排队会话。')).toBeInTheDocument();
  });
});
