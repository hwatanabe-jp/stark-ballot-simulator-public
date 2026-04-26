import { useCallback, useMemo } from 'react';
import { useLanguage } from './useLanguage';
import { t, getTranslations } from '@/lib/i18n';

export type UseTranslationResult = {
  t: (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]) => string;
  translations: ReturnType<typeof getTranslations>;
  language: ReturnType<typeof useLanguage>['language'];
};

export function useTranslation(): UseTranslationResult {
  const { language } = useLanguage();
  const translate = useCallback(
    (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]) => t(language, key, params),
    [language],
  );
  const translations = useMemo(() => getTranslations(language), [language]);

  return useMemo(
    () => ({
      t: translate,
      translations,
      language,
    }),
    [language, translate, translations],
  );
}
