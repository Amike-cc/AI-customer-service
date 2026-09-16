import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ConfirmDialog } from '../../renderer/src/components/common/ConfirmDialog';

describe('ConfirmDialog', () => {
  const defaultProps = {
    open: true,
    title: '确认操作',
    message: '确定要执行此操作吗？',
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders title and message when open', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText('确认操作')).toBeInTheDocument();
    expect(screen.getByText('确定要执行此操作吗？')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<ConfirmDialog {...defaultProps} open={false} />);
    expect(screen.queryByText('确认操作')).not.toBeInTheDocument();
  });

  it('calls onConfirm when confirm button clicked', async () => {
    render(<ConfirmDialog {...defaultProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认' }));
    });
    expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when cancel button clicked', () => {
    render(<ConfirmDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('取消'));
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders custom button labels', () => {
    render(
      <ConfirmDialog
        {...defaultProps}
        confirmLabel="删除"
        cancelLabel="返回"
      />,
    );
    expect(screen.getByText('删除')).toBeInTheDocument();
    expect(screen.getByText('返回')).toBeInTheDocument();
  });

  it('applies the danger button variant', () => {
    render(<ConfirmDialog {...defaultProps} variant="danger" />);
    expect(screen.getByRole('button', { name: '确认' })).toHaveClass('danger');
  });

  it('disables closing and duplicate confirmation while an async action is pending', async () => {
    let resolveConfirm!: () => void;
    const onConfirm = jest.fn(() => new Promise<void>((resolve) => {
      resolveConfirm = resolve;
    }));
    const onCancel = jest.fn();
    render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} onCancel={onCancel} />);

    const confirmButton = screen.getByRole('button', { name: '确认' });
    const cancelButton = screen.getByRole('button', { name: '取消' });
    fireEvent.click(confirmButton);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirmButton).toBeDisabled();
    expect(confirmButton).toHaveAttribute('aria-busy', 'true');
    expect(cancelButton).toBeDisabled();

    fireEvent.click(confirmButton);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    await act(async () => {
      resolveConfirm();
    });
    await waitFor(() => expect(confirmButton).not.toBeDisabled());
    expect(confirmButton).not.toHaveAttribute('aria-busy');
  });
});
