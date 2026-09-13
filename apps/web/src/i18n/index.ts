import { ja } from './translations/ja';
import { en } from './translations/en';
import type { Language } from '@stark-ballot/web/hooks';

type Translations = typeof ja | typeof en;

const translations = {
  ja,
  en,
} as const;

function getTranslations(language: Language): (typeof translations)[Language] {
  return translations[language];
}

type Path<T> = T extends object
  ? {
      [K in keyof T]: K extends string
        ? T[K] extends string
          ? K
          : T[K] extends object
            ? `${K}.${Path<T[K]>}`
            : never
        : never;
    }[keyof T]
  : never;

export type TranslationKey = Path<Translations>;
export type TranslationParams = Record<string, string | number | undefined>;

function isTranslationRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function t(language: Language, key: TranslationKey, params?: TranslationParams): string {
  const trans = getTranslations(language);

  // Navigate to the translation value
  const keys = key.split('.');
  let value: unknown = trans;

  for (const k of keys) {
    if (isTranslationRecord(value) && k in value) {
      value = value[k];
    } else {
      return key; // Retain the fallback for untyped callers.
    }
  }

  // If value is not a string, return the key
  if (typeof value !== 'string') {
    return key;
  }

  // Handle interpolation
  if (params) {
    return value.replace(/\{\{(\w+)\}\}/g, (match: string, paramKey: string) => {
      const paramValue = params[paramKey];
      return paramValue === undefined ? match : paramValue.toString();
    });
  }

  return value;
}
