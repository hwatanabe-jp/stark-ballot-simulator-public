import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LayoutProvider } from './LayoutProvider';
import { useDockingPanel, useMediaQuery } from '@/lib/hooks';
import { usePathname } from 'next/navigation';

let footerHeightOverride: number | null = null;

const createRect = (height: number): DOMRect => {
  return {
    height,
    width: 0,
    top: 0,
    left: 0,
    bottom: height,
    right: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: vi.fn(() => '/'),
  useSearchParams: () => new URLSearchParams(),
}));

// Mock dependencies
vi.mock('@/components/step', () => ({
  StepIndicatorHorizontal: ({ language }: { language: string }) => (
    <div data-testid="step-indicator" data-language={language}>
      Step Indicator
    </div>
  ),
}));

vi.mock('@/components/layout/Header', () => ({
  Header: ({ showReset = true }: { showReset?: boolean }) => (
    <header data-testid="header" data-show-reset={showReset ? 'true' : 'false'}>
      Header
    </header>
  ),
}));

vi.mock('@/components/layout/Footer', async () => {
  const React = await import('react');
  const Footer = React.forwardRef<HTMLElement>((_props, ref) => {
    const setRef = (node: HTMLElement | null) => {
      const override = footerHeightOverride;
      if (node && override !== null) {
        node.getBoundingClientRect = () => createRect(override);
      }
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    };

    return (
      <footer ref={setRef} data-testid="footer">
        Footer
      </footer>
    );
  });
  Footer.displayName = 'Footer';
  return { Footer };
});

vi.mock('@/components/knowledge', () => ({
  KnowledgePanel: ({ variant }: { variant?: string }) => (
    <div data-testid="knowledge-panel" data-variant={variant}>
      Knowledge Panel
    </div>
  ),
  KnowledgeHighlightProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  VerificationTabProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useVerificationTab: () => ({ activeTab: 'my', setActiveTab: vi.fn() }),
}));

vi.mock('@/lib/knowledge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/knowledge')>();

  return {
    ...actual,
    clearKnowledge: vi.fn(),
  };
});

vi.mock('@/lib/hooks', () => ({
  useLanguage: vi.fn(() => ({ language: 'ja', setLanguage: vi.fn(), isLoaded: true })),
  useMediaQuery: vi.fn(() => false),
  useDockingPanel: vi.fn(() => ({
    isDocked: false,
    dockZoneRef: vi.fn(),
    panelRef: vi.fn(),
    isFloating: true,
    floatingPanelHeight: 0,
  })),
}));

describe('LayoutProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    footerHeightOverride = null;
  });

  it('should render step indicator and children', () => {
    render(
      <LayoutProvider>
        <div>Test Content</div>
      </LayoutProvider>,
    );

    expect(screen.getByTestId('step-indicator')).toBeInTheDocument();
    expect(screen.getByText('Test Content')).toBeInTheDocument();
  });

  it('should pass language to step indicator', () => {
    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    const stepIndicator = screen.getByTestId('step-indicator');
    expect(stepIndicator).toHaveAttribute('data-language', 'ja');
  });

  it('should have proper layout structure', () => {
    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    const main = screen.getByRole('main');
    expect(main).toBeInTheDocument();
  });

  it('should use bottom sheet variant on mobile', () => {
    vi.mocked(useMediaQuery).mockReturnValue(true);
    vi.mocked(usePathname).mockReturnValue('/vote');

    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    const knowledgePanel = screen.getByTestId('knowledge-panel');
    expect(knowledgePanel).toHaveAttribute('data-variant', 'bottomSheet');
  });

  it('adds a mobile footer spacer when the bottom sheet is visible', () => {
    vi.mocked(useMediaQuery).mockReturnValue(true);
    vi.mocked(usePathname).mockReturnValue('/vote');

    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    expect(screen.getByTestId('knowledge-bottom-sheet-spacer')).toBeInTheDocument();
  });

  it('disables reset controls on legal routes', () => {
    vi.mocked(usePathname).mockReturnValue('/terms');

    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    expect(screen.getByTestId('header')).toHaveAttribute('data-show-reset', 'false');
    expect(screen.queryByTestId('step-indicator')).not.toBeInTheDocument();
  });

  it('renders a docking sentinel on desktop routes', () => {
    vi.mocked(useMediaQuery).mockReturnValue(false);
    vi.mocked(usePathname).mockReturnValue('/vote');

    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    expect(screen.getByTestId('knowledge-dock-sentinel')).toBeInTheDocument();
  });

  it('adds spacer equal to floating panel height plus bottom gap on desktop', () => {
    vi.mocked(usePathname).mockReturnValue('/vote');
    vi.mocked(useMediaQuery).mockReturnValue(false);
    vi.mocked(useDockingPanel).mockReturnValue({
      isDocked: false,
      dockZoneRef: vi.fn(),
      panelRef: vi.fn(),
      isFloating: true,
      floatingPanelHeight: 120,
    });

    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    const spacer = screen.getByTestId('knowledge-panel-spacer');
    expect(spacer).toHaveStyle({ height: '208px' });
  });

  it('keeps bottom gap spacer when docked to avoid scroll jumps', () => {
    vi.mocked(usePathname).mockReturnValue('/vote');
    vi.mocked(useMediaQuery).mockReturnValue(false);
    vi.mocked(useDockingPanel).mockReturnValue({
      isDocked: true,
      dockZoneRef: vi.fn(),
      panelRef: vi.fn(),
      isFloating: false,
      floatingPanelHeight: 120,
    });

    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    const spacer = screen.getByTestId('knowledge-panel-spacer');
    expect(spacer).toHaveStyle({ height: '88px' });
  });

  it('keeps floating bottom gap independent of footer height', () => {
    footerHeightOverride = 200;
    vi.mocked(usePathname).mockReturnValue('/vote');
    vi.mocked(useMediaQuery).mockReturnValue(false);
    vi.mocked(useDockingPanel).mockReturnValue({
      isDocked: false,
      dockZoneRef: vi.fn(),
      panelRef: vi.fn(),
      isFloating: true,
      floatingPanelHeight: 120,
    });

    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    const spacer = screen.getByTestId('knowledge-panel-spacer');
    expect(spacer).toHaveStyle({ height: '208px' });
  });

  it('should update document language', () => {
    const originalLang = document.documentElement.lang;

    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    expect(document.documentElement.lang).toBe('ja');

    // Cleanup
    document.documentElement.lang = originalLang;
  });

  it('should use wide content width on verify subroutes', () => {
    vi.mocked(usePathname).mockReturnValue('/verify/bot/12');

    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    const main = screen.getByRole('main');
    expect(main.className).toContain('max-w-4xl');
  });

  it('should not set up beforeunload listener on mount', () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    expect(addEventListenerSpy).not.toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  it('scrolls to top on route change', () => {
    const scrollToSpy = vi.fn();
    Object.defineProperty(window, 'scrollTo', {
      value: scrollToSpy,
      writable: true,
      configurable: true,
    });

    vi.mocked(usePathname).mockReturnValue('/vote');
    const { rerender } = render(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    expect(scrollToSpy).not.toHaveBeenCalled();

    vi.mocked(usePathname).mockReturnValue('/aggregate');
    rerender(
      <LayoutProvider>
        <div>Content</div>
      </LayoutProvider>,
    );

    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
  });
});
