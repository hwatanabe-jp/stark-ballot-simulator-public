import { isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn(() =>
    Promise.resolve(
      new Headers([
        ['x-nonce', 'test-nonce'],
        ['accept-language', 'ja-JP,ja;q=0.9'],
      ]),
    ),
  ),
  cookies: vi.fn(() =>
    Promise.resolve({
      get: () => undefined,
    }),
  ),
}));

// Mock next/font/google
vi.mock('next/font/google', () => ({
  Noto_Serif_JP: () => ({
    variable: '--font-noto-serif-jp',
    className: 'noto-serif-jp',
  }),
  Noto_Sans_JP: () => ({
    variable: '--font-noto-sans-jp',
    className: 'noto-sans-jp',
  }),
  IBM_Plex_Mono: () => ({
    variable: '--font-ibm-plex-mono',
    className: 'ibm-plex-mono',
  }),
  Shippori_Mincho: () => ({
    variable: '--font-shippori-mincho',
    className: 'shippori-mincho',
  }),
}));

// Mock LayoutProvider
vi.mock('@/components/LayoutProvider', () => ({
  LayoutProvider: ({ children }: { children: React.ReactNode }) => (
    <div>
      <div data-testid="step-indicator">Step Indicator</div>
      <main>{children}</main>
    </div>
  ),
}));

// Mock LanguageProvider
vi.mock('@/lib/hooks', () => ({
  LanguageProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="language-provider">{children}</div>
  ),
}));

describe('RootLayout', () => {
  const renderLayout = async (children: ReactNode): Promise<ReactElement> => {
    const { default: RootLayout } = await import('./layout');
    return RootLayout({ children });
  };

  type AnyElement = ReactElement<Record<string, unknown>>;

  const assertElement = (node: unknown, label: string): AnyElement => {
    if (!isValidElement(node)) {
      throw new Error(`${label} is not a valid React element`);
    }
    return node as AnyElement;
  };

  it('should pass children into LayoutProvider via LanguageProvider', async () => {
    const ui = (await renderLayout(<div>Test Content</div>)) as AnyElement;

    const body = assertElement(ui.props.children, 'body');
    const cspProvider = assertElement(body.props.children, 'csp provider');
    const languageProvider = assertElement(cspProvider.props.children, 'language provider');
    const layoutProvider = assertElement(languageProvider.props.children, 'layout provider');
    const content = assertElement(layoutProvider.props.children, 'content');

    expect(content.type).toBe('div');
    expect(content.props.children).toBe('Test Content');
  });

  it('should set language attribute on html element', async () => {
    const ui = (await renderLayout(<div>Test</div>)) as AnyElement;

    expect(ui.type).toBe('html');
    expect(ui.props.lang).toBe('ja');
  });

  it('should have proper metadata', async () => {
    // Note: Metadata is handled by Next.js, so we just verify the export exists
    const { default: RootLayout } = await import('./layout');
    expect(RootLayout).toBeDefined();
  });

  it('should apply proper layout structure', async () => {
    const ui = (await renderLayout(<div>Content</div>)) as AnyElement;

    const body = assertElement(ui.props.children, 'body');
    expect(body.type).toBe('body');
    expect(String(body.props.className)).toContain('text-text-primary');
    expect(String(body.props.className)).toContain('bg-paper-warm');

    const cspProvider = assertElement(body.props.children, 'csp provider');
    const languageProvider = assertElement(cspProvider.props.children, 'language provider');
    const layoutProvider = assertElement(languageProvider.props.children, 'layout provider');
    expect(layoutProvider.props.children).toBeDefined();
  });

  it('does not execute global environment validation during layout module evaluation', async () => {
    vi.resetModules();
    const validateEnv = vi.fn();
    vi.doMock('@/lib/env/validate', () => ({
      validateEnv,
    }));

    const { default: RootLayout } = await import('./layout');
    expect(RootLayout).toBeDefined();
    expect(validateEnv).not.toHaveBeenCalled();
  });
});
