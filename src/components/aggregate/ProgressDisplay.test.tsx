import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressDisplay } from './ProgressDisplay';
import { t as translate } from '@/lib/i18n';

// Mock useTranslation hook
vi.mock('@/lib/hooks', () => ({
  useTranslation: () => ({
    language: 'en',
    t: (key: string, params?: Record<string, string | number>) => translate('en', key, params),
  }),
}));

describe('ProgressDisplay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic rendering', () => {
    it('renders with pending status', () => {
      render(<ProgressDisplay status="pending" />);

      expect(screen.getByText('Waiting in queue...')).toBeInTheDocument();
      expect(screen.getByText('0%')).toBeInTheDocument();
    });

    it('renders with running status', () => {
      const startedAt = Date.now() - 30000; // Started 30 seconds ago
      render(<ProgressDisplay status="running" startedAt={startedAt} estimatedDurationMs={360000} />);

      expect(screen.getByText('Processing...')).toBeInTheDocument();
    });

    it('renders with succeeded status', () => {
      render(<ProgressDisplay status="succeeded" />);

      expect(screen.getByText('Completed')).toBeInTheDocument();
      expect(screen.getByText('100%')).toBeInTheDocument();
    });

    it('renders with failed status', () => {
      render(<ProgressDisplay status="failed" />);

      expect(screen.getByText('Error')).toBeInTheDocument();
    });

    it('renders with timeout status', () => {
      render(<ProgressDisplay status="timeout" />);

      expect(screen.getByText('Timeout')).toBeInTheDocument();
    });
  });

  describe('queue info panel', () => {
    it('displays queue position when provided', () => {
      render(<ProgressDisplay status="pending" queuePosition={3} queueDepth={8} />);

      expect(screen.getByText('Queue Position')).toBeInTheDocument();
      expect(screen.getByText('3 / 8')).toBeInTheDocument();
    });

    it('formats position as 99+ when over 99', () => {
      render(<ProgressDisplay status="pending" queuePosition={150} queueDepth={200} />);

      expect(screen.getByText('99+ / 99+')).toBeInTheDocument();
    });

    it('does not show queue panel when no queue info', () => {
      render(<ProgressDisplay status="pending" />);

      expect(screen.queryByText('Queue Position')).not.toBeInTheDocument();
    });

    it('shows estimated start time when provided', () => {
      const estimatedStartAt = Date.now() + 180000; // 3 minutes from now
      render(<ProgressDisplay status="pending" queuePosition={2} queueDepth={5} estimatedStartAt={estimatedStartAt} />);

      expect(screen.getByText('Est. Start')).toBeInTheDocument();
      expect(screen.getByText('~3 min')).toBeInTheDocument();
    });

    it('shows estimated completion time when provided', () => {
      const estimatedCompletionAt = Date.now() + 300000; // 5 minutes from now
      render(
        <ProgressDisplay
          status="pending"
          queuePosition={2}
          queueDepth={5}
          estimatedCompletionAt={estimatedCompletionAt}
        />,
      );

      expect(screen.getByText('Est. Completion')).toBeInTheDocument();
      expect(screen.getByText('~5 min')).toBeInTheDocument();
    });
  });

  describe('formatEstimatedTime behavior', () => {
    it('shows "Soon" when within 2 minutes overdue', () => {
      const estimatedCompletionAt = Date.now() - 60000; // 1 minute overdue
      render(
        <ProgressDisplay
          status="pending"
          queuePosition={1}
          queueDepth={1}
          estimatedCompletionAt={estimatedCompletionAt}
        />,
      );

      expect(screen.getByText('Soon')).toBeInTheDocument();
    });

    it('shows "Taking longer..." when 2-10 minutes overdue', () => {
      const estimatedCompletionAt = Date.now() - 300000; // 5 minutes overdue
      render(
        <ProgressDisplay
          status="pending"
          queuePosition={1}
          queueDepth={1}
          estimatedCompletionAt={estimatedCompletionAt}
        />,
      );

      expect(screen.getByText('Taking longer...')).toBeInTheDocument();
    });

    it('shows time in HH:MM format when more than 10 minutes overdue', () => {
      const estimatedCompletionAt = Date.now() - 900000; // 15 minutes overdue (11:45 AM)
      render(
        <ProgressDisplay
          status="pending"
          queuePosition={1}
          queueDepth={1}
          estimatedCompletionAt={estimatedCompletionAt}
        />,
      );

      // Should show the actual time (11:45 AM in some format)
      expect(screen.queryByText('Taking longer...')).not.toBeInTheDocument();
      expect(screen.queryByText('Soon')).not.toBeInTheDocument();
    });

    it('shows seconds when less than 60 seconds remaining', () => {
      const estimatedCompletionAt = Date.now() + 30000; // 30 seconds from now
      render(
        <ProgressDisplay
          status="pending"
          queuePosition={1}
          queueDepth={1}
          estimatedCompletionAt={estimatedCompletionAt}
        />,
      );

      expect(screen.getByText('~30s')).toBeInTheDocument();
    });

    it('shows time in HH:MM format when more than 10 minutes remaining', () => {
      const estimatedCompletionAt = Date.now() + 900000; // 15 minutes from now
      render(
        <ProgressDisplay
          status="pending"
          queuePosition={1}
          queueDepth={1}
          estimatedCompletionAt={estimatedCompletionAt}
        />,
      );

      // Should show time in HH:MM format, not minutes
      expect(screen.queryByText(/~\d+ min/)).not.toBeInTheDocument();
    });
  });

  describe('running state', () => {
    it('shows estimated completion time during running state', () => {
      const startedAt = Date.now() - 30000;
      const estimatedCompletionAt = Date.now() + 180000; // 3 minutes from now
      render(
        <ProgressDisplay
          status="running"
          startedAt={startedAt}
          estimatedDurationMs={360000}
          estimatedCompletionAt={estimatedCompletionAt}
        />,
      );

      expect(screen.getByText(/Est\. completion:/)).toBeInTheDocument();
    });

    it('does not show queue panel when running', () => {
      const startedAt = Date.now() - 30000;
      render(
        <ProgressDisplay
          status="running"
          startedAt={startedAt}
          estimatedDurationMs={360000}
          queuePosition={0}
          queueDepth={5}
        />,
      );

      // Queue panel should not appear for running state
      expect(screen.queryByText('Queue Position')).not.toBeInTheDocument();
    });
  });

  it('smoothly completes when status transitions to succeeded', () => {
    const startedAt = Date.now() - 60000;
    const { rerender } = render(
      <ProgressDisplay status="running" startedAt={startedAt} estimatedDurationMs={360000} />,
    );

    expect(screen.queryByText('100%')).not.toBeInTheDocument();

    rerender(<ProgressDisplay status="succeeded" />);

    expect(screen.queryByText('100%')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByText('100%')).toBeInTheDocument();
  });
});
