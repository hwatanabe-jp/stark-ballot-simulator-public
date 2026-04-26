import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useLanguage, LanguageProvider } from './useLanguage';
import type { ReactNode } from 'react';

// Wrapper component for testing hooks that require LanguageProvider
const wrapper = ({ children }: { children: ReactNode }) => <LanguageProvider>{children}</LanguageProvider>;

describe('useLanguage', () => {
  const originalNavigatorLanguage = window.navigator.language;
  let getItemMock: ReturnType<typeof vi.fn<(key: string) => string | null>>;
  let setItemMock: ReturnType<typeof vi.fn<(key: string, value: string) => void>>;
  let cookieValue = '';

  beforeEach(() => {
    vi.clearAllMocks();
    cookieValue = '';
    Object.defineProperty(document, 'cookie', {
      get: () => cookieValue,
      set: (value: string) => {
        const [pair] = value.split(';');
        const [name, cookieVal] = pair.split('=');
        const parts = cookieValue
          .split(';')
          .map((entry) => entry.trim())
          .filter(Boolean)
          .filter((entry) => !entry.startsWith(`${name}=`));
        parts.push(`${name}=${cookieVal}`);
        cookieValue = parts.join('; ');
      },
      configurable: true,
    });
    // Mock localStorage properly
    const mockStorage: { [key: string]: string } = {};
    getItemMock = vi.fn<(key: string) => string | null>((key) => mockStorage[key] || null);
    setItemMock = vi.fn<(key: string, value: string) => void>((key, value) => {
      mockStorage[key] = value;
    });
    const storage: Storage = {
      getItem: getItemMock,
      setItem: setItemMock,
      removeItem: vi.fn((key: string) => {
        delete mockStorage[key];
      }),
      clear: vi.fn(() => {
        Object.keys(mockStorage).forEach((key) => delete mockStorage[key]);
      }),
      key: vi.fn((index: number) => Object.keys(mockStorage)[index] ?? null),
      get length() {
        return Object.keys(mockStorage).length;
      },
    };
    Object.defineProperty(global, 'localStorage', {
      value: storage,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window.navigator, 'language', {
      value: originalNavigatorLanguage,
      configurable: true,
    });
  });

  it('should throw error when used outside LanguageProvider', () => {
    // Suppress console.error for this test
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      renderHook(() => useLanguage());
    }).toThrow('useLanguage must be used within LanguageProvider');

    consoleSpy.mockRestore();
  });

  it('should return "ja" when navigator.language starts with "ja"', async () => {
    Object.defineProperty(window.navigator, 'language', {
      value: 'ja-JP',
      configurable: true,
    });

    const { result } = renderHook(() => useLanguage(), { wrapper });

    await waitFor(() => {
      expect(result.current.language).toBe('ja');
    });
  });

  it('should return "en" when navigator.language does not start with "ja"', async () => {
    Object.defineProperty(window.navigator, 'language', {
      value: 'en-US',
      configurable: true,
    });

    const { result } = renderHook(() => useLanguage(), { wrapper });

    await waitFor(() => {
      expect(result.current.language).toBe('en');
    });
  });

  it('should return "en" for other languages like "fr-FR"', async () => {
    Object.defineProperty(window.navigator, 'language', {
      value: 'fr-FR',
      configurable: true,
    });

    const { result } = renderHook(() => useLanguage(), { wrapper });

    await waitFor(() => {
      expect(result.current.language).toBe('en');
    });
  });

  it('should use stored language from localStorage if available', async () => {
    getItemMock.mockImplementation((key: string) => (key === 'stark-ballot-lang' ? 'ja' : null));

    Object.defineProperty(window.navigator, 'language', {
      value: 'en-US',
      configurable: true,
    });

    const { result } = renderHook(() => useLanguage(), { wrapper });

    await waitFor(() => {
      expect(result.current.language).toBe('ja');
    });
  });

  it('should prefer cookie over localStorage and navigator language', async () => {
    getItemMock.mockImplementation((key: string) => (key === 'stark-ballot-lang' ? 'ja' : null));
    document.cookie = 'stark-ballot-lang=en';
    Object.defineProperty(window.navigator, 'language', {
      value: 'ja-JP',
      configurable: true,
    });

    const { result } = renderHook(() => useLanguage(), { wrapper });

    await waitFor(() => {
      expect(result.current.language).toBe('en');
    });
  });

  it('should allow manual language change', async () => {
    Object.defineProperty(window.navigator, 'language', {
      value: 'en-US',
      configurable: true,
    });

    const { result } = renderHook(() => useLanguage(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    act(() => {
      result.current.setLanguage('ja');
    });

    expect(result.current.language).toBe('ja');
    expect(setItemMock).toHaveBeenCalledWith('stark-ballot-lang', 'ja');
    expect(document.cookie).toContain('stark-ballot-lang=ja');
  });

  it('should persist language change to localStorage', async () => {
    const { result } = renderHook(() => useLanguage(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    act(() => {
      result.current.setLanguage('ja');
    });

    expect(setItemMock).toHaveBeenCalledWith('stark-ballot-lang', 'ja');
    expect(document.cookie).toContain('stark-ballot-lang=ja');
  });
});
