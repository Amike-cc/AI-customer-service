import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { EmptyState } from '../../renderer/src/components/common/EmptyState';

describe('EmptyState', () => {
  it('renders message text', () => {
    render(<EmptyState message="请选择店铺" />);
    expect(screen.getByText('请选择店铺')).toBeInTheDocument();
  });

  it('renders title when provided', () => {
    render(<EmptyState title="未选择店铺" />);
    expect(screen.getByText('未选择店铺')).toBeInTheDocument();
  });

  it('uses message as supporting text when title is provided', () => {
    render(<EmptyState title="未选择店铺" message="请先从左侧选择一个店铺" />);
    expect(screen.getByText('未选择店铺')).toBeInTheDocument();
    expect(screen.getByText('请先从左侧选择一个店铺')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<EmptyState title="标题" description="描述内容" message="后备内容" />);
    expect(screen.getByText('描述内容')).toBeInTheDocument();
    expect(screen.queryByText('后备内容')).not.toBeInTheDocument();
  });

  it('renders custom icon', () => {
    render(<EmptyState title="测试" icon={<span data-testid="custom-icon">*</span>} />);
    expect(screen.getByTestId('custom-icon')).toBeInTheDocument();
  });

  it('renders action element', () => {
    render(
      <EmptyState
        title="测试"
        action={<button data-testid="action-btn">操作</button>}
      />,
    );
    expect(screen.getByTestId('action-btn')).toBeInTheDocument();
  });

  it('renders default icon when no icon provided', () => {
    render(<EmptyState title="测试" />);
    expect(screen.getByTestId('icon-Inbox')).toBeInTheDocument();
  });
});
