import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { StepIndicatorHorizontal } from './StepIndicatorHorizontal';
import { usePathname } from 'next/navigation';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
}));

describe('StepIndicatorHorizontal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue('/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should render all steps in Japanese by default', () => {
    render(<StepIndicatorHorizontal />);

    expect(screen.getByText('ホーム')).toBeInTheDocument();
    expect(screen.getByText('投票')).toBeInTheDocument();
    expect(screen.getByText('集計')).toBeInTheDocument();
    expect(screen.getByText('結果')).toBeInTheDocument();
    expect(screen.getByText('検証')).toBeInTheDocument();
  });

  it('should render English labels when language is en', () => {
    render(<StepIndicatorHorizontal language="en" />);

    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Vote')).toBeInTheDocument();
    expect(screen.getByText('Aggregate')).toBeInTheDocument();
    expect(screen.getByText('Result')).toBeInTheDocument();
    expect(screen.getByText('Verify')).toBeInTheDocument();
  });

  it('should mark the current step as active', () => {
    vi.mocked(usePathname).mockReturnValue('/vote');

    render(<StepIndicatorHorizontal />);

    const voteLabel = screen.getByText('投票');
    const voteItem = voteLabel.closest('[data-step-id="vote"]');
    expect(voteItem).toHaveAttribute('data-status', 'active');
  });

  it('should mark completed steps based on current route', () => {
    vi.mocked(usePathname).mockReturnValue('/aggregate');

    render(<StepIndicatorHorizontal />);

    const completedItems = document.querySelectorAll('[data-status="completed"]');
    expect(completedItems).toHaveLength(2);
  });

  it('should treat nested verify routes as the verify step', () => {
    vi.mocked(usePathname).mockReturnValue('/verify/bot/12');

    render(<StepIndicatorHorizontal />);

    const verifyLabel = screen.getByText('検証');
    const verifyItem = verifyLabel.closest('[data-step-id="verify"]');
    expect(verifyItem).toHaveAttribute('data-status', 'active');
  });

  it('should treat nested result routes as the result step', () => {
    vi.mocked(usePathname).mockReturnValue('/result/summary');

    render(<StepIndicatorHorizontal />);

    const resultLabel = screen.getByText('結果');
    const resultItem = resultLabel.closest('[data-step-id="result"]');
    expect(resultItem).toHaveAttribute('data-status', 'active');
  });

  it('should render completed non-home steps as links', () => {
    vi.mocked(usePathname).mockReturnValue('/aggregate');

    render(<StepIndicatorHorizontal />);

    const voteLink = screen.getByRole('link', { name: '投票' });
    expect(voteLink).toHaveAttribute('href', '/vote');
  });

  it('should use language prop for reset confirmation', async () => {
    vi.mocked(usePathname).mockReturnValue('/aggregate');
    const onReset = vi.fn();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    const user = userEvent.setup();

    render(<StepIndicatorHorizontal language="en" onReset={onReset} />);

    await user.click(screen.getByRole('button', { name: 'Home' }));

    expect(window.confirm).toHaveBeenCalledWith('Start over from the beginning? All current progress will be lost.');
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
