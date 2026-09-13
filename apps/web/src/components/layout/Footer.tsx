'use client';

import React from 'react';
import { useTranslation } from '@stark-ballot/web/hooks/useTranslation';
import { useHasActiveSession } from '@stark-ballot/web/hooks/useActiveSession';
import { AppLink } from '@stark-ballot/web/navigation/appNavigation';
import './SiteChrome.css';

const SPEC_URL = 'https://specs.stark-ballot-sim.hwatanabe.dev';
const PUBLIC_REPOSITORY_URL = 'https://github.com/hwatanabe-jp/stark-ballot-simulator-public';

export function Footer(): React.ReactElement {
  const { t } = useTranslation();
  const currentYear = new Date().getFullYear();
  const hasActiveSession = useHasActiveSession({ fallback: true });

  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <div>&copy; {currentYear} H. Watanabe</div>
        <nav aria-label="Footer navigation">
          {hasActiveSession ? (
            <a href="/terms" target="_blank" rel="noopener noreferrer">
              {t('footer.terms')}
            </a>
          ) : (
            <AppLink href="/terms">{t('footer.terms')}</AppLink>
          )}
          {hasActiveSession ? (
            <a href="/privacy" target="_blank" rel="noopener noreferrer">
              {t('footer.privacy')}
            </a>
          ) : (
            <AppLink href="/privacy">{t('footer.privacy')}</AppLink>
          )}
          <a href={SPEC_URL} target="_blank" rel="noopener noreferrer">
            {t('footer.spec')}
          </a>
          <a href={PUBLIC_REPOSITORY_URL} target="_blank" rel="noopener noreferrer">
            {t('footer.github')}
          </a>
        </nav>
      </div>
    </footer>
  );
}
