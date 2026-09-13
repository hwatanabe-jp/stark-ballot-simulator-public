'use client';

import { useState, useEffect, useCallback } from 'react';
import { BotVotingProgress } from '@stark-ballot/web/components/vote/BotVotingProgress';
import { VoteForm } from '@stark-ballot/web/components/vote/VoteForm';
import { useTranslation } from '@stark-ballot/web/hooks';
import { useAppRouter } from '@stark-ballot/web/navigation/appNavigation';
import '@stark-ballot/web/components/vote/Vote.css';

export default function VotePage(): React.ReactElement {
  const { t } = useTranslation();
  const router = useAppRouter();
  const [isWaiting, setIsWaiting] = useState(false);

  useEffect(() => {
    // Check if hash is #waiting
    const checkHash = () => {
      setIsWaiting(window.location.hash === '#waiting');
    };

    // Initial check
    checkHash();

    // Listen for hash changes
    window.addEventListener('hashchange', checkHash);

    return () => {
      window.removeEventListener('hashchange', checkHash);
    };
  }, []);

  const handleVoteComplete = useCallback(() => {
    setIsWaiting(true);
    if (typeof window !== 'undefined' && window.location.hash !== '#waiting') {
      window.location.hash = '#waiting';
    }
    router.push('/vote#waiting');
  }, [router]);

  // Display animated bot voting progress if hash is #waiting
  if (isWaiting) {
    return <BotVotingProgress autoNavigate={true} />;
  }

  return (
    <div className="vote-page">
      <div className="vote-page__intro">
        <h1>{t('pages.vote.title')}</h1>
      </div>
      <section className="vote-page__selection" aria-labelledby="vote-selection-title">
        <h2 id="vote-selection-title">{t('pages.vote.selectionTitle')}</h2>
        <VoteForm onVoteComplete={handleVoteComplete} />
      </section>
    </div>
  );
}
