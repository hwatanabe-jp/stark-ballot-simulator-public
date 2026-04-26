import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ProgressBar } from './ProgressBar';

describe('ProgressBar', () => {
  it('should render with 0% progress', () => {
    render(<ProgressBar value={0} max={100} />);

    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuenow', '0');
    expect(progressbar).toHaveAttribute('aria-valuemin', '0');
    expect(progressbar).toHaveAttribute('aria-valuemax', '100');
  });

  it('should render with 50% progress', () => {
    render(<ProgressBar value={50} max={100} />);

    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuenow', '50');
  });

  it('should render with 100% progress', () => {
    render(<ProgressBar value={100} max={100} />);

    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuenow', '100');
  });

  it('should calculate percentage correctly', () => {
    render(<ProgressBar value={21} max={63} />);

    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuenow', '21');
    expect(progressbar).toHaveAttribute('aria-valuemax', '63');
  });

  it('should display label when provided', () => {
    render(<ProgressBar value={50} max={100} label="Loading..." />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('should display percentage when showPercentage is true', () => {
    render(<ProgressBar value={75} max={100} showPercentage />);

    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  it('should display custom format', () => {
    render(<ProgressBar value={21} max={63} showValue format={(value, max) => `${value}/${max} completed`} />);

    expect(screen.getByText('21/63 completed')).toBeInTheDocument();
  });

  it('should apply custom className', () => {
    render(<ProgressBar value={50} max={100} className="custom-class" />);

    const container = screen.getByRole('progressbar').parentElement;
    expect(container).toHaveClass('custom-class');
  });

  it('should apply different color variants', () => {
    const { rerender } = render(<ProgressBar value={50} max={100} variant="primary" />);

    let fill = screen.getByTestId('progress-fill');
    expect(fill).toHaveClass('from-ink-600', 'to-ink-500');

    rerender(<ProgressBar value={50} max={100} variant="verified" />);
    fill = screen.getByTestId('progress-fill');
    expect(fill).toHaveClass('from-verified-600', 'to-verified-500');

    rerender(<ProgressBar value={50} max={100} variant="warning" />);
    fill = screen.getByTestId('progress-fill');
    expect(fill).toHaveClass('from-warning-600', 'to-warning-500');
  });

  it('should handle animation prop', () => {
    const { rerender } = render(<ProgressBar value={50} max={100} animate />);

    const fill = screen.getByTestId('progress-fill');
    expect(fill).toHaveClass('transition-all', 'duration-300');

    rerender(<ProgressBar value={50} max={100} animate={false} />);
    expect(fill).not.toHaveClass('transition-all');
  });

  it('should have correct width style based on percentage', () => {
    render(<ProgressBar value={60} max={100} />);

    const fill = screen.getByTestId('progress-fill');
    expect(fill).toHaveStyle({ width: '60%' });
  });

  it('should handle edge case with 0 max value', () => {
    render(<ProgressBar value={0} max={0} />);

    const fill = screen.getByTestId('progress-fill');
    expect(fill).toHaveStyle({ width: '0%' });
  });
});
