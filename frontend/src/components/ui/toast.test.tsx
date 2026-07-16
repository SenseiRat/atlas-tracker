import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ToastProvider, useToasts } from './toast';

function Pusher() {
  const { pushToast } = useToasts();
  return (
    <button type="button" onClick={() => pushToast('Saved successfully', 'success')}>
      push
    </button>
  );
}

describe('toast', () => {
  it('renders a pushed toast and dismisses it via the close button', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    await user.click(screen.getByText('push'));
    expect(screen.getByText('Saved successfully')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /dismiss notification/i }));
    await waitFor(() => expect(screen.queryByText('Saved successfully')).toBeNull());
  });

  it('exposes an aria-live region', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    await user.click(screen.getByText('push'));
    expect(screen.getByRole('region', { name: /notifications/i })).toHaveAttribute('aria-live', 'polite');
  });
});
