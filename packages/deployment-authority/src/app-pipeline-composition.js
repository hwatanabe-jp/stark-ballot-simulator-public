import { resolveAllowedDeploymentTarget } from './index.js';
import { isDeepStrictEqual, types } from 'node:util';

import { bindAppAcceptanceSelection } from './app-acceptance-ledger.js';
import { projectAppRollbackAuthority } from './app-acceptance-projections.js';
import { deriveAppExecutionAuthoritySha256, projectRollbackAppExecutionAuthority } from './app-execution-authority.js';
import {
  admitAppImageSignatureVerifierDesiredState,
  selectAppImageSignatureVerifierAction,
} from './app-image-signature-verifier-reconciliation.js';
import { snapshotExactRecord } from './descriptor-snapshot.js';
import { canonicalJsonSha256, deepFreeze, requireString } from './internal.js';
import { admitAppReleaseSelection } from './app-release-selection.js';
import { admitAppSavedPlanAuthority } from './app-saved-plan-authority.js';
import { CURRENT_APP_STATUS_PIPELINE_ACTION } from './app-status-pipeline-authority.js';
import { decodeTerraformBaselineNonsecretInputValues } from './terraform-authority.js';

/** @typedef {ReturnType<typeof resolveAllowedDeploymentTarget>} AllowedDeploymentTarget */
const INPUT_KEYS = [
  'acceptanceSelection',
  'currentVerifierReconciliation',
  'emptyPlanAcceptanceSelection',
  'releaseInputs',
  'terraformSavedPlan',
  'verifierPreflightSavedPlan',
];
const BOUND_SELECTION_KEYS = [
  'acceptance',
  'acceptanceKey',
  'acceptanceObservation',
  'pointer',
  'pointerObservation',
  'selectionType',
  'targetKey',
];
const RELEASE_FACT_KEYS = [
  'foundationAcceptanceKey',
  'foundationContractHash',
  'proverImageDigest',
  'proverReleaseKey',
  'toolchainImageDigest',
  'toolchainReleaseKey',
  'zkvmContractHash',
];
const SOURCE_CHECKS = Object.freeze([
  'terraform-bootstrap-format',
  'terraform-app-format',
  'terraform-app-configuration',
  'node-runtime',
  'locked-dependencies',
  'repository-format',
  'repository-lint',
  'type-system',
  'public-safety',
  'unit-tests',
]);
const NORMAL_CARRIED_AUTHORITY = Object.freeze([
  'app-execution-authority',
  'deployment-identity',
  'foundation-acceptance',
  'toolchain-release',
  'prover-release',
  'verifier-signature-evidence',
  'zkvm-contract',
  'source-preflight',
]);
const ROLLBACK_CARRIED_AUTHORITY = Object.freeze([
  'app-execution-authority',
  'retained-app-acceptance',
  'retained-lambda-deployables',
  'retained-static-deployable',
  'rollback-execution-identity',
  'current-verifier-package',
  'retained-runtime-verifier',
  'zkvm-contract',
  'source-preflight',
]);
const ACTION_STAGES = Object.freeze({
  'select-source': 'Source',
  'resolve-release': 'ResolveRelease',
  'plan-verifier-preflight': 'VerifierPreflightPlan',
  'approve-verifier-preflight': 'VerifierPreflightApproval',
  'apply-verifier-preflight': 'VerifierPreflightApply',
  'verify-prover-signature': 'VerifyProverSignature',
  'plan-terraform': 'TerraformPlan',
  'approve-terraform': 'TerraformApproval',
  'apply-terraform': 'TerraformApply',
  'deploy-static-frontend': 'StaticFrontendDeploy',
  'smoke-runtime-and-publish-acceptance': 'PostApplySmoke',
});
const MAX_INSPECTED_VALUES = 100_000;
const MAX_INSPECTED_BYTES = 64 * 1024 * 1024;
const MAX_INSPECTION_DEPTH = 64;
const MAX_COLLECTION_ENTRIES = 10_000;

/**
 * Reject proxies before any reflective admission can reach their traps.
 * Other unsupported descriptors are rejected by the owning authority parser.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {{bytes: number; count: number}} [budget]
 * @param {Set<object>} [ancestors]
 * @param {number} [depth]
 * @param {number} [maximum]
 */
function rejectProxies(
  value,
  label,
  budget = { bytes: 0, count: 0 },
  ancestors = new Set(),
  depth = 0,
  maximum = MAX_INSPECTED_VALUES,
) {
  budget.count += 1;
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value, 'utf8');
  }
  if (budget.count > maximum || budget.bytes > MAX_INSPECTED_BYTES || depth > MAX_INSPECTION_DEPTH) {
    throw new Error(`${label} exceeds its inspection bound.`);
  }
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return;
  }
  if (types.isProxy(value)) {
    throw new Error(`${label} must not contain a proxy.`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${label} must not contain a cycle.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
      const length = lengthDescriptor?.value;
      if (
        lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, 'value') ||
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_COLLECTION_ENTRIES
      ) {
        throw new Error(`${label} contains an over-bound collection.`);
      }
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_COLLECTION_ENTRIES + (Array.isArray(value) ? 1 : 0)) {
      throw new Error(`${label} contains an over-bound collection.`);
    }
    for (const key of keys) {
      if (typeof key === 'string') {
        budget.bytes += Buffer.byteLength(key, 'utf8');
        if (budget.bytes > MAX_INSPECTED_BYTES) {
          throw new Error(`${label} exceeds its inspection bound.`);
        }
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
        rejectProxies(descriptor.value, label, budget, ancestors, depth + 1, maximum);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

/** @param {unknown} value @param {AllowedDeploymentTarget} target */
function admitBoundSelection(value, target) {
  rejectProxies(value, 'App pipeline acceptance selection');
  const selection = snapshotExactRecord(value, BOUND_SELECTION_KEYS, 'App pipeline acceptance selection');
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
  if (!isDeepStrictEqual(selection, rebound)) {
    throw new Error('App pipeline acceptance selection is detached from its admitted authority.');
  }
  return rebound;
}

/** @param {Readonly<Record<string, unknown>>} selection */
function acceptedReleaseChainSha256(selection) {
  const acceptance = /** @type {Readonly<Record<string, unknown>>} */ (selection['acceptance']);
  const release = /** @type {Readonly<Record<string, unknown>>} */ (acceptance['releaseAuthority']);
  return canonicalJsonSha256({
    foundationAcceptanceKey: release['foundationAcceptanceKey'],
    foundationContractHash: release['foundationContractHash'],
    proverReleaseKey: release['proverReleaseKey'],
    toolchainReleaseKey: release['toolchainReleaseKey'],
  });
}

/** @param {Readonly<Record<string, unknown>>} selected */
function selectedReleaseChainSha256(selected) {
  return canonicalJsonSha256({
    foundationAcceptanceKey: selected['foundationAcceptanceKey'],
    foundationContractHash: selected['foundationContractHash'],
    proverReleaseKey: selected['proverReleaseKey'],
    toolchainReleaseKey: selected['toolchainReleaseKey'],
  });
}

/**
 * Cross-bind a normal verifier-preflight review to the release facts displayed
 * by its mandatory approval.
 *
 * @param {unknown} value
 * @param {string} controlSourceSha
 * @param {string} selectedSourceSha
 * @param {Readonly<Record<string, unknown>>} releaseInputs
 * @param {AllowedDeploymentTarget} target
 */
function admitVerifierPreflight(value, controlSourceSha, selectedSourceSha, releaseInputs, target) {
  const classified = admitAppSavedPlanAuthority(value, target.targetKey);
  if (classified.disposition !== 'REVIEWABLE') {
    throw new Error('App verifier preflight must require review.');
  }
  const evidence = /** @type {Readonly<Record<string, unknown>>} */ (classified.evidence);
  const context = /** @type {Readonly<Record<string, unknown>>} */ (evidence['context']);
  const authority = /** @type {Readonly<Record<string, unknown>>} */ (classified.authority);
  const selectedReleaseAuthority = /** @type {Readonly<Record<string, unknown>>} */ (
    releaseInputs['selectedReleaseAuthority']
  );
  if (
    context['sourceSha'] !== controlSourceSha ||
    authority['packageSourceSha'] !== selectedSourceSha ||
    !RELEASE_FACT_KEYS.every((key) => authority[key] === selectedReleaseAuthority[key]) ||
    authority['releaseAuthoritySha256'] !== canonicalJsonSha256(selectedReleaseAuthority)
  ) {
    throw new Error('App verifier preflight is detached from its source or release authority.');
  }
  const summary = /** @type {Readonly<Record<string, unknown>>} */ (evidence['summary']);
  return deepFreeze({
    controlSourceSha,
    selectedSourceSha,
    ...selectedReleaseAuthority,
    releaseAuthoritySha256: canonicalJsonSha256(selectedReleaseAuthority),
    preflightActionCounts: summary['actionCounts'],
    preflightChangedAddresses: summary['changedAddresses'],
  });
}

/**
 * @param {Readonly<Record<string, unknown>>} authority
 * @param {Readonly<Record<string, unknown>>} releaseInputs
 */
function assertNormalReleaseBinding(authority, releaseInputs) {
  const selected = /** @type {Readonly<Record<string, unknown>>} */ (releaseInputs['selectedReleaseAuthority']);
  const prover = /** @type {Readonly<Record<string, unknown>>} */ (
    /** @type {Readonly<Record<string, unknown>>} */ (releaseInputs['prover'])['releaseRecord']
  );
  if (
    !RELEASE_FACT_KEYS.every((key) => authority[key] === selected[key]) ||
    authority['expectedImageId'] !== prover['expectedImageId'] ||
    authority['methodVersion'] !== prover['methodVersion'] ||
    authority['imageIdVariant'] !== prover['imageIdVariant']
  ) {
    throw new Error('App Terraform plan is detached from the resolved release inputs.');
  }
}

/**
 * @param {Readonly<Record<string, unknown>>} authority
 * @param {Readonly<Record<string, unknown>>} selection
 * @param {string} controlSourceSha
 * @param {unknown} currentVerifierInput
 * @param {AllowedDeploymentTarget} target
 */
function assertRollbackBinding(authority, selection, controlSourceSha, currentVerifierInput, target) {
  const rollback = projectAppRollbackAuthority(selection, target.targetKey);
  const release = rollback['releaseAuthority'];
  const proverImage = release['proverImage'];
  const toolchainImage = release['toolchainImage'];
  const zkvm = release['zkvm'];
  rejectProxies(currentVerifierInput, 'App rollback current verifier reconciliation');
  const currentVerifierRequest = snapshotExactRecord(
    currentVerifierInput,
    ['desired', 'observation'],
    'App rollback current verifier reconciliation',
  );
  const desiredVerifier = admitAppImageSignatureVerifierDesiredState(currentVerifierRequest['desired']);
  if (desiredVerifier.targetKey !== target.targetKey) {
    throw new Error('App rollback verifier target does not match the expected target.');
  }
  const currentVerifier = selectAppImageSignatureVerifierAction(desiredVerifier, currentVerifierRequest['observation']);
  if (currentVerifier['kind'] !== 'validate-live-state') {
    throw new Error('App rollback current verifier has not converged.');
  }
  const selectedFunction = currentVerifier['selectedFunction'];
  const runtimeFunction = currentVerifier['runtimeFunction'];
  const selectedConfiguration = selectedFunction['functionConfigurationAuthority'];
  const selectedEnvironment = selectedConfiguration['environment'];
  const desiredPackage = desiredVerifier['package'];
  const selectedPackage = {
    s3Bucket: desiredPackage['s3Bucket'],
    s3Key: desiredPackage['s3Key'],
    s3ObjectVersionId: desiredPackage['s3ObjectVersionId'],
  };
  const runtimeConfiguration = runtimeFunction['functionConfigurationAuthority'];
  const runtimeEnvironment = runtimeConfiguration['environment'];
  const desiredAliases = desiredVerifier['aliases'];
  const desiredRuntimeAlias = desiredAliases['runtime'];
  const desiredRuntimeTarget = desiredRuntimeAlias['target'];
  const runtimePackage =
    desiredRuntimeTarget['kind'] === 'retained-function'
      ? desiredRuntimeTarget['function']['resolvedS3Object']
      : selectedPackage;
  const deployables = rollback['deployables'];
  const lambdaArtifacts = deployables['lambdaArtifacts'];
  const retainedArtifacts = lambdaArtifacts['artifacts'];
  const normalizedArtifacts = Object.fromEntries(
    Object.entries(retainedArtifacts).map(([name, artifact]) => {
      return [
        name,
        {
          asset_manifest_sha256: artifact['assetManifestSha256'],
          s3_bucket: artifact['bucket'],
          s3_key: artifact['key'],
          s3_object_version: artifact['versionId'],
          source_code_hash: artifact['sourceCodeHash'],
          trust_root_sha256: artifact['trustRootSha256'],
        },
      ];
    }),
  );
  normalizedArtifacts['image_signature_verifier'] = {
    asset_manifest_sha256: selectedEnvironment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256'],
    s3_bucket: selectedPackage['s3Bucket'],
    s3_key: selectedPackage['s3Key'],
    s3_object_version: selectedPackage['s3ObjectVersionId'],
    source_code_hash: selectedFunction['codeSha256'],
    trust_root_sha256: selectedEnvironment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256'],
  };
  const lambdaSetSha256 = canonicalJsonSha256({
    sourceSha: lambdaArtifacts['sourceSha'],
    artifacts: normalizedArtifacts,
  });
  const executionAuthority = projectRollbackAppExecutionAuthority(
    {
      controlSourceSha,
      acceptanceSelection: selection,
    },
    target.targetKey,
  );
  const appExecutionAuthoritySha256 = deriveAppExecutionAuthoritySha256(executionAuthority, target.targetKey);
  const verifier = rollback['verifier'];
  const signaturePreflight = verifier['signaturePreflight'];
  const retainedVerifierPackage = signaturePreflight['verifierPackage'];
  const retainedInputValues = decodeTerraformBaselineNonsecretInputValues(rollback['nonsecretInputs']);
  const exactBindings = [
    [authority['selectedAcceptanceKey'], rollback['selectedAcceptanceKey']],
    [authority['selectedSourceSha'], rollback['selectedApplicationSourceSha']],
    [authority['lambdaSourceSha'], rollback['selectedApplicationSourceSha']],
    [authority['proverReleaseKey'], release['proverReleaseKey']],
    [authority['toolchainReleaseKey'], release['toolchainReleaseKey']],
    [authority['proverImageDigest'], proverImage['imageDigest']],
    [authority['toolchainImageDigest'], toolchainImage['imageDigest']],
    [authority['expectedImageId'], zkvm['expectedImageId']],
    [authority['methodVersion'], zkvm['methodVersion']],
    [authority['imageIdVariant'], zkvm['imageIdVariant']],
    [authority['imageIdMappingSha256'], zkvm['imageIdMappingSha256']],
    [authority['appExecutionAuthoritySha256'], appExecutionAuthoritySha256],
    [authority['lambdaSourceSha'], lambdaArtifacts['sourceSha']],
    [authority['lambdaSetSha256'], lambdaSetSha256],
    [authority['verifierFunctionVersion'], runtimeFunction['functionVersion']],
    [runtimePackage['s3Bucket'], retainedVerifierPackage['bucket']],
    [runtimePackage['s3Key'], retainedVerifierPackage['key']],
    [runtimePackage['s3ObjectVersionId'], retainedVerifierPackage['versionId']],
    [runtimeFunction['codeSha256'], retainedVerifierPackage['sourceCodeHash']],
    [
      runtimeEnvironment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256'],
      retainedVerifierPackage['assetManifestSha256'],
    ],
    [
      runtimeEnvironment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256'],
      retainedVerifierPackage['trustRootSha256'],
    ],
    [runtimeEnvironment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST'], proverImage['imageDigest']],
    [runtimeConfiguration['runtime'], retainedInputValues['lambda_runtime']],
    [runtimeConfiguration['timeout_seconds'], retainedInputValues['image_signature_verifier_lambda_timeout_seconds']],
    [
      runtimeEnvironment['IMAGE_SIGNATURE_VERIFIER_HANDLER_DEADLINE_MS'],
      String(retainedInputValues['image_signature_verifier_handler_deadline_ms']),
    ],
    [
      runtimeEnvironment['IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPT_TIMEOUT_MS'],
      String(retainedInputValues['image_signature_status_attempt_timeout_ms']),
    ],
    [
      runtimeEnvironment['IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPTS'],
      String(retainedInputValues['image_signature_status_max_attempts']),
    ],
    [
      runtimeEnvironment['IMAGE_SIGNATURE_VERIFIER_STATUS_RETRY_DELAY_MS'],
      String(retainedInputValues['image_signature_status_retry_delay_ms']),
    ],
    [
      runtimeEnvironment['IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS'],
      String(retainedInputValues['image_signature_verifier_process_timeout_ms']),
    ],
  ];
  if (exactBindings.some(([actual, expected]) => actual !== expected)) {
    throw new Error('App rollback plan or runtime verifier is detached from the retained acceptance.');
  }
  return deepFreeze({
    appExecutionAuthoritySha256,
    currentVerifier,
    executionAuthority,
    rollback,
  });
}

/** @param {'normal' | 'rollback'} mode @param {'manual-approval' | 'exact-empty-plan-skip'} terraformApproval */
function actions(mode, terraformApproval) {
  const preflightExecution = mode === 'normal' ? 'required' : 'retained-authority';
  return deepFreeze([
    action('select-source', [], [], ['SourceOutput'], 'required'),
    action('resolve-release', ['select-source'], ['SourceOutput'], ['ReleaseResolutionOutput'], 'required'),
    action(
      'plan-verifier-preflight',
      ['resolve-release'],
      ['SourceOutput', 'ReleaseResolutionOutput'],
      ['VerifierPreflightPlanOutput'],
      preflightExecution,
    ),
    action(
      'approve-verifier-preflight',
      ['plan-verifier-preflight'],
      [],
      [],
      mode === 'normal' ? 'required' : 'skipped',
    ),
    action(
      'apply-verifier-preflight',
      ['approve-verifier-preflight'],
      ['SourceOutput', 'ReleaseResolutionOutput', 'VerifierPreflightPlanOutput'],
      ['VerifierPreflightApplyOutput'],
      preflightExecution,
    ),
    action(
      'verify-prover-signature',
      ['apply-verifier-preflight'],
      ['SourceOutput', 'ReleaseResolutionOutput', 'VerifierPreflightApplyOutput'],
      ['VerifierSignatureOutput'],
      preflightExecution,
    ),
    action(
      'plan-terraform',
      ['verify-prover-signature'],
      ['SourceOutput', 'ReleaseResolutionOutput', 'VerifierSignatureOutput'],
      ['PlanOutput'],
      'required',
    ),
    action(
      'approve-terraform',
      ['plan-terraform'],
      [],
      [],
      terraformApproval === 'manual-approval' ? 'required' : 'skipped',
    ),
    action('apply-terraform', ['approve-terraform'], ['SourceOutput', 'PlanOutput'], ['ApplyOutput'], 'required'),
    action(
      'deploy-static-frontend',
      ['apply-terraform'],
      ['SourceOutput', 'ApplyOutput'],
      ['StaticDeployOutput'],
      'required',
    ),
    action(
      'smoke-runtime-and-publish-acceptance',
      ['deploy-static-frontend'],
      ['SourceOutput', 'PlanOutput', 'ApplyOutput', 'StaticDeployOutput'],
      [],
      'required',
    ),
    CURRENT_APP_STATUS_PIPELINE_ACTION,
  ]);
}

/**
 * @param {keyof typeof ACTION_STAGES} operation
 * @param {readonly string[]} predecessors
 * @param {readonly string[]} inputArtifacts
 * @param {readonly string[]} outputArtifacts
 * @param {string} execution
 */
function action(operation, predecessors, inputArtifacts, outputArtifacts, execution) {
  const stage = ACTION_STAGES[operation];
  if (stage === undefined) {
    throw new Error('App pipeline operation has no exact stage owner.');
  }
  const category =
    operation === 'select-source'
      ? 'Source'
      : operation === 'approve-verifier-preflight' || operation === 'approve-terraform'
        ? 'Approval'
        : 'Build';
  const provider =
    category === 'Source' ? 'CodeStarSourceConnection' : category === 'Approval' ? 'Manual' : 'CodeBuild';
  const primarySource = category === 'Build' ? 'SourceOutput' : null;
  if (category === 'Build' && (inputArtifacts.length < 1 || inputArtifacts.length > 5)) {
    throw new Error('App pipeline build action input artifact count is invalid.');
  }
  if (outputArtifacts.length > 5) {
    throw new Error('App pipeline action output artifact count is invalid.');
  }
  return {
    category,
    stage,
    operation,
    predecessors,
    inputArtifacts,
    outputArtifacts,
    primarySource,
    provider,
    execution,
  };
}

/**
 * @param {'normal' | 'rollback'} mode
 * @param {Readonly<Record<string, unknown>>} authority
 * @param {Readonly<Record<string, unknown>>} approval
 */
function terraformPlanAuthority(mode, authority, approval) {
  const carriedAuthority = mode === 'normal' ? [...NORMAL_CARRIED_AUTHORITY] : [...ROLLBACK_CARRIED_AUTHORITY];
  const executionAuthorityWork =
    mode === 'normal'
      ? {
          operation: 'materialize-app-execution-authority',
          inputs: ['deployment-inputs'],
          outputs: ['app-execution-authority'],
        }
      : {
          operation: 'materialize-retained-execution-authority',
          inputs: ['deployment-inputs'],
          outputs: ['app-execution-authority'],
        };
  const deploymentAuthority =
    mode === 'normal'
      ? {
          appExecutionAuthoritySha256: authority['appExecutionAuthoritySha256'],
          deploymentId: authority['deploymentId'],
          selectedSourceSha: authority['selectedSourceSha'],
          reviewedPlanChecksum: approval['reviewedPlanChecksum'],
          lambdaSetSha256: authority['lambdaSetSha256'],
        }
      : {
          appExecutionAuthoritySha256: authority['appExecutionAuthoritySha256'],
          selectedAcceptanceKey: authority['selectedAcceptanceKey'],
          deploymentId: authority['deploymentId'],
          selectedSourceSha: authority['selectedSourceSha'],
          reviewedPlanChecksum: approval['reviewedPlanChecksum'],
          lambdaSetSha256: authority['lambdaSetSha256'],
          verifierFunctionVersion: authority['verifierFunctionVersion'],
        };
  const deploymentMaterialization = 'app-execution-authority';
  const orderedWork = [
    { operation: 'verify-source-only-repository', inputs: ['SourceOutput'], outputs: ['source-checks'] },
    {
      operation: 'materialize-release-and-signature-authority',
      inputs: ['source-checks', 'ReleaseResolutionOutput', 'VerifierSignatureOutput'],
      outputs: ['deployment-inputs'],
    },
    executionAuthorityWork,
    {
      operation: 'materialize-deployment-artifacts',
      inputs: ['deployment-inputs', deploymentMaterialization],
      outputs: carriedAuthority.filter((name) => name !== 'app-execution-authority' && name !== 'source-preflight'),
    },
    {
      operation: 'write-source-preflight',
      inputs: ['SourceOutput', deploymentMaterialization],
      outputs: ['source-preflight'],
    },
    {
      operation: 'create-saved-plan',
      inputs: ['SourceOutput', ...carriedAuthority],
      outputs: ['PlanOutput'],
    },
  ];
  const outputOwners = orderedWork.flatMap((work) => work.outputs);
  if (new Set(outputOwners).size !== outputOwners.length) {
    throw new Error('App Terraform plan work must assign every output to exactly one owner.');
  }
  return deepFreeze({
    deploymentAuthority,
    sourceChecks: SOURCE_CHECKS,
    orderedWork,
    carriedAuthority,
  });
}

/**
 * Compose the exact App execution graph from already-owned acceptance and
 * saved-plan authorities. This pure boundary has no transport or state port.
 * Callers evaluating an empty-plan skip must invoke it with a newly observed
 * current acceptance selection; an earlier release-resolution observation is
 * not sufficient skip authority.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function composeAppPipelineExecution(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'App pipeline composition expected target'),
  );
  if ((typeof value === 'object' || typeof value === 'function') && value !== null && types.isProxy(value)) {
    throw new Error('App pipeline composition must not be a proxy.');
  }
  const input = snapshotExactRecord(value, INPUT_KEYS, 'App pipeline composition');
  const selection = admitBoundSelection(input['acceptanceSelection'], target);
  const terraformClassified = admitAppSavedPlanAuthority(input['terraformSavedPlan'], target.targetKey);
  const terraformEvidence = /** @type {Readonly<Record<string, unknown>>} */ (terraformClassified.evidence);
  const approval = /** @type {Readonly<Record<string, unknown>>} */ (terraformEvidence['approval']);
  const authority = /** @type {Readonly<Record<string, unknown>>} */ (terraformClassified.authority);
  const context = /** @type {Readonly<Record<string, unknown>>} */ (terraformEvidence['context']);
  const mode = approval['deploymentMode'];
  if (mode !== 'normal' && mode !== 'rollback') {
    throw new Error('App pipeline deployment mode is invalid.');
  }
  const controlSourceSha = /** @type {string} */ (approval['controlSourceSha']);
  const selectedSourceSha = /** @type {string} */ (approval['selectedSourceSha']);
  if (context['sourceSha'] !== controlSourceSha || authority['selectedSourceSha'] !== selectedSourceSha) {
    throw new Error('App Terraform plan is detached from its source authority.');
  }

  let releaseResolution;
  let verifierPreflightApproval;
  let terraformApproval;
  if (mode === 'normal') {
    if (selection.selectionType !== 'current') {
      throw new Error('A normal App execution requires the current acceptance selection.');
    }
    if (
      input['releaseInputs'] === null ||
      input['verifierPreflightSavedPlan'] === null ||
      input['currentVerifierReconciliation'] !== null
    ) {
      throw new Error('A normal App execution requires resolved releases and verifier preflight review.');
    }
    const releaseInputs = admitAppReleaseSelection(input['releaseInputs'], target.targetKey);
    if (releaseInputs.selectedSourceSha !== selectedSourceSha) {
      throw new Error('App release inputs are detached from the selected source.');
    }
    const preflightAuthority = admitVerifierPreflight(
      input['verifierPreflightSavedPlan'],
      controlSourceSha,
      selectedSourceSha,
      releaseInputs,
      target,
    );
    assertNormalReleaseBinding(authority, releaseInputs);
    const comparison = /** @type {Readonly<Record<string, unknown>> | null} */ (terraformClassified.releaseComparison);
    if (comparison !== null) {
      const selectedChainSha256 = selectedReleaseChainSha256(
        /** @type {Readonly<Record<string, unknown>>} */ (releaseInputs.selectedReleaseAuthority),
      );
      const currentChainSha256 = acceptedReleaseChainSha256(selection);
      if (
        comparison['selectedReleaseChainSha256'] !== selectedChainSha256 ||
        comparison['currentAcceptedReleaseChainSha256'] !== currentChainSha256
      ) {
        throw new Error('App release comparison is detached from its release resolution or current acceptance.');
      }
    }
    if (terraformClassified.disposition === 'EMPTY_PLAN_SKIP') {
      if (input['emptyPlanAcceptanceSelection'] === null) {
        throw new Error('An App empty-plan skip requires a decision-time current acceptance selection.');
      }
      const decisionSelection = admitBoundSelection(input['emptyPlanAcceptanceSelection'], target);
      if (decisionSelection.selectionType !== 'current') {
        throw new Error('An App empty-plan skip requires the decision-time current acceptance.');
      }
      if (
        comparison === null ||
        comparison['currentAcceptedReleaseChainSha256'] !== acceptedReleaseChainSha256(decisionSelection)
      ) {
        throw new Error('App empty-plan comparison is detached from its decision-time current acceptance.');
      }
      terraformApproval = {
        disposition: 'exact-empty-plan-skip',
        emptyPlanAuthority: {
          currentAcceptance: decisionSelection,
          releaseChainSha256: comparison['selectedReleaseChainSha256'],
        },
      };
    } else {
      if (input['emptyPlanAcceptanceSelection'] !== null) {
        throw new Error('A reviewable App plan must not consume empty-plan acceptance authority.');
      }
      terraformApproval = { disposition: 'manual-approval', emptyPlanAuthority: null };
    }
    releaseResolution = {
      currentAcceptance: selection,
      retainedAcceptance: null,
      selectedReleaseInputs: releaseInputs,
    };
    verifierPreflightApproval = { disposition: 'required', authority: preflightAuthority };
  } else {
    if (selection.selectionType !== 'retained') {
      throw new Error('An App rollback requires one retained acceptance selection.');
    }
    if (
      input['releaseInputs'] !== null ||
      input['verifierPreflightSavedPlan'] !== null ||
      input['emptyPlanAcceptanceSelection'] !== null ||
      input['currentVerifierReconciliation'] === null
    ) {
      throw new Error('App rollback must not resolve current releases or mutate verifier preflight authority.');
    }
    if (terraformClassified.disposition !== 'REVIEWABLE') {
      throw new Error('App rollback must require Terraform approval.');
    }
    const rollbackBinding = assertRollbackBinding(
      authority,
      selection,
      controlSourceSha,
      input['currentVerifierReconciliation'],
      target,
    );
    releaseResolution = {
      currentAcceptance: null,
      retainedAcceptance: selection,
      selectedReleaseInputs: null,
      selectedRollbackAuthority: rollbackBinding.rollback,
      currentVerifier: rollbackBinding.currentVerifier,
    };
    verifierPreflightApproval = { disposition: 'retained-authority', authority: null };
    terraformApproval = { disposition: 'manual-approval', emptyPlanAuthority: null };
  }

  const approvalDisposition = /** @type {'manual-approval' | 'exact-empty-plan-skip'} */ (
    terraformApproval.disposition
  );
  return deepFreeze({
    deploymentMode: mode,
    source: { controlSourceSha, selectedSourceSha },
    releaseResolution,
    approvals: {
      verifierPreflight: verifierPreflightApproval,
      terraform: terraformApproval,
    },
    actions: actions(mode, approvalDisposition),
    terraformPlan: terraformPlanAuthority(mode, authority, approval),
  });
}
