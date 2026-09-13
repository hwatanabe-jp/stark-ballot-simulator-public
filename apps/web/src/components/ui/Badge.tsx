import React from 'react';
import { joinClassNames } from '@stark-ballot/web/shared/classNames';

/**
 * Badge - semantic status label
 *
 * Variants:
 * - verified: 検証成功
 * - warning: 警告
 * - error: エラー
 * - info: 情報
 * - default: デフォルト
 */

export type BadgeVariant = 'verified' | 'error' | 'warning' | 'info' | 'default';
export type BadgeSize = 'small' | 'medium' | 'large';

export interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  size?: BadgeSize;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  verified: 'bg-verified-100 text-verified-700 border-verified-500',
  error: 'bg-error-100 text-error-700 border-error-500',
  warning: 'bg-warning-100 text-warning-700 border-warning-500',
  info: 'bg-info-100 text-info-600 border-info-500',
  default: 'bg-ink-100 text-ink-700 border-ink-300',
} as const;

const sizeStyles: Record<BadgeSize, string> = {
  small: 'text-xs px-2 py-0.5',
  medium: 'text-[0.8125rem] px-3 py-1',
  large: 'text-sm px-4 py-1.5',
} as const;

const baseStyles = joinClassNames(
  'inline-flex items-center gap-1',
  'rounded-full border',
  'font-secondary font-medium',
);

export function Badge({ children, variant = 'default', size = 'medium', className }: BadgeProps): React.ReactElement {
  return (
    <span role="status" className={joinClassNames(baseStyles, variantStyles[variant], sizeStyles[size], className)}>
      {children}
    </span>
  );
}
