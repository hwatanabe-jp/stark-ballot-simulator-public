import { RadioGroup } from './RadioGroup';

const options = [
  { value: 'A', label: 'Option A' },
  { value: 'B', label: 'Option B' },
] as const;

RadioGroup({
  name: 'choice',
  options,
  value: 'A',
  onChange: (value) => {
    void (value satisfies 'A' | 'B');
  },
});

RadioGroup({ name: 'choice', options, value: '', onChange: () => {} });

RadioGroup({
  name: 'choice',
  options,
  // @ts-expect-error The selected value cannot add an option to the declared choices.
  value: 'Z',
  onChange: () => {},
});

RadioGroup({
  name: 'choice',
  options,
  // @ts-expect-error A wider callback cannot admit an undeclared selected value.
  value: 'Z',
  onChange: (value: string) => {
    void value;
  },
});

RadioGroup({
  name: 'choice',
  options,
  value: 'A',
  // @ts-expect-error The handler must accept every declared choice.
  onChange: (value: 'A') => {
    void value;
  },
});
