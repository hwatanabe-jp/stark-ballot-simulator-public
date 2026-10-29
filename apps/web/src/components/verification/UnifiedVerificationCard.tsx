'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Loader2, Circle, Download, ChevronDown } from 'lucide-react';
import type { KnowledgeData, VerificationStepId, VerificationStepStatus } from '@stark-ballot/web/knowledge';
import { KNOWLEDGE_KEYS } from '@stark-ballot/web/knowledge';
import { useTranslation } from '@stark-ballot/web/hooks';
import type { TranslationKey } from '@stark-ballot/web/i18n';
import type { VerificationDisplayStatus, VerifiedPresentation } from '@stark-ballot/verification/presentation-policy';
import {
  KnowledgeEvidence,
  selectKnowledgeItems,
  useKnowledgeItems,
  useKnowledgeHighlight,
} from '@stark-ballot/web/components/knowledge';
import './UnifiedVerificationCard.css';
import { Button } from '@stark-ballot/web/components/ui/Button';
import { InlineAlert } from '@stark-ballot/web/components/ui/InlineAlert';
import { joinClassNames } from '@stark-ballot/web/shared/classNames';
import { shouldLogBrowserDevelopmentWarnings } from '@stark-ballot/runtime-config/env/browserRuntime';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  isVerificationCheckRequired,
  type VerificationCheck,
  type VerificationCheckId,
  type VerificationEvidence,
} from '@stark-ballot/verification/checks';

type CheckStatus = 'pending' | 'running' | 'success' | 'failed';
type CheckVisualStatus = CheckStatus | 'demo';
type SummaryStatus = VerificationDisplayStatus | 'in_progress';

type SummaryData = {
  message: string;
  subMessage?: string;
} & (
  | { status: Exclude<SummaryStatus, 'verified'>; verifiedPresentation?: never }
  | { status: 'verified'; verifiedPresentation: VerifiedPresentation }
);

interface DownloadData {
  available: boolean;
  status: 'idle' | 'loading' | 'success' | 'error';
  error?: string | null;
  onDownload: () => void;
}

interface VerificationDetailItemDefinition {
  checkId: VerificationCheckId;
  number: number;
  labelKey: TranslationKey;
  noteKey?: TranslationKey;
  dependsOnStark?: boolean;
}

interface VerificationCategoryDefinition {
  id: VerificationStepId;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  items: VerificationDetailItemDefinition[];
}

export interface UnifiedVerificationCardProps {
  summary: SummaryData | null;
  knowledgeFilterKeys?: readonly (keyof KnowledgeData)[];
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
        noteKey: 'pages.verify.stepsCard.notes.myVoteIncluded.leafEvidence',
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

const EVIDENCE_LABEL_KEYS: Record<VerificationEvidence, TranslationKey> = {
  local: 'pages.verify.stepsCard.evidence.local',
  public: 'pages.verify.stepsCard.evidence.public',
  zk: 'pages.verify.stepsCard.evidence.zk',
  demo: 'pages.verify.stepsCard.evidence.demo',
};

const STATUS_LABEL_KEYS: Record<CheckStatus, TranslationKey> = {
  pending: 'pages.verify.stepsCard.status.pending',
  running: 'pages.verify.stepsCard.status.running',
  success: 'pages.verify.stepsCard.status.success',
  failed: 'pages.verify.stepsCard.status.failed',
};

const VISUAL_STATUS_LABEL_KEYS: Record<CheckVisualStatus, TranslationKey> = {
  ...STATUS_LABEL_KEYS,
  demo: 'pages.verify.stepsCard.evidence.demo',
};

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
  if (status === 'failed') {
    return 'failed';
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

const resolveVisualStatus = (status: CheckStatus, evidence?: VerificationEvidence): CheckVisualStatus => {
  return status === 'success' && evidence === 'demo' ? 'demo' : status;
};

const resolveMissingCheckStatus = (
  hasExplicitCheckPayload: boolean,
  definition: (typeof VERIFICATION_CHECK_DEFINITIONS)[number] | undefined,
  baseStatus: CheckStatus,
): CheckStatus => {
  if (hasExplicitCheckPayload && definition && isVerificationCheckRequired(definition)) {
    return 'pending';
  }
  return baseStatus;
};

const StatusIcon = ({ status, size = 16 }: { status: CheckVisualStatus; size?: number }): React.ReactElement => {
  const style = { width: size, height: size };

  switch (status) {
    case 'success':
      return <CheckCircle2 style={style} />;
    case 'demo':
      return <AlertTriangle style={style} />;
    case 'failed':
      return <XCircle style={style} />;
    case 'running':
      return <Loader2 className="animate-spin" style={style} />;
    case 'pending':
    default:
      return <Circle className="opacity-40" style={style} />;
  }
};

const SummaryStatusIcon = ({ status }: { status: SummaryStatus }): React.ReactElement => {
  const size = 32;
  const style = { width: size, height: size };

  switch (status) {
    case 'verified':
      return <CheckCircle2 className="text-verified-600" style={style} aria-hidden="true" />;
    case 'warning':
    case 'demo_only':
      return <AlertTriangle className="text-warning-600" style={style} aria-hidden="true" />;
    case 'failed':
      return <XCircle className="text-error-600" style={style} aria-hidden="true" />;
    case 'in_progress':
      return <Loader2 className="animate-spin text-ink-500" style={style} aria-hidden="true" />;
  }
};

const STATUS_ICON_COLOR: Record<CheckVisualStatus, string> = {
  pending: 'text-text-muted',
  running: 'text-ink-500',
  success: 'text-verified-600',
  failed: 'text-error-600',
  demo: 'text-warning-600',
};

const SUMMARY_TEXT_STYLES: Record<SummaryStatus, string> = {
  verified: 'text-verified-700',
  warning: 'text-warning-700',
  demo_only: 'text-warning-700',
  failed: 'text-error-700',
  in_progress: 'text-ink-700',
};

const OPERATIONAL_STEP_ERROR_PATTERN = /(fetch|network|timeout|internal|\bapi\b|unavailable|parse)/i;

type CheckDefinition = (typeof VERIFICATION_CHECK_DEFINITIONS)[number];

function resolveDetailEvidence(check: VerificationCheck | undefined, definition: CheckDefinition | undefined) {
  const evidence: VerificationEvidence = check?.evidence ?? definition?.evidence ?? 'public';
  return { evidence, rawInputs: check?.inputs ?? definition?.inputs };
}

interface DetailItemContext {
  checkById: Map<VerificationCheckId, VerificationCheck> | null;
  baseStatus: CheckStatus;
  gateStatus: CheckStatus;
  visibleKnowledgeItems: ReturnType<typeof selectKnowledgeItems>;
}

function prepareDetailItem(
  item: VerificationDetailItemDefinition,
  { checkById, baseStatus, gateStatus, visibleKnowledgeItems }: DetailItemContext,
) {
  const check = checkById?.get(item.checkId);
  const definition = CHECK_DEFINITION_BY_ID.get(item.checkId);
  const rawStatus = check?.status ?? resolveMissingCheckStatus(checkById !== null, definition, baseStatus);
  const normalizedStatus = normalizeStatus(rawStatus);
  const status = applyStarkGate(normalizedStatus, gateStatus, item.dependsOnStark);
  const { evidence, rawInputs } = resolveDetailEvidence(check, definition);
  const knowledgeKeys = rawInputs?.filter(isKnowledgeKey) ?? [];
  const noteKey = check?.noteKey ?? item.noteKey;
  return {
    ...item,
    evidence,
    knowledgeKeys,
    knowledgeItems: selectKnowledgeItems(visibleKnowledgeItems, knowledgeKeys),
    status,
    visualStatus: resolveVisualStatus(status, evidence),
    ...(noteKey ? { noteKey } : {}),
  };
}

function VerificationDownloadAction({ download }: { download: DownloadData }): React.ReactElement {
  const { t } = useTranslation();
  const loading = download.status === 'loading';
  return (
    <div className="verification-report__download">
      <Button
        variant="secondary"
        onClick={download.onDownload}
        disabled={!download.available || loading}
        aria-busy={loading}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="h-4 w-4" aria-hidden="true" />
        )}
        {loading ? t('pages.verify.download.loading') : t('pages.verify.download.cta')}
      </Button>
      <p>{t('pages.verify.download.description')}</p>
    </div>
  );
}

function VerificationSummaryRegion({
  summary,
  sequenceComplete,
  download,
}: Pick<UnifiedVerificationCardProps, 'summary' | 'sequenceComplete' | 'download'>): React.ReactElement | null {
  const { t } = useTranslation();
  if (!summary && !sequenceComplete) return null;
  return (
    <div className="verification-report__summary-region">
      {summary && (
        <div
          role="status"
          aria-label={t('pages.verify.resultSummary.ariaLabel')}
          data-testid="result-summary"
          data-status={summary.status}
          className="verification-report__summary"
        >
          <SummaryStatusIcon status={summary.status} />
          <div>
            <h2 className={SUMMARY_TEXT_STYLES[summary.status]} data-testid="overall-status">
              {summary.message}
            </h2>
            {summary.subMessage && <p>{summary.subMessage}</p>}
          </div>
        </div>
      )}
      {sequenceComplete && <VerificationDownloadAction download={download} />}
      {download.status === 'success' && <InlineAlert message={t('pages.verify.download.success')} variant="success" />}
      {download.status === 'error' && download.error && <InlineAlert message={download.error} variant="error" />}
    </div>
  );
}

function useCheckEvidenceSelection(
  preparedCategories: ReadonlyArray<{ items: Array<ReturnType<typeof prepareDetailItem>> }>,
  sequenceComplete: boolean,
) {
  const { highlightedKeys, setHighlightedKeys } = useKnowledgeHighlight();
  const [selectedCheck, setSelectedCheck] = useState<VerificationCheckId | null>(null);
  useEffect(() => {
    const check = preparedCategories
      .flatMap((category) => category.items)
      .find((item) => item.checkId === selectedCheck);
    const nextKeys = sequenceComplete && check ? check.knowledgeItems.map((item) => item.key) : [];
    if (highlightedKeys.length !== nextKeys.length || highlightedKeys.some((key, index) => key !== nextKeys[index])) {
      setHighlightedKeys(nextKeys);
    }
  }, [highlightedKeys, preparedCategories, selectedCheck, sequenceComplete, setHighlightedKeys]);

  useEffect(() => () => setHighlightedKeys([]), [setHighlightedKeys]);

  return { selectedCheck, setSelectedCheck };
}

export function UnifiedVerificationCard({
  summary,
  knowledgeFilterKeys = [],
  verificationChecks,
  starkGateStatus,
  visibleStepCount,
  sequenceComplete,
  stepStatusMap,
  download,
}: UnifiedVerificationCardProps): React.ReactElement {
  const { t } = useTranslation();
  const knowledgeItems = useKnowledgeItems();
  const visibleKnowledgeItems = useMemo(
    () => selectKnowledgeItems(knowledgeItems, knowledgeFilterKeys),
    [knowledgeItems, knowledgeFilterKeys],
  );
  const [expandedCategories, setExpandedCategories] = useState<Set<VerificationStepId>>(
    new Set(['cast_as_intended', 'recorded_as_cast', 'counted_as_recorded', 'stark_verification']),
  );

  const checkById = useMemo(() => {
    if (!verificationChecks) {
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

  useEffect(() => {
    if (!shouldLogBrowserDevelopmentWarnings()) return;
    for (const { id: categoryId } of VERIFICATION_CATEGORIES) {
      const error = stepStatusMap[categoryId].error;
      if (error) {
        console.warn(`[Verify] Step ${categoryId} failed: ${error}`);
      }
    }
  }, [stepStatusMap]);

  const preparedCategories = useMemo(() => {
    const baseStatusMap: Record<VerificationStepId, CheckStatus> = {
      cast_as_intended: normalizeStatus(stepStatusMap.cast_as_intended.status),
      recorded_as_cast: normalizeStatus(stepStatusMap.recorded_as_cast.status),
      counted_as_recorded: normalizeStatus(stepStatusMap.counted_as_recorded.status),
      stark_verification: normalizeStatus(stepStatusMap.stark_verification.status),
    };
    const gateStatus = starkGateStatus ?? baseStatusMap.stark_verification;

    return VERIFICATION_CATEGORIES.map((category) => {
      const baseStatus = baseStatusMap[category.id];
      const items = category.items.map((item) =>
        prepareDetailItem(item, { checkById, baseStatus, gateStatus, visibleKnowledgeItems }),
      );
      const categoryStatus = aggregateStatus(items);
      const categoryVisualStatus: CheckVisualStatus =
        categoryStatus === 'success' && items.some((item) => item.visualStatus === 'demo') ? 'demo' : categoryStatus;
      const error = stepStatusMap[category.id].error;

      return {
        ...category,
        status: categoryStatus,
        visualStatus: categoryVisualStatus,
        successCount: countSuccessful(items),
        totalCount: items.length,
        items,
        error:
          error && OPERATIONAL_STEP_ERROR_PATTERN.test(error) ? t('pages.verify.stepsCard.errors.generic') : undefined,
      };
    });
  }, [checkById, starkGateStatus, stepStatusMap, t, visibleKnowledgeItems]);

  const { selectedCheck, setSelectedCheck } = useCheckEvidenceSelection(preparedCategories, sequenceComplete);

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

  return (
    <div className="verification-report">
      <VerificationSummaryRegion summary={summary} sequenceComplete={sequenceComplete} download={download} />
      {isPreparing ? (
        <p className="verification-report__preparing" role="status">
          {t('pages.verify.stepsCard.preparing')}
        </p>
      ) : (
        <div>
          {displayedCategories.map((category) => {
            const isExpanded = expandedCategories.has(category.id);
            return (
              <section key={category.id} className="verification-category">
                <h3>
                  <button
                    type="button"
                    onClick={() => toggleCategory(category.id)}
                    className="verification-category__heading"
                    aria-expanded={isExpanded}
                    aria-controls={`category-${category.id}-content`}
                    data-testid={`step-${category.id}`}
                    data-status={category.status}
                    data-visual-status={category.visualStatus}
                  >
                    <span>{t(category.titleKey)}</span>
                    <span className="verification-category__meta">
                      <span>
                        {category.successCount}/{category.totalCount}
                      </span>
                      <span className={STATUS_ICON_COLOR[category.visualStatus]} aria-hidden="true">
                        <StatusIcon status={category.visualStatus} size={18} />
                      </span>
                      <ChevronDown
                        className={joinClassNames('h-4 w-4', isExpanded && 'rotate-180')}
                        aria-hidden="true"
                      />
                    </span>
                  </button>
                </h3>
                {isExpanded && (
                  <div id={`category-${category.id}-content`}>
                    {category.items.map((item) => {
                      const label = t(item.labelKey);
                      const note = item.noteKey ? t(item.noteKey) : null;
                      const isInteractive = sequenceComplete && item.knowledgeItems.length > 0;
                      const isSelected = isInteractive && selectedCheck === item.checkId;
                      const evidenceId = `evidence-${item.checkId}`;
                      return (
                        <div key={item.checkId} className="verification-check">
                          <button
                            type="button"
                            aria-disabled={isInteractive ? undefined : 'true'}
                            aria-expanded={isInteractive ? isSelected : undefined}
                            aria-controls={isInteractive ? evidenceId : undefined}
                            onClick={() => {
                              if (isInteractive) setSelectedCheck(isSelected ? null : item.checkId);
                            }}
                            className="verification-check__button"
                            data-testid={`check-${item.checkId}`}
                            data-status={item.status}
                            data-visual-status={item.visualStatus}
                            aria-label={`${t(category.titleKey)} ${item.number}: ${label}`}
                          >
                            <span className="verification-check__number">{String(item.number).padStart(2, '0')}</span>
                            <span className="verification-check__main">
                              <span className="verification-check__label">{label}</span>
                              <span className="verification-check__meta">
                                <span className="verification-check__evidence">
                                  {t(EVIDENCE_LABEL_KEYS[item.evidence])}
                                </span>
                                <span
                                  className={joinClassNames(
                                    'verification-check__status',
                                    STATUS_ICON_COLOR[item.visualStatus],
                                  )}
                                >
                                  <span aria-hidden="true">
                                    <StatusIcon status={item.visualStatus} size={13} />
                                  </span>
                                  {t(VISUAL_STATUS_LABEL_KEYS[item.visualStatus])}
                                </span>
                              </span>
                              {note && <span className="verification-check__note">{note}</span>}
                            </span>
                          </button>
                          {isSelected && (
                            <KnowledgeEvidence
                              id={evidenceId}
                              items={item.knowledgeItems}
                              filterKeys={item.knowledgeKeys}
                            />
                          )}
                        </div>
                      );
                    })}
                    {category.error && <InlineAlert message={category.error} variant="error" />}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
