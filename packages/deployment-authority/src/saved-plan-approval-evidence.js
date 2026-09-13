import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { snapshotDataTree, snapshotExactRecord } from './descriptor-snapshot.js';
import { snapshotBoundedBytes } from './exact-bytes.js';
import {
  canonicalJson,
  canonicalRecordJson,
  deepFreeze,
  parseGitCommitSha,
  parseS3VersionId,
  parseSha256,
  requireGroupedLowercaseUuid,
  requireString,
} from './internal.js';
import {
  parseDeploymentLaneContext,
  renderDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
  resolveBootstrapSavedPlanApprovalAction,
  resolveDeploymentLaneAuthority,
  validateAwsSsoCallerIdentityForPermissionSet,
} from './index.js';
import { admitSavedPlanCorrespondence, admitSavedPlanResolvedInputs } from './saved-plan-correspondence.js';
import { SAVED_PLAN_CORRESPONDENCE_BYTE_LIMITS } from './saved-plan-correspondence-byte-policy.js';
import { buildSavedPlanReview } from './saved-plan-review.js';
import { admitSavedPlanReviewContext } from './saved-plan-semantic-review.js';

/** @typedef {ReturnType<typeof resolveAllowedDeploymentTarget>} AllowedDeploymentTarget */
const COMPACT_SUMMARY_MAX_BYTES = 512;
const EXPANDED_EVIDENCE_MAX_BYTES = 1024 * 1024;
const SAVED_PLAN_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
/** @param {AllowedDeploymentTarget} expectedTarget */
function gatePolicies(expectedTarget) {
  return Object.freeze({
    'bootstrap/terraform': Object.freeze({
      stageName: 'ManualApproval',
      actionName: resolveBootstrapSavedPlanApprovalAction(expectedTarget),
    }),
    'foundation/terraform': Object.freeze({
      stageName: 'ManualApproval',
      actionName: 'ApproveFoundationApply',
    }),
    'app/verifier-preflight': Object.freeze({
      stageName: 'VerifierPreflightApproval',
      actionName: 'ApproveVerifierPreflightApply',
    }),
    'app/terraform': Object.freeze({
      stageName: 'ManualApproval',
      actionName: 'ApproveTargetRuntimeApply',
    }),
  });
}

/** @param {unknown} value @param {string} label @param {Set<object>} ancestors */
function rejectProxyTree(value, label, ancestors = new Set()) {
  if (typeof value !== 'object' || value === null) return;
  if (types.isProxy(value)) throw new Error(`${label} must not contain a Proxy.`);
  if (value instanceof Uint8Array) return;
  if (ancestors.has(value)) return;
  ancestors.add(value);
  try {
    let keys;
    try {
      keys = Reflect.ownKeys(value);
    } catch (error) {
      throw new Error(`${label} cannot be inspected safely.`, { cause: error });
    }
    for (const key of keys) {
      let descriptor;
      try {
        descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      } catch (error) {
        throw new Error(`${label} cannot be inspected safely.`, { cause: error });
      }
      if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
        rejectProxyTree(descriptor.value, label, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

/** @param {unknown} value @param {string} label */
function authorityTree(value, label) {
  rejectProxyTree(value, label);
  try {
    return snapshotDataTree(value, label);
  } catch (error) {
    throw new Error(`${label} must contain only canonical authority data.`, { cause: error });
  }
}

/** @param {unknown} value @param {readonly string[]} keys @param {string} label */
function exactRecord(value, keys, label) {
  rejectProxyTree(value, label);
  try {
    return snapshotExactRecord(value, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/** @param {unknown} value @param {string} label */
function uuid(value, label) {
  try {
    return requireGroupedLowercaseUuid(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

/**
 * Derives the only retained object key for one pending manual approval action.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {string}
 */
export function deriveSavedPlanApprovalEvidenceKey(value, expectedTargetKey) {
  const expectedTarget = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan approval evidence expected target'),
  );
  const input = exactRecord(
    value,
    ['actionExecutionId', 'gate', 'lane', 'pipelineExecutionId', 'targetKey'],
    'Saved-plan approval evidence key input',
  );
  const lane = input['lane'];
  const gate = input['gate'];
  if (
    input['targetKey'] !== expectedTarget.targetKey ||
    typeof lane !== 'string' ||
    typeof gate !== 'string' ||
    !Object.hasOwn(gatePolicies(expectedTarget), `${lane}/${gate}`)
  ) {
    throw new Error('Saved-plan approval evidence key authority is invalid.');
  }
  const pipelineExecutionId = uuid(input['pipelineExecutionId'], 'Saved-plan approval pipeline execution ID');
  const actionExecutionId = uuid(input['actionExecutionId'], 'Saved-plan approval action execution ID');
  return (
    `${resolveDeploymentLaneAuthority(expectedTarget, 'bootstrap').names.approvalEvidencePrefix}/saved-plans/${expectedTarget.targetKey}/${lane}/${gate}/` +
    `${pipelineExecutionId}/${actionExecutionId}.json`
  );
}

/**
 * Admits an observed key only when it exactly re-derives from the reviewed
 * saved-plan approval authority.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {string}
 */
export function admitSavedPlanApprovalEvidenceKey(value, expectedTargetKey) {
  const expectedTarget = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan approval evidence expected target'),
  );
  const key = requireString(value, 'Saved-plan approval evidence key');
  const authorityPrefix = `${resolveDeploymentLaneAuthority(expectedTarget, 'bootstrap').names.approvalEvidencePrefix}/saved-plans/${expectedTarget.targetKey}/`;
  if (!key.startsWith(authorityPrefix)) {
    throw new Error('Saved-plan approval evidence key is outside its exact authority.');
  }
  const segments = key.slice(authorityPrefix.length).split('/');
  if (segments.length !== 4) {
    throw new Error('Saved-plan approval evidence key is outside its exact authority.');
  }
  const [lane, gate, pipelineExecutionId, objectName] = segments;
  if (objectName === undefined || !objectName.endsWith('.json')) {
    throw new Error('Saved-plan approval evidence key is outside its exact authority.');
  }
  const actionExecutionId = objectName.slice(0, -'.json'.length);
  const admitted = deriveSavedPlanApprovalEvidenceKey(
    {
      targetKey: expectedTarget.targetKey,
      lane,
      gate,
      pipelineExecutionId,
      actionExecutionId,
    },
    expectedTarget.targetKey,
  );
  if (admitted !== key) {
    throw new Error('Saved-plan approval evidence key is outside its exact authority.');
  }
  return admitted;
}

/** @param {unknown} value @param {string} label */
function sha256(value, label) {
  try {
    return parseSha256(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

/** @param {unknown} value @param {string} label */
function sourceSha(value, label) {
  try {
    return parseGitCommitSha(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

/** @param {unknown} lane @param {string} controlSourceSha @param {string | null} selectedApplicationSourceSha */
function approvalSourceSha(lane, controlSourceSha, selectedApplicationSourceSha) {
  if (lane === 'app') {
    if (selectedApplicationSourceSha === null) {
      throw new Error('Saved-plan App approval evidence is missing its selected application source.');
    }
    return selectedApplicationSourceSha;
  }
  if (lane !== 'bootstrap' && lane !== 'foundation') {
    throw new Error('Saved-plan approval evidence source lane is invalid.');
  }
  if (selectedApplicationSourceSha !== null) {
    throw new Error('Saved-plan non-App approval evidence must not contain a selected application source.');
  }
  return controlSourceSha;
}

/** @param {Uint8Array | string} value */
function rawSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} value @param {string} label */
function timestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

/** @param {unknown} value @param {Readonly<Record<string, unknown>>} target @param {AllowedDeploymentTarget} expectedTarget */
function artifactBinding(value, target, expectedTarget) {
  const artifact = exactRecord(
    value,
    ['bucket', 'key', 'metadata', 'sha256', 'versionId'],
    'Saved-plan approval artifact',
  );
  const bucket = requireString(artifact['bucket'], 'Saved-plan approval artifact bucket');
  const key = requireString(
    artifact['key'],
    'Saved-plan approval artifact key',
    /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,1024}$/u,
  );
  const context = /** @type {import('./index.js').DeploymentLaneContext} */ (target);
  if (bucket !== context.names.artifactBucket) {
    throw new Error('Saved-plan approval artifact bucket does not match its lane.');
  }
  const versionId = parseS3VersionId(artifact['versionId'], 'Saved-plan approval artifact VersionId');
  const archiveSha256 = sha256(artifact['sha256'], 'Saved-plan approval artifact SHA-256');
  const metadata = exactRecord(
    artifact['metadata'],
    ['contentLength', 'etag', 'kmsKeyArn', 'lastModified', 'serverSideEncryption'],
    'Saved-plan approval artifact metadata',
  );
  const contentLength = metadata['contentLength'];
  if (
    typeof contentLength !== 'number' ||
    !Number.isSafeInteger(contentLength) ||
    contentLength < 1 ||
    contentLength > SAVED_PLAN_ARCHIVE_MAX_BYTES
  ) {
    throw new Error('Saved-plan approval artifact content length is invalid.');
  }
  const etag = requireString(metadata['etag'], 'Saved-plan approval artifact ETag', /^"[A-Za-z0-9._:+/=-]{1,1022}"$/u);
  const kmsKeyArn = requireString(
    metadata['kmsKeyArn'],
    'Saved-plan approval artifact KMS key ARN',
    new RegExp(
      `^arn:${expectedTarget.partition}:kms:${expectedTarget.region}:${expectedTarget.accountId}:key/` +
        '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      'u',
    ),
  );
  if (metadata['serverSideEncryption'] !== 'aws:kms') {
    throw new Error('Saved-plan approval artifact must use the exact KMS encryption mode.');
  }
  return deepFreeze({
    bucket,
    key,
    versionId,
    sha256: archiveSha256,
    metadata: {
      contentLength,
      etag,
      kmsKeyArn,
      lastModified: timestamp(metadata['lastModified'], 'Saved-plan approval artifact last-modified time'),
      serverSideEncryption: /** @type {const} */ ('aws:kms'),
    },
  });
}

/** @param {unknown} value @param {string} lane @param {string} gate @param {string} pipelineExecutionId @param {AllowedDeploymentTarget} expectedTarget */
function pendingActionBinding(value, lane, gate, pipelineExecutionId, expectedTarget) {
  const pending = exactRecord(
    value,
    ['actionExecutionId', 'actionName', 'pipelineExecutionId', 'stageName'],
    'Saved-plan pending approval action',
  );
  let contract;
  switch (`${lane}/${gate}`) {
    case 'bootstrap/terraform':
      contract = gatePolicies(expectedTarget)['bootstrap/terraform'];
      break;
    case 'foundation/terraform':
      contract = gatePolicies(expectedTarget)['foundation/terraform'];
      break;
    case 'app/verifier-preflight':
      contract = gatePolicies(expectedTarget)['app/verifier-preflight'];
      break;
    case 'app/terraform':
      contract = gatePolicies(expectedTarget)['app/terraform'];
      break;
    default:
      throw new Error('Saved-plan pending approval action does not match its governed gate.');
  }
  if (
    contract === undefined ||
    pending['stageName'] !== contract.stageName ||
    pending['actionName'] !== contract.actionName
  ) {
    throw new Error('Saved-plan pending approval action does not match its governed gate.');
  }
  const exactPipelineExecutionId = uuid(
    pending['pipelineExecutionId'],
    'Saved-plan pending approval pipeline execution ID',
  );
  if (exactPipelineExecutionId !== pipelineExecutionId) {
    throw new Error('Saved-plan pending approval action is detached from its pipeline execution.');
  }
  return deepFreeze({
    pipelineExecutionId: exactPipelineExecutionId,
    stageName: contract.stageName,
    actionName: contract.actionName,
    actionExecutionId: uuid(pending['actionExecutionId'], 'Saved-plan pending approval action execution ID'),
  });
}

/** @param {unknown} value @param {AllowedDeploymentTarget} expectedTarget */
function reviewerBinding(value, expectedTarget) {
  const reviewer = exactRecord(value, ['Account', 'Arn', 'UserId'], 'Saved-plan admin reviewer identity');
  const accountId = requireString(reviewer['Account'], 'Saved-plan admin reviewer account');
  const { arn } = validateAwsSsoCallerIdentityForPermissionSet(
    { Account: accountId, Arn: reviewer['Arn'] },
    expectedTarget,
    'AdministratorAccess',
  );
  const userId = requireString(
    reviewer['UserId'],
    'Saved-plan admin reviewer user ID',
    /^[A-Z0-9]+:[A-Za-z0-9+=,.@_-]+$/u,
  );
  const sessionName = arn.slice(arn.lastIndexOf('/') + 1);
  if (accountId !== expectedTarget.accountId || !userId.endsWith(`:${sessionName}`)) {
    throw new Error('Saved-plan admin reviewer identity does not match the reviewed target and session.');
  }
  return deepFreeze({ accountId, arn, userId });
}

/** @param {unknown} review @param {string} lane @param {string} gate */
function deploymentMode(review, lane, gate) {
  if (lane !== 'app') return /** @type {const} */ ('none');
  if (gate === 'verifier-preflight') return /** @type {const} */ ('normal');
  const reviewRecord = exactRecord(
    review,
    ['approval', 'artifact', 'authority', 'context', 'reviewDigest', 'reviewType', 'state', 'summary'],
    'Saved-plan reviewer-side review',
  );
  const approval = exactRecord(
    reviewRecord['approval'],
    [
      'accountId',
      'controlSourceSha',
      'deploymentEnvironment',
      'deploymentMode',
      'reviewedPlanChecksum',
      'selectedSourceSha',
    ],
    'Saved-plan App semantic approval',
  );
  if (approval['deploymentMode'] !== 'normal' && approval['deploymentMode'] !== 'rollback') {
    throw new Error('Saved-plan App deployment mode is invalid.');
  }
  return approval['deploymentMode'];
}

/** @param {unknown} value */
function terraformPlanJson(value) {
  const bytes = snapshotBoundedBytes(value, {
    label: 'Saved-plan approval Terraform plan JSON',
    maxBytes: SAVED_PLAN_CORRESPONDENCE_BYTE_LIMITS.tfplanJson,
  });
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error('Saved-plan approval Terraform plan JSON must be valid UTF-8.', { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('Saved-plan approval Terraform plan JSON must be valid JSON.', { cause: error });
  }
}

/** @param {unknown} value @param {Readonly<Record<string, unknown>>} correspondenceInput @param {AllowedDeploymentTarget} expectedTarget */
function admittedReview(value, correspondenceInput, expectedTarget) {
  const review = exactRecord(
    value,
    ['approval', 'artifact', 'authority', 'context', 'reviewDigest', 'reviewType', 'state', 'summary'],
    'Saved-plan reviewer-side review',
  );
  if (review['reviewType'] !== 'saved-plan-review') {
    throw new Error('Saved-plan approval requires the exact reviewer-side review.');
  }
  const files = exactRecord(
    correspondenceInput['files'],
    ['backend', 'providerLock', 'providerSelections', 'terraformIdentity', 'tfplan', 'tfplanJson'],
    'Saved-plan approval correspondence files',
  );
  const summary = exactRecord(
    review['summary'],
    [
      'actionCounts',
      'applyable',
      'changedAddresses',
      'checkStatusCounts',
      'complete',
      'deferredChangeCount',
      'drift',
      'errored',
      'formatVersion',
      'foundationBootstrapImpact',
      'omittedChangedAddressCount',
      'outputChanges',
      'planJsonSha256',
      'terraformVersion',
      'tfplanSha256',
    ],
    'Saved-plan reviewer-side review summary',
  );
  const rebuilt = buildSavedPlanReview(
    /** @type {Parameters<typeof buildSavedPlanReview>[0]} */ ({
      context: review['context'],
      artifact: review['artifact'],
      state: review['state'],
      plan: {
        planJson: terraformPlanJson(files['tfplanJson']),
        planJsonSha256: summary['planJsonSha256'],
        tfplanSha256: summary['tfplanSha256'],
      },
      approval: review['approval'],
      authority: review['authority'],
    }),
    expectedTarget.targetKey,
  );
  if (canonicalJson(rebuilt) !== canonicalJson(review)) {
    throw new Error('Saved-plan reviewer-side review is detached from the exact Terraform plan.');
  }
  return rebuilt;
}

/**
 * Exact-admits the complete reviewer-side material independently of a pending approval action.
 * Empty normal App plans use this boundary without creating approval evidence.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function admitSavedPlanReviewMaterial(value, expectedTargetKey) {
  const expectedTarget = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan approval evidence expected target'),
  );
  const input = exactRecord(value, ['correspondence', 'review'], 'Saved-plan review material input');
  const correspondenceInput = exactRecord(
    input['correspondence'],
    ['expected', 'files', 'manifestBody'],
    'Saved-plan approval correspondence',
  );
  const correspondence = admitSavedPlanCorrespondence(correspondenceInput, expectedTarget.targetKey);
  const review = admittedReview(input['review'], correspondenceInput, expectedTarget);
  const rebuiltSemanticReview = {
    reviewType: 'saved-plan-semantic-review',
    context: review.context,
    summary: review.summary,
    approval: review.approval,
    authority: review.authority,
  };
  if (canonicalJson(rebuiltSemanticReview) !== canonicalJson(correspondence.contract.review)) {
    throw new Error('Saved-plan reviewer-side review is detached from its correspondence.');
  }
  return deepFreeze({ correspondence, review });
}

/**
 * Builds the create-once expanded evidence for one conscious manual approval.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function buildExpandedSavedPlanApprovalEvidence(value, expectedTargetKey) {
  const expectedTarget = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan approval evidence expected target'),
  );
  const input = exactRecord(
    value,
    ['artifactObservation', 'correspondence', 'pendingAction', 'review', 'reviewerIdentity'],
    'Saved-plan expanded approval input',
  );
  const correspondenceInput = exactRecord(
    input['correspondence'],
    ['expected', 'files', 'manifestBody'],
    'Saved-plan approval correspondence',
  );
  const material = admitSavedPlanReviewMaterial(
    {
      correspondence: input['correspondence'],
      review: input['review'],
    },
    expectedTarget.targetKey,
  );
  const correspondence = material.correspondence;
  if (correspondence.contract.disposition !== 'REVIEWABLE') {
    throw new Error('Saved-plan manual approval evidence requires a reviewable disposition.');
  }
  const expected = exactRecord(
    correspondenceInput['expected'],
    [
      'backend',
      'contract',
      'execution',
      'providerIdentity',
      'resolvedInputs',
      'runtime',
      'source',
      'targetContext',
      'terraformIdentity',
    ],
    'Saved-plan approval correspondence expectations',
  );
  const context = parseDeploymentLaneContext(expected['targetContext']);
  const lane = String(correspondence.target.lane);
  const gate = String(correspondence.target.gate);
  const pendingAction = pendingActionBinding(
    input['pendingAction'],
    lane,
    gate,
    correspondence.execution.pipelineExecutionId,
    expectedTarget,
  );
  const artifact = artifactBinding(input['artifactObservation'], context, expectedTarget);
  const reviewer = reviewerBinding(input['reviewerIdentity'], expectedTarget);
  const review = material.review;
  const tfplanMetadata = correspondence.files['tfplan'];
  if (tfplanMetadata === undefined) {
    throw new Error('Saved-plan correspondence is missing its tfplan binding.');
  }
  if (
    review.artifact.bucket !== artifact.bucket ||
    review.artifact.key !== artifact.key ||
    review.artifact.versionId !== artifact.versionId ||
    review.artifact.sha256 !== artifact.sha256
  ) {
    throw new Error('Saved-plan reviewer-side review is detached from the exact artifact observation.');
  }
  if (
    review.state.bucket !== correspondence.backend.bucketName ||
    review.state.key !== correspondence.backend.backendKey
  ) {
    throw new Error('Saved-plan reviewer-side review state is detached from its correspondence backend.');
  }
  const source = deepFreeze({
    controlSourceSha: sourceSha(
      correspondence.source.requestedControlSourceSha,
      'Saved-plan approval control source SHA',
    ),
    selectedApplicationSourceSha:
      correspondence.source.selectedApplicationSourceSha === null
        ? null
        : sourceSha(
            correspondence.source.selectedApplicationSourceSha,
            'Saved-plan approval selected application source SHA',
          ),
  });
  return deepFreeze({
    target: {
      targetKey: correspondence.target.targetKey,
      accountId: correspondence.target.accountId,
      region: correspondence.target.region,
      deploymentEnvironment: correspondence.target.deploymentEnvironment,
      lane,
      gate,
    },
    source,
    contract: {
      deploymentMode: deploymentMode(review, lane, gate),
      disposition: correspondence.contract.disposition,
      reviewDigest: sha256(review.reviewDigest, 'Saved-plan reviewer-side review digest'),
      tfplanSha256: tfplanMetadata.sha256,
    },
    artifact,
    correspondenceSha256: rawSha256(
      snapshotBoundedBytes(correspondenceInput['manifestBody'], {
        label: 'Saved-plan correspondence manifest',
        maxBytes: SAVED_PLAN_CORRESPONDENCE_BYTE_LIMITS.manifest,
      }),
    ),
    execution: {
      pipelineExecutionId: correspondence.execution.pipelineExecutionId,
      stageName: pendingAction.stageName,
      actionName: pendingAction.actionName,
      actionExecutionId: pendingAction.actionExecutionId,
    },
    resolvedInputs: correspondence.resolvedInputs,
    review,
    reviewer,
  });
}

/** @param {unknown} value @param {AllowedDeploymentTarget} expectedTarget */
function approvalEvidence(value, expectedTarget) {
  const evidence = exactRecord(
    authorityTree(value, 'Saved-plan expanded approval evidence'),
    [
      'artifact',
      'contract',
      'correspondenceSha256',
      'execution',
      'resolvedInputs',
      'review',
      'reviewer',
      'source',
      'target',
    ],
    'Saved-plan expanded approval evidence',
  );
  const target = exactRecord(
    evidence['target'],
    ['accountId', 'deploymentEnvironment', 'gate', 'lane', 'region', 'targetKey'],
    'Saved-plan approval evidence target',
  );
  const lane = String(target['lane']);
  const gate = String(target['gate']);
  if (
    target['targetKey'] !== expectedTarget.targetKey ||
    target['accountId'] !== expectedTarget.accountId ||
    target['region'] !== expectedTarget.region ||
    target['deploymentEnvironment'] !== expectedTarget.environmentId ||
    !Object.hasOwn(gatePolicies(expectedTarget), `${lane}/${gate}`)
  ) {
    throw new Error('Saved-plan approval evidence target is invalid.');
  }
  const source = exactRecord(
    evidence['source'],
    ['controlSourceSha', 'selectedApplicationSourceSha'],
    'Saved-plan approval evidence source',
  );
  const controlSourceSha = sourceSha(source['controlSourceSha'], 'Saved-plan approval evidence control source SHA');
  const selectedApplicationSourceSha =
    source['selectedApplicationSourceSha'] === null
      ? null
      : sourceSha(
          source['selectedApplicationSourceSha'],
          'Saved-plan approval evidence selected application source SHA',
        );
  const effectiveSourceSha = approvalSourceSha(lane, controlSourceSha, selectedApplicationSourceSha);
  const contract = exactRecord(
    evidence['contract'],
    ['deploymentMode', 'disposition', 'reviewDigest', 'tfplanSha256'],
    'Saved-plan approval evidence contract',
  );
  const requiredMode = lane === 'app' ? (gate === 'verifier-preflight' ? 'normal' : null) : 'none';
  if (
    requiredMode === null
      ? contract['deploymentMode'] !== 'normal' && contract['deploymentMode'] !== 'rollback'
      : contract['deploymentMode'] !== requiredMode
  ) {
    throw new Error('Saved-plan approval evidence contract is invalid.');
  }
  if (contract['disposition'] !== 'REVIEWABLE') {
    throw new Error('Saved-plan manual approval evidence requires a reviewable disposition.');
  }
  if (lane === 'app' && contract['deploymentMode'] === 'normal' && selectedApplicationSourceSha !== controlSourceSha) {
    throw new Error('Saved-plan approval evidence source does not match its deployment mode.');
  }
  const execution = exactRecord(
    evidence['execution'],
    ['actionExecutionId', 'actionName', 'pipelineExecutionId', 'stageName'],
    'Saved-plan approval evidence execution',
  );
  const pipelineExecutionId = uuid(
    execution['pipelineExecutionId'],
    'Saved-plan approval evidence pipeline execution ID',
  );
  const pending = pendingActionBinding(execution, lane, gate, pipelineExecutionId, expectedTarget);
  const context = renderDeploymentLaneContext({
    target: expectedTarget,
    lane: /** @type {'app' | 'bootstrap' | 'foundation'} */ (lane),
    accountId: expectedTarget.accountId,
    requestedControlSourceSha: controlSourceSha,
    selectedApplicationSourceSha: effectiveSourceSha,
    frameworkSourceSha: controlSourceSha,
  });
  artifactBinding(evidence['artifact'], context, expectedTarget);
  const reviewer = exactRecord(
    evidence['reviewer'],
    ['accountId', 'arn', 'userId'],
    'Saved-plan approval evidence reviewer',
  );
  reviewerBinding({ Account: reviewer['accountId'], Arn: reviewer['arn'], UserId: reviewer['userId'] }, expectedTarget);
  const review = exactRecord(
    evidence['review'],
    ['approval', 'artifact', 'authority', 'context', 'reviewDigest', 'reviewType', 'state', 'summary'],
    'Saved-plan approval evidence review',
  );
  const reviewContext = admitSavedPlanReviewContext(review['context'], expectedTarget.targetKey);
  const reviewState = exactRecord(
    review['state'],
    ['bucket', 'etag', 'key', 'versionId'],
    'Saved-plan approval evidence review state',
  );
  if (reviewState['bucket'] !== context.names.terraformStateBucket || reviewState['key'] !== context.root.backendKey) {
    throw new Error('Saved-plan approval evidence review state does not match its expected target and lane.');
  }
  const reviewArtifact = exactRecord(
    review['artifact'],
    ['bucket', 'key', 'sha256', 'versionId'],
    'Saved-plan approval evidence review artifact',
  );
  const evidenceArtifact = exactRecord(
    evidence['artifact'],
    ['bucket', 'key', 'metadata', 'sha256', 'versionId'],
    'Saved-plan approval evidence artifact',
  );
  const reviewSummary = exactRecord(
    review['summary'],
    [
      'actionCounts',
      'applyable',
      'changedAddresses',
      'checkStatusCounts',
      'complete',
      'deferredChangeCount',
      'drift',
      'errored',
      'formatVersion',
      'foundationBootstrapImpact',
      'omittedChangedAddressCount',
      'outputChanges',
      'planJsonSha256',
      'terraformVersion',
      'tfplanSha256',
    ],
    'Saved-plan approval evidence review summary',
  );
  if (
    review['reviewType'] !== 'saved-plan-review' ||
    review['reviewDigest'] !== contract['reviewDigest'] ||
    reviewContext['accountId'] !== target['accountId'] ||
    reviewContext['deploymentEnvironment'] !== target['deploymentEnvironment'] ||
    reviewContext['gate'] !== gate ||
    reviewContext['lane'] !== lane ||
    reviewContext['pipelineExecutionId'] !== pipelineExecutionId ||
    reviewContext['region'] !== target['region'] ||
    reviewContext['sourceSha'] !== controlSourceSha ||
    reviewSummary['tfplanSha256'] !== contract['tfplanSha256'] ||
    reviewArtifact['bucket'] !== evidenceArtifact['bucket'] ||
    reviewArtifact['key'] !== evidenceArtifact['key'] ||
    reviewArtifact['versionId'] !== evidenceArtifact['versionId'] ||
    reviewArtifact['sha256'] !== evidenceArtifact['sha256']
  ) {
    throw new Error('Saved-plan approval evidence review is detached from its retained authority.');
  }
  sha256(evidence['correspondenceSha256'], 'Saved-plan approval evidence correspondence SHA-256');
  sha256(contract['reviewDigest'], 'Saved-plan approval evidence review digest');
  sha256(contract['tfplanSha256'], 'Saved-plan approval evidence tfplan SHA-256');
  admitSavedPlanResolvedInputs({ lane, resolvedInputs: evidence['resolvedInputs'] }, expectedTarget.targetKey);
  return {
    evidence,
    target,
    source: { controlSourceSha, selectedApplicationSourceSha },
    contract,
    execution: pending,
  };
}

/**
 * Renders the bounded CodePipeline approval summary for one persisted expanded evidence object.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function renderCompactSavedPlanApprovalSummary(value, expectedTargetKey) {
  const expectedTarget = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan approval evidence expected target'),
  );
  const input = exactRecord(
    authorityTree(value, 'Saved-plan compact approval summary input'),
    ['evidence', 'evidenceReference'],
    'Saved-plan compact approval summary input',
  );
  const admitted = approvalEvidence(input['evidence'], expectedTarget);
  const reference = exactRecord(
    input['evidenceReference'],
    ['key', 'sha256', 'versionId'],
    'Saved-plan expanded approval evidence reference',
  );
  const expectedKey = deriveSavedPlanApprovalEvidenceKey(
    {
      targetKey: admitted.target['targetKey'],
      lane: admitted.target['lane'],
      gate: admitted.target['gate'],
      pipelineExecutionId: admitted.execution.pipelineExecutionId,
      actionExecutionId: admitted.execution.actionExecutionId,
    },
    expectedTarget.targetKey,
  );
  const key = requireString(reference['key'], 'Saved-plan expanded approval evidence key');
  if (key !== expectedKey) {
    throw new Error('Saved-plan expanded approval evidence key is detached from its pending action.');
  }
  const versionId = parseS3VersionId(reference['versionId'], 'Saved-plan expanded approval evidence VersionId');
  const evidenceSha256 = sha256(reference['sha256'], 'Saved-plan expanded approval evidence SHA-256');
  if (rawSha256(canonicalRecordJson(admitted.evidence)) !== evidenceSha256) {
    throw new Error('Saved-plan expanded approval evidence SHA-256 does not match its canonical body.');
  }
  const summary = canonicalJson({
    accountId: admitted.target['accountId'],
    deploymentEnvironment: admitted.target['deploymentEnvironment'],
    deploymentMode: admitted.contract['deploymentMode'],
    disposition: admitted.contract['disposition'],
    evidenceSha256,
    evidenceVersionId: versionId,
    reviewedPlanChecksum: admitted.contract['tfplanSha256'],
    sourceSha: approvalSourceSha(
      admitted.target['lane'],
      admitted.source.controlSourceSha,
      admitted.source.selectedApplicationSourceSha,
    ),
  });
  if (Buffer.byteLength(summary, 'utf8') > COMPACT_SUMMARY_MAX_BYTES) {
    throw new Error('Saved-plan compact approval summary exceeds its byte bound.');
  }
  return summary;
}

/**
 * Exact-admits a compact summary by rebuilding it from its expanded evidence and immutable object reference.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function admitCompactSavedPlanApprovalSummary(value, expectedTargetKey) {
  const expectedTarget = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan approval evidence expected target'),
  );
  const input = exactRecord(
    authorityTree(value, 'Saved-plan compact approval summary admission input'),
    ['compactSummary', 'evidence', 'evidenceReference'],
    'Saved-plan compact approval summary admission input',
  );
  const compactSummary = requireString(input['compactSummary'], 'Saved-plan compact approval summary');
  const expected = renderCompactSavedPlanApprovalSummary(
    {
      evidence: input['evidence'],
      evidenceReference: input['evidenceReference'],
    },
    expectedTarget.targetKey,
  );
  if (Buffer.byteLength(compactSummary, 'utf8') > COMPACT_SUMMARY_MAX_BYTES || compactSummary !== expected) {
    throw new Error('Saved-plan compact approval summary does not match its expanded evidence.');
  }
  return compactSummary;
}

/** @param {unknown} value */
function expandedBody(value) {
  const body = snapshotBoundedBytes(value, {
    label: 'Saved-plan expanded approval evidence body',
    maxBytes: EXPANDED_EVIDENCE_MAX_BYTES,
  });
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (error) {
    throw new Error('Saved-plan expanded approval evidence body must be valid UTF-8.', { cause: error });
  }
  let parsed;
  try {
    parsed = authorityTree(JSON.parse(text), 'Saved-plan expanded approval evidence body');
  } catch (error) {
    throw new Error('Saved-plan expanded approval evidence body must be valid JSON.', { cause: error });
  }
  if (text !== canonicalRecordJson(parsed)) {
    throw new Error('Saved-plan expanded approval evidence body must use canonical JSON bytes.');
  }
  return { body, parsed };
}

/**
 * Exact-admits the persisted expanded evidence and its compact CodePipeline summary as one agreement.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function admitSavedPlanApprovalAgreement(value, expectedTargetKey) {
  const expectedTarget = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan approval evidence expected target'),
  );
  const input = exactRecord(
    value,
    ['compactSummary', 'correspondence', 'expandedBody', 'expandedReference', 'pendingAction'],
    'Saved-plan approval agreement input',
  );
  const body = expandedBody(input['expandedBody']);
  const parsedEvidence = approvalEvidence(body.parsed, expectedTarget).evidence;
  const reference = exactRecord(
    input['expandedReference'],
    ['key', 'sha256', 'versionId'],
    'Saved-plan expanded approval evidence reference',
  );
  const expectedSha256 = sha256(reference['sha256'], 'Saved-plan expanded approval evidence SHA-256');
  if (rawSha256(body.body) !== expectedSha256) {
    throw new Error('Saved-plan expanded approval evidence SHA-256 does not match its exact stored bytes.');
  }
  const artifact = exactRecord(
    parsedEvidence['artifact'],
    ['bucket', 'key', 'metadata', 'sha256', 'versionId'],
    'Saved-plan approval evidence artifact',
  );
  const reviewer = exactRecord(
    parsedEvidence['reviewer'],
    ['accountId', 'arn', 'userId'],
    'Saved-plan approval evidence reviewer',
  );
  const rebuilt = buildExpandedSavedPlanApprovalEvidence(
    {
      artifactObservation: artifact,
      correspondence: input['correspondence'],
      pendingAction: input['pendingAction'],
      review: parsedEvidence['review'],
      reviewerIdentity: {
        Account: reviewer['accountId'],
        Arn: reviewer['arn'],
        UserId: reviewer['userId'],
      },
    },
    expectedTarget.targetKey,
  );
  if (canonicalJson(rebuilt) !== canonicalJson(parsedEvidence)) {
    throw new Error('Saved-plan expanded approval evidence is detached from its admitted authorities.');
  }
  const evidenceReference = deepFreeze({
    key: requireString(reference['key'], 'Saved-plan expanded approval evidence key'),
    versionId: parseS3VersionId(reference['versionId'], 'Saved-plan expanded approval evidence VersionId'),
    sha256: expectedSha256,
  });
  const compactSummary = admitCompactSavedPlanApprovalSummary(
    {
      compactSummary: input['compactSummary'],
      evidence: rebuilt,
      evidenceReference,
    },
    expectedTarget.targetKey,
  );
  return deepFreeze({ compactSummary, evidence: rebuilt, evidenceReference });
}
