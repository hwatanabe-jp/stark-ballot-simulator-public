'use client';

import { useTranslation } from '@stark-ballot/web/hooks';
import { INFOGRAPHIC_GUARANTEE_KEYS } from '@stark-ballot/web/i18n/dynamic-keys';

export function InfographicGuarantees(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <details className="home-disclosure">
        <summary>
          <h2>{t('infographic.guarantees.heading')}</h2>
        </summary>
        <ul className="home-guarantees">
          {INFOGRAPHIC_GUARANTEE_KEYS.map((key) => (
            <li key={key}>{t(`infographic.guarantees.items.${key}`)}</li>
          ))}
        </ul>
      </details>
      <details className="home-disclosure">
        <summary>
          <h2>{t('infographic.tamperDemo.heading')}</h2>
        </summary>
        <p className="home-tamper-description">{t('infographic.tamperDemo.description')}</p>
      </details>
    </>
  );
}
