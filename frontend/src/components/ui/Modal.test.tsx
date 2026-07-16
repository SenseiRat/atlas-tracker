import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Modal } from './Modal';

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        opener
      </button>
      <Modal open={open} onClose={() => setOpen(false)} ariaLabel="Test dialog">
        <button type="button">first</button>
        <button type="button">second</button>
      </Modal>
    </>
  );
}

describe('Modal', () => {
  it('renders with dialog semantics when open', () => {
    render(
      <Modal open onClose={() => {}} ariaLabel="Hello">
        <button type="button">ok</button>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Hello');
  });

  it('does not render when closed', () => {
    render(
      <Modal open={false} onClose={() => {}} ariaLabel="Hidden">
        <button type="button">ok</button>
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape', async () => {
    render(<Harness />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('moves focus into the dialog on open', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByText('first')).toHaveFocus());
  });

  it('traps Tab focus within the dialog', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByText('first')).toHaveFocus());
    // Shift+Tab from the first focusable should wrap to the last one.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByText('second')).toHaveFocus();
  });
});
