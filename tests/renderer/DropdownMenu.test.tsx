import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DropdownMenu } from '../../renderer/src/components/common/DropdownMenu';

describe('DropdownMenu', () => {
  beforeAll(() => {
    const browserGlobal = globalThis as any;
    if (!browserGlobal.requestAnimationFrame) {
      browserGlobal.requestAnimationFrame = (callback: (timestamp: number) => void) =>
        setTimeout(() => callback(0), 0);
    }
    if (!browserGlobal.cancelAnimationFrame) {
      browserGlobal.cancelAnimationFrame = (handle: ReturnType<typeof setTimeout>) =>
        clearTimeout(handle);
    }
  });

  it('exposes menu aria state and supports keyboard focus navigation', async () => {
    const onEdit = jest.fn();
    const onDelete = jest.fn();
    render(
      <DropdownMenu
        label="店铺操作"
        trigger={<span aria-hidden="true">⋮</span>}
        items={[
          { label: '编辑', onClick: onEdit },
          { label: '不可用', onClick: jest.fn(), disabled: true },
          { label: '删除', onClick: onDelete, danger: true },
        ]}
      />,
    );

    const trigger = screen.getByRole('button', { name: '店铺操作' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);

    const menu = screen.getByRole('menu', { name: '店铺操作' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', menu.id);
    expect(screen.getByRole('menuitem', { name: '不可用' })).toBeDisabled();

    const editItem = screen.getByRole('menuitem', { name: '编辑' });
    const deleteItem = screen.getByRole('menuitem', { name: '删除' });
    await waitFor(() => expect(editItem).toHaveFocus());

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(deleteItem).toHaveFocus();
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(editItem).toHaveFocus();
    fireEvent.keyDown(document, { key: 'End' });
    expect(deleteItem).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Home' });
    expect(editItem).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('invokes an enabled item once and closes the menu', () => {
    const onSelect = jest.fn();
    render(
      <DropdownMenu
        label="更多操作"
        trigger={<span aria-hidden="true">⋮</span>}
        items={[{ label: '重命名', onClick: onSelect }]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
