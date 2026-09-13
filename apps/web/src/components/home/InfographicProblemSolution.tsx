'use client';

import { useTranslation } from '@stark-ballot/web/hooks';

export function InfographicProblemSolution(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <dl className="home-comparison">
      <div>
        <dt>{t('infographic.problemSolution.traditional.title')}</dt>
        <dd>{t('infographic.problemSolution.traditional.description')}</dd>
      </div>
      <div>
        <dt>{t('infographic.problemSolution.starkBallot.title')}</dt>
        <dd>{t('infographic.problemSolution.starkBallot.description')}</dd>
      </div>
    </dl>
  );
}
