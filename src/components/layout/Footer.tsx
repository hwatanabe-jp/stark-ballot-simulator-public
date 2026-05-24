'use client';

import Link from 'next/link';
import React, { forwardRef } from 'react';
import { BookOpen, GitBranch } from 'lucide-react';
import { useTranslation } from '@/lib/hooks/useTranslation';
import { useHasActiveSession } from '@/lib/hooks/useActiveSession';

/**
 * Footer - 「透明な信頼」デザインシステム
 *
 * グローバルフッター:
 * - 著作権表示
 * - 利用規約リンク
 * - プライバシーポリシーリンク
 * - 公開ドキュメントリンク
 *
 * 法務リンクの挙動:
 * - セッションなし: 同じタブで開く
 * - セッション有効: 新規タブで開く（セッション保護のため）
 */

const cn = (...classes: Array<string | false | undefined>): string => {
  return classes.filter(Boolean).join(' ');
};

const SPEC_URL = 'https://specs.stark-ballot-sim.hwatanabe.dev';
const PUBLIC_REPOSITORY_URL = 'https://github.com/hwatanabe-jp/stark-ballot-simulator-public';

export const Footer = forwardRef<HTMLElement>(function Footer(_props, ref): React.ReactElement {
  const { t } = useTranslation();
  const currentYear = new Date().getFullYear();
  const hasActiveSession = useHasActiveSession({ fallback: true });

  return (
    <footer ref={ref} className={cn('bg-paper-cool', 'border-bs border-paper-border', 'px-4 md:px-6 py-6', 'mt-auto')}>
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          {/* Copyright */}
          <div className="text-sm text-text-muted font-secondary">&copy; {currentYear} H. Watanabe</div>

          {/* Links */}
          <nav
            className="grid w-full grid-cols-2 items-center gap-x-6 gap-y-2 sm:flex sm:w-auto sm:gap-6"
            aria-label="Footer navigation"
          >
            {hasActiveSession ? (
              <a
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  'text-sm text-text-secondary',
                  'hover:text-text-primary',
                  'transition-colors duration-150',
                  'font-secondary',
                  'text-center',
                )}
              >
                {t('footer.terms')}
              </a>
            ) : (
              <Link
                href="/terms"
                className={cn(
                  'text-sm text-text-secondary',
                  'hover:text-text-primary',
                  'transition-colors duration-150',
                  'font-secondary',
                  'text-center',
                )}
              >
                {t('footer.terms')}
              </Link>
            )}
            {hasActiveSession ? (
              <a
                href="/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  'text-sm text-text-secondary',
                  'hover:text-text-primary',
                  'transition-colors duration-150',
                  'font-secondary',
                  'text-center',
                )}
              >
                {t('footer.privacy')}
              </a>
            ) : (
              <Link
                href="/privacy"
                className={cn(
                  'text-sm text-text-secondary',
                  'hover:text-text-primary',
                  'transition-colors duration-150',
                  'font-secondary',
                  'text-center',
                )}
              >
                {t('footer.privacy')}
              </Link>
            )}
            <a
              href={SPEC_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'text-sm text-text-secondary',
                'hover:text-text-primary',
                'transition-colors duration-150',
                'font-secondary',
                'flex items-center gap-1.5',
                'justify-center',
              )}
            >
              <BookOpen className="w-4 h-4" />
              {t('footer.spec')}
            </a>
            <a
              href={PUBLIC_REPOSITORY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'text-sm text-text-secondary',
                'hover:text-text-primary',
                'transition-colors duration-150',
                'font-secondary',
                'flex items-center gap-1.5',
                'justify-center',
              )}
            >
              <GitBranch className="w-4 h-4" />
              {t('footer.github')}
            </a>
          </nav>
        </div>
      </div>
    </footer>
  );
});

Footer.displayName = 'Footer';
