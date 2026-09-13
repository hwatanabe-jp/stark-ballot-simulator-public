/** @typedef {import('./index.js').AllowedDeploymentTarget} AllowedDeploymentTarget */
import { isDeepStrictEqual } from 'node:util';
import { allowsAppEmptyPlanSkip } from './plan-approval.js';
import { admitAppImageSignatureVerifierDesiredState } from './app-image-signature-verifier-reconciliation.js';
import { snapshotDataTree } from './descriptor-snapshot.js';
import { parseDynamoDbRecoveryPhase } from './dynamodb-recovery-phase.js';
import {
  canonicalJson,
  canonicalRecordJson,
  deepFreeze,
  parseDigestPinnedImageReference,
  parseGitCommitSha,
  parseImageDigest,
  parseImmutableObjectReference,
  parseS3VersionId,
  parseSha256,
  requireExactKeys,
  requireGroupedLowercaseUuid,
  requireString,
  sha256Text,
} from './internal.js';
import { parseDeploymentLaneContext, resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import { PROVER_RELEASE_KIND, TOOLCHAIN_RELEASE_KIND, admitReleaseRecordKey } from './release-ledger.js';
import { FOUNDATION_ACCEPTANCE_KIND, admitTerraformAcceptanceRecordKey } from './terraform-acceptance.js';
import {
  buildTerraformBaselineSecretReferences,
  decodeTerraformBaselineNonsecretInputValues,
  validateCodeBuildRuntimeEvidence,
  validateTerraformBackendAuthority,
  validateTerraformBaselineInputIdentity,
  validateTerraformBaselineProviderLock,
  validateTerraformBaselineProviderSelections,
} from './terraform-authority.js';

export const APP_ACCEPTANCE_KIND = /** @type {const} */ ('app-acceptance');
export const APP_CURRENT_ACCEPTANCE_POINTER_KIND = /** @type {const} */ ('app-current-acceptance-pointer');

const RECORD_KEY_SUFFIX_PATTERN = /^[0-9a-f]{64}\.json$/u;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const IMAGE_ID_PATTERN = /^0x[0-9a-f]{64}$/u;
const MAX_PROVIDER_LOCK_BYTES = 1024 * 1024;
const MAX_HISTORY_LENGTH = 10;
const AWS_PROVIDER_ADDRESS = 'registry.terraform.io/hashicorp/aws';
const TERRAFORM_VERSION = '1.15.8';
const AWS_PROVIDER_VERSION = '6.58.0';
const RETAINED_APP_ACCEPTANCE_PROVIDER_IDENTITIES = Object.freeze([
  Object.freeze({ terraformVersion: TERRAFORM_VERSION, awsProviderVersion: AWS_PROVIDER_VERSION }),
  Object.freeze({ terraformVersion: '1.15.5', awsProviderVersion: AWS_PROVIDER_VERSION }),
  Object.freeze({ terraformVersion: '1.15.5', awsProviderVersion: '6.57.1' }),
]);

const APP_ACCEPTANCE_KEYS = [
  'acceptanceAttemptId',
  'acceptedAt',
  'acceptedPlanChecksum',
  'approval',
  'backend',
  'controlSourceSha',
  'deployables',
  'deploymentId',
  'deploymentMode',
  'kind',
  'nonsecretInputs',
  'pipelineExecutionId',
  'planDisposition',
  'provider',
  'releaseAuthority',
  'rollbackSelection',
  'runtime',
  'secretReferences',
  'selectedApplicationSourceSha',
  'smoke',
  'targetContext',
  'targetKey',
  'verifier',
];
const PROVIDER_KEYS = ['lock', 'platform', 'runtime', 'selections', 'terraformVersion'];
const APPROVAL_KEYS = ['approvalMode', 'approvedAt', 'evidence', 'reviewedPlanChecksum'];
const SMOKE_KEYS = ['acceptedPlanChecksum', 'deploymentId', 'evidence', 'pipelineExecutionId', 'result'];
const RELEASE_AUTHORITY_KEYS = [
  'foundationAcceptanceKey',
  'foundationContractHash',
  'proverImage',
  'proverReleaseKey',
  'toolchainImage',
  'toolchainReleaseKey',
  'zkvm',
];
const IMAGE_KEYS = ['imageDigest', 'imageUri'];
const ZKVM_KEYS = [
  'applicationZkvmContractHash',
  'expectedImageId',
  'failureMarkerContractSha256',
  'imageIdMappingSha256',
  'imageIdVariant',
  'methodVersion',
  'proverZkvmContractHash',
  'zkvmContractHash',
];
const VERIFIER_KEYS = ['confirmedImageIdMapping', 'signaturePreflight'];
const CONFIRMED_MAPPING_KEYS = [
  'expectedImageId',
  'imageIdMappingSha256',
  'imageIdVariant',
  'methodVersion',
  'proverImageDigest',
  'proverReleaseKey',
  'zkvmContractHash',
];
const SIGNATURE_PREFLIGHT_KEYS = [
  'evidence',
  'managedSigningStatus',
  'proverImageUri',
  'proverReleaseKey',
  'result',
  'selectedApplicationSourceSha',
  'verifierIdentitySha256',
  'verifierPackage',
];
const DEPLOYABLES_KEYS = ['lambdaArtifacts', 'staticFrontend'];
const LAMBDA_SET_KEYS = ['artifactType', 'artifacts', 'bucket', 'prefix', 'sourceSha'];
const LAMBDA_ARTIFACT_KEYS = [
  'assetManifestSha256',
  'bucket',
  'key',
  'sha256',
  'sourceCodeHash',
  'trustRootSha256',
  'versionId',
];
const LAMBDA_ARTIFACT_NAMES = /** @type {const} */ ([
  'finalization_writer',
  'image_signature_verifier',
  'proof_dispatcher',
  'public_api',
  'semaphore_janitor',
  'verification_worker',
]);
const STATIC_FRONTEND_KEYS = ['artifactSha256', 'bucket', 'key', 'sha256', 'versionId'];
const ROLLBACK_SELECTION_KEYS = ['acceptanceKey', 'selectedDeploymentId', 'staticArtifactDeploymentId'];
const RUNTIME_KEYS = ['applyOutputsSha256', 'deploymentIdentityAuthoritySha256', 'dynamodbRecovery'];
const DYNAMODB_RECOVERY_KEYS = ['manifest', 'phase'];
const SELECTED_VERIFIER_AUTHORITY_KEYS = [
  'architecture',
  'environment_sha256',
  'execution_role_arn',
  'execution_role_assume_policy_sha256',
  'execution_role_permissions_boundary_arn',
  'execution_role_permissions_boundary_policy_sha256',
  'execution_role_policy_sha256',
  'function_arn',
  'function_configuration_sha256',
  'function_version',
  'package',
  'preflight_alias_arn',
  'runtime',
  'runtime_alias_arn',
  'timeout_seconds',
];
const SELECTED_VERIFIER_PACKAGE_KEYS = [
  'asset_manifest_sha256',
  's3_bucket',
  's3_key',
  's3_object_version',
  'source_code_hash',
  'trust_root_sha256',
];
const POINTER_KEYS = ['compareAndSwapEvidenceId', 'generation', 'headKey', 'history', 'kind', 'previous', 'targetKey'];
const POINTER_OBSERVATION_KEYS = ['etag', 'versionId'];
const INITIAL_POINTER_INPUT_KEYS = ['history', 'predecessor'];
const TRANSITION_INPUT_KEYS = ['currentPointer', 'currentPointerObservation', 'nextRecordKey'];
const SELECTION_INPUT_KEYS = ['pointer', 'pointerObservation', 'record', 'recordKey', 'recordObservation'];

/**
 * @typedef {{ readonly etag: string; readonly versionId: string }} AppObjectObservation
 * @typedef {{
 *   readonly kind: typeof APP_ACCEPTANCE_KIND;
 *   readonly targetKey: import('./index.js').DeploymentTargetKey;
 *   readonly targetContext: import('./index.js').DeploymentLaneContext;
 *   readonly backend: import('./terraform-authority.js').TerraformBackendAuthority;
 *   readonly nonsecretInputs: import('./terraform-authority.js').TerraformNonsecretInputs;
 *   readonly secretReferences: readonly import('./terraform-authority.js').TerraformSecretReference[];
 *   readonly provider: ReturnType<typeof admitProvider>;
 *   readonly acceptedPlanChecksum: string;
 *   readonly approval: ReturnType<typeof admitApproval>;
 *   readonly smoke: ReturnType<typeof admitSmoke>;
 *   readonly pipelineExecutionId: string;
 *   readonly acceptanceAttemptId: string;
 *   readonly acceptedAt: string;
 *   readonly controlSourceSha: string;
 *   readonly selectedApplicationSourceSha: string;
 *   readonly deploymentId: string;
 *   readonly deploymentMode: 'normal' | 'rollback';
 *   readonly planDisposition: 'changed' | 'empty';
 *   readonly releaseAuthority: ReturnType<typeof admitAppAcceptanceReleaseAuthority>;
 *   readonly rollbackSelection: Readonly<{
 *     readonly acceptanceKey: string;
 *     readonly selectedDeploymentId: string;
 *     readonly staticArtifactDeploymentId: string;
 *   }> | null;
 *   readonly verifier: ReturnType<typeof admitAppAcceptanceVerifierAuthority>;
 *   readonly deployables: ReturnType<typeof admitDeployables>;
 *   readonly runtime: ReturnType<typeof admitRuntime>;
 * }} AppAcceptance
 * @typedef {{
 *   readonly kind: typeof APP_CURRENT_ACCEPTANCE_POINTER_KIND;
 *   readonly targetKey: import('./index.js').DeploymentTargetKey;
 *   readonly generation: number;
 *   readonly headKey: string;
 *   readonly history: readonly string[];
 *   readonly previous: AppObjectObservation | null;
 *   readonly compareAndSwapEvidenceId: string;
 * }} AppCurrentAcceptancePointer
 * @typedef {{
 *   readonly selectionType: 'current' | 'retained';
 *   readonly targetKey: import('./index.js').DeploymentTargetKey;
 *   readonly pointer: AppCurrentAcceptancePointer;
 *   readonly pointerObservation: AppObjectObservation;
 *   readonly acceptanceKey: string;
 *   readonly acceptance: AppAcceptance;
 *   readonly acceptanceObservation: AppObjectObservation;
 * }} BoundAppAcceptanceSelection
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
function canonicalTimestamp(value, label) {
  if (
    typeof value !== 'string' ||
    !CANONICAL_TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function positiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function opaqueEtag(value, label) {
  const etag = requireString(value, label);
  if (etag.trim() !== etag || /\s/u.test(etag) || Buffer.byteLength(etag, 'utf8') > 1024) {
    throw new Error(`${label} is invalid.`);
  }
  return etag;
}

/** @param {unknown} value @param {string} label @returns {AppObjectObservation} */
function admitObservation(value, label) {
  const record = exactKeys(value, POINTER_OBSERVATION_KEYS, label);
  return deepFreeze({
    etag: opaqueEtag(record['etag'], `${label} ETag`),
    versionId: parseS3VersionId(record['versionId'], `${label} VersionId`),
  });
}

/** @param {unknown} value @param {string} label */
function immutableReference(value, label) {
  try {
    return parseImmutableObjectReference(value);
  } catch (error) {
    throw new Error(`${label} must be an exact immutable object reference.`, { cause: error });
  }
}

/** @param {unknown} value @param {string} label */
function imageId(value, label) {
  return requireString(value, label, IMAGE_ID_PATTERN);
}

/** @param {unknown} value @param {string} label */
function deploymentId(value, label) {
  return requireString(value, label, /^dep_[0-9a-f]{32}$/u);
}

/** @param {unknown} value @param {string} label */
function admissionUuid(value, label) {
  try {
    return requireGroupedLowercaseUuid(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

/** @param {unknown} value @param {import('./index.js').DeploymentLaneContext} context @param {boolean} retained */
function admitProviderForAuthority(value, context, retained) {
  const provider = exactKeys(value, PROVIDER_KEYS, 'App acceptance provider');
  const terraformVersion = provider['terraformVersion'];
  if (
    typeof terraformVersion !== 'string' ||
    provider['platform'] !== 'linux_amd64' ||
    (!retained && terraformVersion !== TERRAFORM_VERSION)
  ) {
    throw new Error('App acceptance Terraform runtime is invalid.');
  }
  const selectionsRecord = exactKeys(
    provider['selections'],
    [AWS_PROVIDER_ADDRESS],
    'App acceptance provider selections',
  );
  const awsProviderVersion = selectionsRecord[AWS_PROVIDER_ADDRESS];
  const identities = retained
    ? RETAINED_APP_ACCEPTANCE_PROVIDER_IDENTITIES
    : [{ terraformVersion: TERRAFORM_VERSION, awsProviderVersion: AWS_PROVIDER_VERSION }];
  if (
    typeof awsProviderVersion !== 'string' ||
    !identities.some(
      (identity) =>
        identity.terraformVersion === terraformVersion && identity.awsProviderVersion === awsProviderVersion,
    )
  ) {
    throw new Error(
      retained
        ? 'Retained App acceptance provider identity is invalid.'
        : 'App acceptance AWS provider selection is invalid.',
    );
  }
  const identity = {
    terraform_version: terraformVersion,
    platform: 'linux_amd64',
    terraform_outdated: false,
    provider_selections: { [AWS_PROVIDER_ADDRESS]: awsProviderVersion },
  };
  const selections = validateTerraformBaselineProviderSelections(selectionsRecord, identity);
  if (
    typeof provider['lock'] !== 'string' ||
    Buffer.byteLength(provider['lock'], 'utf8') === 0 ||
    Buffer.byteLength(provider['lock'], 'utf8') > MAX_PROVIDER_LOCK_BYTES ||
    provider['lock'].includes('\0')
  ) {
    throw new Error('App acceptance provider lock is invalid.');
  }
  const lockBytes = validateTerraformBaselineProviderLock(provider['lock'], identity);
  const lock = Buffer.from(lockBytes).toString('utf8');
  if (lock !== provider['lock']) {
    throw new Error('App acceptance provider lock is invalid.');
  }
  const runtime = validateCodeBuildRuntimeEvidence(provider['runtime'], context);
  return deepFreeze({
    lock,
    selections: { [AWS_PROVIDER_ADDRESS]: selections[AWS_PROVIDER_ADDRESS] },
    terraformVersion,
    platform: /** @type {const} */ ('linux_amd64'),
    runtime,
  });
}

/** @param {unknown} value @param {import('./index.js').DeploymentLaneContext} context */
function admitProvider(value, context) {
  return admitProviderForAuthority(value, context, false);
}

/** @param {unknown} value @param {import('./index.js').DeploymentLaneContext} context */
function admitRetainedProvider(value, context) {
  return admitProviderForAuthority(value, context, true);
}

/** @param {unknown} value @param {string} expectedPlanChecksum @param {'normal' | 'rollback'} mode @param {'changed' | 'empty'} disposition @param {string} expectedPipelineExecutionId @param {AllowedDeploymentTarget} target */
function admitApproval(value, expectedPlanChecksum, mode, disposition, expectedPipelineExecutionId, target) {
  const approval = exactKeys(value, APPROVAL_KEYS, 'App acceptance approval');
  const reviewedPlanChecksum = parseSha256(approval['reviewedPlanChecksum'], 'App acceptance reviewed plan checksum');
  if (reviewedPlanChecksum !== expectedPlanChecksum) {
    throw new Error('App acceptance approval is detached from its accepted plan.');
  }
  const expectedApprovalMode =
    allowsAppEmptyPlanSkip(target.environmentId, mode) && disposition === 'empty'
      ? 'empty-plan-skip'
      : 'manual-approval';
  if (approval['approvalMode'] !== expectedApprovalMode) {
    throw new Error('App acceptance approval does not match its plan disposition and deploy mode.');
  }
  let approvedAt = null;
  if (expectedApprovalMode === 'manual-approval') {
    approvedAt = canonicalTimestamp(approval['approvedAt'], 'App acceptance approval timestamp');
  } else if (approval['approvedAt'] !== null) {
    throw new Error('App acceptance empty-plan approval timestamp must be null.');
  }
  const evidence = immutableReference(approval['evidence'], 'App acceptance approval evidence');
  if (
    evidence.key !==
    `${resolveDeploymentLaneAuthority(target, 'app').names.approvalEvidencePrefix}/${expectedPipelineExecutionId}.json`
  ) {
    throw new Error('App acceptance approval evidence key is detached from its pipeline execution.');
  }
  return deepFreeze({
    approvalMode: expectedApprovalMode,
    approvedAt,
    evidence,
    reviewedPlanChecksum,
  });
}

/** @param {unknown} value @param {string} expectedPlanChecksum @param {string} expectedPipelineExecutionId @param {string} expectedAcceptanceAttemptId @param {string} expectedDeploymentId @param {AllowedDeploymentTarget} target */
function admitSmoke(
  value,
  expectedPlanChecksum,
  expectedPipelineExecutionId,
  expectedAcceptanceAttemptId,
  expectedDeploymentId,
  target,
) {
  const smoke = exactKeys(value, SMOKE_KEYS, 'App acceptance smoke');
  if (smoke['result'] !== 'passed') {
    throw new Error('App acceptance smoke result must be passed.');
  }
  const planChecksum = parseSha256(smoke['acceptedPlanChecksum'], 'App acceptance smoke plan checksum');
  if (planChecksum !== expectedPlanChecksum) {
    throw new Error('App acceptance smoke plan binding is invalid.');
  }
  if (smoke['pipelineExecutionId'] !== expectedPipelineExecutionId || smoke['deploymentId'] !== expectedDeploymentId) {
    throw new Error('App acceptance smoke execution binding is invalid.');
  }
  const evidence = immutableReference(smoke['evidence'], 'App acceptance smoke evidence');
  const expectedEvidenceKey =
    `${resolveDeploymentLaneAuthority(target, 'app').names.acceptedDeploymentPrefix}/executions/${expectedPipelineExecutionId}/attempts/` +
    `${expectedAcceptanceAttemptId}/app-smoke-report.json`;
  if (evidence.key !== expectedEvidenceKey) {
    throw new Error('App acceptance smoke evidence key is detached from its acceptance attempt.');
  }
  return deepFreeze({
    result: /** @type {const} */ ('passed'),
    evidence,
    acceptedPlanChecksum: planChecksum,
    pipelineExecutionId: expectedPipelineExecutionId,
    deploymentId: expectedDeploymentId,
  });
}

/** @param {unknown} value @param {'toolchain' | 'prover'} kind @param {AllowedDeploymentTarget} target */
function admitImage(value, kind, target) {
  const image = exactKeys(value, IMAGE_KEYS, `App acceptance ${kind} image`);
  const policy = {
    partition: target.partition,
    accountId: target.accountId,
    region: target.region,
    repository:
      kind === 'toolchain'
        ? resolveDeploymentLaneAuthority(target, 'app').names.toolchainRepository
        : resolveDeploymentLaneAuthority(target, 'app').names.proverRepository,
  };
  const parsed = parseDigestPinnedImageReference(image['imageUri'], policy);
  const digest = parseImageDigest(image['imageDigest'], `App acceptance ${kind} image digest`);
  if (parsed.digest !== digest) {
    const label = kind === 'prover' ? 'Prover' : 'Toolchain';
    throw new Error(`App acceptance ${label} image digest is detached from its URI.`);
  }
  return deepFreeze({ imageUri: parsed.imageUri, imageDigest: digest });
}

/** @param {unknown} value @param {unknown} expectedTargetKey */
export function admitAppAcceptanceReleaseAuthority(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App acceptance expected target'));
  const authority = exactKeys(value, RELEASE_AUTHORITY_KEYS, 'App acceptance release authority');
  const foundationAcceptanceKey = admitTerraformAcceptanceRecordKey(
    FOUNDATION_ACCEPTANCE_KIND,
    authority['foundationAcceptanceKey'],
    target.targetKey,
  );
  const toolchainReleaseKey = admitReleaseRecordKey(
    TOOLCHAIN_RELEASE_KIND,
    authority['toolchainReleaseKey'],
    target.targetKey,
  );
  const proverReleaseKey = admitReleaseRecordKey(PROVER_RELEASE_KIND, authority['proverReleaseKey'], target.targetKey);
  const toolchainImage = admitImage(authority['toolchainImage'], 'toolchain', target);
  const proverImage = admitImage(authority['proverImage'], 'prover', target);
  const zkvm = exactKeys(authority['zkvm'], ZKVM_KEYS, 'App acceptance zkVM authority');
  const applicationZkvmContractHash = parseSha256(
    zkvm['applicationZkvmContractHash'],
    'App acceptance application zkVM contract hash',
  );
  const proverZkvmContractHash = parseSha256(
    zkvm['proverZkvmContractHash'],
    'App acceptance Prover zkVM contract hash',
  );
  const zkvmContractHash = parseSha256(zkvm['zkvmContractHash'], 'App acceptance zkVM contract hash');
  if (applicationZkvmContractHash !== zkvmContractHash || proverZkvmContractHash !== zkvmContractHash) {
    throw new Error('App acceptance zkVM contract hashes must match exactly.');
  }
  const methodVersion = positiveInteger(zkvm['methodVersion'], 'App acceptance method version');
  if (zkvm['imageIdVariant'] !== 'default') {
    throw new Error('App acceptance ImageID variant must be default.');
  }
  return deepFreeze({
    foundationAcceptanceKey,
    foundationContractHash: parseSha256(authority['foundationContractHash'], 'App acceptance Foundation contract hash'),
    toolchainReleaseKey,
    proverReleaseKey,
    toolchainImage,
    proverImage,
    zkvm: {
      applicationZkvmContractHash,
      proverZkvmContractHash,
      zkvmContractHash,
      expectedImageId: imageId(zkvm['expectedImageId'], 'App acceptance expected ImageID'),
      methodVersion,
      imageIdVariant: /** @type {const} */ ('default'),
      imageIdMappingSha256: parseSha256(zkvm['imageIdMappingSha256'], 'App acceptance ImageID mapping SHA-256'),
      failureMarkerContractSha256: parseSha256(
        zkvm['failureMarkerContractSha256'],
        'App acceptance failure-marker contract SHA-256',
      ),
    },
  });
}

/** @param {unknown} value @param {string} expectedBucket @param {string} expectedPrefix */
function admitLambdaArtifacts(value, expectedBucket, expectedPrefix) {
  const artifactSet = exactKeys(value, LAMBDA_SET_KEYS, 'App acceptance Lambda deployables');
  if (
    artifactSet['artifactType'] !== 'app-lambda-artifacts' ||
    artifactSet['sourceSha'] !== parseGitCommitSha(artifactSet['sourceSha'], 'App acceptance Lambda source SHA') ||
    artifactSet['bucket'] !== expectedBucket ||
    artifactSet['prefix'] !== expectedPrefix
  ) {
    throw new Error('App acceptance Lambda deployable authority is invalid.');
  }
  const entries = exactKeys(artifactSet['artifacts'], LAMBDA_ARTIFACT_NAMES, 'App acceptance Lambda artifacts');
  /** @param {typeof LAMBDA_ARTIFACT_NAMES[number]} name */
  function admitArtifact(name) {
    const artifact = exactKeys(entries[name], LAMBDA_ARTIFACT_KEYS, `App acceptance Lambda artifact ${name}`);
    const sha256 = parseSha256(artifact['sha256'], `App acceptance Lambda artifact ${name} SHA-256`);
    const expectedSourceCodeHash = Buffer.from(sha256, 'hex').toString('base64');
    const basename = name === 'image_signature_verifier' ? 'image-signature-verifier' : name;
    const expectedKey = `${expectedPrefix}/${basename}.zip`;
    if (artifact['bucket'] !== expectedBucket || artifact['sourceCodeHash'] !== expectedSourceCodeHash) {
      throw new Error(`App acceptance Lambda artifact ${name} is inconsistent.`);
    }
    if (artifact['key'] !== expectedKey) {
      throw new Error(`App acceptance canonical Lambda artifact key for ${name} is invalid.`);
    }
    const verifier = name === 'image_signature_verifier';
    const assetManifestSha256 =
      artifact['assetManifestSha256'] === null
        ? null
        : parseSha256(artifact['assetManifestSha256'], `App acceptance Lambda artifact ${name} asset manifest SHA-256`);
    const trustRootSha256 =
      artifact['trustRootSha256'] === null
        ? null
        : parseSha256(artifact['trustRootSha256'], `App acceptance Lambda artifact ${name} trust root SHA-256`);
    if (verifier !== (assetManifestSha256 !== null && trustRootSha256 !== null)) {
      throw new Error(`App acceptance Lambda artifact ${name} verifier evidence is invalid.`);
    }
    return deepFreeze({
      bucket: expectedBucket,
      key: expectedKey,
      versionId: parseS3VersionId(artifact['versionId'], `App acceptance Lambda artifact ${name} VersionId`),
      sha256,
      sourceCodeHash: expectedSourceCodeHash,
      assetManifestSha256,
      trustRootSha256,
    });
  }
  return deepFreeze({
    artifactType: /** @type {const} */ ('app-lambda-artifacts'),
    sourceSha: /** @type {string} */ (artifactSet['sourceSha']),
    bucket: expectedBucket,
    prefix: expectedPrefix,
    artifacts: {
      finalization_writer: admitArtifact('finalization_writer'),
      image_signature_verifier: admitArtifact('image_signature_verifier'),
      proof_dispatcher: admitArtifact('proof_dispatcher'),
      public_api: admitArtifact('public_api'),
      semaphore_janitor: admitArtifact('semaphore_janitor'),
      verification_worker: admitArtifact('verification_worker'),
    },
  });
}

/** @param {unknown} value @param {string} sourceSha @param {string} staticOwnerDeploymentId @param {AllowedDeploymentTarget} target */
function admitDeployables(value, sourceSha, staticOwnerDeploymentId, target) {
  const deployables = exactKeys(value, DEPLOYABLES_KEYS, 'App acceptance deployables');
  const expectedPrefix = `${resolveDeploymentLaneAuthority(target, 'app').names.lambdaArtifactPrefix}/${sourceSha}`;
  const lambdaArtifacts = admitLambdaArtifacts(
    deployables['lambdaArtifacts'],
    resolveDeploymentLaneAuthority(target, 'app').names.appRetainedArtifactBucket,
    expectedPrefix,
  );
  if (lambdaArtifacts.sourceSha !== sourceSha) {
    throw new Error('App acceptance Lambda deployables are detached from the selected source.');
  }
  const staticFrontend = exactKeys(
    deployables['staticFrontend'],
    STATIC_FRONTEND_KEYS,
    'App acceptance static frontend deployable',
  );
  const expectedStaticKey = `${resolveDeploymentLaneAuthority(target, 'app').names.staticFrontendArtifactPrefix}/${sourceSha}/${staticOwnerDeploymentId}/dist.tar.gz`;
  if (
    staticFrontend['bucket'] !== resolveDeploymentLaneAuthority(target, 'app').names.appRetainedArtifactBucket ||
    staticFrontend['key'] !== expectedStaticKey
  ) {
    throw new Error('App acceptance static frontend deployable authority is invalid.');
  }
  return deepFreeze({
    lambdaArtifacts,
    staticFrontend: {
      bucket: resolveDeploymentLaneAuthority(target, 'app').names.appRetainedArtifactBucket,
      key: expectedStaticKey,
      versionId: parseS3VersionId(staticFrontend['versionId'], 'App acceptance static frontend VersionId'),
      sha256: parseSha256(staticFrontend['sha256'], 'App acceptance static frontend SHA-256'),
      artifactSha256: parseSha256(staticFrontend['artifactSha256'], 'App acceptance static frontend artifact SHA-256'),
    },
  });
}

/** @param {unknown} value @param {'normal' | 'rollback'} deploymentMode @param {AllowedDeploymentTarget} target */
function admitRollbackSelection(value, deploymentMode, target) {
  if (deploymentMode === 'normal') {
    if (value !== null) {
      throw new Error('Normal App acceptance must not carry a rollback selection.');
    }
    return null;
  }
  if (value === null) {
    throw new Error('Rollback App acceptance requires one retained rollback selection.');
  }
  const selection = exactKeys(value, ROLLBACK_SELECTION_KEYS, 'App acceptance rollback selection');
  return deepFreeze({
    acceptanceKey: admitAppAcceptanceRecordKey(selection['acceptanceKey'], target.targetKey),
    selectedDeploymentId: deploymentId(
      selection['selectedDeploymentId'],
      'App acceptance rollback selected deployment ID',
    ),
    staticArtifactDeploymentId: deploymentId(
      selection['staticArtifactDeploymentId'],
      'App acceptance rollback static artifact deployment ID',
    ),
  });
}

/** @param {unknown} value @param {string} deploymentIdentifier */
function admitRuntime(value, deploymentIdentifier) {
  const runtime = exactKeys(value, RUNTIME_KEYS, 'App acceptance runtime snapshot');
  const deploymentIdentityAuthoritySha256 = parseSha256(
    runtime['deploymentIdentityAuthoritySha256'],
    'App acceptance deployment identity authority SHA-256',
  );
  if (deploymentIdentifier !== `dep_${deploymentIdentityAuthoritySha256.slice(0, 32)}`) {
    throw new Error('App acceptance deployment ID is detached from its runtime identity authority.');
  }
  const recovery = exactKeys(runtime['dynamodbRecovery'], DYNAMODB_RECOVERY_KEYS, 'App acceptance DynamoDB recovery');
  const phase = parseDynamoDbRecoveryPhase(recovery['phase']);
  const manifest =
    recovery['manifest'] === null ? null : immutableReference(recovery['manifest'], 'App acceptance recovery manifest');
  if ((phase === 'primary_active') !== (manifest === null)) {
    throw new Error('App acceptance recovery manifest does not match the recovery phase.');
  }
  return deepFreeze({
    applyOutputsSha256: parseSha256(runtime['applyOutputsSha256'], 'App acceptance Apply outputs SHA-256'),
    deploymentIdentityAuthoritySha256,
    dynamodbRecovery: { phase, manifest },
  });
}

/** @param {unknown} value @param {ReturnType<typeof admitAppAcceptanceReleaseAuthority>} releaseAuthorityValue @param {string} sourceSha @param {unknown} expectedTargetKey */
export function admitAppAcceptanceVerifierAuthority(value, releaseAuthorityValue, sourceSha, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App acceptance expected target'));
  const releaseAuthority = admitAppAcceptanceReleaseAuthority(releaseAuthorityValue, target.targetKey);
  const verifier = exactKeys(value, VERIFIER_KEYS, 'App acceptance verifier authority');
  const mapping = exactKeys(
    verifier['confirmedImageIdMapping'],
    CONFIRMED_MAPPING_KEYS,
    'App acceptance confirmed ImageID mapping',
  );
  const { zkvm, proverImage } = releaseAuthority;
  /** @type {readonly (readonly [string, unknown])[]} */
  const expectedMappingFields = [
    ['proverReleaseKey', releaseAuthority['proverReleaseKey']],
    ['proverImageDigest', proverImage['imageDigest']],
    ['expectedImageId', zkvm['expectedImageId']],
    ['methodVersion', zkvm['methodVersion']],
    ['imageIdVariant', zkvm['imageIdVariant']],
    ['imageIdMappingSha256', zkvm['imageIdMappingSha256']],
    ['zkvmContractHash', zkvm['zkvmContractHash']],
  ];
  for (const [field, expected] of expectedMappingFields) {
    if (mapping[field] !== expected) {
      throw new Error(`App acceptance confirmed ImageID mapping ${field} is detached.`);
    }
  }
  const preflight = exactKeys(
    verifier['signaturePreflight'],
    SIGNATURE_PREFLIGHT_KEYS,
    'App acceptance signature preflight',
  );
  if (
    preflight['result'] !== 'passed' ||
    preflight['managedSigningStatus'] !== 'COMPLETE' ||
    preflight['selectedApplicationSourceSha'] !== sourceSha ||
    preflight['proverReleaseKey'] !== releaseAuthority['proverReleaseKey'] ||
    preflight['proverImageUri'] !== proverImage['imageUri']
  ) {
    throw new Error('App acceptance signature preflight authority is detached.');
  }
  const packageInput = exactKeys(
    preflight['verifierPackage'],
    LAMBDA_ARTIFACT_KEYS,
    'App acceptance signature preflight verifier package',
  );
  const packageSha256 = parseSha256(
    packageInput['sha256'],
    'App acceptance signature preflight verifier package SHA-256',
  );
  const verifierPackage = deepFreeze({
    bucket: requireString(packageInput['bucket'], 'App acceptance signature preflight verifier package bucket'),
    key: requireString(packageInput['key'], 'App acceptance signature preflight verifier package key'),
    versionId: parseS3VersionId(
      packageInput['versionId'],
      'App acceptance signature preflight verifier package VersionId',
    ),
    sha256: packageSha256,
    sourceCodeHash: requireString(
      packageInput['sourceCodeHash'],
      'App acceptance signature preflight verifier package source-code hash',
      /^[A-Za-z0-9+/]{43}=$/u,
    ),
    assetManifestSha256: parseSha256(
      packageInput['assetManifestSha256'],
      'App acceptance signature preflight verifier package asset-manifest SHA-256',
    ),
    trustRootSha256: parseSha256(
      packageInput['trustRootSha256'],
      'App acceptance signature preflight verifier package trust-root SHA-256',
    ),
  });
  if (
    verifierPackage.bucket !== resolveDeploymentLaneAuthority(target, 'app').names.appRetainedArtifactBucket ||
    verifierPackage.key !==
      `${resolveDeploymentLaneAuthority(target, 'app').names.lambdaArtifactPrefix}/${sourceSha}/image-signature-verifier.zip` ||
    verifierPackage.sourceCodeHash !== Buffer.from(packageSha256, 'hex').toString('base64')
  ) {
    throw new Error('App acceptance signature preflight verifier package authority is invalid.');
  }
  return deepFreeze({
    confirmedImageIdMapping: {
      proverReleaseKey: releaseAuthority.proverReleaseKey,
      proverImageDigest: proverImage.imageDigest,
      expectedImageId: zkvm.expectedImageId,
      methodVersion: zkvm.methodVersion,
      imageIdVariant: zkvm.imageIdVariant,
      imageIdMappingSha256: zkvm.imageIdMappingSha256,
      zkvmContractHash: zkvm.zkvmContractHash,
    },
    signaturePreflight: {
      result: /** @type {const} */ ('passed'),
      selectedApplicationSourceSha: sourceSha,
      proverReleaseKey: releaseAuthority.proverReleaseKey,
      proverImageUri: proverImage.imageUri,
      managedSigningStatus: /** @type {const} */ ('COMPLETE'),
      evidence: immutableReference(preflight['evidence'], 'App acceptance signature preflight evidence'),
      verifierIdentitySha256: parseSha256(
        preflight['verifierIdentitySha256'],
        'App acceptance verifier identity SHA-256',
      ),
      verifierPackage,
    },
  });
}

/** @param {AppAcceptance['verifier']} verifier @param {AppAcceptance['deployables']} deployables */
function assertVerifierDeployableBinding(verifier, deployables) {
  const preflight = verifier['signaturePreflight'];
  const verifierPackage = preflight['verifierPackage'];
  const lambdaArtifacts = deployables['lambdaArtifacts'];
  const artifacts = lambdaArtifacts['artifacts'];
  if (!isDeepStrictEqual(verifierPackage, artifacts['image_signature_verifier'])) {
    throw new Error('App acceptance signature preflight verifier package is detached from deployables.');
  }
}

/**
 * @param {Readonly<Record<string, unknown>>} inputValues
 * @param {'normal' | 'rollback'} deploymentMode
 * @param {AppAcceptance['releaseAuthority']} releaseAuthority
 * @param {AppAcceptance['deployables']} deployables
 * @param {import('./index.js').DeploymentLaneContext} context
 */
function assertVerifierInputAuthority(inputValues, deploymentMode, releaseAuthority, deployables, context) {
  const proverImage = releaseAuthority['proverImage'];
  const proverImageUri = proverImage['imageUri'];
  const preflightImageUri = inputValues['image_signature_preflight_prover_image_uri'];
  const baseImageUri = inputValues['image_signature_verifier_base_prover_image_uri'];
  const reconciliationDesiredJson = inputValues['image_signature_verifier_reconciliation_desired_json'];
  const reconciliationDesiredSha256 = inputValues['image_signature_verifier_reconciliation_desired_sha256'];
  const reconciledFunctionVersion = inputValues['image_signature_verifier_reconciled_function_version'];
  const selectedValue = inputValues['image_signature_verifier_selected_authority'];
  if (deploymentMode === 'normal') {
    if (
      preflightImageUri !== proverImageUri ||
      baseImageUri !== null ||
      typeof reconciliationDesiredJson !== 'string' ||
      typeof reconciliationDesiredSha256 !== 'string' ||
      typeof reconciledFunctionVersion !== 'string' ||
      !/^[1-9][0-9]*$/u.test(reconciledFunctionVersion) ||
      selectedValue !== null
    ) {
      throw new Error('Normal App acceptance verifier input authority is detached from its selected Prover image.');
    }
    let desired;
    try {
      desired = admitAppImageSignatureVerifierDesiredState(JSON.parse(reconciliationDesiredJson));
    } catch (error) {
      throw new Error('Normal App acceptance verifier reconciliation authority is invalid.', { cause: error });
    }
    const lambdaArtifacts = deployables['lambdaArtifacts'];
    const artifacts = lambdaArtifacts['artifacts'];
    const verifierArtifact = artifacts['image_signature_verifier'];
    const desiredPackage = desired['package'];
    const signatureAuthority = desired['signatureAuthority'];
    if (
      desired['targetKey'] !== `${context.target.accountLabel}/${context.target.environmentId}` ||
      canonicalJson(desired) !== reconciliationDesiredJson ||
      sha256Text(reconciliationDesiredJson) !== reconciliationDesiredSha256 ||
      desired['expectedFunctionVersion'] !== reconciledFunctionVersion ||
      desired['sourceSha'] !== inputValues['app_source_sha'] ||
      signatureAuthority['proverImageDigest'] !== proverImage['imageDigest'] ||
      desiredPackage['s3Bucket'] !== verifierArtifact['bucket'] ||
      desiredPackage['s3Key'] !== verifierArtifact['key'] ||
      desiredPackage['s3ObjectVersionId'] !== verifierArtifact['versionId'] ||
      desiredPackage['zipSha256'] !== verifierArtifact['sha256'] ||
      desiredPackage['codeSha256'] !== verifierArtifact['sourceCodeHash'] ||
      desiredPackage['assetManifestSha256'] !== verifierArtifact['assetManifestSha256'] ||
      desiredPackage['trustRootSha256'] !== verifierArtifact['trustRootSha256']
    ) {
      throw new Error('Normal App acceptance verifier reconciliation authority is detached.');
    }
    return;
  }
  if (
    preflightImageUri !== null ||
    baseImageUri !== proverImageUri ||
    reconciliationDesiredJson !== null ||
    reconciliationDesiredSha256 !== null ||
    reconciledFunctionVersion !== null ||
    selectedValue === null
  ) {
    throw new Error('Rollback App acceptance verifier input authority is detached from its selected Prover image.');
  }

  const selected = exactKeys(
    selectedValue,
    SELECTED_VERIFIER_AUTHORITY_KEYS,
    'App acceptance selected verifier authority',
  );
  const functionArn =
    `arn:${context.target.partition}:lambda:${context.target.region}:${context.target.accountId}:function:` +
    context.names.signatureVerifierFunction;
  const roleArn =
    `arn:${context.target.partition}:iam::${context.target.accountId}:role/` + context.names.signatureVerifierRole;
  const permissionsBoundaryArn =
    `arn:${context.target.partition}:iam::${context.target.accountId}:policy/` +
    context.names.signatureVerifierPermissionsBoundary;
  if (
    selected['architecture'] !== 'x86_64' ||
    selected['function_arn'] !== functionArn ||
    selected['execution_role_arn'] !== roleArn ||
    selected['execution_role_permissions_boundary_arn'] !== permissionsBoundaryArn ||
    selected['preflight_alias_arn'] !== `${functionArn}:preflight` ||
    selected['runtime_alias_arn'] !== `${functionArn}:runtime` ||
    selected['runtime'] !== inputValues['lambda_runtime'] ||
    selected['timeout_seconds'] !== inputValues['image_signature_verifier_lambda_timeout_seconds'] ||
    typeof selected['function_version'] !== 'string' ||
    !/^[1-9][0-9]*$/u.test(selected['function_version'])
  ) {
    throw new Error('App acceptance selected verifier target identity is invalid.');
  }
  for (const field of [
    'environment_sha256',
    'execution_role_assume_policy_sha256',
    'execution_role_permissions_boundary_policy_sha256',
    'execution_role_policy_sha256',
    'function_configuration_sha256',
  ]) {
    parseSha256(selected[field], `App acceptance selected verifier ${field}`);
  }
  const selectedPackage = exactKeys(
    selected['package'],
    SELECTED_VERIFIER_PACKAGE_KEYS,
    'App acceptance selected verifier package',
  );
  const lambdaArtifacts = deployables['lambdaArtifacts'];
  const artifacts = lambdaArtifacts['artifacts'];
  const verifierArtifact = artifacts['image_signature_verifier'];
  const expectedPackage = {
    asset_manifest_sha256: verifierArtifact['assetManifestSha256'],
    s3_bucket: verifierArtifact['bucket'],
    s3_key: verifierArtifact['key'],
    s3_object_version: verifierArtifact['versionId'],
    source_code_hash: verifierArtifact['sourceCodeHash'],
    trust_root_sha256: verifierArtifact['trustRootSha256'],
  };
  if (!isDeepStrictEqual(selectedPackage, expectedPackage)) {
    throw new Error('App acceptance selected verifier package is detached from its retained deployable.');
  }
}

/**
 * Admit and detach one exact target App acceptance record.
 *
 * @param {unknown} value
 * @param {typeof admitProvider} providerAdmission
 * @param {AllowedDeploymentTarget} target
 * @returns {AppAcceptance}
 */
function admitAppAcceptanceWithProvider(value, providerAdmission, target) {
  const snapshot = snapshotDataTree(value, 'App acceptance descriptor snapshot');
  const record = exactKeys(snapshot, APP_ACCEPTANCE_KEYS, 'App acceptance');
  if (record['kind'] !== APP_ACCEPTANCE_KIND || record['targetKey'] !== target.targetKey) {
    throw new Error('App acceptance kind or target is invalid.');
  }
  const context = parseDeploymentLaneContext(record['targetContext']);
  if (context.target.accountLabel !== target.accountLabel || context.target.environmentId !== target.environmentId) {
    throw new Error('App acceptance context is detached from its expected target.');
  }
  if (context.root.lane !== 'app' || context.root.scope !== 'app') {
    throw new Error('App acceptance context is not the App root.');
  }
  const controlSourceSha = parseGitCommitSha(record['controlSourceSha'], 'App acceptance control source SHA');
  const selectedApplicationSourceSha = parseGitCommitSha(
    record['selectedApplicationSourceSha'],
    'App acceptance selected application source SHA',
  );
  if (
    context.source.requestedControlSourceSha !== controlSourceSha ||
    context.source.selectedApplicationSourceSha !== selectedApplicationSourceSha
  ) {
    throw new Error('App acceptance source authority is detached from its target context.');
  }
  const deploymentMode = record['deploymentMode'];
  if (deploymentMode !== 'normal' && deploymentMode !== 'rollback') {
    throw new Error('App acceptance deployment mode is invalid.');
  }
  if (deploymentMode === 'normal' && controlSourceSha !== selectedApplicationSourceSha) {
    throw new Error('Normal App acceptance must select its control source.');
  }
  const planDisposition = record['planDisposition'];
  if (planDisposition !== 'changed' && planDisposition !== 'empty') {
    throw new Error('App acceptance plan disposition is invalid.');
  }
  const pipelineExecutionId = admissionUuid(record['pipelineExecutionId'], 'App acceptance pipeline execution ID');
  const acceptanceAttemptId = admissionUuid(record['acceptanceAttemptId'], 'App acceptance attempt ID');
  const deploymentIdentifier = deploymentId(record['deploymentId'], 'App acceptance deployment ID');
  const acceptedAt = canonicalTimestamp(record['acceptedAt'], 'App acceptance timestamp');
  const acceptedPlanChecksum = parseSha256(record['acceptedPlanChecksum'], 'App acceptance plan checksum');
  const backend = validateTerraformBackendAuthority(record['backend'], 'app', target.targetKey);
  if (backend.bucketName !== context.names.terraformStateBucket) {
    throw new Error('App acceptance state bucket is invalid.');
  }
  const nonsecretInputs = validateTerraformBaselineInputIdentity(record['nonsecretInputs'], context, {
    deploymentMode,
  });
  const expectedSecretReferences = buildTerraformBaselineSecretReferences('app', context);
  if (!isDeepStrictEqual(record['secretReferences'], expectedSecretReferences)) {
    throw new Error('App acceptance secret references do not match the exact App target authority.');
  }
  const secretReferences = expectedSecretReferences;
  const provider = providerAdmission(record['provider'], context);
  const approval = admitApproval(
    record['approval'],
    acceptedPlanChecksum,
    deploymentMode,
    planDisposition,
    pipelineExecutionId,
    target,
  );
  if (approval.approvedAt !== null && approval.approvedAt > acceptedAt) {
    throw new Error('App acceptance predates its approval.');
  }
  const smoke = admitSmoke(
    record['smoke'],
    acceptedPlanChecksum,
    pipelineExecutionId,
    acceptanceAttemptId,
    deploymentIdentifier,
    target,
  );
  const releaseAuthority = admitAppAcceptanceReleaseAuthority(record['releaseAuthority'], target.targetKey);
  const rollbackSelection = admitRollbackSelection(record['rollbackSelection'], deploymentMode, target);
  const staticOwnerDeploymentId = rollbackSelection?.staticArtifactDeploymentId ?? deploymentIdentifier;
  const deployables = admitDeployables(
    record['deployables'],
    selectedApplicationSourceSha,
    staticOwnerDeploymentId,
    target,
  );
  const runtime = admitRuntime(record['runtime'], deploymentIdentifier);
  const verifier = admitAppAcceptanceVerifierAuthority(
    record['verifier'],
    releaseAuthority,
    selectedApplicationSourceSha,
    target.targetKey,
  );
  assertVerifierDeployableBinding(verifier, deployables);
  const inputValues = decodeTerraformBaselineNonsecretInputValues(nonsecretInputs);
  assertVerifierInputAuthority(inputValues, deploymentMode, releaseAuthority, deployables, context);
  const zkvm = releaseAuthority.zkvm;
  const proverImage = releaseAuthority.proverImage;
  /** @type {readonly (readonly [string, unknown])[]} */
  const expectedInputFields = [
    ['app_source_sha', selectedApplicationSourceSha],
    ['deploy_mode', deploymentMode],
    ['deployment_id', deploymentIdentifier],
    ['expected_image_id', zkvm['expectedImageId']],
    ['prover_image_uri', proverImage['imageUri']],
  ];
  for (const [field, expected] of expectedInputFields) {
    if (inputValues[field] !== expected) {
      const label = field === 'deployment_id' ? 'deployment ID' : field;
      throw new Error(`App acceptance Terraform input ${label} is detached from the acceptance authority.`);
    }
  }
  const mappingInput = exactKeys(
    inputValues['image_id_mapping_evidence'],
    [
      'current_method_version',
      'current_method_version_key',
      'expected_image_id',
      'mapping_path',
      'mapping_sha256',
      'variant',
    ],
    'App acceptance Terraform ImageID mapping input',
  );
  if (
    mappingInput['mapping_path'] !== 'public/imageId-mapping.json' ||
    mappingInput['mapping_sha256'] !== zkvm['imageIdMappingSha256'] ||
    mappingInput['current_method_version'] !== zkvm['methodVersion'] ||
    mappingInput['current_method_version_key'] !== String(zkvm['methodVersion']) ||
    mappingInput['variant'] !== zkvm['imageIdVariant'] ||
    mappingInput['expected_image_id'] !== zkvm['expectedImageId']
  ) {
    throw new Error('App acceptance Terraform ImageID mapping input is detached.');
  }
  const inputLambdaArtifacts = exactKeys(
    inputValues['lambda_artifacts'],
    LAMBDA_ARTIFACT_NAMES,
    'App acceptance Terraform Lambda artifact inputs',
  );
  const lambdaSet = deployables.lambdaArtifacts;
  const admittedArtifacts = lambdaSet['artifacts'];
  for (const name of LAMBDA_ARTIFACT_NAMES) {
    const inputArtifact = exactKeys(
      inputLambdaArtifacts[name],
      ['asset_manifest_sha256', 's3_bucket', 's3_key', 's3_object_version', 'source_code_hash', 'trust_root_sha256'],
      `App acceptance Terraform Lambda artifact input ${name}`,
    );
    const artifact = admittedArtifacts[name];
    if (
      inputArtifact['s3_bucket'] !== artifact['bucket'] ||
      inputArtifact['s3_key'] !== artifact['key'] ||
      inputArtifact['s3_object_version'] !== artifact['versionId'] ||
      inputArtifact['source_code_hash'] !== artifact['sourceCodeHash'] ||
      inputArtifact['asset_manifest_sha256'] !== artifact['assetManifestSha256'] ||
      inputArtifact['trust_root_sha256'] !== artifact['trustRootSha256']
    ) {
      throw new Error(`App acceptance Terraform Lambda artifact input ${name} is detached.`);
    }
  }
  const recovery = runtime.dynamodbRecovery;
  if (inputValues['dynamodb_recovery_phase'] !== recovery['phase']) {
    throw new Error('App acceptance Terraform DynamoDB recovery phase is detached.');
  }
  if ((inputValues['dynamodb_recovery_activation'] === null) !== (recovery['manifest'] === null)) {
    throw new Error('App acceptance Terraform DynamoDB recovery activation is detached.');
  }
  if (inputValues['dynamodb_recovery_activation'] !== null && recovery['manifest'] !== null) {
    const activation = /** @type {Readonly<Record<string, unknown>>} */ (inputValues['dynamodb_recovery_activation']);
    const manifest = recovery['manifest'];
    const recoveryId = parseSha256(activation['recovery_id'], 'App acceptance recovery activation ID');
    if (
      parseSha256(activation['manifest_sha256'], 'App acceptance recovery activation manifest SHA-256') !==
      manifest['sha256']
    ) {
      throw new Error('App acceptance Terraform recovery activation is detached from its retained manifest.');
    }
    if (
      manifest['key'] !==
      `${resolveDeploymentLaneAuthority(target, 'app').names.recoveryManifestPrefix}/${recoveryId}.json`
    ) {
      throw new Error('App acceptance Terraform recovery activation is detached from its retained manifest key.');
    }
  }
  return deepFreeze({
    kind: APP_ACCEPTANCE_KIND,
    targetKey: target.targetKey,
    targetContext: context,
    backend,
    nonsecretInputs,
    secretReferences,
    provider,
    acceptedPlanChecksum,
    approval,
    smoke,
    pipelineExecutionId,
    acceptanceAttemptId,
    acceptedAt,
    controlSourceSha,
    selectedApplicationSourceSha,
    deploymentId: deploymentIdentifier,
    deploymentMode,
    planDisposition,
    releaseAuthority,
    rollbackSelection,
    verifier,
    deployables,
    runtime,
  });
}

/**
 * Admit one fresh or current App acceptance. The active owning lane remains
 * pinned to the current Terraform and AWS provider identity.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {AppAcceptance}
 */
export function admitAppAcceptance(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App acceptance expected target'));
  return admitAppAcceptanceWithProvider(value, admitProvider, target);
}

/**
 * Admit one exact acceptance retained in the bounded acceptance history.
 * This does not make an older provider identity eligible as a pointer head.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {AppAcceptance}
 */
export function admitRetainedAppAcceptance(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App acceptance expected target'));
  return admitAppAcceptanceWithProvider(value, admitRetainedProvider, target);
}

/** @param {AllowedDeploymentTarget} target */
function appAcceptanceRecordPrefix(target) {
  return `${resolveDeploymentLaneAuthority(target, 'app').names.acceptedDeploymentPrefix}/acceptances/`;
}

/** @param {unknown} record @param {unknown} expectedTargetKey @returns {string} */
export function deriveAppAcceptanceRecordKey(record, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App acceptance expected target'));
  const admitted = admitRetainedAppAcceptance(record, target.targetKey);
  return `${appAcceptanceRecordPrefix(target)}${sha256Text(canonicalRecordJson(admitted))}.json`;
}

/** @param {unknown} value @param {unknown} expectedTargetKey @returns {string} */
export function admitAppAcceptanceRecordKey(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App acceptance expected target'));
  const prefix = appAcceptanceRecordPrefix(target);
  if (
    typeof value !== 'string' ||
    !value.startsWith(prefix) ||
    !RECORD_KEY_SUFFIX_PATTERN.test(value.slice(prefix.length))
  ) {
    throw new Error('App acceptance record key is outside its exact namespace.');
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {AllowedDeploymentTarget} target */
function admitHistory(value, label, target) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_HISTORY_LENGTH) {
    throw new Error(`${label} must contain between 1 and 10 record keys.`);
  }
  const history = value.map((key) => admitAppAcceptanceRecordKey(key, target.targetKey));
  if (new Set(history).size !== history.length) {
    throw new Error(`${label} must not contain a duplicate record key.`);
  }
  return deepFreeze(history);
}

/** @param {number} generation @param {string} headKey @param {readonly string[]} history @param {AppObjectObservation | null} previous */
function compareAndSwapEvidenceId(generation, headKey, history, previous) {
  return `cas/app-acceptance/${sha256Text(canonicalRecordJson({ generation, headKey, history, previous }))}`;
}

/**
 * Admit one bounded-history App current pointer.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {AppCurrentAcceptancePointer}
 */
export function admitAppCurrentAcceptancePointer(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App acceptance expected target'));
  const snapshot = snapshotDataTree(value, 'App current acceptance pointer descriptor snapshot');
  const pointer = exactKeys(snapshot, POINTER_KEYS, 'App current acceptance pointer');
  if (pointer['kind'] !== APP_CURRENT_ACCEPTANCE_POINTER_KIND || pointer['targetKey'] !== target.targetKey) {
    throw new Error('App current acceptance pointer kind or target is invalid.');
  }
  const generation = positiveInteger(pointer['generation'], 'App current acceptance pointer generation');
  const history = admitHistory(pointer['history'], 'App current acceptance pointer history', target);
  const headKey = admitAppAcceptanceRecordKey(pointer['headKey'], target.targetKey);
  if (history[0] !== headKey) {
    throw new Error('App current acceptance pointer head must be the first history key.');
  }
  const previous =
    pointer['previous'] === null ? null : admitObservation(pointer['previous'], 'App current acceptance predecessor');
  if (previous === null && (target.environmentId !== 'main' || generation !== 1 || history.length !== 1)) {
    throw new Error('An App pointer without a predecessor must be the single first production acceptance.');
  }
  const expectedEvidenceId = compareAndSwapEvidenceId(generation, headKey, history, previous);
  if (pointer['compareAndSwapEvidenceId'] !== expectedEvidenceId) {
    throw new Error('App current acceptance compare-and-swap evidence is detached from its pointer content.');
  }
  return deepFreeze({
    kind: APP_CURRENT_ACCEPTANCE_POINTER_KIND,
    targetKey: target.targetKey,
    generation,
    headKey,
    history,
    previous,
    compareAndSwapEvidenceId: expectedEvidenceId,
  });
}

/**
 * Project the first production App pointer from a complete normal acceptance.
 * It has no predecessor or fabricated historical observation. Its publisher
 * must use first-create, never a compare-and-swap against inferred absence.
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {AppCurrentAcceptancePointer}
 */
export function projectAppAcceptanceGenesisPointer(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App genesis expected target'));
  if (target.environmentId !== 'main') throw new Error('App genesis is limited to the production target.');
  const record = admitAppAcceptance(value, target.targetKey);
  if (
    record.deploymentMode !== 'normal' ||
    record.planDisposition !== 'changed' ||
    record.runtime.dynamodbRecovery.phase !== 'primary_active' ||
    record.runtime.dynamodbRecovery.manifest !== null
  ) {
    throw new Error('The first App acceptance must be a changed normal deployment with primary tables active.');
  }
  const headKey = deriveAppAcceptanceRecordKey(record, target.targetKey);
  const history = [headKey];
  return admitAppCurrentAcceptancePointer(
    {
      kind: APP_CURRENT_ACCEPTANCE_POINTER_KIND,
      targetKey: target.targetKey,
      generation: 1,
      headKey,
      history,
      previous: null,
      compareAndSwapEvidenceId: compareAndSwapEvidenceId(1, headKey, history, null),
    },
    target.targetKey,
  );
}

/**
 * Project one bounded pointer from an observed predecessor and complete
 * accepted history.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {AppCurrentAcceptancePointer}
 */
export function projectInitialAppAcceptancePointer(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App acceptance expected target'));
  const input = exactKeys(
    snapshotDataTree(value, 'Initial App acceptance pointer input snapshot'),
    INITIAL_POINTER_INPUT_KEYS,
    'Initial App acceptance pointer input',
  );
  const history = admitHistory(input['history'], 'Initial App acceptance pointer history', target);
  const previous = admitObservation(input['predecessor'], 'Initial App acceptance pointer predecessor');
  const generation = 1;
  const headKey = /** @type {string} */ (history[0]);
  return admitAppCurrentAcceptancePointer(
    {
      kind: APP_CURRENT_ACCEPTANCE_POINTER_KIND,
      targetKey: target.targetKey,
      generation,
      headKey,
      history,
      previous,
      compareAndSwapEvidenceId: compareAndSwapEvidenceId(generation, headKey, history, previous),
    },
    target.targetKey,
  );
}

/**
 * Project one exact normal or rollback pointer-head transition.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {AppCurrentAcceptancePointer}
 */
export function projectAppAcceptancePointerTransition(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App acceptance expected target'));
  const input = exactKeys(
    snapshotDataTree(value, 'App acceptance pointer transition input snapshot'),
    TRANSITION_INPUT_KEYS,
    'App acceptance pointer transition input',
  );
  const current = admitAppCurrentAcceptancePointer(input['currentPointer'], target.targetKey);
  const currentObservation = admitObservation(
    input['currentPointerObservation'],
    'App acceptance current pointer observation',
  );
  const nextRecordKey = admitAppAcceptanceRecordKey(input['nextRecordKey'], target.targetKey);
  if (nextRecordKey === current.headKey) {
    throw new Error('App acceptance pointer transition must change its head.');
  }
  if (current.generation === Number.MAX_SAFE_INTEGER) {
    throw new Error('App acceptance pointer generation would overflow.');
  }
  const generation = current.generation + 1;
  const history = [nextRecordKey, ...current.history.filter((key) => key !== nextRecordKey)].slice(
    0,
    MAX_HISTORY_LENGTH,
  );
  const previous = currentObservation;
  return admitAppCurrentAcceptancePointer(
    {
      kind: APP_CURRENT_ACCEPTANCE_POINTER_KIND,
      targetKey: target.targetKey,
      generation,
      headKey: nextRecordKey,
      history,
      previous,
      compareAndSwapEvidenceId: compareAndSwapEvidenceId(generation, nextRecordKey, history, previous),
    },
    target.targetKey,
  );
}

/**
 * Cross-bind one exact immutable App acceptance to a current pointer
 * observation without resolving any release or Foundation current pointer.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {BoundAppAcceptanceSelection}
 */
export function bindAppAcceptanceSelection(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App acceptance expected target'));
  const input = exactKeys(
    snapshotDataTree(value, 'App acceptance selection input snapshot'),
    SELECTION_INPUT_KEYS,
    'App acceptance selection input',
  );
  const pointer = admitAppCurrentAcceptancePointer(input['pointer'], target.targetKey);
  const pointerObservation = admitObservation(input['pointerObservation'], 'App acceptance pointer observation');
  const acceptanceKey = admitAppAcceptanceRecordKey(input['recordKey'], target.targetKey);
  if (!pointer.history.includes(acceptanceKey)) {
    throw new Error('Selected App acceptance record key is outside the current pointer history.');
  }
  const selectionType = acceptanceKey === pointer.headKey ? 'current' : 'retained';
  const acceptance =
    selectionType === 'current'
      ? admitAppAcceptance(input['record'], target.targetKey)
      : admitRetainedAppAcceptance(input['record'], target.targetKey);
  if (deriveAppAcceptanceRecordKey(acceptance, target.targetKey) !== acceptanceKey) {
    throw new Error('Selected App acceptance record does not match its derived key.');
  }
  const acceptanceObservation = admitObservation(
    input['recordObservation'],
    'Selected App acceptance record observation',
  );
  return deepFreeze({
    selectionType: /** @type {'current' | 'retained'} */ (selectionType),
    targetKey: target.targetKey,
    pointer,
    pointerObservation,
    acceptanceKey,
    acceptance,
    acceptanceObservation,
  });
}
