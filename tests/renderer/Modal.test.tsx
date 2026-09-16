import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Modal } from '../../renderer/src/components/common/Modal';

function ModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>打开</button>
      <Modal open={open} onClose={() => setOpen(false)} title="测试弹窗">
        <button>确认</button>
      </Modal>
    </>
  );
}

describe('Modal accessibility', () => {
  it('exposes dialog semantics and restores focus after closing', () => {
    render(<ModalHarness />);
    const opener = screen.getByRole('button', { name: '打开' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: '测试弹窗' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
