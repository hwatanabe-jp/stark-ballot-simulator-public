import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('prevents activation when disabled', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();

    render(
      <Button variant="secondary" disabled onClick={onClick}>
        Disabled button
      </Button>,
    );
    const button = screen.getByRole('button');

    expect(button).toBeDisabled();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('prevents activation and marks its spinner decorative while loading', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();

    render(
      <Button variant="verify" loading onClick={onClick}>
        Loading button
      </Button>,
    );
    const button = screen.getByRole('button');

    expect(button).toBeDisabled();
    expect(screen.getByTestId('loading-spinner')).toHaveAttribute('aria-hidden', 'true');
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
