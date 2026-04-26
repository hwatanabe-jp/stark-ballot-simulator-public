import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { RadioGroup } from './RadioGroup';

describe('RadioGroup', () => {
  const options = [
    { value: 'A', label: 'Option A' },
    { value: 'B', label: 'Option B' },
    { value: 'C', label: 'Option C' },
    { value: 'D', label: 'Option D' },
    { value: 'E', label: 'Option E' },
  ];

  it('should render all options', () => {
    render(<RadioGroup name="test" options={options} value="" onChange={() => {}} />);

    options.forEach((option) => {
      expect(screen.getByLabelText(option.label)).toBeInTheDocument();
    });
  });

  it('should have correct name attribute on all radio inputs', () => {
    render(<RadioGroup name="test-group" options={options} value="" onChange={() => {}} />);

    const radios = screen.getAllByRole('radio');
    radios.forEach((radio) => {
      expect(radio).toHaveAttribute('name', 'test-group');
    });
  });

  it('should select the option with matching value prop', () => {
    render(<RadioGroup name="test" options={options} value="C" onChange={() => {}} />);

    expect(screen.getByLabelText('Option C')).toBeChecked();
    expect(screen.getByLabelText('Option A')).not.toBeChecked();
  });

  it('should call onChange when option is selected', async () => {
    const handleChange = vi.fn();
    const user = userEvent.setup();

    render(<RadioGroup name="test" options={options} value="A" onChange={handleChange} />);

    await user.click(screen.getByLabelText('Option B'));

    expect(handleChange).toHaveBeenCalledWith('B');
    expect(handleChange).toHaveBeenCalledTimes(1);
  });

  it('should support custom className', () => {
    render(<RadioGroup name="test" options={options} value="" onChange={() => {}} className="custom-class" />);

    const container = screen.getByRole('radiogroup');
    expect(container).toHaveClass('custom-class');
  });

  it('should support disabled state', () => {
    render(<RadioGroup name="test" options={options} value="" onChange={() => {}} disabled />);

    const radios = screen.getAllByRole('radio');
    radios.forEach((radio) => {
      expect(radio).toBeDisabled();
    });
  });

  it('should not call onChange when disabled', async () => {
    const handleChange = vi.fn();
    const user = userEvent.setup();

    render(<RadioGroup name="test" options={options} value="A" onChange={handleChange} disabled />);

    await user.click(screen.getByLabelText('Option B'));

    expect(handleChange).not.toHaveBeenCalled();
  });

  it('should apply proper styling to selected option', () => {
    render(<RadioGroup name="test" options={options} value="B" onChange={() => {}} />);

    const selectedInput = screen.getByLabelText('Option B');
    const selectedLabel = selectedInput.closest('label');
    expect(selectedLabel).toHaveClass('bg-ink-50', 'border-ink-600');
  });

  it('should have proper ARIA attributes', () => {
    render(<RadioGroup name="test" options={options} value="A" onChange={() => {}} label="Choose an option" />);

    const radiogroup = screen.getByRole('radiogroup');
    expect(radiogroup).toHaveAttribute('aria-label', 'Choose an option');
  });

  it('should support custom option rendering with description', () => {
    const optionsWithDescription = [
      { value: 'A', label: 'Option A', description: 'Description for A' },
      { value: 'B', label: 'Option B', description: 'Description for B' },
    ];

    render(<RadioGroup name="test" options={optionsWithDescription} value="" onChange={() => {}} />);

    expect(screen.getByText('Description for A')).toBeInTheDocument();
    expect(screen.getByText('Description for B')).toBeInTheDocument();
  });

  it('should have focus-visible styles for keyboard navigation', () => {
    render(<RadioGroup name="test" options={options} value="" onChange={() => {}} />);

    const firstInput = screen.getByLabelText('Option A');
    const firstLabel = firstInput.closest('label');

    // Label should have has-[:focus-visible] classes for accessibility
    expect(firstLabel).toHaveClass('has-[:focus-visible]:ring-2');
    expect(firstLabel).toHaveClass('has-[:focus-visible]:ring-ink-500');
    expect(firstLabel).toHaveClass('has-[:focus-visible]:ring-offset-2');
  });
});
