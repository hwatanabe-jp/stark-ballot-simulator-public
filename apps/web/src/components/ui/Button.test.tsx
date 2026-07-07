import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('should render children text', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button')).toHaveTextContent('Click me');
  });

  it('should handle click events', async () => {
    const handleClick = vi.fn();
    const user = userEvent.setup();

    render(<Button onClick={handleClick}>Click me</Button>);
    await user.click(screen.getByRole('button'));

    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('should apply primary variant styles by default', () => {
    render(<Button>Primary button</Button>);
    const button = screen.getByRole('button');

    expect(button).toHaveClass('bg-ink-700', 'text-paper-white');
  });

  it('should apply secondary variant styles when specified', () => {
    render(<Button variant="secondary">Secondary button</Button>);
    const button = screen.getByRole('button');

    expect(button).toHaveClass('bg-paper-cream', 'text-ink-700', 'border-ink-300');
  });

  it('should be disabled when disabled prop is true', () => {
    render(<Button disabled>Disabled button</Button>);
    const button = screen.getByRole('button');

    expect(button).toBeDisabled();
    expect(button).toHaveClass('opacity-50', 'cursor-not-allowed');
  });

  it('should not call onClick when disabled', async () => {
    const handleClick = vi.fn();
    const user = userEvent.setup();

    render(
      <Button disabled onClick={handleClick}>
        Disabled button
      </Button>,
    );
    await user.click(screen.getByRole('button'));

    expect(handleClick).not.toHaveBeenCalled();
  });

  it('should show loading state with spinner', () => {
    render(<Button loading>Loading button</Button>);
    const button = screen.getByRole('button');

    expect(button).toBeDisabled();
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('should apply full width styles when fullWidth is true', () => {
    render(<Button fullWidth>Full width button</Button>);
    const button = screen.getByRole('button');

    expect(button).toHaveClass('w-full');
  });

  it('should pass through additional className', () => {
    render(<Button className="custom-class">Custom button</Button>);
    const button = screen.getByRole('button');

    expect(button).toHaveClass('custom-class');
  });

  it('should support different button types', () => {
    render(<Button type="submit">Submit button</Button>);
    const button = screen.getByRole('button');

    expect(button).toHaveAttribute('type', 'submit');
  });
});
