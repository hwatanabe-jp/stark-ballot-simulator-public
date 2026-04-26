import React from 'react';

/**
 * Badge - 「透明な信頼」デザインシステム
 *
 * Variants:
 * - verified: 検証成功（落ち着いた青緑）
 * - warning: 警告（山吹色）
 * - error: エラー（深い赤）
 * - info: 情報（薄い藍）
 * - default: デフォルト（墨色）
 * - stamp: 印鑑スタイル（朱色、回転）
 */

export type BadgeVariant = 'verified' | 'error' | 'warning' | 'info' | 'default' | 'stamp';
export type BadgeSize = 'small' | 'medium' | 'large';

export interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  size?: BadgeSize;
  icon?: boolean;
  className?: string;
}

const cn = (...classes: Array<string | false | undefined>): string => {
  return classes.filter(Boolean).join(' ');
};

const variantStyles: Record<BadgeVariant, string> = {
  verified: 'bg-verified-100 text-verified-700 border-verified-500',
  error: 'bg-error-100 text-error-700 border-error-500',
  warning: 'bg-warning-100 text-warning-700 border-warning-500',
  info: 'bg-info-100 text-info-600 border-info-500',
  default: 'bg-ink-100 text-ink-700 border-ink-300',
  stamp: cn(
    'bg-vermillion-100 text-vermillion-700 border-vermillion-500',
    'border-2 rounded-lg',
    'transform -rotate-2',
    'font-semibold',
  ),
} as const;

const sizeStyles: Record<BadgeSize, string> = {
  small: 'text-xs px-2 py-0.5',
  medium: 'text-[0.8125rem] px-3 py-1',
  large: 'text-sm px-4 py-1.5',
} as const;

const IconCheck = (): React.ReactElement => (
  <svg
    className="w-3.5 h-3.5"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M5 13l4 4L19 7" />
  </svg>
);

const IconX = (): React.ReactElement => (
  <svg
    className="w-3.5 h-3.5"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

const IconWarning = (): React.ReactElement => (
  <svg
    className="w-3.5 h-3.5"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 9v4M12 17h.01" />
    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
  </svg>
);

const IconInfo = (): React.ReactElement => (
  <svg
    className="w-3.5 h-3.5"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </svg>
);

const iconMap: Record<BadgeVariant, React.ReactElement | null> = {
  verified: <IconCheck />,
  error: <IconX />,
  warning: <IconWarning />,
  info: <IconInfo />,
  default: null,
  stamp: <IconCheck />,
} as const;

const baseStyles = cn('inline-flex items-center gap-1', 'rounded-full border', 'font-secondary font-medium');

export function Badge({
  children,
  variant = 'default',
  size = 'medium',
  icon = false,
  className,
}: BadgeProps): React.ReactElement {
  const showIcon = icon && iconMap[variant] !== null;
  const isStamp = variant === 'stamp';

  return (
    <span
      role="status"
      className={cn(
        baseStyles,
        variantStyles[variant],
        sizeStyles[size],
        // Stamp variant has its own rounded style
        isStamp && 'rounded-lg',
        className,
      )}
    >
      {showIcon && (
        <span data-testid={`badge-icon-${variant}`} aria-hidden="true">
          {iconMap[variant]}
        </span>
      )}
      {children}
    </span>
  );
}

// Legacy alias for backwards compatibility
export type { BadgeVariant as BadgeVariantType };
