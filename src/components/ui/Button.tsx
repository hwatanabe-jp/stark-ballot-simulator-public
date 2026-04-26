import React from 'react';

/**
 * Button - 「透明な信頼」デザインシステム
 *
 * Variants:
 * - primary: 墨色(ink-700)背景、白テキスト、インセットシャドウ
 * - secondary: 和紙色(paper-cream)背景、墨色テキスト、墨色ボーダー
 * - verify: 朱色(vermillion-600)背景、印鑑テクスチャオーバーレイ
 */

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'verify';
  loading?: boolean;
  fullWidth?: boolean;
  children: React.ReactNode;
}

const cn = (...classes: Array<string | false | undefined>): string => {
  return classes.filter(Boolean).join(' ');
};

export function Button({
  variant = 'primary',
  loading = false,
  fullWidth = false,
  disabled,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps): React.ReactElement {
  const isDisabled = disabled || loading;

  // Base styles
  const baseStyles = cn(
    // Typography
    'font-secondary text-sm font-medium',
    // Spacing
    'px-6 py-3',
    // Shape
    'rounded-lg',
    // Transition
    'transition-all duration-150 ease-in-out',
    // Layout
    'inline-flex items-center justify-center gap-2',
    // Focus
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-500 focus-visible:ring-offset-2',
  );

  // Variant styles
  const variantStyles = {
    primary: cn(
      'bg-ink-700 text-paper-white',
      'shadow-[inset_0_1px_2px_rgba(26,31,77,0.08)]',
      'hover:bg-ink-600 hover:shadow-md',
      'active:bg-ink-800 active:shadow-[inset_0_2px_4px_rgba(26,31,77,0.12)]',
    ),
    secondary: cn(
      'bg-paper-cream text-ink-700',
      'border border-ink-300',
      'shadow-sm',
      'hover:bg-ink-50 hover:border-ink-500',
      'active:bg-ink-100',
    ),
    verify: cn(
      'bg-vermillion-600 text-paper-white',
      'rounded-lg',
      'relative overflow-hidden',
      'stamp-texture',
      'hover:bg-vermillion-500',
      'active:scale-[0.98] active:shadow-[0_0_0_2px_var(--color-vermillion-500),0_2px_8px_rgba(199,61,61,0.25)]',
    ),
  };

  // Disabled styles
  const disabledStyles = isDisabled ? 'opacity-50 cursor-not-allowed pointer-events-none' : 'cursor-pointer';

  const buttonClasses = cn(baseStyles, variantStyles[variant], disabledStyles, fullWidth && 'w-full', className);

  return (
    <button type={type} className={buttonClasses} disabled={isDisabled} {...props}>
      {loading && (
        <span data-testid="loading-spinner" className="inline-block animate-spin" aria-hidden="true">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
          </svg>
        </span>
      )}
      {children}
    </button>
  );
}
