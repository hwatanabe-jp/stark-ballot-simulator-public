'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { BotVotingProgress } from '@/components/vote/BotVotingProgress';
import { VoteForm } from '@/components/vote/VoteForm';
import { useTranslation } from '@/lib/hooks';

export default function VotePage(): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
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
    <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="font-display text-[var(--text-display)] font-bold text-ink-900 mb-3 tracking-[var(--tracking-display)] leading-[var(--leading-display)]">
          {t('pages.vote.title')}
        </h1>
        <p className="font-secondary text-text-secondary leading-relaxed">{t('pages.vote.overview')}</p>
      </div>

      {/* Vote Selection Card */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="font-primary text-xl text-ink-800">{t('pages.vote.selectionTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <VoteForm
            onVoteComplete={() => {
              handleVoteComplete();
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
