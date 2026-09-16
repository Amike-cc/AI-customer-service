import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ShopListItem } from '../../renderer/src/types/api';

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

jest.mock('../../renderer/src/components/knowledge/VersionPanel', () => ({
  VersionPanel: () => <div>版本测试面板</div>,
}));
jest.mock('../../renderer/src/components/knowledge/AccuracyPanel', () => ({
  AccuracyPanel: () => <div>准确率测试面板</div>,
}));
jest.mock('../../renderer/src/components/knowledge/ReviewPanel', () => ({
  ReviewPanel: () => <div>审核测试面板</div>,
}));
jest.mock('../../renderer/src/components/knowledge/TemplatePanel', () => ({
  TemplatePanel: () => <div>模板测试面板</div>,
}));

import { KnowledgeBase } from '../../renderer/src/components/knowledge/KnowledgeBase';

const shops: ShopListItem[] = [
  {
    shopId: 'shop-a',
    shopName: '店铺 A',
    platform: 'feige',
    enabled: true,
    autoReply: true,
    loginStatus: 'logged_in',
    lastLoginAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: 'Healthy',
    stateRecord: {},
  },
  {
    shopId: 'shop-b',
    shopName: '店铺 B',
    platform: 'pinduoduo',
    enabled: true,
    autoReply: true,
    loginStatus: 'logged_in',
    lastLoginAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: 'Healthy',
    stateRecord: {},
  },
];

const faqList = jest.fn();
const faqUpdate = jest.fn();
const faqDelete = jest.fn();

function installApiMock(): void {
  faqList.mockResolvedValue([
    { q: '通用问题', a: '通用回复', priority: 50, category: 'general', tags: [] },
    { q: '售后问题', a: '售后回复', priority: 80, category: 'after_sales', tags: ['售后'] },
  ]);
  faqUpdate.mockResolvedValue({ ok: true });
  faqDelete.mockResolvedValue({ ok: true });

  (window as any).api = {
    rule: { list: jest.fn().mockResolvedValue([]) },
    faq: {
      list: faqList,
      add: jest.fn().mockResolvedValue({ ok: true }),
      update: faqUpdate,
      delete: faqDelete,
    },
    kb: {
      getSensitiveWords: jest.fn().mockResolvedValue([]),
      getPrompt: jest.fn().mockResolvedValue(''),
      getCategoryStats: jest.fn().mockResolvedValue([]),
      getAccuracyStats: jest.fn().mockResolvedValue(null),
      listPendingReviews: jest.fn().mockResolvedValue([]),
      exportKnowledge: jest.fn().mockResolvedValue('{}'),
      importKnowledge: jest.fn().mockResolvedValue({ imported: 0 }),
    },
    product: {
      getSyncStatus: jest.fn().mockResolvedValue(null),
    },
  };
}

async function openFilteredFaqPanel(): Promise<void> {
  const shopSelect = await screen.findByRole('combobox', { name: '知识库店铺' });
  await waitFor(() => expect(shopSelect).toHaveValue('shop-a'));
  fireEvent.click(screen.getByRole('tab', { name: /店铺 FAQ/ }));
  await screen.findByText('售后问题');
  fireEvent.change(screen.getByRole('combobox', { name: 'FAQ 分类筛选' }), {
    target: { value: 'after_sales' },
  });
  expect(screen.queryByText('通用问题')).not.toBeInTheDocument();
  expect(screen.getByText('售后问题')).toBeInTheDocument();
}

describe('KnowledgeBase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installApiMock();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('提供有标签的店铺选择器，并在当前店铺失效时回退到首个有效店铺', async () => {
    const { rerender } = render(<KnowledgeBase shops={shops} />);
    const select = await screen.findByRole('combobox', { name: '知识库店铺' });

    await waitFor(() => expect(select).toHaveValue('shop-a'));
    fireEvent.change(select, { target: { value: 'shop-b' } });
    expect(select).toHaveValue('shop-b');

    rerender(<KnowledgeBase shops={[shops[0]]} />);
    await waitFor(() => expect(select).toHaveValue('shop-a'));
  });

  it('分类筛选后编辑 FAQ 仍使用完整列表中的原始索引', async () => {
    render(<KnowledgeBase shops={shops} />);
    await openFilteredFaqPanel();

    fireEvent.click(screen.getByRole('button', { name: /编辑 FAQ 售后问题/ }));
    fireEvent.change(screen.getByDisplayValue('售后问题'), {
      target: { value: '售后问题已更新' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存 FAQ' }));

    await waitFor(() => {
      expect(faqUpdate).toHaveBeenCalledWith(
        'shop-a',
        1,
        expect.objectContaining({ q: '售后问题已更新', category: 'after_sales' }),
      );
    });
    expect((window as any).api.kb.listFaqsByCategory).toBeUndefined();
  });

  it('分类筛选后删除 FAQ 仍使用完整列表中的原始索引', async () => {
    render(<KnowledgeBase shops={shops} />);
    await openFilteredFaqPanel();

    fireEvent.click(screen.getByRole('button', { name: /删除 FAQ 售后问题/ }));
    fireEvent.click(screen.getByRole('button', { name: '删除 FAQ' }));

    await waitFor(() => {
      expect(faqDelete).toHaveBeenCalledWith('shop-a', 1);
    });
  });
});
