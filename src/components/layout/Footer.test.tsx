import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Footer } from './Footer';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

vi.mock('@/lib/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'footer.terms': 'Terms of Use',
        'footer.privacy': 'Privacy Policy',
      };
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('@/lib/session', () => ({
  getSessionData: vi.fn(),
}));

const sessionModule = await import('@/lib/session');
const mockGetSessionData = vi.mocked(sessionModule.getSessionData);

describe('Footer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens legal links in same tab when no active session', async () => {
    mockGetSessionData.mockReturnValue(null);

    render(<Footer />);

    await waitFor(() => {
      const termsLink = screen.getByRole('link', { name: 'Terms of Use' });
      const privacyLink = screen.getByRole('link', { name: 'Privacy Policy' });
      expect(termsLink).not.toHaveAttribute('target');
      expect(privacyLink).not.toHaveAttribute('target');
    });
  });

  it('opens legal links in new tab when session is active', () => {
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      phase: 'voting',
    });

    render(<Footer />);

    const termsLink = screen.getByRole('link', { name: 'Terms of Use' });
    expect(termsLink).toHaveAttribute('target', '_blank');
    expect(termsLink).toHaveAttribute('rel', 'noopener noreferrer');

    const privacyLink = screen.getByRole('link', { name: 'Privacy Policy' });
    expect(privacyLink).toHaveAttribute('target', '_blank');
    expect(privacyLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('falls back to new tab when localStorage throws', () => {
    mockGetSessionData.mockImplementation(() => {
      throw new Error('localStorage access denied');
    });

    render(<Footer />);

    // localStorage 失敗時は安全側にフォールバック（新規タブで開く）
    const termsLink = screen.getByRole('link', { name: 'Terms of Use' });
    expect(termsLink).toHaveAttribute('target', '_blank');

    const privacyLink = screen.getByRole('link', { name: 'Privacy Policy' });
    expect(privacyLink).toHaveAttribute('target', '_blank');
  });
});
