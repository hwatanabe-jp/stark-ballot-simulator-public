'use client';

import { useCallback } from 'react';
import { joinClassNames } from '@stark-ballot/web/shared/classNames';
import type { Language } from '@stark-ballot/web/hooks/useLanguage';
import { t } from '@stark-ballot/web/i18n';
import { AppLink, useAppPathname } from '@stark-ballot/web/navigation/appNavigation';
import './StepIndicatorHorizontal.css';

interface StepIndicatorHorizontalProps {
  currentStep?: number;
  language?: Language;
  className?: string;
  onReset?: () => void;
}

interface Step {
  id: string;
  label: string;
  labelEn: string;
  path: string;
}

const steps = [
  { id: 'home', label: 'ホーム', labelEn: 'Home', path: '/' },
  { id: 'vote', label: '投票', labelEn: 'Vote', path: '/vote' },
  { id: 'aggregate', label: '集計', labelEn: 'Aggregate', path: '/aggregate' },
  { id: 'result', label: '結果', labelEn: 'Result', path: '/result' },
  { id: 'verify', label: '検証', labelEn: 'Verify', path: '/verify' },
] satisfies ReadonlyArray<Step>;

type StepStatus = 'pending' | 'active' | 'completed';

export function StepIndicatorHorizontal({
  currentStep,
  language = 'ja',
  className,
  onReset,
}: StepIndicatorHorizontalProps): React.ReactElement {
  const pathname = useAppPathname();
  const normalizePath = (path: string): string => {
    if (path.length > 1 && path.endsWith('/')) {
      return path.slice(0, -1);
    }
    return path;
  };

  const isStepMatch = (path: string, stepPath: string): boolean => {
    if (stepPath === '/') {
      return path === '/';
    }
    return path === stepPath || path.startsWith(`${stepPath}/`);
  };

  const getCurrentStepIndex = (): number => {
    const normalizedPath = normalizePath(pathname);
    const index = steps.findIndex((step) => isStepMatch(normalizedPath, step.path));
    return index >= 0 ? index : 0;
  };

  const derivedIndex = getCurrentStepIndex();
  const currentStepIndex = currentStep ?? derivedIndex;

  const getStepStatus = (index: number): StepStatus => {
    if (index < currentStepIndex) return 'completed';
    if (index === currentStepIndex) return 'active';
    return 'pending';
  };

  const handleHomeClick = useCallback(() => {
    if (onReset && window.confirm(t(language, 'actions.resetConfirm'))) {
      onReset();
    }
  }, [language, onReset]);

  return (
    <nav
      className={joinClassNames('step-indicator', className)}
      aria-label="Progress navigation"
      data-testid="step-indicator"
    >
      <ol className="step-indicator__list" role="list">
        {steps.map((step, index) => {
          const status = getStepStatus(index);
          const isCompleted = status === 'completed';
          const isHome = step.id === 'home';
          const canNavigateHome = isCompleted && isHome && onReset;

          return (
            <li key={step.id} className="step-indicator__item" data-step-id={step.id} data-status={status}>
              {canNavigateHome ? (
                <button type="button" onClick={handleHomeClick} className="step-indicator__link">
                  <span className="step-indicator__label">{language === 'ja' ? step.label : step.labelEn}</span>
                </button>
              ) : isCompleted ? (
                <AppLink href={step.path} className="step-indicator__link">
                  <span className="step-indicator__label">{language === 'ja' ? step.label : step.labelEn}</span>
                </AppLink>
              ) : (
                <div className="step-indicator__link" aria-current={status === 'active' ? 'step' : undefined}>
                  <span className="step-indicator__label">{language === 'ja' ? step.label : step.labelEn}</span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
