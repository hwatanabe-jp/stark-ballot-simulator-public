'use client';

import { useEffect, useCallback, useContext, useSyncExternalStore, createContext, type ReactNode } from 'react';
import {
  type Language,
  LANGUAGE_COOKIE_NAME,
  LANGUAGE_STORAGE_KEY,
  buildLanguageCookie,
  resolveInitialLanguage,
} from '@/lib/i18n/language';
import { getCookieValue } from '@/lib/http/cookies';

export type { Language } from '@/lib/i18n/language';

/**
 * useLanguage - 「透明な信頼」デザインシステム
 *
 * 言語選択の初期化・永続化ロジック:
 * 1. localStorage に保存値があれば使用
 * 2. なければ navigator.language が 'ja' で始まれば 'ja'、それ以外は 'en'
 * 3. 保存値とブラウザ言語が食い違う場合は保存値を優先（ユーザー選択を尊重）
 *
 * Context を使用してグローバルに状態を共有。
 */

export type UseLanguageResult = {
  language: Language;
  setLanguage: (lang: Language) => void;
  isLoaded: boolean;
};

/**
 * Language Context
 */
const LanguageContext = createContext<UseLanguageResult | null>(null);
const LANGUAGE_CHANGE_EVENT = 'stark-ballot:language-change';

const getClientLanguage = (fallback: Language): Language => {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const storedLang = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  const cookieLang = getCookieValue(document.cookie, LANGUAGE_COOKIE_NAME);
  return resolveInitialLanguage({
    cookie: cookieLang,
    storage: storedLang,
    acceptLanguage: navigator.language,
  });
};

const subscribeLanguage = (callback: () => void): (() => void) => {
  if (typeof window === 'undefined') {
    return () => undefined;
  }
  const handleStorage = (event: StorageEvent) => {
    if (event.key === LANGUAGE_STORAGE_KEY) {
      callback();
    }
  };
  const handleCustom = () => {
    callback();
  };
  window.addEventListener('storage', handleStorage);
  window.addEventListener(LANGUAGE_CHANGE_EVENT, handleCustom);
  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(LANGUAGE_CHANGE_EVENT, handleCustom);
  };
};

/**
 * LanguageProvider - 言語状態をグローバルに共有
 *
 * layout.tsx で使用し、全コンポーネントで言語状態を共有する。
 */
export function LanguageProvider({
  children,
  initialLanguage = 'ja',
}: {
  children: ReactNode;
  initialLanguage?: Language;
}): React.ReactElement {
  const language = useSyncExternalStore(
    subscribeLanguage,
    () => getClientLanguage(initialLanguage),
    () => initialLanguage,
  );
  const isLoaded = typeof window !== 'undefined';

  const setLanguage = useCallback((lang: Language) => {
    if (typeof window === 'undefined') {
      return;
    }
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
    document.cookie = buildLanguageCookie(lang);
    window.dispatchEvent(new Event(LANGUAGE_CHANGE_EVENT));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    document.cookie = buildLanguageCookie(language);
  }, [language]);

  return <LanguageContext.Provider value={{ language, setLanguage, isLoaded }}>{children}</LanguageContext.Provider>;
}

/**
 * 言語設定フック
 *
 * LanguageProvider 内で使用する。Context から言語状態を取得。
 */
export function useLanguage(): UseLanguageResult {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within LanguageProvider');
  }
  return context;
}

/**
 * 言語設定フック（フォールバック付き）
 *
 * LanguageProvider 外でも使用可能。Context がない場合はデフォルト値を返す。
 * Storybook や単体テストでの使用を想定。
 */
export function useLanguageOptional(): UseLanguageResult {
  const context = useContext(LanguageContext);
  if (!context) {
    return {
      language: 'ja',
      setLanguage: () => {},
      isLoaded: false,
    };
  }
  return context;
}
