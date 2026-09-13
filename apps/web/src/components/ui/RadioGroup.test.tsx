import { render, screen, within } from '@testing-library/react';
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

  it('disables every option and prevents changes when disabled', async () => {
    const handleChange = vi.fn();
    const user = userEvent.setup();

    render(<RadioGroup name="test" options={options} value="A" onChange={handleChange} disabled />);

    screen.getAllByRole('radio').forEach((radio) => {
      expect(radio).toBeDisabled();
    });
    await user.click(screen.getByLabelText('Option B'));

    expect(handleChange).not.toHaveBeenCalled();
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

  it('allows keyboard focus and selection with native radios', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<RadioGroup name="test" options={options} value="" onChange={onChange} />);
    await user.tab();
    expect(screen.getByLabelText('Option A')).toHaveFocus();
    await user.keyboard('[ArrowDown]');
    expect(screen.getByLabelText('Option B')).toHaveFocus();
    expect(onChange).toHaveBeenCalledWith('B');
  });

  it('keeps labels and descriptions scoped to each instance in separate forms', () => {
    render(
      <>
        <form>
          <RadioGroup
            name="choice"
            label="First ballot"
            options={[{ value: 'A', label: 'First choice', description: 'First description' }]}
            value=""
            onChange={() => {}}
          />
        </form>
        <form>
          <RadioGroup
            name="choice"
            label="Second ballot"
            options={[{ value: 'A', label: 'Second choice', description: 'Second description' }]}
            value=""
            onChange={() => {}}
          />
        </form>
      </>,
    );

    const first = within(screen.getByRole('radiogroup', { name: 'First ballot' })).getByRole('radio');
    const second = within(screen.getByRole('radiogroup', { name: 'Second ballot' })).getByRole('radio');
    expect(first).toHaveAccessibleName('First choice');
    expect(first).toHaveAccessibleDescription('First description');
    expect(second).toHaveAccessibleName('Second choice');
    expect(second).toHaveAccessibleDescription('Second description');
  });
});
