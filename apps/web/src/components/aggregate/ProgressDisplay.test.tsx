import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressDisplay } from './ProgressDisplay';
import { t as translate, type TranslationKey, type TranslationParams } from '@stark-ballot/web/i18n';

// Mock useTranslation hook
vi.mock('@stark-ballot/web/hooks', () => ({
  useTranslation: () => ({
    language: 'en',
    t: (key: TranslationKey, params?: TranslationParams) => translate('en', key, params),
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
    it('renders pending status without queue details when queue info is absent', () => {
      render(<ProgressDisplay status="pending" />);

      expect(screen.getByText('Waiting in queue...')).toBeInTheDocument();
      expect(screen.getByText('0%')).toBeInTheDocument();
      expect(screen.queryByText('Queue Position')).not.toBeInTheDocument();
      expect(screen.queryByText('Typical duration')).not.toBeInTheDocument();
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
    it('displays typical duration without capacity or positional claims', () => {
      render(<ProgressDisplay status="pending" concurrencyLimit={2} estimatedDurationMs={360000} />);

      expect(screen.getByText('Waiting')).toBeInTheDocument();
      expect(screen.getByText('Typical duration')).toBeInTheDocument();
      expect(screen.getByText('~6 min')).toBeInTheDocument();
      expect(screen.queryByText('Queue Position')).not.toBeInTheDocument();
      expect(screen.queryByText(/position in queue/i)).not.toBeInTheDocument();
    });
  });

  describe('running state', () => {
    it('does not show queue panel when running', () => {
      const startedAt = Date.now() - 30000;
      render(
        <ProgressDisplay status="running" startedAt={startedAt} estimatedDurationMs={360000} concurrencyLimit={2} />,
      );

      // Queue panel should not appear for running state
      expect(screen.queryByText('Queue Position')).not.toBeInTheDocument();
      expect(screen.queryByText('Typical duration')).not.toBeInTheDocument();
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
