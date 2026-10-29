'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@stark-ballot/web/components/ui/Button';
import { TurnstileWidget } from '@stark-ballot/web/components/security/TurnstileWidget';
import { isBrowserTurnstileRequiredForAction } from '@stark-ballot/web/components/security/turnstilePolicy';
import { InlineAlert } from '@stark-ballot/web/components/ui/InlineAlert';
import { RadioGroup } from '@stark-ballot/web/components/ui/RadioGroup';
import { useTranslation } from '@stark-ballot/web/hooks';
import type { UseTranslationResult } from '@stark-ballot/web/hooks/useTranslation';
import type { SessionIdentity } from '@stark-ballot/web/session';
import type { SessionData } from '@stark-ballot/web/session/types';
import { generateCommitment } from '@stark-ballot/web/vote/commitment';
import {
  captureSessionIdentity,
  getSessionDataForIdentity,
  saveSessionDataForIdentity,
} from '@stark-ballot/web/session';
import { saveKnowledgeData } from '@stark-ballot/web/knowledge';
import type { VoteChoice } from '@stark-ballot/web/session/types';
import { VOTE_CHOICES as VOTE_OPTIONS } from '@stark-ballot/verification/shared/constants';
import { isValidVoteId } from '@stark-ballot/validation/vote-id';
import { isValidHexString } from '@stark-ballot/crypto-primitives';
import { submitVote } from '@stark-ballot/web/api/votes';
import { resolveApiClientErrorCode } from '@stark-ballot/web/api/client';
import './Vote.css';

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

type VoteOpening = { vote: VoteChoice; commitment: string; randomValue: string };
type VoteSubmissionResponse = Awaited<ReturnType<typeof submitVote>>;
type VoteRequestOutcome = { kind: 'received'; result: VoteSubmissionResponse } | { kind: 'ignored' };

function requireVoteSubmissionSession(identity: SessionIdentity | null) {
  if (!identity) {
    throw new Error('Session not found');
  }
  const sessionData = getSessionDataForIdentity(identity);
  if (!sessionData?.sessionId) {
    throw new Error('Session not found');
  }
  if (!sessionData.capabilityToken) throw new Error('Session not found');
  if (!sessionData.electionId) {
    throw new Error('Election ID missing');
  }
  return { identity, sessionData };
}

function savedVoteOpening(session: SessionData | null): VoteOpening | null {
  return session?.myVote !== undefined
    ? { vote: session.myVote, commitment: session.myCommit, randomValue: session.myRand }
    : null;
}

function validateVoteSubmissionResponse(result: VoteSubmissionResponse, commitment: string): void {
  const { voteId, bulletinIndex, bulletinRootAtCast } = result;
  if (
    result.commitment !== commitment ||
    !voteId ||
    !isValidVoteId(voteId) ||
    bulletinIndex < 0 ||
    !bulletinRootAtCast ||
    !isValidHexString(bulletinRootAtCast)
  ) {
    throw new Error('Invalid vote response');
  }
}

function resolveVoteFailureMessage(error: unknown, t: UseTranslationResult['t']): string {
  if (error instanceof Error && error.message === 'Network error') return t('errors.network');
  if (error instanceof Error && error.message.includes('CAPTCHA')) return t('errors.captchaFailed');
  return t('errors.generic');
}

interface VoteSubmissionOptions {
  identity: SessionIdentity | null;
  pendingOpening: VoteOpening | null;
  selectedOption: VoteChoice;
  turnstileToken: string | null;
  controller: AbortController;
  onOpening: (opening: VoteOpening) => void;
  onCaptchaFailure: () => void;
  onVoteComplete: VoteFormProps['onVoteComplete'];
}

async function requestVoteOpening(
  session: SessionData,
  opening: VoteOpening,
  options: VoteSubmissionOptions,
): Promise<VoteRequestOutcome> {
  const { controller, turnstileToken } = options;
  try {
    const result = await submitVote(
      session,
      {
        commitment: opening.commitment,
        vote: opening.vote,
        rand: opening.randomValue,
        ...(turnstileToken ? { turnstileToken } : {}),
      },
      { signal: controller.signal },
    );
    return { kind: 'received', result };
  } catch (error) {
    if (controller.signal.aborted) return { kind: 'ignored' };
    if (resolveApiClientErrorCode(error) === 'CAPTCHA_FAILED') {
      options.onCaptchaFailure();
      return { kind: 'ignored' };
    }
    throw error;
  }
}

function publishVoteReceipt(identity: SessionIdentity, opening: VoteOpening, result: VoteSubmissionResponse): void {
  const { voteId, bulletinIndex, bulletinRootAtCast, castAtMs } = result;
  saveSessionDataForIdentity(identity, { voteId, bulletinIndex, bulletinRootAtCast });
  saveKnowledgeData(
    {
      'user.choice': opening.vote,
      'user.random': opening.randomValue,
      'user.commitment': opening.commitment,
      'user.voteId': voteId,
      'user.bulletinIndex': bulletinIndex,
      'user.bulletinRootAtCast': bulletinRootAtCast,
      ...(typeof castAtMs === 'number' ? { 'user.castAtMs': castAtMs } : {}),
    },
    { expectedSessionId: identity.sessionId },
  );
}

async function executeVoteSubmission(options: VoteSubmissionOptions): Promise<boolean> {
  const { identity, sessionData } = requireVoteSubmissionSession(options.identity);
  // An uncertain response must replay the exact opening, including after reload.
  const opening = options.pendingOpening ??
    savedVoteOpening(sessionData) ?? {
      vote: options.selectedOption,
      ...(await generateCommitment(options.selectedOption, sessionData.electionId)),
    };
  if (options.controller.signal.aborted) return false;
  const sessionBeforeSubmit = getSessionDataForIdentity(identity);
  if (!sessionBeforeSubmit) throw new Error('Session not found');
  saveSessionDataForIdentity(identity, {
    myVote: opening.vote,
    myCommit: opening.commitment,
    myRand: opening.randomValue,
  });
  options.onOpening(opening);
  const outcome = await requestVoteOpening(sessionBeforeSubmit, opening, options);
  if (outcome.kind === 'ignored' || options.controller.signal.aborted) return false;
  if (!getSessionDataForIdentity(identity)) throw new Error('Session not found');
  const result = outcome.result;
  validateVoteSubmissionResponse(result, opening.commitment);
  publishVoteReceipt(identity, opening, result);
  options.onVoteComplete({
    voteId: result.voteId,
    bulletinIndex: result.bulletinIndex,
    bulletinRootAtCast: result.bulletinRootAtCast,
    commitment: opening.commitment,
  });
  return true;
}

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
function useVoteSubmission({ onVoteComplete, onError }: VoteFormProps, t: UseTranslationResult['t']) {
  const [mountedSessionIdentity] = useState(() => captureSessionIdentity());
  const [pendingOpening, setPendingOpening] = useState(() =>
    savedVoteOpening(mountedSessionIdentity ? getSessionDataForIdentity(mountedSessionIdentity) : null),
  );
  const [selectedOption, setSelectedOption] = useState<VoteChoice | null>(pendingOpening?.vote ?? null);
  const [turnstileAttempt, setTurnstileAttempt] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const submissionControllerRef = useRef<AbortController | null>(null);
  const requireVoteTurnstile = isBrowserTurnstileRequiredForAction('vote');

  useEffect(() => () => submissionControllerRef.current?.abort(), []);

  const handleOptionChange = useCallback(
    (value: VoteChoice) => {
      setSelectedOption(value);
      setError(null);
      if (mountedSessionIdentity) {
        saveKnowledgeData({ 'user.choice': value }, { expectedSessionId: mountedSessionIdentity.sessionId });
      }
    },
    [mountedSessionIdentity],
  );

  const finishSubmission = (controller: AbortController, didSucceed: boolean) => {
    if (submissionControllerRef.current === controller) submissionControllerRef.current = null;
    if (!didSucceed && !controller.signal.aborted) {
      setIsSubmitting(false);
      setTurnstileToken(null);
      setTurnstileAttempt((attempt) => attempt + 1);
    }
  };

  const handleSubmit = async () => {
    if (!selectedOption || submissionControllerRef.current) return;
    if (requireVoteTurnstile && !turnstileToken) {
      const msg = t('errors.captchaFailed');
      setError(msg);
      onError?.(msg);
      return;
    }

    const controller = new AbortController();
    submissionControllerRef.current = controller;
    setIsSubmitting(true);
    setError(null);
    let didSucceed = false;

    try {
      didSucceed = await executeVoteSubmission({
        identity: mountedSessionIdentity,
        pendingOpening,
        selectedOption,
        turnstileToken,
        controller,
        onOpening: (opening) => {
          setPendingOpening(opening);
          setSelectedOption(opening.vote);
        },
        onCaptchaFailure: () => {
          const message = t('errors.captchaFailed');
          setError(message);
          setTurnstileToken(null);
          onError?.(message);
        },
        onVoteComplete,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      const errorMessage = resolveVoteFailureMessage(err, t);
      setError(errorMessage);
      onError?.(errorMessage);
    } finally {
      finishSubmission(controller, didSucceed);
    }
  };

  return {
    selectedOption,
    pendingOpening,
    isSubmitting,
    requireVoteTurnstile,
    turnstileAttempt,
    setTurnstileToken,
    turnstileToken,
    error,
    handleOptionChange,
    handleSubmit,
  };
}

export function VoteForm(props: VoteFormProps): React.ReactElement {
  const { t } = useTranslation();
  const {
    selectedOption,
    pendingOpening,
    isSubmitting,
    requireVoteTurnstile,
    turnstileAttempt,
    setTurnstileToken,
    turnstileToken,
    error,
    handleOptionChange,
    handleSubmit,
  } = useVoteSubmission(props, t);
  const getOptionLabel = (option: VoteChoice): string => {
    return t('pages.vote.optionLabel', { option });
  };

  return (
    <div className="vote-form">
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
        onChange={handleOptionChange}
        disabled={isSubmitting || pendingOpening !== null}
      />

      {requireVoteTurnstile && (
        <div className="flex justify-center">
          <TurnstileWidget
            key={turnstileAttempt}
            action="vote"
            onTokenChange={setTurnstileToken}
            disabled={isSubmitting}
          />
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
        className="vote-form__submit"
        data-testid="submit-vote"
      >
        {isSubmitting ? t('pages.vote.submitting') : t('pages.vote.submit')}
      </Button>
    </div>
  );
}
