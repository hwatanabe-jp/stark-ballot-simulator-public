import { useCallback } from 'react';
import { useLanguage } from './useLanguage';
import { t, type TranslationKey, type TranslationParams } from '@stark-ballot/web/i18n';

export type UseTranslationResult = {
  t: (key: TranslationKey, params?: TranslationParams) => string;
  language: ReturnType<typeof useLanguage>['language'];
};

export function useTranslation(): UseTranslationResult {
  const { language } = useLanguage();
  const translate = useCallback(
    (key: TranslationKey, params?: TranslationParams) => t(language, key, params),
    [language],
  );

  return {
    t: translate,
    language,
  };
}
