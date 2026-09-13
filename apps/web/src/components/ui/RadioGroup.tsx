import React, { useId } from 'react';
import './RadioGroup.css';

export interface RadioOption<Value extends string = string> {
  value: Value;
  label: string;
  description?: string;
  testId?: string;
}

export interface RadioGroupProps<Value extends string = string> {
  name: string;
  options: readonly RadioOption<Value>[];
  // Only the options determine which values are allowed.
  value: NoInfer<Value> | '';
  onChange: (value: NoInfer<Value>) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
}

export function RadioGroup<Value extends string>({
  name,
  options,
  value,
  onChange,
  disabled = false,
  className = '',
  label,
}: RadioGroupProps<Value>): React.ReactElement {
  const groupId = useId();
  return (
    <div role="radiogroup" aria-label={label} className={`ui-radio-group ${className}`}>
      {options.map((option) => (
        <label key={option.value} className="ui-radio-group__option" data-testid={option.testId}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => {
              if (!disabled) onChange(option.value);
            }}
            disabled={disabled}
            aria-labelledby={`${groupId}-${option.value}-label`}
            aria-describedby={option.description ? `${groupId}-${option.value}-desc` : undefined}
          />
          <span className="ui-radio-group__copy">
            <span id={`${groupId}-${option.value}-label`} className="ui-radio-group__label">
              {option.label}
            </span>
            {option.description && (
              <span id={`${groupId}-${option.value}-desc`} className="ui-radio-group__description">
                {option.description}
              </span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}
