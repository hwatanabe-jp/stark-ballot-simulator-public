'use client';

import { useCallback } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Language } from '@/lib/hooks/useLanguage';
import { t } from '@/lib/i18n';

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
  path: Route;
}

const steps = [
  { id: 'home', label: 'ホーム', labelEn: 'Home', path: '/' },
  { id: 'vote', label: '投票', labelEn: 'Vote', path: '/vote' },
  { id: 'aggregate', label: '集計', labelEn: 'Aggregate', path: '/aggregate' },
  { id: 'result', label: '結果', labelEn: 'Result', path: '/result' },
  { id: 'verify', label: '検証', labelEn: 'Verify', path: '/verify' },
] satisfies ReadonlyArray<Step>;

type StepStatus = 'pending' | 'active' | 'completed';

const cn = (...classes: Array<string | false | undefined>): string => classes.filter(Boolean).join(' ');

export function StepIndicatorHorizontal({
  currentStep,
  language = 'ja',
  className,
  onReset,
}: StepIndicatorHorizontalProps): React.ReactElement {
  const pathname = usePathname();
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
  const newlyCompletedStep = currentStepIndex > 0 ? (steps[currentStepIndex - 1]?.id ?? null) : null;

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

  const renderDot = (status: StepStatus, stepId: string, index: number): React.ReactNode => {
    const isNewlyCompleted = status === 'completed' && newlyCompletedStep === stepId;
    return (
      <div
        className={cn('step-dot', status, status === 'completed' && isNewlyCompleted && 'animate-step-complete-subtle')}
      >
        {status === 'completed' ? (
          <svg
            className={cn('w-3.5 h-3.5', isNewlyCompleted && 'animate-check-subtle')}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          index + 1
        )}
      </div>
    );
  };

  return (
    <nav
      className={cn('step-indicator-horizontal', className)}
      aria-label="Progress navigation"
      data-testid="step-indicator"
    >
      <ol className="step-list" role="list">
        {steps.map((step, index) => {
          const status = getStepStatus(index);
          const isCompleted = status === 'completed';
          const isHome = step.id === 'home';
          const canNavigateHome = isCompleted && isHome && onReset;

          return (
            <li key={step.id} className={cn('step-item', status)} data-step-id={step.id} data-status={status}>
              {canNavigateHome ? (
                <button type="button" onClick={handleHomeClick} className="step-link">
                  {renderDot(status, step.id, index)}
                  <span className="step-label">{language === 'ja' ? step.label : step.labelEn}</span>
                </button>
              ) : isCompleted ? (
                <Link href={step.path} className="step-link">
                  {renderDot(status, step.id, index)}
                  <span className="step-label">{language === 'ja' ? step.label : step.labelEn}</span>
                </Link>
              ) : (
                <div
                  className={cn('step-link', status === 'pending' && 'opacity-60')}
                  aria-current={status === 'active' ? 'step' : undefined}
                >
                  {renderDot(status, step.id, index)}
                  <span className="step-label">{language === 'ja' ? step.label : step.labelEn}</span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
