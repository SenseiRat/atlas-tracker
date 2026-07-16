import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ConfirmProvider, useConfirm } from './ConfirmDialog';

function Harness({ onResult }: { onResult: (value: boolean) => void }) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      onClick={async () => {
        const result = await confirm({ title: 'Delete thing', message: 'Are you sure?' });
        onResult(result);
      }}
    >
      trigger
    </button>
  );
}

describe('ConfirmDialog', () => {
  it('resolves true when confirmed', async () => {
    const user = userEvent.setup();
    let result: boolean | null = null;
    render(
      <ConfirmProvider>
        <Harness onResult={(value) => (result = value)} />
      </ConfirmProvider>,
    );
    await user.click(screen.getByText('trigger'));
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(result).toBe(true));
  });

  it('resolves false when cancelled', async () => {
    const user = userEvent.setup();
    let result: boolean | null = null;
    render(
      <ConfirmProvider>
        <Harness onResult={(value) => (result = value)} />
      </ConfirmProvider>,
    );
    await user.click(screen.getByText('trigger'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(result).toBe(false));
  });
});
