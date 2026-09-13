import { isDeepStrictEqual } from 'node:util';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import {
  assertNeverPublishedS3Object,
  canonicalJsonSha256,
  deepFreeze,
  parseImmutableObjectReference,
  parseS3VersionId,
  requireExactKeys,
  requireString,
} from './internal.js';
import { admitSavedPlanReviewContext, buildSavedPlanSemanticReview } from './saved-plan-semantic-review.js';
import { snapshotDataTree } from './descriptor-snapshot.js';
import {
  deriveTerraformAcceptancePointerKey,
  FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND,
} from './terraform-acceptance.js';

/**
 * @typedef {'app' | 'bootstrap' | 'foundation'} SavedPlanReviewLane
 * @typedef {'terraform' | 'verifier-preflight'} SavedPlanReviewGate
 * @typedef {'normal' | 'rollback'} SavedPlanReviewDeploymentMode
 * @typedef {object} SavedPlanReviewContext
 * @property {string} accountId
 * @property {string} backendKey
 * @property {string} deploymentEnvironment
 * @property {SavedPlanReviewGate} gate
 * @property {SavedPlanReviewLane} lane
 * @property {string} pipelineExecutionId
 * @property {string} region
 * @property {string} sourceSha
 * @property {string} stateIdentity
 * @typedef {object} SavedPlanReviewArtifact
 * @property {string} bucket
 * @property {string} key
 * @property {string} sha256
 * @property {string} versionId
 * @typedef {{ readonly bucket: string; readonly key: string } & (
 *   { readonly versionId: string; readonly etag: string } |
 *   { readonly versionId: null; readonly etag: null }
 * )} SavedPlanReviewState
 * @typedef {object} SavedPlanReviewPlanInput
 * @property {unknown} planJson
 * @property {string} planJsonSha256
 * @property {string} tfplanSha256
 * @typedef {object} SavedPlanReviewSourceApproval
 * @property {string} sourceSha
 * @property {string} accountId
 * @property {string} deploymentEnvironment
 * @property {string} reviewedPlanChecksum
 * @typedef {object} SavedPlanReviewAppApproval
 * @property {SavedPlanReviewDeploymentMode} deploymentMode
 * @property {string} controlSourceSha
 * @property {string} selectedSourceSha
 * @property {string} accountId
 * @property {string} deploymentEnvironment
 * @property {string} reviewedPlanChecksum
 * @typedef {object} SavedPlanReviewAppVerifierPreflightAuthority
 * @property {'app-verifier-preflight'} authorityType
 * @property {string} packageSourceSha
 * @property {string} proverImageDigest
 * @property {{ key: string, versionId: string, sha256: string }} package
 * @property {string} sourceCodeHash
 * @property {string} assetManifestSha256
 * @property {string} trustRootSha256
 * @property {string} expectedFunctionVersion
 * @property {string} reconciliationDesiredSha256
 * @property {{
 *   foundationAcceptanceKey: string,
 *   foundationAcceptedSourceSha: string,
 *   closureIdentity: string,
 *   foundationContractHash: string,
 * }} foundationAcceptance
 * @typedef {import('./saved-plan-semantic-review.js').SavedPlanReviewAppVerifierPrerequisiteAuthority} SavedPlanReviewAppVerifierPrerequisiteAuthority
 * @typedef {object} SavedPlanReviewAppDeploymentAuthority
 * @property {'app-deployment'} authorityType
 * @property {SavedPlanReviewDeploymentMode} deploymentMode
 * @property {string} selectedSourceSha
 * @property {string} deploymentId
 * @property {string} appExecutionAuthoritySha256
 * @property {'accepted' | 'pinned'} selectedProverSelector
 * @property {string} expectedImageId
 * @property {number} methodVersion
 * @property {'default' | 'x86_64'} imageIdVariant
 * @property {string} imageIdMappingSha256
 * @property {string} proverImageDigest
 * @property {string} toolchainImageDigest
 * @property {string} proverReleaseKey
 * @property {string} toolchainReleaseKey
 * @property {string} lambdaSourceSha
 * @property {6} lambdaCount
 * @property {string} lambdaSetSha256
 * @property {string} verifierFunctionVersion
 * @typedef {object} SavedPlanReviewInput
 * @property {SavedPlanReviewContext} context
 * @property {SavedPlanReviewArtifact} artifact
 * @property {SavedPlanReviewState} state
 * @property {SavedPlanReviewPlanInput} plan
 * @property {SavedPlanReviewSourceApproval | SavedPlanReviewAppApproval} approval
 * @property {null | SavedPlanReviewAppVerifierPreflightAuthority | SavedPlanReviewAppVerifierPrerequisiteAuthority | SavedPlanReviewAppDeploymentAuthority} authority
 * @typedef {ReturnType<typeof buildSavedPlanSemanticReview>} SavedPlanSemanticReview
 * @typedef {object} SavedPlanReview
 * @property {'saved-plan-review'} reviewType
 * @property {SavedPlanSemanticReview['context']} context
 * @property {SavedPlanReviewArtifact} artifact
 * @property {SavedPlanReviewState} state
 * @property {SavedPlanSemanticReview['summary']} summary
 * @property {SavedPlanSemanticReview['approval']} approval
 * @property {SavedPlanSemanticReview['authority']} authority
 * @property {string} reviewDigest
 */

/** @param {unknown} value @param {readonly string[]} keys @param {string} label */
function exactKeys(value, keys, label) {
  try {
    return requireExactKeys(value, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/** @param {unknown} value @param {string} label */
function parseS3BucketName(value, label) {
  const bucket = requireString(value, label, /^(?![0-9]+(?:\.[0-9]+){3}$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u);
  if (bucket.includes('..') || bucket.includes('.-') || bucket.includes('-.')) {
    throw new Error(`${label} is invalid.`);
  }
  return bucket;
}

/** @param {unknown} value */
function parseArtifact(value) {
  const artifact = exactKeys(value, ['bucket', 'key', 'sha256', 'versionId'], 'Saved-plan review artifact');
  const bucket = parseS3BucketName(artifact['bucket'], 'Saved-plan review artifact bucket');
  const reference = parseImmutableObjectReference({
    key: artifact['key'],
    versionId: artifact['versionId'],
    sha256: artifact['sha256'],
  });
  return deepFreeze({ bucket, ...reference });
}

/** @param {unknown} value @param {ReturnType<typeof admitSavedPlanReviewContext>} context @param {boolean} uncreated */
function parseState(value, context, uncreated) {
  const state = exactKeys(value, ['bucket', 'etag', 'key', 'versionId'], 'Saved-plan review state');
  const key = requireString(state['key'], 'Saved-plan review state key', /^[A-Za-z0-9][A-Za-z0-9._/-]{1,1023}$/u);
  if (key !== context.backendKey) {
    throw new Error('Saved-plan review state key does not match its backend context.');
  }
  if (uncreated) {
    if (state['etag'] !== null || state['versionId'] !== null)
      throw new Error('Initial saved-plan review requires explicitly uncreated state.');
    return deepFreeze({
      bucket: parseS3BucketName(state['bucket'], 'Saved-plan review state bucket'),
      key,
      versionId: null,
      etag: null,
    });
  }
  const etag = requireString(state['etag'], 'Saved-plan review state ETag', /^"[A-Za-z0-9._:+/=-]{1,1022}"$/u);
  if (Buffer.byteLength(etag, 'utf8') > 1024) {
    throw new Error('Saved-plan review state ETag is invalid.');
  }
  return deepFreeze({
    bucket: parseS3BucketName(state['bucket'], 'Saved-plan review state bucket'),
    key,
    versionId: parseS3VersionId(state['versionId'], 'Saved-plan review state VersionId'),
    etag,
  });
}

/** @param {unknown} value @returns {value is Readonly<Record<string, unknown>>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Select initial Foundation review from the admitted saved plan, never an S3
 * lookup failure. Terraform can include newly refreshed data in prior_state
 * even when it has never written a default-workspace state object.
 * Full semantic plan admission remains mandatory before this selection.
 *
 * @param {unknown} value
 * @param {unknown} reviewContext
 * @param {string} expectedTargetKey
 */
export function isInitialFoundationPlan(value, reviewContext, expectedTargetKey) {
  const context = admitSavedPlanReviewContext(reviewContext, expectedTargetKey);
  if (context.lane !== 'foundation' || context.gate !== 'terraform' || context.deploymentEnvironment !== 'main') {
    return false;
  }
  const plan = snapshotDataTree(value, 'Initial Foundation plan');
  if (!isRecord(plan) || plan['complete'] !== true || plan['applyable'] !== true || plan['errored'] !== false) {
    return false;
  }
  const changes = plan['resource_changes'];
  if (!Array.isArray(changes) || changes.length === 0) return false;
  let managedCreates = 0;
  for (const resource of changes) {
    if (!isRecord(resource) || !isRecord(resource['change'])) return false;
    const change = resource['change'];
    if (!Array.isArray(change['actions']) || change['actions'].length !== 1) return false;
    if (resource['mode'] === 'managed') {
      if (change['actions'][0] !== 'create' || change['before'] !== null) return false;
      managedCreates += 1;
    } else if (resource['mode'] !== 'data' || !['read', 'no-op'].includes(change['actions'][0])) {
      return false;
    }
    if (Object.hasOwn(resource, 'previous_address') || Object.hasOwn(change, 'importing')) return false;
  }
  if (managedCreates === 0) return false;
  if (Object.hasOwn(plan, 'prior_state')) {
    const prior = plan['prior_state'];
    if (!isRecord(prior) || !isRecord(prior['values'])) return false;
    const values = prior['values'];
    if (Object.hasOwn(values, 'outputs')) {
      const priorOutputs = values['outputs'];
      if (!isRecord(priorOutputs)) return false;
      const plannedValues = plan['planned_values'];
      const plannedOutputs = isRecord(plannedValues) ? plannedValues['outputs'] : undefined;
      const outputChanges = plan['output_changes'];
      // Refresh can populate known outputs before any state has been published.
      // Admit only exact planned values that this plan still creates from null.
      for (const [name, output] of Object.entries(priorOutputs)) {
        const change = isRecord(outputChanges) ? outputChanges[name] : undefined;
        if (
          !isRecord(output) ||
          !isDeepStrictEqual(Object.keys(output).sort(), ['sensitive', 'type', 'value']) ||
          output['sensitive'] !== false ||
          !isRecord(plannedOutputs) ||
          !isDeepStrictEqual(output, plannedOutputs[name]) ||
          !isRecord(change) ||
          !isDeepStrictEqual(change['actions'], ['create']) ||
          change['before'] !== null ||
          change['before_sensitive'] !== false ||
          change['after_sensitive'] !== false ||
          change['after_unknown'] !== false ||
          !isDeepStrictEqual(output['value'], change['after'])
        ) {
          return false;
        }
      }
    }
    if (Object.hasOwn(values, 'root_module')) {
      const root = values['root_module'];
      if (!isRecord(root)) return false;
      if (
        Object.hasOwn(root, 'child_modules') &&
        (!Array.isArray(root['child_modules']) || root['child_modules'].length > 0)
      ) {
        return false;
      }
      if (
        Object.hasOwn(root, 'resources') &&
        (!Array.isArray(root['resources']) ||
          root['resources'].some((resource) => !isRecord(resource) || resource['mode'] !== 'data'))
      ) {
        return false;
      }
    }
  }
  if (
    Object.hasOwn(plan, 'resource_drift') &&
    (!Array.isArray(plan['resource_drift']) || plan['resource_drift'].length > 0)
  ) {
    return false;
  }
  const outputs = plan['output_changes'];
  if (
    outputs !== undefined &&
    (!isRecord(outputs) ||
      Object.values(outputs).some(
        (output) =>
          !isRecord(output) ||
          output['before'] !== null ||
          !Array.isArray(output['actions']) ||
          output['actions'].length !== 1 ||
          !(output['actions'][0] === 'create' || (output['actions'][0] === 'no-op' && output['after'] === null)),
      ))
  ) {
    return false;
  }
  return true;
}

/** @param {string} expectedTargetKey */
export function foundationInitialStateObjects(expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(expectedTargetKey);
  if (target.environmentId !== 'main') throw new Error('Initial Foundation state is production-only.');
  const lane = resolveDeploymentLaneAuthority(target, 'foundation');
  return deepFreeze([
    { kind: /** @type {const} */ ('state'), bucket: lane.names.terraformStateBucket, key: lane.backendKey },
    {
      kind: /** @type {const} */ ('acceptance'),
      bucket: lane.names.terraformAuthorityBucket,
      key: deriveTerraformAcceptancePointerKey(FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND, target.targetKey),
    },
  ]);
}

/** @param {unknown} value @param {'state' | 'acceptance'} kind @param {string} expectedTargetKey */
export function assertFoundationInitialStateObjectNeverPublished(value, kind, expectedTargetKey) {
  const scope = foundationInitialStateObjects(expectedTargetKey).find((object) => object.kind === kind);
  if (scope === undefined) throw new Error('Initial Foundation object family is invalid.');
  assertNeverPublishedS3Object(
    snapshotDataTree(value, 'Initial Foundation storage'),
    { ...scope, allowStateLockSuffix: kind === 'state' },
    'Initial Foundation review',
  );
  return scope;
}

/**
 * Builds the immutable semantic review bound to one exact saved-plan artifact.
 *
 * @param {SavedPlanReviewInput} value
 * @param {unknown} expectedTargetKey
 * @returns {SavedPlanReview}
 */
export function buildSavedPlanReview(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'Saved-plan expected target'));
  const input = exactKeys(
    value,
    ['approval', 'artifact', 'authority', 'context', 'plan', 'state'],
    'Saved-plan review input',
  );
  const context = admitSavedPlanReviewContext(input['context'], target.targetKey);
  const artifact = parseArtifact(input['artifact']);
  const laneAuthority = resolveDeploymentLaneAuthority(target, context.lane);
  const semantic = buildSavedPlanSemanticReview(
    {
      context: input['context'],
      plan: input['plan'],
      approval: input['approval'],
      authority: input['authority'],
    },
    target.targetKey,
  );
  const { summary, approval, authority } = semantic;
  const planBinding = exactKeys(
    input['plan'],
    ['planJson', 'planJsonSha256', 'tfplanSha256'],
    'Saved-plan review plan',
  );
  const state = parseState(
    input['state'],
    context,
    authority?.authorityType === 'app-verifier-prerequisite' ||
      isInitialFoundationPlan(planBinding['planJson'], context, target.targetKey),
  );
  if (
    artifact.bucket !== laneAuthority.names.artifactBucket ||
    state.bucket !== laneAuthority.names.terraformStateBucket
  ) {
    throw new Error('Saved-plan review artifact or state bucket does not match the expected target and lane.');
  }
  const reviewDigest = canonicalJsonSha256({ context, artifact, state, summary, approval, authority });
  return deepFreeze({
    reviewType: /** @type {const} */ ('saved-plan-review'),
    context,
    artifact,
    state,
    summary,
    approval,
    authority,
    reviewDigest,
  });
}
