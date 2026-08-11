import { deepFreeze, parseFullSourceSha, requireExactKeys } from './internal.js';
import { resolveAllowedDeploymentTarget } from './index.js';

export const ROLLBACK_READINESS_CHECK_FAILURE_STAGES = Object.freeze([
  'authority-admission',
  'candidate-admission',
  'baseline-admission',
  'dependency-admission',
  'identity-admission',
  'provider-initialization',
  'runner-runtime',
  'plan-input-preparation',
  'terraform-plan',
  'plan-summary',
]);

export const DYNAMODB_RECOVERY_READINESS_CHECK_FAILURE_STAGES = Object.freeze([
  'authority-admission',
  'baseline-admission',
  'dependency-admission',
  'identity-admission',
  'manifest-admission',
  'provider-initialization',
  'runner-runtime',
  'terraform-plan',
  'plan-summary',
]);

const EVIDENCE_KEYS = [
  'controlSourceSha',
  'evidenceType',
  'failureStage',
  'finishedAt',
  'planSummary',
  'reportOnly',
  'result',
  'startedAt',
  'targetKey',
];
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function parseCanonicalTimestamp(value, label) {
  if (
    typeof value !== 'string' ||
    !CANONICAL_TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical UTC timestamp.`);
  }
  return value;
}

export function validateReadinessCheckFailureEvidence(value) {
  const evidence = requireExactKeys(value, EVIDENCE_KEYS, 'Readiness check-failure evidence');
  const failureStages =
    evidence.evidenceType === 'app-rollback-readiness-check-failed'
      ? ROLLBACK_READINESS_CHECK_FAILURE_STAGES
      : evidence.evidenceType === 'dynamodb-recovery-readiness-check-failed'
        ? DYNAMODB_RECOVERY_READINESS_CHECK_FAILURE_STAGES
        : null;
  if (failureStages === null) {
    throw new Error('Readiness check-failure evidence type is invalid.');
  }
  const target = resolveAllowedDeploymentTarget('stark-dev/develop');
  if (evidence.targetKey !== target.targetKey) {
    throw new Error('Readiness check-failure target is invalid.');
  }
  const controlSourceSha = parseFullSourceSha(evidence.controlSourceSha, 'Readiness check-failure control source SHA');
  if (typeof evidence.failureStage !== 'string' || !failureStages.includes(evidence.failureStage)) {
    throw new Error('Readiness check-failure failure stage is invalid.');
  }
  if (evidence.result !== 'check-failed' || evidence.reportOnly !== true) {
    throw new Error('Readiness check-failure result or report-only boundary is invalid.');
  }
  if (evidence.planSummary !== null) {
    throw new Error('Readiness check-failure plan summary must be null.');
  }
  const startedAt = parseCanonicalTimestamp(evidence.startedAt, 'Readiness check-failure startedAt');
  const finishedAt = parseCanonicalTimestamp(evidence.finishedAt, 'Readiness check-failure finishedAt');
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error('Readiness check-failure finishedAt must not precede startedAt.');
  }
  return deepFreeze({
    evidenceType: evidence.evidenceType,
    targetKey: target.targetKey,
    controlSourceSha,
    startedAt,
    finishedAt,
    failureStage: evidence.failureStage,
    result: 'check-failed',
    planSummary: null,
    reportOnly: true,
  });
}
