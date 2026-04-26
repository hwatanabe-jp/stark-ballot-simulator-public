'use client';

import React from 'react';
import Link from 'next/link';
import { useLanguage, type Language } from '@/lib/hooks/useLanguage';
import { useTranslation } from '@/lib/hooks/useTranslation';

/**
 * Header - 「透明な信頼」デザインシステム
 *
 * グローバルヘッダー:
 * - ロゴ（左）
 * - 言語切替ボタン（右）
 * - 「やり直す」ボタン（右）
 */

const cn = (...classes: Array<string | false | undefined>): string => {
  return classes.filter(Boolean).join(' ');
};

interface HeaderProps {
  onReset?: () => void;
  showReset?: boolean;
}

export function Header({ onReset, showReset = true }: HeaderProps): React.ReactElement {
  const { language, setLanguage } = useLanguage();
  const { t } = useTranslation();

  const toggleLanguage = () => {
    const newLang: Language = language === 'ja' ? 'en' : 'ja';
    setLanguage(newLang);
  };

  const handleReset = () => {
    if (onReset) {
      onReset();
    } else {
      // デフォルト動作: トップページへ遷移
      window.location.href = '/';
    }
  };

  return (
    <header
      className={cn(
        'sticky inset-bs-0 z-50',
        'bg-paper-warm/95 backdrop-blur-sm',
        'border-be border-paper-border',
        'px-4 md:px-6 py-3',
      )}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <Link href="/" className={cn('text-ink-900 hover:text-ink-700', 'transition-colors duration-150')}>
            <span className="font-primary text-lg font-semibold tracking-tight">STARK Ballot Simulator</span>
          </Link>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          {/* Language toggle */}
          <button
            onClick={toggleLanguage}
            className={cn(
              'px-3 py-1.5 rounded-md',
              'text-sm font-secondary font-medium',
              'text-text-secondary hover:text-text-primary',
              'hover:bg-ink-50',
              'transition-colors duration-150',
              'flex items-center gap-1.5',
            )}
            aria-label={language === 'ja' ? t('header.languageSwitchToEnglish') : t('header.languageSwitchToJapanese')}
          >
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
            </svg>
            <span>{language === 'ja' ? 'JA' : 'EN'}</span>
          </button>

          {/* Reset button */}
          {showReset && (
            <button
              onClick={handleReset}
              className={cn(
                'px-3 py-1.5 rounded-md',
                'text-sm font-secondary font-medium',
                'text-text-secondary hover:text-vermillion-600',
                'hover:bg-vermillion-50',
                'transition-colors duration-150',
                'flex items-center gap-1.5',
                'whitespace-nowrap',
              )}
              aria-label={t('actions.reset')}
            >
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              <span>{t('actions.reset')}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
