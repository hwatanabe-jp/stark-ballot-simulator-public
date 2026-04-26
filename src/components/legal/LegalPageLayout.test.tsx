import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { t as translate } from '@/lib/i18n';
import { LegalPageLayout } from './LegalPageLayout';

vi.mock('@/lib/hooks/useLanguage', () => ({
  useLanguageOptional: () => ({
    language: 'en',
    setLanguage: () => {},
    isLoaded: true,
  }),
}));

vi.mock('@/lib/session', () => ({
  getSessionData: vi.fn(),
}));

const sessionModule = await import('@/lib/session');
const mockGetSessionData = vi.mocked(sessionModule.getSessionData);

describe('LegalPageLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows only back to home link when no active session', async () => {
    mockGetSessionData.mockReturnValue(null);

    render(
      <LegalPageLayout title="Terms" effectiveDate="2026-01-20" effectiveDateLabel="Effective Date">
        <p>Body</p>
      </LegalPageLayout>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('legal-back-to-home')).toBeInTheDocument();
      expect(screen.queryByTestId('legal-close-tab')).not.toBeInTheDocument();
      expect(screen.queryByText(translate('en', 'legal.sessionNotice'))).not.toBeInTheDocument();
    });
  });

  it('shows both close tab button and back to home link when session is active', () => {
    mockGetSessionData.mockReturnValue({
      sessionId: 'session-1',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      phase: 'voting',
    });

    render(
      <LegalPageLayout title="Terms" effectiveDate="2026-01-20" effectiveDateLabel="Effective Date">
        <p>Body</p>
      </LegalPageLayout>,
    );

    // セッション有効時は両方表示される
    expect(screen.getByTestId('legal-close-tab')).toBeInTheDocument();
    expect(screen.getByTestId('legal-back-to-home')).toBeInTheDocument();
    expect(screen.getByText(translate('en', 'legal.sessionNotice'))).toBeInTheDocument();
    expect(screen.getByText(translate('en', 'legal.closeTabHint'))).toBeInTheDocument();
  });

  it('triggers window.close from the close tab button', () => {
    mockGetSessionData.mockReturnValue({
      sessionId: 'session-2',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      phase: 'verifying',
    });

    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});

    render(
      <LegalPageLayout title="Privacy" effectiveDate="2026-01-20" effectiveDateLabel="Effective Date">
        <p>Body</p>
      </LegalPageLayout>,
    );

    const closeButton = screen.getByTestId('legal-close-tab');
    closeButton.click();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to active session when localStorage throws', () => {
    mockGetSessionData.mockImplementation(() => {
      throw new Error('localStorage access denied');
    });

    render(
      <LegalPageLayout title="Terms" effectiveDate="2026-01-20" effectiveDateLabel="Effective Date">
        <p>Body</p>
      </LegalPageLayout>,
    );

    // localStorage 失敗時は安全側にフォールバック（セッション有効とみなす）
    expect(screen.getByTestId('legal-close-tab')).toBeInTheDocument();
    expect(screen.getByTestId('legal-back-to-home')).toBeInTheDocument();
    expect(screen.getByText(translate('en', 'legal.sessionNotice'))).toBeInTheDocument();
  });
});
