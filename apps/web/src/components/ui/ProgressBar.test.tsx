import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ProgressBar } from './ProgressBar';

describe('ProgressBar', () => {
  it('exposes an accessible range and the calculated fill percentage', () => {
    render(<ProgressBar value={21} max={63} ariaLabel="集計中" />);

    const progressbar = screen.getByRole('progressbar', { name: '集計中' });
    expect(progressbar).toHaveAttribute('aria-valuenow', '21');
    expect(progressbar).toHaveAttribute('aria-valuemin', '0');
    expect(progressbar).toHaveAttribute('aria-valuemax', '63');
    expect(screen.getByTestId('progress-fill')).toHaveStyle({ width: '33%' });
  });

  it('renders a finite empty fill when the maximum is zero', () => {
    render(<ProgressBar value={0} max={0} />);

    expect(screen.getByTestId('progress-fill')).toHaveStyle({ width: '0%' });
  });
});
