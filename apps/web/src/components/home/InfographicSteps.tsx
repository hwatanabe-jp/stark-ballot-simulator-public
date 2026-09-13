'use client';

import { useTranslation } from '@stark-ballot/web/hooks';
import { INFOGRAPHIC_STEP_KEYS } from '@stark-ballot/web/i18n/dynamic-keys';

export function InfographicSteps(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <details className="home-disclosure">
      <summary>
        <h2>{t('infographic.steps.heading')}</h2>
      </summary>
      <ol className="home-steps">
        {INFOGRAPHIC_STEP_KEYS.map((key, index) => (
          <li key={key}>
            <span className="home-step-number" aria-hidden="true">
              {index + 1}
            </span>
            <div>
              <h3>{t(`infographic.steps.${key}.label`)}</h3>
              <p>{t(`infographic.steps.${key}.brief`)}</p>
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}
