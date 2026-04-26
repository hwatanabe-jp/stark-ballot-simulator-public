import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Badge } from './Badge';

describe('Badge', () => {
  it('should render children text', () => {
    render(<Badge>Badge text</Badge>);
    expect(screen.getByText('Badge text')).toBeInTheDocument();
  });

  it('should apply verified variant styles', () => {
    render(<Badge variant="verified">Verified</Badge>);
    const badge = screen.getByText('Verified');

    expect(badge).toHaveClass('bg-verified-100', 'text-verified-700', 'border-verified-500');
  });

  it('should apply error variant styles', () => {
    render(<Badge variant="error">Error</Badge>);
    const badge = screen.getByText('Error');

    expect(badge).toHaveClass('bg-error-100', 'text-error-700', 'border-error-500');
  });

  it('should apply warning variant styles', () => {
    render(<Badge variant="warning">Warning</Badge>);
    const badge = screen.getByText('Warning');

    expect(badge).toHaveClass('bg-warning-100', 'text-warning-700', 'border-warning-500');
  });

  it('should apply info variant styles', () => {
    render(<Badge variant="info">Info</Badge>);
    const badge = screen.getByText('Info');

    expect(badge).toHaveClass('bg-info-100', 'text-info-600', 'border-info-500');
  });

  it('should apply default variant styles', () => {
    render(<Badge variant="default">Default</Badge>);
    const badge = screen.getByText('Default');

    expect(badge).toHaveClass('bg-ink-100', 'text-ink-700', 'border-ink-300');
  });

  it('should render check icon for verified variant', () => {
    render(
      <Badge variant="verified" icon>
        Verified
      </Badge>,
    );

    expect(screen.getByTestId('badge-icon-verified')).toBeInTheDocument();
  });

  it('should render cross icon for error variant', () => {
    render(
      <Badge variant="error" icon>
        Error
      </Badge>,
    );

    expect(screen.getByTestId('badge-icon-error')).toBeInTheDocument();
  });

  it('should apply small size styles', () => {
    render(<Badge size="small">Small badge</Badge>);
    const badge = screen.getByText('Small badge');

    expect(badge).toHaveClass('text-xs', 'px-2', 'py-0.5');
  });

  it('should apply medium size styles by default', () => {
    render(<Badge>Medium badge</Badge>);
    const badge = screen.getByText('Medium badge');

    expect(badge).toHaveClass('px-3', 'py-1');
  });

  it('should apply large size styles', () => {
    render(<Badge size="large">Large badge</Badge>);
    const badge = screen.getByText('Large badge');

    expect(badge).toHaveClass('text-sm', 'px-4', 'py-1.5');
  });

  it('should apply custom className', () => {
    render(<Badge className="custom-class">Custom</Badge>);
    const badge = screen.getByText('Custom');

    expect(badge).toHaveClass('custom-class');
  });

  it('should have proper ARIA role', () => {
    render(<Badge variant="verified">Status</Badge>);
    const badge = screen.getByText('Status');

    expect(badge).toHaveAttribute('role', 'status');
  });

  it('should render as span by default', () => {
    render(<Badge>Badge</Badge>);
    const badge = screen.getByText('Badge');

    expect(badge.tagName).toBe('SPAN');
  });
});
