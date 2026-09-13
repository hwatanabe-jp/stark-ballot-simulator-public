import { snapshotDataTree } from './descriptor-snapshot.js';
import { deepFreeze, requireExactKeys, requireString } from './internal.js';
import { bindAppAcceptanceSelection } from './app-acceptance-ledger.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';

const BOUND_SELECTION_KEYS = [
  'acceptance',
  'acceptanceKey',
  'acceptanceObservation',
  'pointer',
  'pointerObservation',
  'selectionType',
  'targetKey',
];

/**
 * Re-admit a bound selection at every consumer boundary. This keeps a
 * projection from becoming a second App record parser and preserves the
 * pointer/history/body cross-binding established by the ledger kernel.
 *
 * @param {unknown} value
 * @param {import('./index.js').AllowedDeploymentTarget} target
 * @returns {import('./app-acceptance-ledger.js').BoundAppAcceptanceSelection}
 */
function admitBoundSelection(value, target) {
  const snapshot = snapshotDataTree(value, 'Bound App acceptance selection descriptor snapshot');
  let selection;
  try {
    selection = requireExactKeys(snapshot, BOUND_SELECTION_KEYS, 'Bound App acceptance selection');
  } catch (error) {
    throw new Error('Bound App acceptance selection must use the exact current shape.', { cause: error });
  }
  const rebound = bindAppAcceptanceSelection(
    {
      pointer: selection['pointer'],
      pointerObservation: selection['pointerObservation'],
      recordKey: selection['acceptanceKey'],
      record: selection['acceptance'],
      recordObservation: selection['acceptanceObservation'],
    },
    target.targetKey,
  );
  if (selection['selectionType'] !== rebound.selectionType || selection['targetKey'] !== rebound.targetKey) {
    throw new Error('Bound App acceptance selection metadata is detached from its pointer and record.');
  }
  return rebound;
}

/** @param {unknown} value @param {string} label @param {import('./index.js').AllowedDeploymentTarget} target */
function requireCurrent(value, label, target) {
  const selection = admitBoundSelection(value, target);
  if (selection.selectionType !== 'current') {
    throw new Error(`${label} requires the current App acceptance selection.`);
  }
  return selection;
}

/**
 * Project the exact historical App configuration needed by the report-only
 * drift runner. No state, current release pointer, or mutation authority is
 * included.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function projectAppTerraformDriftAuthority(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'App acceptance projection expected target'),
  );
  const selection = requireCurrent(value, 'App Terraform drift authority', target);
  const acceptance = selection.acceptance;
  return deepFreeze({
    authorityType: /** @type {const} */ ('app-terraform-drift-authority'),
    targetKey: acceptance.targetKey,
    acceptanceKey: selection.acceptanceKey,
    acceptedAt: acceptance.acceptedAt,
    controlSourceSha: acceptance.controlSourceSha,
    selectedApplicationSourceSha: acceptance.selectedApplicationSourceSha,
    deploymentMode: acceptance.deploymentMode,
    targetContext: acceptance.targetContext,
    backend: acceptance.backend,
    nonsecretInputs: acceptance.nonsecretInputs,
    secretReferences: acceptance.secretReferences,
    provider: acceptance.provider,
    acceptedPlanChecksum: acceptance.acceptedPlanChecksum,
  });
}

/**
 * Project only immutable App/release keys and digest-pinned images needed by
 * reference-aware retention. The controller may apply this projection to
 * every current-pointer history selection.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function projectRetainedAppImageAuthority(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'App acceptance projection expected target'),
  );
  const selection = admitBoundSelection(value, target);
  const authority = selection.acceptance.releaseAuthority;
  return deepFreeze({
    authorityType: /** @type {const} */ ('retained-app-image-authority'),
    targetKey: selection.targetKey,
    acceptanceKey: selection.acceptanceKey,
    toolchainReleaseKey: authority['toolchainReleaseKey'],
    proverReleaseKey: authority['proverReleaseKey'],
    toolchainImage: authority['toolchainImage'],
    proverImage: authority['proverImage'],
  });
}

/**
 * Project the deterministic, closed EventBridge request payload for a newly
 * current acceptance. Its timestamp is the immutable acceptedAt fact, never
 * invocation time.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function projectAppAcceptanceEvent(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'App acceptance projection expected target'),
  );
  const selection = requireCurrent(value, 'App acceptance event', target);
  const acceptance = selection.acceptance;
  return deepFreeze({
    source: 'stark-ballot.observability',
    detailType: 'Accepted Deployment',
    eventBusName: 'default',
    detail: {
      ts: acceptance.acceptedAt,
      event_type: 'deployment_accepted',
      env: acceptance.targetContext.target.environmentId,
      deployment_id: acceptance.deploymentId,
      deployment_mode: acceptance.deploymentMode,
      pipeline_execution_id: acceptance.pipelineExecutionId,
      plan_disposition: acceptance.planDisposition,
      resource_name: 'app',
      state: 'ACCEPTED',
    },
  });
}

/**
 * Project the exact current retained inputs used by the static-fast gate. The
 * attempt paths come from the admitted acceptance identity, not from an
 * operator or a second accepted-record parser.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function projectAppStaticFastAuthority(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'App acceptance projection expected target'),
  );
  resolveDeploymentLaneAuthority(target, 'static-fast');
  const selection = requireCurrent(value, 'App static-fast authority', target);
  const acceptance = selection.acceptance;
  const attemptPrefix =
    `${resolveDeploymentLaneAuthority(target, 'app').names.acceptedDeploymentPrefix}/executions/${acceptance.pipelineExecutionId}/attempts/` +
    acceptance.acceptanceAttemptId;
  const smoke = /** @type {Readonly<Record<string, unknown>>} */ (acceptance.smoke);
  const smokeEvidence = /** @type {Readonly<Record<string, unknown>>} */ (smoke['evidence']);
  if (smokeEvidence['key'] !== `${attemptPrefix}/app-smoke-report.json`) {
    throw new Error('App static-fast authority smoke evidence is detached from its accepted attempt.');
  }
  const staticFrontend = /** @type {Readonly<Record<string, unknown>>} */ (acceptance.deployables['staticFrontend']);
  const zkvm = /** @type {Readonly<Record<string, unknown>>} */ (acceptance.releaseAuthority['zkvm']);
  return deepFreeze({
    authorityType: /** @type {const} */ ('app-static-fast-authority'),
    targetKey: selection.targetKey,
    acceptanceKey: selection.acceptanceKey,
    acceptanceObservation: selection.acceptanceObservation,
    selectedApplicationSourceSha: acceptance.selectedApplicationSourceSha,
    deploymentId: acceptance.deploymentId,
    applyOutputsPath: `${attemptPrefix}/apply-outputs.json`,
    applyOutputsSha256: acceptance.runtime['applyOutputsSha256'],
    imageIdMappingSha256: zkvm['imageIdMappingSha256'],
    staticFrontendArtifactSha256: staticFrontend['artifactSha256'],
  });
}

/**
 * Project the currently accepted DynamoDB recovery phase and immutable
 * manifest reference. Historical selections cannot drive recovery state.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function projectAppCurrentRecoveryAuthority(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'App acceptance projection expected target'),
  );
  const selection = requireCurrent(value, 'App current recovery authority', target);
  const recovery = /** @type {Readonly<Record<string, unknown>>} */ (selection.acceptance.runtime['dynamodbRecovery']);
  return deepFreeze({
    authorityType: /** @type {const} */ ('app-current-recovery-authority'),
    targetKey: selection.targetKey,
    acceptanceKey: selection.acceptanceKey,
    current: recovery,
  });
}

/**
 * Project one retained acceptance into complete exact-forward rollback input.
 * The selected record already owns every historical release, deployable, and
 * drift coordinate; no current Toolchain, Prover, or Foundation read exists.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function projectAppRollbackAuthority(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'App acceptance projection expected target'),
  );
  const selection = admitBoundSelection(value, target);
  if (selection.selectionType !== 'retained') {
    throw new Error('App rollback authority requires a retained App acceptance selection.');
  }
  const acceptance = selection.acceptance;
  return deepFreeze({
    authorityType: /** @type {const} */ ('app-rollback-authority'),
    targetKey: selection.targetKey,
    selectedAcceptanceKey: selection.acceptanceKey,
    acceptedAt: acceptance.acceptedAt,
    controlSourceSha: acceptance.controlSourceSha,
    selectedApplicationSourceSha: acceptance.selectedApplicationSourceSha,
    deploymentId: acceptance.deploymentId,
    staticArtifactDeploymentId: acceptance.rollbackSelection?.staticArtifactDeploymentId ?? acceptance.deploymentId,
    deploymentMode: acceptance.deploymentMode,
    targetContext: acceptance.targetContext,
    backend: acceptance.backend,
    nonsecretInputs: acceptance.nonsecretInputs,
    secretReferences: acceptance.secretReferences,
    provider: acceptance.provider,
    acceptedPlanChecksum: acceptance.acceptedPlanChecksum,
    releaseAuthority: acceptance.releaseAuthority,
    verifier: acceptance.verifier,
    deployables: acceptance.deployables,
    runtime: acceptance.runtime,
  });
}
