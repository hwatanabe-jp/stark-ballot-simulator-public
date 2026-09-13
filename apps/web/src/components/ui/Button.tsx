import React from 'react';
import { joinClassNames } from '@stark-ballot/web/shared/classNames';
import './Button.css';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant: 'secondary' | 'verify';
  loading?: boolean;
  fullWidth?: boolean;
  children: React.ReactNode;
}

export function Button({
  variant,
  loading = false,
  fullWidth = false,
  disabled,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps): React.ReactElement {
  const isDisabled = disabled || loading;

  const buttonClasses = joinClassNames(
    'ui-button',
    `ui-button--${variant}`,
    fullWidth && 'ui-button--full-width',
    className,
  );

  return (
    <button type={type} className={buttonClasses} disabled={isDisabled} {...props}>
      {loading && (
        <span data-testid="loading-spinner" className="ui-button__spinner" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
          </svg>
        </span>
      )}
      {children}
    </button>
  );
}
