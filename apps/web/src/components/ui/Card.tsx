import React from 'react';

/**
 * Card - 「透明な信頼」デザインシステム
 *
 * Variants:
 * - default: 紙テクスチャ背景、下部グラデーションライン
 * - verification: 検証カード（verified時に右上印鑑装飾）
 */

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'verification';
  verified?: boolean;
  children: React.ReactNode;
}

const cn = (...classes: Array<string | false | undefined>): string => {
  return classes.filter(Boolean).join(' ');
};

export function Card({
  variant = 'default',
  verified = false,
  className,
  children,
  ...props
}: CardProps): React.ReactElement {
  const baseStyles = cn(
    // Background with paper texture
    'bg-paper-texture',
    // Border
    'border border-paper-border',
    // Shape
    'rounded-xl',
    // Spacing
    'p-6',
    // Position for pseudo-elements
    'relative',
    // Bottom line decoration
    'card-bottom-line',
  );

  const verificationStyles =
    variant === 'verification'
      ? cn(
          // Additional styles for verification cards
          'overflow-visible',
        )
      : '';

  return (
    <div className={cn(baseStyles, verificationStyles, className)} {...props}>
      {/* Verified stamp decoration */}
      {variant === 'verification' && verified && (
        <div
          className={cn(
            'absolute -inset-bs-2 -inset-e-2',
            'w-10 h-10',
            'bg-vermillion-500',
            'rounded-full',
            'flex items-center justify-center',
            'text-paper-white text-sm font-bold',
            'transform -rotate-[5deg]',
            'shadow-md',
            'animate-stamp',
          )}
          aria-label="検証済み"
        >
          <svg
            className="w-5 h-5 animate-check"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
        </div>
      )}

      {children}
    </div>
  );
}

/**
 * CardHeader - カードのヘッダー部分
 */
interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function CardHeader({ className, children, ...props }: CardHeaderProps): React.ReactElement {
  return (
    <div className={cn('mb-4', className)} {...props}>
      {children}
    </div>
  );
}

/**
 * CardTitle - カードのタイトル
 */
interface CardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  children: React.ReactNode;
}

export function CardTitle({ className, children, ...props }: CardTitleProps): React.ReactElement {
  return (
    <h3
      className={cn(
        'font-primary font-medium text-[var(--text-h2)] text-ink-900',
        'leading-[var(--leading-h2)]',
        className,
      )}
      {...props}
    >
      {children}
    </h3>
  );
}

/**
 * CardDescription - カードの説明テキスト
 */
interface CardDescriptionProps extends React.HTMLAttributes<HTMLParagraphElement> {
  children: React.ReactNode;
}

export function CardDescription({ className, children, ...props }: CardDescriptionProps): React.ReactElement {
  return (
    <p className={cn('mt-1 text-sm text-text-secondary', className)} {...props}>
      {children}
    </p>
  );
}

/**
 * CardContent - カードのメインコンテンツ
 */
interface CardContentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function CardContent({ className, children, ...props }: CardContentProps): React.ReactElement {
  return (
    <div className={cn('', className)} {...props}>
      {children}
    </div>
  );
}

/**
 * CardFooter - カードのフッター部分
 */
interface CardFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function CardFooter({ className, children, ...props }: CardFooterProps): React.ReactElement {
  return (
    <div className={cn('mt-6 flex items-center gap-4', className)} {...props}>
      {children}
    </div>
  );
}
