'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { InlineAlert } from '@/components/ui/InlineAlert';
import { useTranslation } from '@/lib/hooks';
import {
  captureSessionIdentity,
  getSessionAuthHeaders,
  getSessionData,
  getSessionDataForIdentity,
  isSessionReplacedForIdentity,
  SESSION_STORAGE_KEY,
} from '@/lib/session';
import { saveKnowledgeData } from '@/lib/knowledge';
import { getNumberProperty, getRecordProperty, getStringProperty, isRecord } from '@/lib/utils/guards';
import { resolveApiUrl } from '@/lib/api/apiBaseUrl';
import { apiFetch } from '@/lib/api/apiFetch';
import { isSessionUnavailableErrorCode } from '@/lib/errors/apiErrorGuards';
import type { VoteChoice } from '@/lib/session/types';

interface BotVotingProgressProps {
  /** Callback when bot voting is complete */
  onComplete?: () => void;
  /** Auto-navigate to aggregate page */
  autoNavigate?: boolean;
}

interface DistributionData {
  A: number;
  B: number;
  C: number;
  D: number;
  E: number;
}

const DEFAULT_BOT_VOTES_TOTAL = 63;

const ANIMATION_DURATION_MS = 10000;
const ANIMATION_INTERVAL_MS = 400;
const MAX_BAR_HEIGHT = 75;
const BAR_VARIANCE_RANGE = 16; // ±8%
const JITTER_RANGE = 2; // ±1% per update

/**
 * Easing function for slower initial growth
 * Creates organic "ink pooling" feel
 */
function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/**
 * Seeded pseudo-random number generator for consistent animations per session
 */
function seededRandom(seed: string, index: number): number {
  let hash = 0;
  const str = `${seed}:${index}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash % 100) / 100;
}

/**
 * Generate pseudo-distribution for animation (privacy-preserving)
 * - Slower growth with easing (easeOutQuad)
 * - Max height capped at 75% for visual balance
 * - Per-bar variance of ±8% (subtle but noticeable)
 * - Per-update jitter of ±1% (kept deterministic per session)
 * Numbers are NOT displayed - only used for bar heights
 */
function generatePseudoDistribution(seed: string, progress: number, tickIndex: number): DistributionData {
  const choices: VoteChoice[] = ['A', 'B', 'C', 'D', 'E'];
  const distribution: DistributionData = { A: 0, B: 0, C: 0, D: 0, E: 0 };

  // Apply easing for slower initial growth, faster at end
  const easedProgress = easeOutQuad(progress);

  // Base height: max 75% for visual balance
  const baseHeight = easedProgress * MAX_BAR_HEIGHT;

  // Each bar gets fixed variance offset + small deterministic jitter
  for (const choice of choices) {
    const fixedVariance = (seededRandom(`${seed}:${choice}:variance`, 0) - 0.5) * BAR_VARIANCE_RANGE;
    const jitter = (seededRandom(`${seed}:${choice}:jitter`, tickIndex) - 0.5) * JITTER_RANGE;
    const height = baseHeight + fixedVariance + jitter;
    distribution[choice] = Math.min(MAX_BAR_HEIGHT + 8, Math.max(5, height));
  }

  return distribution;
}

/**
 * Bot Voting Progress with animated bar chart
 *
 * Design spec (design-spec-transparent-trust.md):
 * - Bar chart showing vote distribution during 10s wait
 * - NO numbers displayed (privacy)
 * - Gradient blur on bar edges for ambiguity
 * - Progress text: "処理中..." only
 *
 * Enhanced aesthetics:
 * - Slower, smoother animations (400ms intervals + CSS transitions)
 * - Subtle variance between bars (±8%) per session
 * - Bars freeze after 10 seconds; indicator continues
 * - Multi-layer gradients for depth
 * - Organic blur boundaries
 * - Ink-drop loading animation
 */
export function BotVotingProgress({ onComplete, autoNavigate = true }: BotVotingProgressProps): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const hasNavigated = useRef(false);
  const animationStartRef = useRef<number | null>(null);
  const hasAnimationFrozen = useRef(false);
  const hasSeedFromApi = useRef(false);
  const [expectedSessionIdentity] = useState(() => captureSessionIdentity(getSessionData()));
  const expectedSessionId = expectedSessionIdentity?.sessionId;

  const [distribution, setDistribution] = useState<DistributionData>({
    A: 5,
    B: 5,
    C: 5,
    D: 5,
    E: 5,
  });
  const [animationSeed, setAnimationSeed] = useState(() => expectedSessionId ?? 'default');
  const [isComplete, setIsComplete] = useState(false);
  const [isAnimationFrozen, setIsAnimationFrozen] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const resolveSessionErrorMessage = useCallback((): string => {
    return isSessionReplacedForIdentity(expectedSessionIdentity)
      ? t('pages.vote.errors.sessionReplaced')
      : t('pages.vote.errors.sessionNotFound');
  }, [expectedSessionIdentity, t]);

  const getExpectedSession = useCallback(() => {
    return getSessionDataForIdentity(expectedSessionIdentity);
  }, [expectedSessionIdentity]);

  useEffect(() => {
    saveKnowledgeData({ botVotesStatus: { status: 'pending', total: DEFAULT_BOT_VOTES_TOTAL } }, { expectedSessionId });
  }, [expectedSessionId]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== SESSION_STORAGE_KEY) {
        return;
      }
      if (!isSessionReplacedForIdentity(expectedSessionIdentity)) {
        return;
      }
      setSessionError(t('pages.vote.errors.sessionReplaced'));
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [expectedSessionIdentity, t]);

  // Animation loop for pseudo-distribution (slower: 400ms intervals)
  const updateAnimation = useCallback(() => {
    if (hasAnimationFrozen.current) return;
    if (animationStartRef.current === null) {
      animationStartRef.current = Date.now();
    }
    const elapsed = Date.now() - animationStartRef.current;
    const progress = Math.min(1, elapsed / ANIMATION_DURATION_MS);
    const tickIndex = Math.floor(elapsed / ANIMATION_INTERVAL_MS);

    const newDistribution = generatePseudoDistribution(animationSeed, progress, tickIndex);
    setDistribution(newDistribution);

    if (progress >= 1) {
      hasAnimationFrozen.current = true;
      setIsAnimationFrozen(true);
    }
  }, [animationSeed]);

  // Poll for completion
  useEffect(() => {
    if (sessionError) {
      return;
    }

    const fetchProgress = async () => {
      try {
        const sessionData = getExpectedSession();
        if (!sessionData) {
          setSessionError(resolveSessionErrorMessage());
          return;
        }

        const response = await apiFetch(resolveApiUrl('/api/progress'), {
          headers: getSessionAuthHeaders(sessionData),
        });

        if (!response.ok) {
          let errorPayload: unknown = null;
          try {
            errorPayload = await response.json();
          } catch {
            errorPayload = null;
          }
          const errorCode = getStringProperty(errorPayload, 'error');
          if (isSessionUnavailableErrorCode(errorCode)) {
            if (intervalRef.current) {
              clearInterval(intervalRef.current);
              intervalRef.current = null;
            }
            setSessionError(resolveSessionErrorMessage());
          }
          return;
        }

        const resultPayload: unknown = await response.json();
        const dataRecord = getRecordProperty(resultPayload, 'data') ?? (isRecord(resultPayload) ? resultPayload : null);

        if (!dataRecord) {
          return;
        }

        const seed = getStringProperty(dataRecord, 'animationSeed');
        if (seed && !hasSeedFromApi.current) {
          setAnimationSeed(seed);
          hasSeedFromApi.current = true;
        }

        // Check completion
        const completedFlag = (dataRecord as { completed?: unknown }).completed;
        const count = getNumberProperty(dataRecord, 'count');
        const total = getNumberProperty(dataRecord, 'total');
        const completed =
          typeof completedFlag === 'boolean'
            ? completedFlag
            : count !== undefined && total !== undefined && count >= total;

        if (completed && !hasNavigated.current) {
          setIsComplete(true);
          hasNavigated.current = true;
          saveKnowledgeData(
            {
              botVotesStatus: {
                status: 'completed',
                total: total ?? DEFAULT_BOT_VOTES_TOTAL,
              },
            },
            { expectedSessionId },
          );

          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }

          onComplete?.();

          if (autoNavigate) {
            setTimeout(() => {
              if (!getExpectedSession()) {
                setSessionError(resolveSessionErrorMessage());
                return;
              }
              router.push('/aggregate');
            }, 500);
          }
        }

        if (!completed && typeof total === 'number') {
          saveKnowledgeData({ botVotesStatus: { status: 'pending', total } }, { expectedSessionId });
        }
      } catch (error) {
        // Continue polling on error
        console.error('[BotVotingProgress] Poll error:', error);
      }
    };

    void fetchProgress();
    intervalRef.current = setInterval(() => {
      void fetchProgress();
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [
    autoNavigate,
    expectedSessionId,
    getExpectedSession,
    onComplete,
    resolveSessionErrorMessage,
    router,
    sessionError,
  ]);

  // Animation update loop (slower: 400ms intervals, CSS handles smoothing)
  useEffect(() => {
    if (isComplete || isAnimationFrozen) return;

    if (animationStartRef.current === null) {
      animationStartRef.current = Date.now();
    }
    const animationInterval = setInterval(updateAnimation, ANIMATION_INTERVAL_MS);
    return () => clearInterval(animationInterval);
  }, [updateAnimation, isComplete, isAnimationFrozen]);

  const choices: VoteChoice[] = ['A', 'B', 'C', 'D', 'E'];

  if (sessionError) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <InlineAlert message={sessionError} variant="error" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-primary font-semibold text-ink-900 mb-4">{t('pages.vote.botVoting.title')}</h2>
      </div>

      {/* Animated bar chart with enhanced aesthetics */}
      <div className="bg-paper-cream border border-paper-border rounded-xl px-6 pbs-4 pbe-6 mb-6 relative overflow-hidden">
        {/* Subtle paper texture overlay */}
        <div
          className="absolute inset-0 opacity-30 pointer-events-none"
          style={{
            backgroundImage: 'url(/textures/paper-noise.png)',
            backgroundSize: '128px 128px',
            mixBlendMode: 'overlay',
          }}
        />

        <div className="relative flex items-end justify-center gap-6 h-40">
          {choices.map((choice, index) => (
            <div key={choice} className="flex flex-col items-center gap-3 flex-1 max-w-16">
              {/* Bar with multi-layer gradient and organic blur */}
              <div className="relative w-full h-32 flex items-end justify-center">
                <div
                  className="w-full rounded-t-lg relative overflow-hidden animate-ink-pool-glow"
                  style={{
                    height: `${distribution[choice]}%`,
                    // Multi-layer gradient for depth (ink pooling effect)
                    background: `
                      linear-gradient(
                        to top,
                        var(--color-ink-700) 0%,
                        var(--color-ink-600) 40%,
                        var(--color-ink-500) 70%,
                        var(--color-ink-400) 100%
                      )
                    `,
                    // Smooth CSS transition (800ms for organic feel)
                    transition: 'height 800ms cubic-bezier(0.4, 0, 0.2, 1)',
                    // Staggered animation delay for subtle wave effect
                    animationDelay: `${index * 200}ms`,
                  }}
                >
                  {/* Multi-layer top blur for organic boundary */}
                  <div
                    className="absolute inset-x-0 inset-bs-0 h-5"
                    style={{
                      background: `
                        linear-gradient(
                          to bottom,
                          rgba(247, 246, 243, 0.95) 0%,
                          rgba(247, 246, 243, 0.6) 40%,
                          rgba(247, 246, 243, 0.2) 70%,
                          transparent 100%
                        )
                      `,
                    }}
                  />

                  {/* Subtle inner highlight for depth */}
                  <div
                    className="absolute inset-0 pointer-events-none"
                    style={{
                      background: `
                        linear-gradient(
                          90deg,
                          rgba(255, 255, 255, 0.08) 0%,
                          transparent 30%,
                          transparent 70%,
                          rgba(0, 0, 0, 0.05) 100%
                        )
                      `,
                    }}
                  />
                </div>
              </div>

              {/* Choice label with refined typography */}
              <span className="text-sm font-medium text-text-secondary tracking-wide">{choice}</span>
            </div>
          ))}
        </div>

        {/* Progress indicator with ink-drop animation */}
        <div className="relative mt-4 flex items-center justify-center gap-3">
          <div className="flex gap-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="w-2 h-2 rounded-full bg-ink-500 animate-ink-drop"
                style={{ animationDelay: `${i * 300}ms` }}
              />
            ))}
          </div>
          <span className="text-text-muted text-sm font-medium ml-1">{t('pages.vote.botVoting.processing')}</span>
        </div>
      </div>
    </div>
  );
}
