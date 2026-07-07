'use client';

import { useState, useCallback } from 'react';
import { Button } from '@stark-ballot/web/components/ui/Button';
import { TurnstileWidget } from '@stark-ballot/web/components/security/TurnstileWidget';
import { isBrowserTurnstileRequiredForAction } from '@stark-ballot/web/components/security/turnstilePolicy';
import { InlineAlert } from '@stark-ballot/web/components/ui/InlineAlert';
import { RadioGroup } from '@stark-ballot/web/components/ui/RadioGroup';
import { useTranslation } from '@stark-ballot/web/hooks';
import { generateCommitment } from '@stark-ballot/web/vote/commitment';
import { getSessionAuthHeaders, getSessionData, saveSessionData } from '@stark-ballot/web/session';
import { saveKnowledgeData } from '@stark-ballot/web/knowledge';
import type { VoteChoice } from '@stark-ballot/web/session/types';
import { isValidVoteId } from '@stark-ballot/web/vote/voteIdValidation';
import { isValidHexString } from '@stark-ballot/verification/shared/hex';
import { resolveApiUrl } from '@stark-ballot/web/api/apiBaseUrl';
import { apiFetch } from '@stark-ballot/web/api/apiFetch';
import { VoteResponseSchema } from '@stark-ballot/api-contract/validation/apiSchemas';
import {
  admitApiResponse,
  readApiJson,
  readStandardApiError,
  readStandardApiErrorCode,
} from '@stark-ballot/web/api/responseAdmission';

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
      saveKnowledgeData({ 'user.choice': value });
      scrollToBottom();
    },
    [scrollToBottom],
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
      const sessionData = getSessionData();
      if (!sessionData?.sessionId) {
        throw new Error('Session not found');
      }
      const sessionAuthHeaders = getSessionAuthHeaders(sessionData);
      if (!sessionAuthHeaders['X-Session-ID'] || !sessionAuthHeaders['X-Session-Capability']) {
        throw new Error('Session not found');
      }
      if (!sessionData.electionId) {
        throw new Error('Election ID missing');
      }

      // Generate commitment
      const { commitment, randomValue } = await generateCommitment(selectedOption, sessionData.electionId);

      // Save vote data to session
      saveSessionData({
        myVote: selectedOption,
        myCommit: commitment,
        myRand: randomValue,
      });

      // Submit vote to API
      const response = await apiFetch(resolveApiUrl('/api/vote'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...sessionAuthHeaders,
        },
        body: JSON.stringify({
          commitment,
          vote: selectedOption,
          rand: randomValue,
          ...(turnstileToken ? { turnstileToken } : {}),
        }),
      });

      if (!response.ok) {
        const errorPayload = await readStandardApiError(response);

        if (readStandardApiErrorCode(errorPayload) === 'CAPTCHA_FAILED') {
          const msg = t('errors.captchaFailed');
          setError(msg);
          setTurnstileToken(null);
          onError?.(msg);
          return;
        }
        throw new Error('API error');
      }

      const payload = admitApiResponse(VoteResponseSchema, await readApiJson(response), 'vote response');
      const { voteId, bulletinIndex, bulletinRootAtCast, timestamp: voteTimestamp } = payload.data;

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
      saveSessionData({
        voteId,
        bulletinIndex,
        bulletinRootAtCast,
      });

      // Update knowledge store with vote info (after API success)
      saveKnowledgeData({
        'user.choice': selectedOption,
        'user.random': randomValue,
        'user.commitment': commitment,
        'user.voteId': voteId,
        'user.bulletinIndex': bulletinIndex,
        'user.bulletinRootAtCast': bulletinRootAtCast,
        ...(typeof voteTimestamp === 'number' ? { 'user.voteTimestamp': voteTimestamp } : {}),
      });

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
