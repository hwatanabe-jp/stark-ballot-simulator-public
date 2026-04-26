'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Loader2, Circle, Download, ChevronDown } from 'lucide-react';
import type { KnowledgeData, VerificationStepId, VerificationStepStatus } from '@/lib/knowledge';
import { KNOWLEDGE_KEYS } from '@/lib/knowledge';
import { useTranslation } from '@/lib/hooks';
import { useKnowledgeHighlight } from '@/components/knowledge';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { InlineAlert } from '@/components/ui/InlineAlert';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckId,
  type VerificationEvidence,
} from '@/lib/verification/verification-checks';

type CheckStatus = 'pending' | 'running' | 'success' | 'failed';
type SummaryStatus = 'verified' | 'warning' | 'failed' | 'in_progress';

interface SummaryData {
  status: SummaryStatus;
  message: string;
  subMessage?: string;
  messageKey?: string;
}

interface DownloadData {
  available: boolean;
  status: 'idle' | 'loading' | 'success' | 'error';
  error?: string | null;
  onDownload: () => void;
}

interface VerificationDetailItemDefinition {
  checkId: VerificationCheckId;
  number: number;
  labelKey: string;
  noteKey?: string;
  dependsOnStark?: boolean;
}

interface VerificationCategoryDefinition {
  id: VerificationStepId;
  titleKey: string;
  descriptionKey: string;
  items: VerificationDetailItemDefinition[];
}

export interface UnifiedVerificationCardProps {
  summary: SummaryData | null;
  verificationChecks?: VerificationCheck[];
  /** Override for STARK-dependent gating when STARK is already resolved before display. */
  starkGateStatus?: CheckStatus;
  visibleStepCount: number;
  sequenceComplete: boolean;
  stepStatusMap: Record<VerificationStepId, { status: VerificationStepStatus; error?: string }>;
  download: DownloadData;
}

const CHECK_DEFINITION_BY_ID = new Map<VerificationCheckId, (typeof VERIFICATION_CHECK_DEFINITIONS)[number]>(
  VERIFICATION_CHECK_DEFINITIONS.map((definition) => [definition.id, definition]),
);

const KNOWLEDGE_KEY_SET = new Set<string>(KNOWLEDGE_KEYS);

const isKnowledgeKey = (value: string): value is keyof KnowledgeData => KNOWLEDGE_KEY_SET.has(value);

const VERIFICATION_CATEGORIES: VerificationCategoryDefinition[] = [
  {
    id: 'cast_as_intended',
    titleKey: 'pages.verify.stepsCard.categories.castAsIntended.title',
    descriptionKey: 'pages.verify.stepsCard.categories.castAsIntended.description',
    items: [
      {
        checkId: 'cast_receipt_present',
        number: 1,
        labelKey: 'pages.verify.stepsCard.categories.castAsIntended.items.receiptPresent',
      },
      {
        checkId: 'cast_choice_range',
        number: 2,
        labelKey: 'pages.verify.stepsCard.categories.castAsIntended.items.choiceRange',
      },
      {
        checkId: 'cast_random_format',
        number: 3,
        labelKey: 'pages.verify.stepsCard.categories.castAsIntended.items.randomFormat',
      },
      {
        checkId: 'cast_commitment_match',
        number: 4,
        labelKey: 'pages.verify.stepsCard.categories.castAsIntended.items.commitmentMatch',
      },
    ],
  },
  {
    id: 'recorded_as_cast',
    titleKey: 'pages.verify.stepsCard.categories.recordedAsCast.title',
    descriptionKey: 'pages.verify.stepsCard.categories.recordedAsCast.description',
    items: [
      {
        checkId: 'recorded_commitment_in_bulletin',
        number: 5,
        labelKey: 'pages.verify.stepsCard.categories.recordedAsCast.items.commitmentInBulletin.label',
        noteKey: 'pages.verify.stepsCard.categories.recordedAsCast.items.commitmentInBulletin.note',
      },
      {
        checkId: 'recorded_index_in_range',
        number: 6,
        labelKey: 'pages.verify.stepsCard.categories.recordedAsCast.items.indexInRange',
      },
      {
        checkId: 'recorded_root_at_cast_consistent',
        number: 7,
        labelKey: 'pages.verify.stepsCard.categories.recordedAsCast.items.rootAtCastConsistent.label',
        noteKey: 'pages.verify.stepsCard.categories.recordedAsCast.items.rootAtCastConsistent.note',
      },
      {
        checkId: 'recorded_inclusion_proof',
        number: 8,
        labelKey: 'pages.verify.stepsCard.categories.recordedAsCast.items.inclusionProof',
      },
      {
        checkId: 'recorded_consistency_proof',
        number: 9,
        labelKey: 'pages.verify.stepsCard.categories.recordedAsCast.items.consistencyProof',
      },
      {
        checkId: 'recorded_sth_third_party',
        number: 10,
        labelKey: 'pages.verify.stepsCard.categories.recordedAsCast.items.sthThirdParty',
      },
    ],
  },
  {
    id: 'counted_as_recorded',
    titleKey: 'pages.verify.stepsCard.categories.countedAsRecorded.title',
    descriptionKey: 'pages.verify.stepsCard.categories.countedAsRecorded.description',
    items: [
      {
        checkId: 'counted_input_sanity',
        number: 11,
        labelKey: 'pages.verify.stepsCard.categories.countedAsRecorded.items.inputSanity',
      },
      {
        checkId: 'counted_unique_indices',
        number: 12,
        labelKey: 'pages.verify.stepsCard.categories.countedAsRecorded.items.uniqueIndices',
      },
      {
        checkId: 'counted_unique_commitments',
        number: 13,
        labelKey: 'pages.verify.stepsCard.categories.countedAsRecorded.items.uniqueCommitments',
      },
      {
        checkId: 'counted_tally_consistent',
        number: 14,
        labelKey: 'pages.verify.stepsCard.categories.countedAsRecorded.items.tallyConsistent',
        dependsOnStark: true,
      },
      {
        checkId: 'counted_missing_indices_zero',
        number: 15,
        labelKey: 'pages.verify.stepsCard.categories.countedAsRecorded.items.missingIndicesZero',
        dependsOnStark: true,
      },
      {
        checkId: 'counted_expected_vs_tree_size',
        number: 16,
        labelKey: 'pages.verify.stepsCard.categories.countedAsRecorded.items.expectedVsTreeSize',
        dependsOnStark: true,
      },
      {
        checkId: 'counted_election_manifest_consistent',
        number: 17,
        labelKey: 'pages.verify.stepsCard.categories.countedAsRecorded.items.electionManifestConsistent',
      },
      {
        checkId: 'counted_close_statement_consistent',
        number: 18,
        labelKey: 'pages.verify.stepsCard.categories.countedAsRecorded.items.closeStatementConsistent',
      },
      {
        checkId: 'counted_my_vote_included',
        number: 19,
        labelKey: 'pages.verify.stepsCard.categories.countedAsRecorded.items.myVoteIncluded',
        dependsOnStark: true,
      },
      {
        checkId: 'counted_input_commitment_match',
        number: 20,
        labelKey: 'pages.verify.stepsCard.categories.countedAsRecorded.items.inputCommitmentMatch',
      },
    ],
  },
  {
    id: 'stark_verification',
    titleKey: 'pages.verify.stepsCard.categories.starkVerification.title',
    descriptionKey: 'pages.verify.stepsCard.categories.starkVerification.description',
    items: [
      {
        checkId: 'stark_image_id_match',
        number: 21,
        labelKey: 'pages.verify.stepsCard.categories.starkVerification.items.imageIdMatch',
        dependsOnStark: true,
      },
      {
        checkId: 'stark_receipt_verify',
        number: 22,
        labelKey: 'pages.verify.stepsCard.categories.starkVerification.items.receiptVerify',
        dependsOnStark: true,
      },
    ],
  },
];

const EVIDENCE_LABEL_KEYS: Record<VerificationEvidence, string> = {
  local: 'pages.verify.stepsCard.evidence.local',
  public: 'pages.verify.stepsCard.evidence.public',
  zk: 'pages.verify.stepsCard.evidence.zk',
  demo: 'pages.verify.stepsCard.evidence.demo',
};

const EVIDENCE_VARIANTS: Record<VerificationEvidence, BadgeVariant> = {
  local: 'default',
  public: 'info',
  zk: 'verified',
  demo: 'warning',
};

const STATUS_LABEL_KEYS: Record<CheckStatus, string> = {
  pending: 'pages.verify.stepsCard.status.pending',
  running: 'pages.verify.stepsCard.status.running',
  success: 'pages.verify.stepsCard.status.success',
  failed: 'pages.verify.stepsCard.status.failed',
};

const STATUS_VARIANTS: Record<CheckStatus, BadgeVariant> = {
  pending: 'default',
  running: 'info',
  success: 'verified',
  failed: 'error',
};

const cn = (...classes: Array<string | false | undefined>): string => classes.filter(Boolean).join(' ');

const normalizeStatus = (status: VerificationStepStatus | undefined): CheckStatus => {
  if (status === 'success' || status === 'failed' || status === 'running') {
    return status;
  }
  return 'pending';
};

const applyStarkGate = (status: CheckStatus, starkStatus: CheckStatus, dependsOnStark?: boolean): CheckStatus => {
  if (!dependsOnStark) {
    return status;
  }
  if (starkStatus === 'failed') {
    return 'failed';
  }
  if (starkStatus !== 'success') {
    return 'pending';
  }
  return status;
};

const aggregateStatus = (items: Array<{ status: CheckStatus }>): CheckStatus => {
  if (items.some((item) => item.status === 'failed')) {
    return 'failed';
  }
  if (items.some((item) => item.status === 'running')) {
    return 'running';
  }
  if (items.some((item) => item.status === 'pending')) {
    return 'pending';
  }
  return 'success';
};

const countSuccessful = (items: Array<{ status: CheckStatus }>): number => {
  return items.filter((item) => item.status === 'success').length;
};

const StatusIcon = ({ status, size = 16 }: { status: CheckStatus; size?: number }): React.ReactElement => {
  const iconClass = `w-[${size}px] h-[${size}px]`;
  const style = { width: size, height: size };

  switch (status) {
    case 'success':
      return <CheckCircle2 className={cn(iconClass, 'animate-status-icon-morph')} style={style} />;
    case 'failed':
      return <XCircle className={cn(iconClass, 'animate-status-icon-morph')} style={style} />;
    case 'running':
      return <Loader2 className={cn(iconClass, 'animate-spin')} style={style} />;
    case 'pending':
    default:
      return <Circle className={cn(iconClass, 'opacity-40')} style={style} />;
  }
};

const StatusBadge = ({
  status,
  size = 'small',
  className,
}: {
  status: CheckStatus;
  size?: 'small' | 'medium' | 'large';
  className?: string;
}): React.ReactElement => {
  const { t } = useTranslation();
  return (
    <Badge variant={STATUS_VARIANTS[status]} size={size} className={cn('transition-colors duration-200', className)}>
      {t(STATUS_LABEL_KEYS[status])}
    </Badge>
  );
};

const SummaryStatusIcon = ({ status }: { status: SummaryStatus }): React.ReactElement => {
  const size = 32;
  const style = { width: size, height: size };

  switch (status) {
    case 'verified':
      return <CheckCircle2 className="text-verified-600" style={style} aria-hidden="true" />;
    case 'warning':
      return <AlertTriangle className="text-warning-600" style={style} aria-hidden="true" />;
    case 'failed':
      return <XCircle className="text-error-600" style={style} aria-hidden="true" />;
    case 'in_progress':
      return <Loader2 className="text-ink-500 animate-spin" style={style} aria-hidden="true" />;
  }
};

const STATUS_ICON_COLOR: Record<CheckStatus, string> = {
  pending: 'text-text-muted',
  running: 'text-ink-500',
  success: 'text-verified-600',
  failed: 'text-error-600',
};

const SUMMARY_TEXT_STYLES: Record<SummaryStatus, string> = {
  verified: 'text-verified-700',
  warning: 'text-warning-700',
  failed: 'text-error-700',
  in_progress: 'text-ink-700',
};

const OPERATIONAL_STEP_ERROR_PATTERN = /(fetch|network|timeout|internal|\bapi\b|unavailable|parse)/i;

export function UnifiedVerificationCard({
  summary,
  verificationChecks,
  starkGateStatus,
  visibleStepCount,
  sequenceComplete,
  stepStatusMap,
  download,
}: UnifiedVerificationCardProps): React.ReactElement {
  const { t } = useTranslation();
  const { setHighlightedKeys } = useKnowledgeHighlight();
  const highlightTimeoutRef = useRef<number | null>(null);
  const highlightStartRef = useRef<number | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<VerificationStepId>>(
    new Set(['cast_as_intended', 'recorded_as_cast', 'counted_as_recorded', 'stark_verification']),
  );

  const checkById = useMemo(() => {
    if (!verificationChecks || verificationChecks.length === 0) {
      return null;
    }
    const map = new Map<VerificationCheckId, VerificationCheck>();
    for (const check of verificationChecks) {
      if (!map.has(check.id)) {
        map.set(check.id, check);
      }
    }
    return map;
  }, [verificationChecks]);

  const clearHighlight = useCallback(() => {
    setHighlightedKeys([]);
  }, [setHighlightedKeys]);

  const handleHighlight = useCallback(
    (keys: Array<keyof KnowledgeData>) => {
      if (!sequenceComplete || keys.length === 0) {
        return;
      }
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current);
      }
      if (highlightStartRef.current !== null) {
        window.clearTimeout(highlightStartRef.current);
      }
      setHighlightedKeys([]);
      highlightStartRef.current = window.setTimeout(() => {
        setHighlightedKeys([...keys]);
        highlightStartRef.current = null;
      }, 0);
      highlightTimeoutRef.current = window.setTimeout(() => {
        clearHighlight();
      }, 2500);
    },
    [clearHighlight, sequenceComplete, setHighlightedKeys],
  );

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current);
      }
      if (highlightStartRef.current !== null) {
        window.clearTimeout(highlightStartRef.current);
      }
      clearHighlight();
    };
  }, [clearHighlight]);

  const resolveErrorMessage = useCallback(
    (error: string | undefined, categoryId: VerificationStepId): string | undefined => {
      if (!error) {
        return undefined;
      }
      if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
        console.warn(`[Verify] Step ${categoryId} failed: ${error}`);
      }
      if (!OPERATIONAL_STEP_ERROR_PATTERN.test(error)) {
        return undefined;
      }
      return t('pages.verify.stepsCard.errors.generic');
    },
    [t],
  );

  const preparedCategories = useMemo(() => {
    const castStatus = normalizeStatus(stepStatusMap.cast_as_intended.status);
    const recordedStatus = normalizeStatus(stepStatusMap.recorded_as_cast.status);
    const countedStatus = normalizeStatus(stepStatusMap.counted_as_recorded.status);
    const starkStatus = normalizeStatus(stepStatusMap.stark_verification.status);
    const gateStatus = starkGateStatus ?? starkStatus;

    return VERIFICATION_CATEGORIES.map((category) => {
      const baseStatusMap: Record<VerificationStepId, CheckStatus> = {
        cast_as_intended: castStatus,
        recorded_as_cast: recordedStatus,
        counted_as_recorded: countedStatus,
        stark_verification: starkStatus,
      };

      const baseStatus = baseStatusMap[category.id];
      const items = category.items.map((item) => {
        const check = checkById?.get(item.checkId);
        const definition = CHECK_DEFINITION_BY_ID.get(item.checkId);
        const rawStatus = check?.status ?? baseStatus;
        const normalizedStatus = normalizeStatus(rawStatus);
        const status = applyStarkGate(normalizedStatus, gateStatus, item.dependsOnStark);
        const evidence: VerificationEvidence = check?.evidence ?? definition?.evidence ?? 'public';
        const rawInputs = check?.inputs ?? definition?.inputs;
        const knowledgeKeys = rawInputs?.filter(isKnowledgeKey) ?? [];
        const noteKey = check?.noteKey ?? item.noteKey;
        return {
          ...item,
          evidence,
          knowledgeKeys,
          status,
          ...(noteKey ? { noteKey } : {}),
        };
      });

      return {
        ...category,
        status: aggregateStatus(items),
        successCount: countSuccessful(items),
        totalCount: items.length,
        items,
        error: resolveErrorMessage(stepStatusMap[category.id].error, category.id),
      };
    });
  }, [checkById, resolveErrorMessage, starkGateStatus, stepStatusMap]);

  const displayedCategories = preparedCategories.slice(0, Math.min(visibleStepCount, preparedCategories.length));
  const isPreparing = visibleStepCount === 0;

  const toggleCategory = useCallback((categoryId: VerificationStepId) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  }, []);

  const showDownloadSection = sequenceComplete;

  return (
    <Card>
      <CardContent className="p-0">
        {/* Verification Steps */}
        <div className="px-6 pbs-6 pbe-6">
          {isPreparing ? (
            <div className="rounded-lg border border-paper-border bg-paper-warm p-4">
              <div className="flex items-center gap-2 text-sm text-text-secondary font-secondary">
                <span className="h-2 w-2 rounded-full bg-ink-400 animate-ink-drop" aria-hidden="true" />
                <span>{t('pages.verify.stepsCard.preparing')}</span>
              </div>
              <div className="mt-4 space-y-2">
                <div className="h-4 rounded-md animate-skeleton-shimmer" />
                <div className="h-4 rounded-md animate-skeleton-shimmer" />
                <div className="h-4 rounded-md animate-skeleton-shimmer" />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {displayedCategories.map((category, index) => {
                const isExpanded = expandedCategories.has(category.id);

                return (
                  <section
                    key={category.id}
                    className="border border-paper-border rounded-lg overflow-hidden animate-slide-in-up"
                    style={{ animationDelay: `${index * 120}ms` }}
                  >
                    {/* Category Header */}
                    <button
                      type="button"
                      onClick={() => toggleCategory(category.id)}
                      className={cn(
                        'w-full px-3 sm:px-4 py-3 flex items-center justify-between gap-3',
                        'bg-paper-warm hover:bg-ink-50 transition-colors',
                        'focus-visible:ring-2 focus-visible:ring-ink-400 focus-visible:ring-inset',
                      )}
                      aria-expanded={isExpanded}
                      aria-controls={`category-${category.id}-content`}
                      data-testid={`step-${category.id}`}
                      data-status={category.status}
                    >
                      <div className="flex items-center min-w-0">
                        <h3 className="font-primary text-base text-ink-900 truncate">{t(category.titleKey)}</h3>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span
                          className={cn(
                            'text-sm font-mono font-features-none',
                            category.status === 'success'
                              ? 'text-verified-600'
                              : category.status === 'failed'
                                ? 'text-error-600'
                                : 'text-text-muted',
                          )}
                        >
                          {category.successCount}/{category.totalCount}
                        </span>
                        <div className={STATUS_ICON_COLOR[category.status]}>
                          <StatusIcon status={category.status} size={18} />
                        </div>
                        <ChevronDown
                          className={cn(
                            'w-4 h-4 text-text-muted transition-transform duration-200',
                            isExpanded && 'rotate-180',
                          )}
                          aria-hidden="true"
                        />
                      </div>
                    </button>

                    {/* Category Content */}
                    {isExpanded && (
                      <div
                        id={`category-${category.id}-content`}
                        className="px-2 sm:px-4 pbe-3 pbs-1 space-y-2 bg-paper-texture"
                      >
                        {category.items.map((item) => {
                          const label = t(item.labelKey);
                          const note = item.noteKey ? t(item.noteKey) : null;
                          const evidenceLabel = t(EVIDENCE_LABEL_KEYS[item.evidence]);
                          const isInteractive = sequenceComplete && item.knowledgeKeys.length > 0;

                          return (
                            <button
                              key={item.checkId}
                              type="button"
                              aria-disabled={isInteractive ? undefined : 'true'}
                              onClick={() => {
                                if (!isInteractive) {
                                  return;
                                }
                                handleHighlight(item.knowledgeKeys);
                              }}
                              className={cn(
                                'verification-detail-item animate-detail-cascade-in w-full text-left',
                                'flex items-start gap-2 sm:gap-3 rounded-lg px-2 sm:px-3 py-2.5',
                                'border border-paper-border border-l-[3px]',
                                'focus-visible:ring-2 focus-visible:ring-ink-400',
                                isInteractive && 'cursor-pointer hover:shadow-sm hover:bg-ink-50',
                                !isInteractive && 'cursor-default',
                              )}
                              data-status={item.status}
                              data-testid={`check-${item.checkId}`}
                              aria-label={`${t(category.titleKey)} ${item.number}: ${label}`}
                            >
                              <div className={cn('mt-0.5 flex-shrink-0', STATUS_ICON_COLOR[item.status])}>
                                <StatusIcon status={item.status} />
                              </div>
                              <div className="flex-1 min-w-0 space-y-1">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                  <span className="font-mono font-features-none text-xs text-text-muted">
                                    {String(item.number).padStart(2, '0')}
                                  </span>
                                  <span className="font-secondary text-sm text-ink-900 flex-1 min-w-0">{label}</span>
                                  <div className="flex items-center gap-2 w-full sm:w-auto sm:ml-auto justify-end order-last sm:order-none">
                                    <Badge variant={EVIDENCE_VARIANTS[item.evidence]} size="small" className="shrink-0">
                                      {evidenceLabel}
                                    </Badge>
                                    <StatusBadge status={item.status} className="shrink-0" />
                                  </div>
                                </div>
                                {note && <p className="text-xs text-text-muted">{note}</p>}
                              </div>
                            </button>
                          );
                        })}

                        {category.error && (
                          <div className="text-sm text-error-600 bg-error-100 border border-error-500 rounded-md px-3 py-2">
                            {category.error}
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}

              {!sequenceComplete && (
                <p className="text-xs text-text-muted">{t('pages.verify.stepsCard.footnoteStarkLast')}</p>
              )}
              {sequenceComplete && (
                <p className="text-xs text-text-muted">{t('pages.verify.stepsCard.footnoteClickable')}</p>
              )}

              {/* Result Summary */}
              {summary && (
                <div
                  className="mt-4 py-3"
                  role="status"
                  aria-label={t('pages.verify.resultSummary.ariaLabel')}
                  data-testid="result-summary"
                >
                  <div className="flex items-start gap-3">
                    <SummaryStatusIcon status={summary.status} />
                    <div className="flex flex-col">
                      <span
                        className={cn('text-xl font-semibold font-primary', SUMMARY_TEXT_STYLES[summary.status])}
                        data-testid="overall-status"
                      >
                        {summary.message}
                      </span>
                      {summary.subMessage && (
                        <span className="text-sm text-text-secondary font-secondary mt-1">{summary.subMessage}</span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Download Footer */}
          {showDownloadSection && (
            <div className="flex flex-col items-center gap-2 pt-4">
              <Button
                variant="secondary"
                onClick={download.onDownload}
                disabled={!download.available || download.status === 'loading'}
                aria-busy={download.status === 'loading'}
              >
                {download.status === 'loading' ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="w-4 h-4" aria-hidden="true" />
                )}
                {download.status === 'loading' ? t('pages.verify.download.loading') : t('pages.verify.download.cta')}
              </Button>
              <p className="text-xs text-text-muted">{t('pages.verify.download.description')}</p>
            </div>
          )}

          {/* Download Success/Error */}
          {download.status === 'success' && (
            <div className="mt-3">
              <InlineAlert message={t('pages.verify.download.success')} variant="success" />
            </div>
          )}

          {download.status === 'error' && download.error && (
            <div className="mt-3">
              <InlineAlert message={download.error} variant="error" />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
