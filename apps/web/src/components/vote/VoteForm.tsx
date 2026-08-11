'use client';

import { useState, useCallback } from 'react';
import { Button } from '@stark-ballot/web/components/ui/Button';
import { TurnstileWidget } from '@stark-ballot/web/components/security/TurnstileWidget';
import { isBrowserTurnstileRequiredForAction } from '@stark-ballot/web/components/security/turnstilePolicy';
import { InlineAlert } from '@stark-ballot/web/components/ui/InlineAlert';
import { RadioGroup } from '@stark-ballot/web/components/ui/RadioGroup';
import { useTranslation } from '@stark-ballot/web/hooks';
import { generateCommitment } from '@stark-ballot/web/vote/commitment';
import {
  captureSessionIdentity,
  getSessionDataForIdentity,
  saveSessionDataForIdentity,
} from '@stark-ballot/web/session';
import { saveKnowledgeData } from '@stark-ballot/web/knowledge';
import type { VoteChoice } from '@stark-ballot/web/session/types';
import { isValidVoteId } from '@stark-ballot/web/vote/voteIdValidation';
import { isValidHexString } from '@stark-ballot/crypto-primitives';
import { submitVote } from '@stark-ballot/web/api/votes';
import { resolveApiClientErrorCode } from '@stark-ballot/web/api/client';

interface VoteFormProps {
  /** Callback when vote is successfully submitted */
  onVoteComplete: (result: VoteResult) => void;
  /** Callback when an error occurs */
  onError?: (error: string) => void;
}

interface VoteResult {
  voteId: string;
  bulletinIndex: number;
  bulletinRootAtCast: string;
  commitment: string;
}

const VOTE_OPTIONS: VoteChoice[] = ['A', 'B', 'C', 'D', 'E'];

/**
 * Vote form component with option selection, Turnstile verification, and submission
 *
 * Handles:
 * - Vote choice selection (A-E)
 * - Commitment generation (SHA-256)
 * - Turnstile CAPTCHA verification
 * - API submission
 * - Session and knowledge store updates
 */
export function VoteForm({ onVoteComplete, onError }: VoteFormProps): React.ReactElement {
  const { t } = useTranslation();
  const [mountedSessionIdentity] = useState(() => captureSessionIdentity());
  const [selectedOption, setSelectedOption] = useState<VoteChoice | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const requireVoteTurnstile = isBrowserTurnstileRequiredForAction('vote');

  const scrollToBottom = useCallback((): void => {
    if (typeof window === 'undefined') {
      return;
    }
    const prefersReducedMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior: ScrollBehavior = prefersReducedMotion ? 'auto' : 'smooth';
    window.setTimeout(() => {
      try {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
      } catch {
        // no-op
      }
    }, 60);
  }, []);

  const handleOptionChange = useCallback(
    (value: VoteChoice) => {
      setSelectedOption(value);
      setError(null);
      if (mountedSessionIdentity) {
        saveKnowledgeData({ 'user.choice': value }, { expectedSessionId: mountedSessionIdentity.sessionId });
      }
      scrollToBottom();
    },
    [mountedSessionIdentity, scrollToBottom],
  );

  const handleSubmit = async () => {
    if (!selectedOption) return;
    if (requireVoteTurnstile && !turnstileToken) {
      const msg = t('errors.captchaFailed');
      setError(msg);
      onError?.(msg);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    let didSucceed = false;

    try {
      if (!mountedSessionIdentity) {
        throw new Error('Session not found');
      }
      const sessionData = getSessionDataForIdentity(mountedSessionIdentity);
      if (!sessionData?.sessionId) {
        throw new Error('Session not found');
      }
      if (!sessionData.capabilityToken) throw new Error('Session not found');
      if (!sessionData.electionId) {
        throw new Error('Election ID missing');
      }

      // Generate commitment
      const { commitment, randomValue } = await generateCommitment(selectedOption, sessionData.electionId);
      const sessionDataBeforeSubmit = getSessionDataForIdentity(mountedSessionIdentity);
      if (!sessionDataBeforeSubmit) {
        throw new Error('Session not found');
      }

      // Save vote data to session
      saveSessionDataForIdentity(mountedSessionIdentity, {
        myVote: selectedOption,
        myCommit: commitment,
        myRand: randomValue,
      });

      // Submit vote to API
      let result;
      try {
        result = await submitVote(sessionDataBeforeSubmit, {
          commitment,
          vote: selectedOption,
          rand: randomValue,
          ...(turnstileToken ? { turnstileToken } : {}),
        });
        if (!getSessionDataForIdentity(mountedSessionIdentity)) {
          throw new Error('Session not found');
        }
      } catch (requestError) {
        if (resolveApiClientErrorCode(requestError) === 'CAPTCHA_FAILED') {
          const msg = t('errors.captchaFailed');
          setError(msg);
          setTurnstileToken(null);
          onError?.(msg);
          return;
        }
        throw requestError;
      }

      const { voteId, bulletinIndex, bulletinRootAtCast, castAtMs } = result;

      // Validate response
      if (
        !voteId ||
        !isValidVoteId(voteId) ||
        bulletinIndex < 0 ||
        !bulletinRootAtCast ||
        !isValidHexString(bulletinRootAtCast)
      ) {
        throw new Error('Invalid vote response');
      }

      // Save vote receipt data
      saveSessionDataForIdentity(mountedSessionIdentity, {
        voteId,
        bulletinIndex,
        bulletinRootAtCast,
      });

      // Update knowledge store with vote info (after API success)
      saveKnowledgeData(
        {
          'user.choice': selectedOption,
          'user.random': randomValue,
          'user.commitment': commitment,
          'user.voteId': voteId,
          'user.bulletinIndex': bulletinIndex,
          'user.bulletinRootAtCast': bulletinRootAtCast,
          ...(typeof castAtMs === 'number' ? { 'user.castAtMs': castAtMs } : {}),
        },
        { expectedSessionId: mountedSessionIdentity.sessionId },
      );

      // Notify completion
      onVoteComplete({
        voteId,
        bulletinIndex,
        bulletinRootAtCast,
        commitment,
      });
      didSucceed = true;
    } catch (err) {
      let errorMessage: string;
      if (err instanceof Error && err.message === 'Network error') {
        errorMessage = t('errors.network');
      } else if (err instanceof Error && err.message.includes('CAPTCHA')) {
        errorMessage = t('errors.captchaFailed');
      } else {
        errorMessage = t('errors.generic');
      }
      setError(errorMessage);
      onError?.(errorMessage);
    } finally {
      if (!didSucceed) {
        setIsSubmitting(false);
      }
    }
  };

  const getOptionLabel = (option: VoteChoice): string => {
    return t('pages.vote.optionLabel', { option });
  };

  return (
    <div className="space-y-6">
      {/* Vote options */}
      <RadioGroup
        name="vote-option"
        label={t('pages.vote.selectionLabel')}
        options={VOTE_OPTIONS.map((option) => ({
          value: option,
          label: getOptionLabel(option),
          testId: `vote-option-${option}`,
        }))}
        value={selectedOption ?? ''}
        onChange={(value) => handleOptionChange(value as VoteChoice)}
        disabled={isSubmitting}
      />

      {requireVoteTurnstile && (
        <div className="flex justify-center">
          <TurnstileWidget action="vote" onTokenChange={setTurnstileToken} disabled={isSubmitting} />
        </div>
      )}

      {/* Error message */}
      {error && <InlineAlert message={error} variant="error" />}

      {/* Submit button */}
      <Button
        variant="verify"
        onClick={() => void handleSubmit()}
        disabled={!selectedOption || isSubmitting || (requireVoteTurnstile && !turnstileToken)}
        loading={isSubmitting}
        fullWidth
        data-testid="submit-vote"
      >
        {isSubmitting ? t('pages.vote.submitting') : t('pages.vote.submit')}
      </Button>
    </div>
  );
}
