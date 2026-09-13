'use client';

import React from 'react';
import { useLanguage } from '@stark-ballot/web/hooks/useLanguage';
import { useTranslation } from '@stark-ballot/web/hooks/useTranslation';
import { AppLink } from '@stark-ballot/web/navigation/appNavigation';
import './SiteChrome.css';

interface HeaderProps {
  onReset?: () => void;
  showReset?: boolean;
}

export function Header({ onReset, showReset = true }: HeaderProps): React.ReactElement {
  const { language, setLanguage } = useLanguage();
  const { t } = useTranslation();
  const toggleLanguage = () => setLanguage(language === 'ja' ? 'en' : 'ja');
  const handleReset = () => {
    if (onReset) onReset();
    else window.location.href = '/';
  };

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <AppLink href="/" className="site-header__brand">
          STARK Ballot Simulator
        </AppLink>
        <div className="site-header__actions">
          <button
            type="button"
            onClick={toggleLanguage}
            aria-label={language === 'ja' ? t('header.languageSwitchToEnglish') : t('header.languageSwitchToJapanese')}
          >
            {language === 'ja' ? 'JA' : 'EN'}
          </button>
          {showReset && (
            <button type="button" onClick={handleReset} aria-label={t('actions.reset')}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
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
