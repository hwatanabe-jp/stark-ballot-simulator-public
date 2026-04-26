import { ja } from './translations/ja';
import { en } from './translations/en';
import type { Language } from '@/lib/hooks';
import { isRecord } from '@/lib/utils/guards';

type Translations = typeof ja | typeof en;

const translations = {
  ja,
  en,
} as const;

export function getTranslations(language: Language): (typeof translations)[Language] {
  return translations[language];
}

type Path<T> = T extends object
  ? {
      [K in keyof T]: K extends string ? (T[K] extends object ? `${K}` | `${K}.${Path<T[K]>}` : `${K}`) : never;
    }[keyof T]
  : never;

type TranslationParams = Record<string, string | number | undefined>;

export function t(language: Language, key: Path<Translations>, params?: TranslationParams): string;
export function t(language: Language, key: readonly string[], params?: TranslationParams): string;
export function t(language: Language, key: string, params?: TranslationParams): string;
export function t(language: Language, key: string | readonly string[], params?: TranslationParams): string {
  const trans = getTranslations(language);

  // Convert array to dot notation
  const keyString = Array.isArray(key) ? key.join('.') : String(key);

  // Navigate to the translation value
  const keys = keyString.split('.');
  let value: unknown = trans;

  for (const k of keys) {
    if (isRecord(value) && k in value) {
      value = value[k];
    } else {
      return keyString; // Return key if not found
    }
  }

  // If value is not a string, return the key
  if (typeof value !== 'string') {
    return keyString;
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
