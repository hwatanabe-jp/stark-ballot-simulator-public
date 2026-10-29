import { admitSessionIdentity } from '@stark-ballot/web/session/identity';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { t as translate } from '@stark-ballot/web/i18n';
import { LegalPageLayout } from './LegalPageLayout';

vi.mock('@stark-ballot/web/hooks/useLanguage', () => ({
  useLanguageOptional: () => ({
    language: 'en',
    setLanguage: () => {},
    isLoaded: true,
  }),
}));

vi.mock('@stark-ballot/web/session', () => ({
  getSessionData: vi.fn(),
}));

const sessionModule = await import('@stark-ballot/web/session');
const mockGetSessionData = vi.mocked(sessionModule.getSessionData);

describe('LegalPageLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the document introduction and only back to home link when no active session', async () => {
    mockGetSessionData.mockReturnValue(null);

    render(
      <LegalPageLayout
        document={{
          title: 'Terms',
          effectiveDate: '2026-01-20',
          effectiveDateLabel: 'Effective Date',
          intro: 'Introduction',
        }}
      >
        <p>Body</p>
      </LegalPageLayout>,
    );

    expect(screen.getByText('Introduction')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('legal-back-to-home')).toBeInTheDocument();
      expect(screen.queryByTestId('legal-close-tab')).not.toBeInTheDocument();
      expect(screen.queryByText(translate('en', 'legal.sessionNotice'))).not.toBeInTheDocument();
    });
  });

  it('shows both close tab button and back to home link when session is active', () => {
    mockGetSessionData.mockReturnValue({
      ...admitSessionIdentity({ sessionId: 'session-1', capabilityToken: 'test-capability-token' }),
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: `0x${'a'.repeat(64)}`,
      logId: `0x${'b'.repeat(64)}`,
      lastActivity: Date.now(),
      expiresAt: Date.now() + 60_000,
      phase: 'voting',
    });

    render(
      <LegalPageLayout
        document={{
          title: 'Terms',
          effectiveDate: '2026-01-20',
          effectiveDateLabel: 'Effective Date',
          intro: 'Introduction',
        }}
      >
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
      ...admitSessionIdentity({ sessionId: 'session-2', capabilityToken: 'test-capability-token' }),
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: `0x${'a'.repeat(64)}`,
      logId: `0x${'b'.repeat(64)}`,
      lastActivity: Date.now(),
      expiresAt: Date.now() + 60_000,
      phase: 'finalizing',
    });

    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});

    render(
      <LegalPageLayout
        document={{
          title: 'Privacy',
          effectiveDate: '2026-01-20',
          effectiveDateLabel: 'Effective Date',
          intro: 'Introduction',
        }}
      >
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
      <LegalPageLayout
        document={{
          title: 'Terms',
          effectiveDate: '2026-01-20',
          effectiveDateLabel: 'Effective Date',
          intro: 'Introduction',
        }}
      >
        <p>Body</p>
      </LegalPageLayout>,
    );

    // localStorage 失敗時は安全側にフォールバック（セッション有効とみなす）
    expect(screen.getByTestId('legal-close-tab')).toBeInTheDocument();
    expect(screen.getByTestId('legal-back-to-home')).toBeInTheDocument();
    expect(screen.getByText(translate('en', 'legal.sessionNotice'))).toBeInTheDocument();
  });
});
