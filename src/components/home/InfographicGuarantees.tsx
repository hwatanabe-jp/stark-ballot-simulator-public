'use client';

import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { useTranslation } from '@/lib/hooks';
import { INFOGRAPHIC_GUARANTEE_KEYS } from '@/lib/i18n/dynamic-keys';

interface InfographicGuaranteesProps {
  style?: React.CSSProperties;
}

const guaranteeKeys = INFOGRAPHIC_GUARANTEE_KEYS;

export function InfographicGuarantees({ style }: InfographicGuaranteesProps): React.ReactElement {
  const { t } = useTranslation();

  return (
    <div className="animate-slide-in-up" style={style}>
      {/* Two-column layout: Guarantees + Tamper Demo */}
      <div className="grid sm:grid-cols-2 gap-6">
        {/* Left: Verification Guarantees */}
        <div>
          <h2 className="font-display text-base sm:text-lg text-ink-900 font-medium mb-4">
            {t('infographic.guarantees.heading')}
          </h2>

          {/* Checklist */}
          <ul className="space-y-3">
            {guaranteeKeys.map((key) => (
              <li key={key} className="flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-verified-500 mt-0.5 flex-shrink-0" />
                <span className="font-primary text-sm text-text-secondary">
                  {t(`infographic.guarantees.items.${key}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Right: Tamper Demo */}
        <div>
          <h2 className="font-display text-base sm:text-lg text-ink-900 font-medium mb-4">
            {t('infographic.tamperDemo.heading')}
          </h2>

          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-warning-500 mt-0.5 flex-shrink-0" />
            <p className="font-primary text-sm text-text-secondary">{t('infographic.tamperDemo.description')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
