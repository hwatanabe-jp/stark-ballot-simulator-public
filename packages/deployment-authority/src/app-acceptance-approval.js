import { allowsAppEmptyPlanSkip } from './plan-approval.js';
import { snapshotDataTree, snapshotExactRecord } from './descriptor-snapshot.js';
import { parseFullSourceSha, parseSha256, resolveAllowedDeploymentTarget } from './index.js';
import { requireGroupedLowercaseUuid, requireString } from './internal.js';

const COMMON_KEYS = [
  'accountId',
  'approvalMode',
  'approvalTimestamp',
  'approver',
  'controlSourceSha',
  'deploymentEnvironment',
  'deploymentMode',
  'evidenceType',
  'manualApprovalSkipped',
  'pipelineExecutionId',
  'reviewedPlanChecksum',
  'selectedSourceSha',
  'sourceSha',
];
const EMPTY_PLAN_KEYS = [
  'evidenceType',
  'importingResourceChangeCount',
  'movedResourceChangeCount',
  'outputChangeCount',
  'planEmpty',
  'resourceChangeCount',
];

/** @param {unknown} value @param {readonly string[]} keys @param {string} label */
function exact(value, keys, label) {
  return snapshotExactRecord(value, keys, label);
}

/**
 * Admit the unchanged App approval evidence wire without retaining any of the
 * retiring accepted-deployment parser.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function admitAppAcceptanceApprovalEvidence(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App post-smoke expected target'));
  const snapshot = /** @type {Readonly<Record<string, unknown>>} */ (
    snapshotDataTree(value, 'App acceptance approval evidence snapshot')
  );
  const empty = snapshot['approvalMode'] === 'empty-plan-skip';
  const approval = exact(
    snapshot,
    empty ? [...COMMON_KEYS, 'planEmptyEvidence'] : [...COMMON_KEYS, 'actionName', 'stageName'],
    'App acceptance approval evidence',
  );
  if (approval['evidenceType'] !== 'app-approval') {
    throw new Error('App acceptance approval evidence type is invalid.');
  }
  requireGroupedLowercaseUuid(approval['pipelineExecutionId'], 'App acceptance approval pipeline execution ID');
  const deploymentMode = approval['deploymentMode'];
  if (deploymentMode !== 'normal' && deploymentMode !== 'rollback') {
    throw new Error('App acceptance approval deployment mode is invalid.');
  }
  const controlSourceSha = parseFullSourceSha(
    approval['controlSourceSha'],
    'App acceptance approval control source SHA',
  );
  const selectedSourceSha = parseFullSourceSha(
    approval['selectedSourceSha'],
    'App acceptance approval selected source SHA',
  );
  const sourceSha = parseFullSourceSha(approval['sourceSha'], 'App acceptance approval source SHA');
  if (sourceSha !== selectedSourceSha || (deploymentMode === 'normal' && selectedSourceSha !== controlSourceSha)) {
    throw new Error('App acceptance approval source authority is invalid.');
  }
  if (approval['accountId'] !== target.accountId || approval['deploymentEnvironment'] !== target.environmentId) {
    throw new Error('App acceptance approval target is invalid.');
  }
  parseSha256(approval['reviewedPlanChecksum'], 'App acceptance approval reviewed plan checksum');
  if (empty) {
    if (
      !allowsAppEmptyPlanSkip(approval['deploymentEnvironment'], deploymentMode) ||
      approval['manualApprovalSkipped'] !== true ||
      approval['approver'] !== null ||
      approval['approvalTimestamp'] !== null
    ) {
      throw new Error('App acceptance empty-plan approval disposition is invalid.');
    }
    const evidence = exact(
      approval['planEmptyEvidence'],
      EMPTY_PLAN_KEYS,
      'App acceptance empty-plan approval evidence',
    );
    if (evidence['evidenceType'] !== 'app-plan-empty' || evidence['planEmpty'] !== true) {
      throw new Error('App acceptance empty-plan approval evidence type is invalid.');
    }
    for (const field of EMPTY_PLAN_KEYS.filter((key) => key.endsWith('Count'))) {
      if (!Number.isSafeInteger(evidence[field]) || evidence[field] !== 0) {
        throw new Error('App acceptance empty-plan approval evidence must contain zero Terraform changes.');
      }
    }
    return approval;
  }
  if (
    approval['approvalMode'] !== 'manual-approval' ||
    approval['manualApprovalSkipped'] !== false ||
    approval['stageName'] !== 'ManualApproval' ||
    approval['actionName'] !== 'ApproveTargetRuntimeApply'
  ) {
    throw new Error('App acceptance manual approval disposition is invalid.');
  }
  const approver = requireString(
    approval['approver'],
    'App acceptance manual approver',
    new RegExp(
      `^arn:${target.partition}:(?:iam|sts)::${target.accountId}:` + '(?:user|role|assumed-role)/[^\\s]+$',
      'u',
    ),
  );
  const approvalTimestamp = requireString(approval['approvalTimestamp'], 'App acceptance manual approval timestamp');
  if (
    approver.length === 0 ||
    Number.isNaN(Date.parse(approvalTimestamp)) ||
    new Date(approvalTimestamp).toISOString() !== approvalTimestamp
  ) {
    throw new Error('App acceptance manual approval authority is invalid.');
  }
  return approval;
}
