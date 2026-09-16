import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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

import { TemplatePanel } from '../../renderer/src/components/knowledge/TemplatePanel';

describe('TemplatePanel', () => {
  const listTemplates = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    listTemplates.mockResolvedValue([]);
    (window as any).api = {
      kb: {
        listTemplates,
        getCategoryStats: jest.fn().mockResolvedValue([]),
        recommendTemplates: jest.fn().mockResolvedValue([]),
      },
    };
  });

  it('分类变化后立即使用新分类加载，不再慢一拍', async () => {
    render(<TemplatePanel shopId="shop-a" />);

    const categorySelect = await screen.findByRole('combobox', { name: '话术模板分类筛选' });
    await waitFor(() => {
      expect(listTemplates).toHaveBeenCalledWith('shop-a', undefined);
    });
    listTemplates.mockClear();

    fireEvent.change(categorySelect, { target: { value: 'after_sales' } });

    await waitFor(() => {
      expect(listTemplates).toHaveBeenCalledWith('shop-a', 'after_sales');
    });
    expect(listTemplates).not.toHaveBeenCalledWith('shop-a', undefined);
  });
});
