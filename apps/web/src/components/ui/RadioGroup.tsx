import React from 'react';

/**
 * RadioGroup - 「透明な信頼」デザインシステム
 *
 * 投票選択UIとして設計。選択時はbox-shadowで強調（レイアウトシフト回避）。
 * インジケーターは20pxの円形、選択時に墨色で塗りつぶし。
 */

export interface RadioOption {
  value: string;
  label: string;
  description?: string;
  testId?: string;
}

export interface RadioGroupProps {
  name: string;
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
}

const cn = (...classes: Array<string | false | undefined>): string => {
  return classes.filter(Boolean).join(' ');
};

export function RadioGroup({
  name,
  options,
  value,
  onChange,
  disabled = false,
  className,
  label,
}: RadioGroupProps): React.ReactElement {
  const handleChange = (optionValue: string) => {
    if (!disabled) {
      onChange(optionValue);
    }
  };

  const getOptionClasses = (isSelected: boolean) => {
    return cn(
      // Base styles
      'block p-4 border rounded-lg cursor-pointer',
      'transition-all duration-150 ease-in-out',
      // Focus state for keyboard navigation
      'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ink-500 has-[:focus-visible]:ring-offset-2',
      // Normal state
      'bg-paper-warm border-paper-border',
      // Hover state
      !isSelected && !disabled && 'hover:border-ink-400 hover:bg-ink-50',
      // Selected state - use box-shadow instead of border-width to avoid layout shift
      isSelected && 'bg-ink-50 border-ink-600 shadow-[0_0_0_1px_var(--color-ink-600)]',
      // Disabled state
      disabled && 'cursor-not-allowed opacity-50',
    );
  };

  return (
    <div role="radiogroup" aria-label={label} className={cn('space-y-3', className)}>
      {options.map((option) => {
        const isSelected = value === option.value;

        return (
          <label key={option.value} className={getOptionClasses(isSelected)} data-testid={option.testId}>
            <div className="flex items-start gap-3">
              {/* Custom radio indicator */}
              <div
                className={cn(
                  'relative flex-shrink-0 mt-0.5',
                  'w-5 h-5 rounded-full',
                  'border-2 transition-colors duration-150',
                  isSelected ? 'border-ink-600' : 'border-ink-400',
                )}
              >
                {/* Inner dot */}
                {isSelected && <div className={cn('absolute inset-1', 'bg-ink-600 rounded-full', 'animate-fade-in')} />}
              </div>

              {/* Hidden native radio for accessibility */}
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={isSelected}
                onChange={() => handleChange(option.value)}
                disabled={disabled}
                className="sr-only"
                aria-describedby={option.description ? `${name}-${option.value}-desc` : undefined}
              />

              {/* Label content */}
              <div className="flex-1 min-w-0">
                <div className="font-secondary text-sm font-medium text-text-primary">{option.label}</div>
                {option.description && (
                  <div id={`${name}-${option.value}-desc`} className="text-sm text-text-secondary mt-1">
                    {option.description}
                  </div>
                )}
              </div>
            </div>
          </label>
        );
      })}
    </div>
  );
}
