'use client';

import { type ReactNode, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, X } from 'lucide-react';
import { useLanguageOptional } from '@/lib/hooks/useLanguage';
import { useHasActiveSession } from '@/lib/hooks/useActiveSession';
import { t } from '@/lib/i18n';

/**
 * LegalPageLayout - 法務ページ用レイアウトコンポーネント
 *
 * プライバシーポリシー、利用規約などの法務文書ページで使用。
 * 「透明な信頼」デザインシステムに準拠した、カードレスで読みやすいレイアウト。
 *
 * Features:
 * - 微かな浮上アニメーション（animate-subtle-rise）
 * - セマンティックな article/section 構造
 * - 権威性のある書体（font-display / font-primary）
 * - コンテンツ幅は LayoutProvider で制御（法務ページは max-w-3xl）
 * - 「トップに戻る」ナビゲーション付き
 */

export interface LegalPageLayoutProps {
  /** ページタイトル */
  title: string;
  /** 施行日（YYYY-MM-DD 形式） */
  effectiveDate: string;
  /** 施行日ラベル（例: "施行日", "Effective Date"） */
  effectiveDateLabel: string;
  /** ページコンテンツ */
  children: ReactNode;
}

export function LegalPageLayout({
  title,
  effectiveDate,
  effectiveDateLabel,
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
    <article className="w-full animate-subtle-rise">
      <div className="mx-auto px-6 py-12 lg:px-8">
        {sessionNotice && (
          <div
            role="note"
            className="mb-6 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3 text-sm text-text-secondary font-secondary"
          >
            {sessionNotice}
          </div>
        )}

        {/* タイトル */}
        <header className="mb-8">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-ink-900 tracking-[var(--tracking-display)] leading-[var(--leading-display)]">
            {title}
          </h1>
          <p className="mt-3 text-sm text-text-muted font-secondary">
            {effectiveDateLabel}: {effectiveDate}
          </p>
        </header>

        {/* コンテンツ */}
        <div className="legal-content font-primary text-text-secondary leading-relaxed space-y-8">{children}</div>

        {/* ナビゲーション */}
        <nav className="mt-12 pbs-8 border-bs border-paper-border space-y-3">
          {/* セッション有効時: タブを閉じるオプション */}
          {hasActiveSession && (
            <div className="space-y-1">
              <button
                type="button"
                onClick={handleCloseTab}
                className="inline-flex items-center gap-2 text-ink-600 hover:text-ink-800 transition-colors font-secondary"
                data-testid="legal-close-tab"
              >
                <X className="w-4 h-4" />
                {t(language, 'legal.closeTab')}
              </button>
              <p className="text-xs text-text-muted font-secondary">{t(language, 'legal.closeTabHint')}</p>
            </div>
          )}
          {/* 常に表示: トップに戻るリンク（フォールバック） */}
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-ink-600 hover:text-ink-800 transition-colors font-secondary"
            data-testid="legal-back-to-home"
          >
            <ArrowLeft className="w-4 h-4" />
            {t(language, 'legal.backToHome')}
          </Link>
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
      <h2 className="font-primary text-xl font-semibold text-ink-900 leading-[var(--leading-h2)]">{title}</h2>
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
    <div className="space-y-2 pl-4 border-l-2 border-paper-border">
      <h3 className="font-primary text-base font-medium text-ink-800">{title}</h3>
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
    <ul className="list-disc list-inside space-y-1 text-sm">
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
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-be border-paper-border-dark">
            {headers.map((header, index) => (
              <th key={index} className="text-left py-2 pr-4 font-medium text-ink-800">
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

/**
 * LegalLink - 法務ページの外部リンクコンポーネント
 */
export interface LegalLinkProps {
  /** リンク先URL */
  href: string;
  /** リンクテキスト */
  children: ReactNode;
}

export function LegalLink({ href, children }: LegalLinkProps): React.ReactElement {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-ink-600 hover:text-ink-800 underline underline-offset-2 transition-colors"
    >
      {children}
    </a>
  );
}
