import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTranslation } from './useTranslation';
import { useLanguage, type Language } from './useLanguage';

vi.mock('./useLanguage', () => ({
  useLanguage: vi.fn(),
}));

function useMockLanguage(language: Language): void {
  vi.mocked(useLanguage).mockReturnValue({
    language,
    setLanguage: vi.fn(),
    isLoaded: true,
  });
}

describe('useTranslation', () => {
  it('keeps the translator stable until the language changes', () => {
    useMockLanguage('ja');
    const { result, rerender } = renderHook(() => useTranslation());
    const japaneseTranslator = result.current.t;

    expect(japaneseTranslator('common.start')).toBe('開始');
    rerender();
    expect(result.current.t).toBe(japaneseTranslator);

    useMockLanguage('en');
    rerender();

    expect(result.current.language).toBe('en');
    expect(result.current.t).not.toBe(japaneseTranslator);
    expect(result.current.t('common.start')).toBe('Start');
  });
});
