import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LayoutProvider } from './LayoutProvider';
import { useLanguage } from '@stark-ballot/web/hooks';
import { useVerificationTab } from '@stark-ballot/web/components/knowledge';
import { clearKnowledge, VERIFY_BOT_KNOWLEDGE_KEYS, VERIFY_MY_KNOWLEDGE_KEYS } from '@stark-ballot/web/knowledge';
import { clearSession } from '@stark-ballot/web/session';
import { useAppPathname } from '@stark-ballot/web/navigation/appNavigation';

const { push, setActiveTab } = vi.hoisted(() => ({ push: vi.fn(), setActiveTab: vi.fn() }));

vi.mock('@stark-ballot/web/navigation/appNavigation', () => ({
  AppLink: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useAppRouter: () => ({ push }),
  useAppPathname: vi.fn(),
}));

vi.mock('@stark-ballot/web/components/step', () => ({
  StepIndicatorHorizontal: ({ language }: { language: string }) => (
    <div data-testid="step-indicator" data-language={language}>
      Step Indicator
    </div>
  ),
}));

vi.mock('@stark-ballot/web/components/layout/Header', () => ({
  Header: ({ showReset = true, onReset }: { showReset?: boolean; onReset: () => void }) => (
    <header data-testid="header" data-show-reset={showReset ? 'true' : 'false'}>
      {showReset && <button onClick={onReset}>Reset</button>}
    </header>
  ),
}));

vi.mock('@stark-ballot/web/components/layout/Footer', () => ({
  Footer: () => <footer data-testid="footer">Footer</footer>,
}));

vi.mock('@stark-ballot/web/components/knowledge', () => ({
  KnowledgePanel: ({ filterKeys }: { filterKeys?: readonly string[] }) => (
    <aside data-testid="knowledge-panel" data-filter-keys={filterKeys?.join(',')}>
      Knowledge Panel
    </aside>
  ),
  KnowledgeHighlightProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  VerificationTabProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useVerificationTab: vi.fn(),
}));

vi.mock('@stark-ballot/web/knowledge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stark-ballot/web/knowledge')>();
  return { ...actual, clearKnowledge: vi.fn() };
});

vi.mock('@stark-ballot/web/session', () => ({ clearSession: vi.fn() }));
vi.mock('@stark-ballot/web/hooks', () => ({ useLanguage: vi.fn() }));

const visibleKeys = () => screen.getByTestId('knowledge-panel').getAttribute('data-filter-keys')?.split(',') ?? [];

describe('LayoutProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAppPathname).mockReturnValue('/vote');
    vi.mocked(useLanguage).mockReturnValue({ language: 'ja', setLanguage: vi.fn(), isLoaded: true });
    vi.mocked(useVerificationTab).mockReturnValue({ activeTab: 'my', setActiveTab });
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('passes the active language to the step indicator and document', () => {
    const originalLang = document.documentElement.lang;
    vi.mocked(useLanguage).mockReturnValue({ language: 'en', setLanguage: vi.fn(), isLoaded: true });
    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    expect(screen.getByTestId('step-indicator')).toHaveAttribute('data-language', 'en');
    expect(document.documentElement.lang).toBe('en');
    document.documentElement.lang = originalLang;
  });

  it('places one knowledge panel after page content and before the footer', () => {
    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    const panel = screen.getByTestId('knowledge-panel');
    const content = screen.getByText('Content');
    const footer = screen.getByTestId('footer');
    expect(screen.getAllByTestId('knowledge-panel')).toHaveLength(1);
    expect(panel.closest('main')).toBe(screen.getByRole('main'));
    expect(content.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the knowledge panel mounted when the viewport and active route change', () => {
    const { rerender } = render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );
    const panel = screen.getByTestId('knowledge-panel');

    fireEvent.resize(window);
    vi.mocked(useAppPathname).mockReturnValue('/result');
    rerender(
      <LayoutProvider>
        <div>Result</div>
      </LayoutProvider>,
    );

    expect(screen.getByTestId('knowledge-panel')).toBe(panel);
    expect(visibleKeys()).toContain('tally.counts');
  });

  it('keeps the home page free of progress and knowledge panels and clears prior knowledge', () => {
    vi.mocked(useAppPathname).mockReturnValue('/');
    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    expect(screen.queryByTestId('step-indicator')).not.toBeInTheDocument();
    expect(screen.queryByTestId('knowledge-panel')).not.toBeInTheDocument();
    expect(clearKnowledge).toHaveBeenCalledOnce();
    expect(setActiveTab).toHaveBeenCalledWith('my');
  });

  it.each(['/privacy', '/terms', '/privacy/details', '/terms/details'])('hides voting controls on %s', (path) => {
    vi.mocked(useAppPathname).mockReturnValue(path);
    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    expect(screen.getByTestId('header')).toHaveAttribute('data-show-reset', 'false');
    expect(screen.queryByTestId('step-indicator')).not.toBeInTheDocument();
    expect(screen.queryByTestId('knowledge-panel')).not.toBeInTheDocument();
  });

  it.each(['/vote', '/aggregate'])('limits %s knowledge to session and vote data', (path) => {
    vi.mocked(useAppPathname).mockReturnValue(path);
    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    expect(visibleKeys()).toEqual(expect.arrayContaining(['electionId', 'user.choice', 'user.commitment']));
    expect(visibleKeys()).not.toContain('tally.counts');
    expect(visibleKeys()).not.toContain('user.voteReceipt');
    expect(visibleKeys()).not.toContain('user.merklePath');
  });

  it('adds public result knowledge without verification-only receipts', () => {
    vi.mocked(useAppPathname).mockReturnValue('/result');
    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    expect(visibleKeys()).toEqual(expect.arrayContaining(['tally.counts', 'proofBundleStatus']));
    expect(visibleKeys()).not.toContain('user.voteReceipt');
    expect(visibleKeys()).not.toContain('user.merklePath');
  });

  it.each(['/verify', '/verify/details'])('uses the active verification tab visibility on %s', (path) => {
    vi.mocked(useAppPathname).mockReturnValue(path);
    const { rerender } = render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );
    expect(visibleKeys()).toEqual(VERIFY_MY_KNOWLEDGE_KEYS);

    vi.mocked(useVerificationTab).mockReturnValue({ activeTab: 'bot', setActiveTab });
    rerender(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );
    expect(visibleKeys()).toEqual(VERIFY_BOT_KNOWLEDGE_KEYS);
  });

  it('clears session and knowledge before returning home through reset', () => {
    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    expect(clearSession).toHaveBeenCalledOnce();
    expect(clearKnowledge).toHaveBeenCalledOnce();
    expect(setActiveTab).toHaveBeenCalledWith('my');
    expect(push).toHaveBeenCalledWith('/');
  });

  it('scrolls to top on route change', () => {
    const { rerender } = render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );
    expect(window.scrollTo).not.toHaveBeenCalled();

    vi.mocked(useAppPathname).mockReturnValue('/aggregate');
    rerender(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
  });
});
