import type { UseTranslationResult } from '@stark-ballot/web/hooks/useTranslation';
import type { VerificationSummaryResult } from '@stark-ballot/verification/summary';
import { t, type TranslationKey } from './index';

const leaf = 'common.start' satisfies TranslationKey;
t('ja', leaf);
t('en', 'pages.result.tally.totalVotes', { total: 5 });

// @ts-expect-error Misspelled leaves must not fall through a string overload.
t('ja', 'common.strat');
// @ts-expect-error Dictionary objects are not translatable strings.
t('ja', 'pages.verify');
// @ts-expect-error Unchecked string-array paths are not part of the translation contract.
t('ja', ['common', 'start']);

function assertHookTranslationKeys(
  translate: UseTranslationResult['t'],
  uncheckedKey: string,
  summary: VerificationSummaryResult,
): void {
  translate(leaf);
  if (summary.messageKey) {
    translate(summary.messageKey);
  }
  // @ts-expect-error Hook consumers retain the same closed key type.
  translate('common.strat');
  // @ts-expect-error Hook consumers cannot translate object nodes.
  translate('pages.verify');
  // @ts-expect-error An arbitrary string has not been admitted as a translation key.
  translate(uncheckedKey);
  // @ts-expect-error The standalone translator also rejects arbitrary strings.
  t('ja', uncheckedKey);
}

void assertHookTranslationKeys;
