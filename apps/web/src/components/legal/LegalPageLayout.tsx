'use client';

import { type ReactNode, useCallback } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { useLanguageOptional } from '@stark-ballot/web/hooks/useLanguage';
import { useHasActiveSession } from '@stark-ballot/web/hooks/useActiveSession';
import { t } from '@stark-ballot/web/i18n';
import { AppLink } from '@stark-ballot/web/navigation/appNavigation';

/**
 * LegalPageLayout - 法務ページ用レイアウトコンポーネント
 *
 * プライバシーポリシー、利用規約などの法務文書ページで使用。
 * 共通の書体と余白を使った、読みやすい文書レイアウト。
 *
 * Features:
 * - セマンティックな article/section 構造
 * - 共通のsans-serif書体（font-display / font-primary）
 * - コンテンツ幅は LayoutProvider で制御（法務ページは最大768px）
 * - 「トップに戻る」ナビゲーション付き
 */

export interface LegalPageLayoutProps {
  /** Localized document heading and introduction. */
  document: {
    title: string;
    effectiveDate: string;
    effectiveDateLabel: string;
    intro: string;
  };
  /** ページコンテンツ */
  children: ReactNode;
}

export function LegalPageLayout({
  document: { title, effectiveDate, effectiveDateLabel, intro },
  children,
}: LegalPageLayoutProps): React.ReactElement {
  const { language } = useLanguageOptional();
  const hasActiveSession = useHasActiveSession({ fallback: true });
  const sessionNotice = hasActiveSession ? t(language, 'legal.sessionNotice') : null;
  const handleCloseTab = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.close();
  }, []);

  return (
    <article className="w-full">
      <div className="mx-auto py-6">
        {sessionNotice && (
          <div
            role="note"
            className="mb-6 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3 font-secondary text-sm text-text-secondary"
          >
            {sessionNotice}
          </div>
        )}

        {/* タイトル */}
        <header className="mb-8">
          <h1 className="font-display font-medium text-3xl leading-[var(--leading-display)] tracking-[var(--tracking-display)] text-ink-900 sm:text-4xl">
            {title}
          </h1>
          <p className="mt-3 font-secondary text-sm text-text-muted">
            {effectiveDateLabel}: {effectiveDate}
          </p>
        </header>

        {/* コンテンツ */}
        <div className="legal-content space-y-8 font-primary leading-relaxed text-text-secondary">
          <p>{intro}</p>
          {children}
        </div>

        {/* ナビゲーション */}
        <nav className="mt-12 space-y-3 border-bs border-paper-border pbs-8">
          {/* セッション有効時: タブを閉じるオプション */}
          {hasActiveSession && (
            <div className="space-y-1">
              <button
                type="button"
                onClick={handleCloseTab}
                className="inline-flex items-center gap-2 font-secondary text-ink-600 transition-colors hover:text-ink-800"
                data-testid="legal-close-tab"
              >
                <X className="h-4 w-4" />
                {t(language, 'legal.closeTab')}
              </button>
              <p className="font-secondary text-xs text-text-muted">{t(language, 'legal.closeTabHint')}</p>
            </div>
          )}
          {/* 常に表示: トップに戻るリンク（フォールバック） */}
          <AppLink
            href="/"
            className="inline-flex items-center gap-2 font-secondary text-ink-600 transition-colors hover:text-ink-800"
            data-testid="legal-back-to-home"
          >
            <ArrowLeft className="h-4 w-4" />
            {t(language, 'legal.backToHome')}
          </AppLink>
        </nav>
      </div>
    </article>
  );
}

/**
 * LegalSection - 法務ページのセクションコンポーネント
 *
 * h2 見出しと本文を含むセクション。
 */
export interface LegalSectionProps {
  /** セクションタイトル */
  title: string;
  /** セクションコンテンツ */
  children: ReactNode;
}

export function LegalSection({ title, children }: LegalSectionProps): React.ReactElement {
  return (
    <section className="space-y-4">
      <h2 className="font-medium font-primary text-xl leading-[var(--leading-h2)] text-ink-900">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/**
 * LegalSubSection - 法務ページのサブセクションコンポーネント
 *
 * h3 見出しと本文を含むサブセクション。
 */
export interface LegalSubSectionProps {
  /** サブセクションタイトル */
  title: string;
  /** サブセクションコンテンツ */
  children: ReactNode;
}

export function LegalSubSection({ title, children }: LegalSubSectionProps): React.ReactElement {
  return (
    <div className="space-y-2 border-l-2 border-paper-border pl-4">
      <h3 className="font-medium font-primary text-base text-ink-800">{title}</h3>
      <div className="space-y-2 text-sm">{children}</div>
    </div>
  );
}

/**
 * LegalList - 法務ページのリストコンポーネント
 */
export interface LegalListProps {
  /** リストアイテム */
  items: readonly string[];
}

export function LegalList({ items }: LegalListProps): React.ReactElement {
  return (
    <ul className="list-inside list-disc space-y-1 text-sm">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * LegalTable - 法務ページのテーブルコンポーネント
 */
export interface LegalTableProps {
  /** ヘッダー行 */
  headers: readonly string[];
  /** データ行 */
  rows: readonly (readonly string[])[];
}

export function LegalTable({ headers, rows }: LegalTableProps): React.ReactElement {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-be border-paper-border-dark">
            {headers.map((header, index) => (
              <th key={index} className="py-2 pr-4 text-left font-medium text-ink-800">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-be border-paper-border">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="py-2 pr-4">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
