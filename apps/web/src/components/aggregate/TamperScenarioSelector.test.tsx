import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { t as translate, type TranslationKey } from '@stark-ballot/web/i18n';
import { TamperScenarioSelector } from './TamperScenarioSelector';

vi.mock('@stark-ballot/web/hooks', () => ({
  useTranslation: () => ({ language: 'ja', t: (key: TranslationKey) => translate('ja', key) }),
}));

describe('TamperScenarioSelector', () => {
  it('retains every supported scenario without exposing internal identifiers', () => {
    const onChange = vi.fn();
    render(<TamperScenarioSelector value={null} onChange={onChange} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => (radio as HTMLInputElement).value)).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);
    for (const radio of radios) expect(radio).not.toBeChecked();
    for (const scenario of ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'])
      expect(screen.queryByText(scenario)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'ランダムエラー注入' }));
    expect(onChange).toHaveBeenCalledWith('S5');
  });

  it('preserves the selected scenario and blocks selection while finalization is active', () => {
    const onChange = vi.fn();
    render(<TamperScenarioSelector value="S4" onChange={onChange} disabled />);
    expect(screen.getByRole('radio', { name: '1体のボットの投票に関する発表結果を改ざんする' })).toBeChecked();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: '改ざんしない' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
