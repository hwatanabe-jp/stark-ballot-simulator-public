'use client';

import { Box, ShieldCheck } from 'lucide-react';
import { useTranslation } from '@/lib/hooks';

interface InfographicProblemSolutionProps {
  style?: React.CSSProperties;
}

export function InfographicProblemSolution({ style }: InfographicProblemSolutionProps): React.ReactElement {
  const { t } = useTranslation();

  return (
    <div className="animate-slide-in-up" style={style}>
      {/* Heading */}
      <h2 className="font-display text-base sm:text-lg text-ink-900 font-medium mb-6">
        {t('infographic.problemSolution.heading')}
      </h2>

      {/* Two-column comparison - always 2 columns */}
      <div className="grid grid-cols-2 gap-4 sm:gap-8">
        {/* Traditional voting */}
        <div className="flex flex-col items-center text-center">
          <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-ink-100 border border-ink-200 flex items-center justify-center mb-2 sm:mb-3">
            <Box className="w-5 h-5 sm:w-6 sm:h-6 text-ink-500" />
          </div>
          <h3 className="font-primary text-sm sm:text-base font-medium text-ink-800 mb-1">
            {t('infographic.problemSolution.traditional.title')}
          </h3>
          <p className="font-primary text-xs sm:text-sm text-text-secondary leading-tight">
            {t('infographic.problemSolution.traditional.description')}
          </p>
        </div>

        {/* STARK Ballot Simulator */}
        <div className="flex flex-col items-center text-center">
          <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-verified-50 border border-verified-200 flex items-center justify-center mb-2 sm:mb-3">
            <ShieldCheck className="w-5 h-5 sm:w-6 sm:h-6 text-verified-500" />
          </div>
          <h3 className="font-primary text-sm sm:text-base font-medium text-ink-800 mb-1">
            {t('infographic.problemSolution.starkBallot.title')}
          </h3>
          <p className="font-primary text-xs sm:text-sm text-text-secondary leading-tight">
            {t('infographic.problemSolution.starkBallot.description')}
          </p>
        </div>
      </div>
    </div>
  );
}
