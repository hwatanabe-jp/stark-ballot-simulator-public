import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTranslation } from './useTranslation';
import { useLanguage, type Language } from './useLanguage';
import { t, getTranslations } from '@/lib/i18n';
import { en } from '@/lib/i18n/translations/en';

// Mock dependencies
vi.mock('./useLanguage', () => ({
  useLanguage: vi.fn(),
}));

vi.mock('@/lib/i18n', () => ({
  t: vi.fn(),
  getTranslations: vi.fn(),
}));

describe('useTranslation', () => {
  // REFACTOR: Added beforeEach to reset mocks
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // REFACTOR: Helper function for common mock setup
  const mockLanguageSetup = (language: Language) => {
    const mockSetLanguage = vi.fn();
    vi.mocked(useLanguage).mockReturnValue({
      language,
      setLanguage: mockSetLanguage,
      isLoaded: true,
    });
    return mockSetLanguage;
  };

  describe('language property', () => {
    it('should return current language from useLanguage', () => {
      const mockLanguage = 'ja';
      mockLanguageSetup(mockLanguage);

      const { result } = renderHook(() => useTranslation());

      expect(result.current.language).toBe(mockLanguage);
    });

    it('should update when language changes', () => {
      const { rerender } = renderHook(() => useTranslation());

      // Initial language
      mockLanguageSetup('ja');
      rerender();

      // Change language
      mockLanguageSetup('en');

      const { result } = renderHook(() => useTranslation());

      expect(result.current.language).toBe('en');
    });
  });

  describe('translations property', () => {
    it('should return translations for current language', () => {
      const mockLanguage: Language = 'en';
      const mockTranslations = en;

      mockLanguageSetup(mockLanguage);
      vi.mocked(getTranslations).mockReturnValue(mockTranslations);

      const { result } = renderHook(() => useTranslation());

      expect(result.current.translations).toBe(mockTranslations);
      expect(getTranslations).toHaveBeenCalledWith(mockLanguage);
    });

    it('should return same translations reference when language unchanged', () => {
      const mockTranslations = en;

      mockLanguageSetup('ja');
      vi.mocked(getTranslations).mockReturnValue(mockTranslations);

      const { result, rerender } = renderHook(() => useTranslation());

      const firstTranslations = result.current.translations;

      rerender();

      const secondTranslations = result.current.translations;

      // Translations should be the same reference if language hasn't changed
      expect(firstTranslations).toBe(secondTranslations);
    });
  });

  describe('t function', () => {
    it('should provide t function that uses current language', () => {
      const mockLanguage = 'ja';
      const mockKey: Parameters<typeof t>[1] = 'vote.submit';
      const expectedTranslation = '投票する';

      mockLanguageSetup(mockLanguage);
      vi.mocked(t).mockReturnValue(expectedTranslation);

      const { result } = renderHook(() => useTranslation());
      const translation = result.current.t(mockKey);

      expect(translation).toBe(expectedTranslation);
      expect(t).toHaveBeenCalledWith(mockLanguage, mockKey, undefined);
    });

    it('should pass parameters to t function', () => {
      const mockLanguage = 'en';
      const mockKey: Parameters<typeof t>[1] = 'vote.confirmation';
      const params = { choice: 'A' };
      const expectedTranslation = 'You voted for A';

      mockLanguageSetup(mockLanguage);
      vi.mocked(t).mockReturnValue(expectedTranslation);

      const { result } = renderHook(() => useTranslation());
      const translation = result.current.t(mockKey, params);

      expect(translation).toBe(expectedTranslation);
      expect(t).toHaveBeenCalledWith(mockLanguage, mockKey, params);
    });

    it('should handle t function with all parameter variations', () => {
      const mockLanguage = 'ja';

      mockLanguageSetup(mockLanguage);
      vi.mocked(t).mockReturnValue('translated');

      const { result } = renderHook(() => useTranslation());

      // Test with just key
      result.current.t('key1');
      expect(t).toHaveBeenCalledWith(mockLanguage, 'key1', undefined);

      // Test with key and params
      result.current.t('key2', { count: 5 });
      expect(t).toHaveBeenCalledWith(mockLanguage, 'key2', { count: 5 });

      // Test with null params
      result.current.t('key3', undefined);
      expect(t).toHaveBeenCalledWith(mockLanguage, 'key3', undefined);
    });

    it('should work consistently across rerenders', () => {
      mockLanguageSetup('ja');
      vi.mocked(t).mockReturnValue('consistent result');

      const { result, rerender } = renderHook(() => useTranslation());

      // t function should work the same across rerenders
      const firstResult = result.current.t('test');
      rerender();
      const secondResult = result.current.t('test');

      expect(firstResult).toBe(secondResult);
      expect(t).toHaveBeenCalledTimes(2);
    });

    it('should return stable t reference when language is unchanged', () => {
      mockLanguageSetup('en');
      vi.mocked(t).mockReturnValue('stable');

      const { result, rerender } = renderHook(() => useTranslation());

      const firstT = result.current.t;

      rerender();

      expect(result.current.t).toBe(firstT);
    });

    // REFACTOR: Added edge case test
    it('should handle empty string keys', () => {
      mockLanguageSetup('en');
      vi.mocked(t).mockReturnValue('');

      const { result } = renderHook(() => useTranslation());

      // Test with empty string key
      result.current.t('');
      expect(t).toHaveBeenCalledWith('en', '', undefined);
    });
  });
});
