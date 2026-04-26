'use client';

import { Vote, Calculator, BarChart3, ShieldCheck, ChevronRight } from 'lucide-react';
import { useTranslation } from '@/lib/hooks';
import { INFOGRAPHIC_STEP_KEYS } from '@/lib/i18n/dynamic-keys';

interface InfographicStepsProps {
  style?: React.CSSProperties;
}

const STEP_ICONS: Record<(typeof INFOGRAPHIC_STEP_KEYS)[number], typeof Vote> = {
  vote: Vote,
  aggregate: Calculator,
  result: BarChart3,
  verify: ShieldCheck,
};

const steps = INFOGRAPHIC_STEP_KEYS.map((key, index) => ({
  key,
  Icon: STEP_ICONS[key],
  delay: `${index * 100}ms`,
}));

export function InfographicSteps({ style }: InfographicStepsProps): React.ReactElement {
  const { t } = useTranslation();

  return (
    <div className="animate-slide-in-up" style={style}>
      {/* Heading */}
      <h2 className="font-display text-base sm:text-lg text-ink-900 font-medium mb-6">
        {t('infographic.steps.heading')}
      </h2>

      {/* Steps flow - 2x2 grid on mobile, horizontal on desktop */}
      <div className="grid grid-cols-2 sm:flex sm:flex-row sm:items-start gap-4 sm:gap-3">
        {steps.map(({ key, Icon, delay }, index) => (
          <div key={key} className="sm:contents">
            {/* Step card */}
            <div
              className="flex flex-col items-center gap-2 animate-slide-in-up sm:flex-1"
              style={{ animationDelay: delay }}
            >
              {/* Step number and icon */}
              <div className="relative">
                <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-ink-100 border border-ink-200 flex items-center justify-center">
                  <Icon className="w-5 h-5 sm:w-6 sm:h-6 text-ink-600" />
                </div>
                <span className="absolute -inset-bs-1 -inset-e-1 w-5 h-5 rounded-full bg-ink-900 text-white text-xs font-medium flex items-center justify-center">
                  {index + 1}
                </span>
              </div>

              {/* Label and brief */}
              <div className="text-center">
                <p className="font-primary text-sm sm:text-base font-medium text-ink-800">
                  {t(`infographic.steps.${key}.label`)}
                </p>
                <p className="font-primary text-xs sm:text-sm text-text-secondary leading-tight">
                  {t(`infographic.steps.${key}.brief`)}
                </p>
              </div>
            </div>

            {/* Arrow connector (desktop only) */}
            {index < steps.length - 1 && (
              <ChevronRight className="hidden sm:block w-5 h-5 text-ink-300 flex-shrink-0 mt-4" aria-hidden="true" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
