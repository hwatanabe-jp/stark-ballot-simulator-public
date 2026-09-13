/** @typedef {import('./index.js').DeploymentLaneContext} DeploymentLaneContext */
/** @typedef {import('./index.js').AllowedDeploymentTarget} AllowedDeploymentTarget */
/** @typedef {import('./terraform-authority.js').CodeBuildRuntimeEvidence} CodeBuildRuntimeEvidence */
/** @typedef {import('./terraform-authority.js').TerraformBackendAuthority} TerraformBackendAuthority */
/** @typedef {import('./terraform-authority.js').TerraformNonsecretInputs} TerraformNonsecretInputs */

/**
 * @typedef {{
 *   readonly approvalType: 'bootstrap-saved-plan-approval';
 *   readonly stageName: 'ManualApproval';
 *   readonly actionName: 'ApproveInitialDevelopmentApply' | 'ApproveBootstrapApply';
 *   readonly actionExecutionId: string;
 *   readonly reviewedPlanChecksum: string;
 *   readonly approver: string;
 *   readonly approvalTimestamp: string;
 * }} BootstrapAcceptanceApproval
 */

/**
 * @typedef {{
 *   readonly evidenceType: 'bootstrap-codebuild-log-group-state';
 *   readonly targetKey: 'stark-dev/develop';
 *   readonly stateIdentity: string;
 *   readonly backendKey: string;
 *   readonly controlSourceSha: string;
 *   readonly frameworkSourceSha: string;
 *   readonly acceptedPlanChecksum: string;
 *   readonly pipelineExecutionId: string;
 *   readonly manifestSha256: string;
 *   readonly stateJsonSha256: string;
 *   readonly expectedMoveCount: number;
 *   readonly verifiedNewAddressCount: number;
 *   readonly retainedOldAddressCount: 0;
 *   readonly remoteIdentityMismatchCount: 0;
 * }} BootstrapMovedLogGroupEvidence
 */

/** @typedef {BootstrapMovedLogGroupEvidence | import('./source-path-build-authority.js').BootstrapLogGroupInventoryEvidence} BootstrapAcceptanceSmokeEvidence */

/**
 * @typedef {{
 *   readonly lock: string;
 *   readonly selections: Readonly<{'registry.terraform.io/hashicorp/aws': '6.58.0'}>;
 *   readonly terraformVersion: '1.15.8';
 *   readonly platform: 'linux_amd64';
 *   readonly runtime: CodeBuildRuntimeEvidence;
 * }} BootstrapAcceptanceProvider
 */

/**
 * @typedef {{
 *   readonly kind: typeof BOOTSTRAP_ACCEPTANCE_KIND;
 *   readonly targetKey: import('./index.js').DeploymentTargetKey;
 *   readonly targetContext: DeploymentLaneContext;
 *   readonly backend: TerraformBackendAuthority;
 *   readonly nonsecretInputs: TerraformNonsecretInputs;
 *   readonly secretReferences: readonly [];
 *   readonly provider: BootstrapAcceptanceProvider;
 *   readonly acceptedPlanChecksum: string;
 *   readonly approval: BootstrapAcceptanceApproval;
 *   readonly smoke: Readonly<{result: 'passed', evidence: BootstrapAcceptanceSmokeEvidence}>;
 *   readonly pipelineExecutionId: string;
 *   readonly acceptanceAttemptId: string;
 *   readonly acceptedAt: string;
 * }} BootstrapTerraformAcceptance
 */

/**
 * @typedef {{ readonly etag: string; readonly versionId: string }} TerraformAcceptancePointerObservation
 */

/**
 * @typedef {{
 *   readonly kind: typeof BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND;
 *   readonly targetKey: import('./index.js').DeploymentTargetKey;
 *   readonly recordKey: string;
 *   readonly pipelineExecutionId: string;
 *   readonly acceptanceAttemptId: string;
 *   readonly previous: TerraformAcceptancePointerObservation | null;
 *   readonly compareAndSwapEvidenceId: string;
 * }} BootstrapTerraformAcceptancePointer
 */

/**
 * @typedef {{ readonly id: string; readonly count: 0 }} FoundationAcceptanceSmokeCheck
 */

/**
 * @typedef {{
 *   readonly ownershipType: 'foundation-state';
 *   readonly stateIdentity: string;
 *   readonly sourceSha: string;
 *   readonly stateResourcesSha256: string;
 *   readonly foundationStateResourceCount: number;
 *   readonly foundationStateResources: readonly string[];
 *   readonly declaredFoundationResources: readonly string[];
 *   readonly appRuntimeResourcesCreated: false;
 *   readonly violations: Readonly<{
 *     sourceModuleDeclarations: readonly [];
 *     moduleStateResources: readonly [];
 *     malformedStateResources: readonly [];
 *     undeclaredStateResources: readonly [];
 *     missingDeclaredStateResources: readonly [];
 *     disallowedFoundationResourceTypes: readonly [];
 *     appRuntimeStateResources: readonly [];
 *   }>;
 *   readonly checks: readonly FoundationAcceptanceSmokeCheck[];
 * }} FoundationAcceptanceStateOwnership
 */

/**
 * @typedef {{
 *   readonly evidenceType: 'foundation-saved-plan';
 *   readonly manifestType: 'foundation-smoke';
 *   readonly stateIdentity: string;
 *   readonly backendKey: string;
 *   readonly controlSourceSha: string;
 *   readonly frameworkSourceSha: string;
 *   readonly acceptedPlanChecksum: string;
 *   readonly pipelineExecutionId: string;
 *   readonly appRuntimeResourcesCreated: false;
 *   readonly evidenceClass: 'FoundationStateAbsenceOfAppRuntime';
 *   readonly stateOwnershipVerified: true;
 *   readonly ecrRetentionControllerVerified: true;
 *   readonly releaseAuthorityRetentionProtected: true;
 *   readonly foundationAcceptancePolicyVerified: true;
 *   readonly foundationContract: Readonly<{
 *     closureIdentity: string;
 *     foundationContractHash: string;
 *   }>;
 *   readonly networkingSha256: string;
 *   readonly imageAuthoritySha256: string;
 *   readonly acceptedMarkerPath: string;
 *   readonly stateOwnership: FoundationAcceptanceStateOwnership;
 *   readonly checks: readonly FoundationAcceptanceSmokeCheck[];
 * }} FoundationAcceptanceSmokeEvidence
 */

/**
 * @typedef {{
 *   readonly approvalType: 'foundation-saved-plan-approval';
 *   readonly stageName: 'ManualApproval';
 *   readonly actionName: 'ApproveFoundationApply';
 *   readonly actionExecutionId: string;
 *   readonly reviewedPlanChecksum: string;
 *   readonly approver: string;
 *   readonly approvalTimestamp: string;
 * }} FoundationAcceptanceApproval
 */

/**
 * @typedef {{
 *   readonly vpcId: string;
 *   readonly proverSubnetIds: readonly string[];
 *   readonly proverSecurityGroupIds: readonly string[];
 *   readonly networkAuthority: 'foundation-owned';
 *   readonly publicSubnetException: 'accepted-for-develop-prover-egress' | 'accepted-for-production-prover-egress';
 * }} FoundationAcceptanceNetworking
 */

/**
 * @typedef {{
 *   readonly repositories: Readonly<{
 *     prover: Readonly<{name: string, url: string}>;
 *     toolchain: Readonly<{name: string, url: string}>;
 *   }>;
 *   readonly signingProfileName: string;
 *   readonly signingProfileArn: string;
 *   readonly signingRepositoryFilters: readonly Readonly<{
 *     filterType: 'WILDCARD_MATCH';
 *     filter: string;
 *   }>[];
 *   readonly tagMutability: 'IMMUTABLE';
 *   readonly scanOnPush: true;
 *   readonly proverSigningStatusRequired: 'COMPLETE';
 *   readonly retentionPolicy: 'reference-aware-controller-target-10';
 * }} FoundationAcceptanceImageAuthority
 */

/**
 * @typedef {{
 *   readonly kind: typeof FOUNDATION_ACCEPTANCE_KIND;
 *   readonly targetKey: import('./index.js').DeploymentTargetKey;
 *   readonly targetContext: DeploymentLaneContext;
 *   readonly backend: TerraformBackendAuthority;
 *   readonly nonsecretInputs: TerraformNonsecretInputs;
 *   readonly secretReferences: readonly [];
 *   readonly provider: BootstrapAcceptanceProvider;
 *   readonly acceptedPlanChecksum: string;
 *   readonly approval: FoundationAcceptanceApproval;
 *   readonly smoke: Readonly<{result: 'passed', evidence: FoundationAcceptanceSmokeEvidence}>;
 *   readonly pipelineExecutionId: string;
 *   readonly acceptanceAttemptId: string;
 *   readonly acceptedAt: string;
 *   readonly foundationContract: Readonly<{
 *     closureIdentity: string;
 *     foundationContractHash: string;
 *   }>;
 *   readonly networking: FoundationAcceptanceNetworking;
 *   readonly imageAuthority: FoundationAcceptanceImageAuthority;
 * }} FoundationTerraformAcceptance
 */

/**
 * @typedef {{
 *   readonly kind: typeof FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND;
 *   readonly targetKey: import('./index.js').DeploymentTargetKey;
 *   readonly recordKey: string;
 *   readonly pipelineExecutionId: string;
 *   readonly acceptanceAttemptId: string;
 *   readonly previous: TerraformAcceptancePointerObservation | null;
 *   readonly compareAndSwapEvidenceId: string;
 * }} FoundationTerraformAcceptancePointer
 */

import {
  canonicalRecordJson,
  deepFreeze,
  parseSha256,
  parseS3VersionId,
  requireGroupedLowercaseUuid,
  requireString,
  sha256Text,
} from './internal.js';
import { snapshotDataTree, snapshotDenseArray, snapshotExactRecord } from './descriptor-snapshot.js';
import { admitFoundationSourceContract } from './foundation-contract.js';
import { admitBootstrapLogGroupInventoryEvidence } from './source-path-build-authority.js';
import {
  parseDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
  resolveBootstrapSavedPlanApprovalAction,
  resolveFoundationPublicSubnetException,
  resolveDeploymentLaneAuthority,
  resolveImageSigningIdentity,
} from './index.js';
import {
  validateCodeBuildRuntimeEvidence,
  validateTerraformBackendAuthority,
  validateTerraformBaselineInputIdentity,
  validateTerraformBaselineProviderLock,
  validateTerraformBaselineProviderSelections,
} from './terraform-authority.js';

export const BOOTSTRAP_ACCEPTANCE_KIND = /** @type {const} */ ('bootstrap-acceptance');
export const BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND = /** @type {const} */ ('bootstrap-current-acceptance-pointer');
export const FOUNDATION_ACCEPTANCE_KIND = /** @type {const} */ ('foundation-acceptance');
export const FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND = /** @type {const} */ (
  'foundation-current-acceptance-pointer'
);

const AWS_PROVIDER_ADDRESS = 'registry.terraform.io/hashicorp/aws';
const TERRAFORM_VERSION = '1.15.8';
const AWS_PROVIDER_VERSION = '6.58.0';
const RECORD_SUFFIX_PATTERN = /^[0-9a-f]{64}\.json$/u;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_PROVIDER_LOCK_BYTES = 1024 * 1024;

const ACCEPTANCE_KEYS = [
  'acceptanceAttemptId',
  'acceptedAt',
  'acceptedPlanChecksum',
  'approval',
  'backend',
  'kind',
  'nonsecretInputs',
  'pipelineExecutionId',
  'provider',
  'secretReferences',
  'smoke',
  'targetContext',
  'targetKey',
];
const FOUNDATION_ACCEPTANCE_KEYS = [...ACCEPTANCE_KEYS, 'foundationContract', 'imageAuthority', 'networking'];
const PROVIDER_KEYS = ['lock', 'platform', 'runtime', 'selections', 'terraformVersion'];
const APPROVAL_KEYS = [
  'actionExecutionId',
  'actionName',
  'approvalTimestamp',
  'approvalType',
  'approver',
  'reviewedPlanChecksum',
  'stageName',
];
const SMOKE_KEYS = ['evidence', 'result'];
const POINTER_KEYS = [
  'acceptanceAttemptId',
  'compareAndSwapEvidenceId',
  'kind',
  'pipelineExecutionId',
  'previous',
  'recordKey',
  'targetKey',
];
const SMOKE_EVIDENCE_KEYS = [
  'acceptedPlanChecksum',
  'backendKey',
  'controlSourceSha',
  'evidenceType',
  'expectedMoveCount',
  'frameworkSourceSha',
  'manifestSha256',
  'pipelineExecutionId',
  'remoteIdentityMismatchCount',
  'retainedOldAddressCount',
  'stateIdentity',
  'stateJsonSha256',
  'targetKey',
  'verifiedNewAddressCount',
];
const FOUNDATION_SMOKE_EVIDENCE_KEYS = [
  'acceptedMarkerPath',
  'acceptedPlanChecksum',
  'appRuntimeResourcesCreated',
  'backendKey',
  'checks',
  'controlSourceSha',
  'ecrRetentionControllerVerified',
  'evidenceClass',
  'evidenceType',
  'foundationAcceptancePolicyVerified',
  'foundationContract',
  'frameworkSourceSha',
  'imageAuthoritySha256',
  'manifestType',
  'networkingSha256',
  'pipelineExecutionId',
  'releaseAuthorityRetentionProtected',
  'stateIdentity',
  'stateOwnership',
  'stateOwnershipVerified',
];
const FOUNDATION_STATE_OWNERSHIP_KEYS = [
  'appRuntimeResourcesCreated',
  'checks',
  'declaredFoundationResources',
  'foundationStateResourceCount',
  'foundationStateResources',
  'ownershipType',
  'sourceSha',
  'stateIdentity',
  'stateResourcesSha256',
  'violations',
];
const FOUNDATION_STATE_OWNERSHIP_VIOLATION_KEYS = [
  'appRuntimeStateResources',
  'disallowedFoundationResourceTypes',
  'malformedStateResources',
  'missingDeclaredStateResources',
  'moduleStateResources',
  'sourceModuleDeclarations',
  'undeclaredStateResources',
];
const FOUNDATION_SMOKE_CHECK_IDS = [
  'foundation_state_nonempty',
  'source_module_declarations_absent',
  'module_state_resources_absent',
  'malformed_state_resources_absent',
  'undeclared_state_resources_absent',
  'missing_declared_state_resources_absent',
  'disallowed_foundation_resource_types_absent',
  'app_runtime_state_resources_absent',
];
const FOUNDATION_NETWORKING_KEYS = [
  'networkAuthority',
  'proverSecurityGroupIds',
  'proverSubnetIds',
  'publicSubnetException',
  'vpcId',
];
const FOUNDATION_IMAGE_AUTHORITY_KEYS = [
  'proverSigningStatusRequired',
  'repositories',
  'retentionPolicy',
  'scanOnPush',
  'signingProfileArn',
  'signingProfileName',
  'signingRepositoryFilters',
  'tagMutability',
];

/**
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function exactKeys(value, keys, label) {
  try {
    return /** @type {Record<string, unknown>} */ (snapshotExactRecord(value, keys, label));
  } catch (error) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${label} must be an object.`, { cause: error });
    }
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function checksum(value, label) {
  try {
    return parseSha256(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function uuid(value, label) {
  try {
    return requireGroupedLowercaseUuid(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
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

/** @param {unknown} value @param {'Bootstrap' | 'Foundation'} [rootLabel] @returns {readonly []} */
function emptySecretReferences(value, rootLabel = 'Bootstrap') {
  let references;
  try {
    references = snapshotDenseArray(value, `${rootLabel} Terraform acceptance secret references`);
  } catch (error) {
    throw new Error(`${rootLabel} Terraform acceptance secret references must be exactly empty.`, { cause: error });
  }
  if (references.length !== 0) {
    throw new Error(`${rootLabel} Terraform acceptance secret references must be exactly empty.`);
  }
  return deepFreeze([]);
}

/**
 * @param {unknown} value
 * @param {DeploymentLaneContext} context
 * @param {'Bootstrap' | 'Foundation'} [rootLabel]
 * @returns {BootstrapAcceptanceProvider}
 */
function admitProvider(value, context, rootLabel = 'Bootstrap') {
  const provider = exactKeys(value, PROVIDER_KEYS, `${rootLabel} Terraform acceptance provider`);
  if (provider['terraformVersion'] !== TERRAFORM_VERSION || provider['platform'] !== 'linux_amd64') {
    throw new Error(`${rootLabel} Terraform acceptance Terraform runtime is invalid.`);
  }
  const selectionsRecord = exactKeys(
    provider['selections'],
    [AWS_PROVIDER_ADDRESS],
    `${rootLabel} Terraform acceptance provider selections`,
  );
  if (selectionsRecord[AWS_PROVIDER_ADDRESS] !== AWS_PROVIDER_VERSION) {
    throw new Error(`${rootLabel} Terraform acceptance AWS provider selection is invalid.`);
  }
  const terraformIdentity = {
    terraform_version: TERRAFORM_VERSION,
    platform: 'linux_amd64',
    terraform_outdated: false,
    provider_selections: { [AWS_PROVIDER_ADDRESS]: AWS_PROVIDER_VERSION },
  };
  const selections = validateTerraformBaselineProviderSelections(selectionsRecord, terraformIdentity);
  if (
    typeof provider['lock'] !== 'string' ||
    Buffer.byteLength(provider['lock'], 'utf8') === 0 ||
    Buffer.byteLength(provider['lock'], 'utf8') > MAX_PROVIDER_LOCK_BYTES ||
    provider['lock'].includes('\0')
  ) {
    throw new Error(`${rootLabel} Terraform acceptance provider lock is invalid.`);
  }
  const admittedLock = validateTerraformBaselineProviderLock(provider['lock'], terraformIdentity);
  const lock = Buffer.from(admittedLock).toString('utf8');
  if (lock !== provider['lock']) {
    throw new Error(`${rootLabel} Terraform acceptance provider lock is invalid.`);
  }
  const runtime = validateCodeBuildRuntimeEvidence(
    snapshotDataTree(provider['runtime'], `${rootLabel} Terraform acceptance provider runtime`),
    context,
  );
  return deepFreeze({
    lock,
    selections: {
      [AWS_PROVIDER_ADDRESS]: /** @type {'6.58.0'} */ (selections[AWS_PROVIDER_ADDRESS]),
    },
    terraformVersion: TERRAFORM_VERSION,
    platform: /** @type {const} */ ('linux_amd64'),
    runtime,
  });
}

/**
 * @param {unknown} value
 * @param {string} acceptedPlanChecksum
 * @param {AllowedDeploymentTarget} target
 * @returns {BootstrapAcceptanceApproval}
 */
function admitApproval(value, acceptedPlanChecksum, target) {
  const approval = exactKeys(value, APPROVAL_KEYS, 'Bootstrap Terraform acceptance approval');
  if (
    approval['approvalType'] !== 'bootstrap-saved-plan-approval' ||
    approval['stageName'] !== 'ManualApproval' ||
    approval['actionName'] !== resolveBootstrapSavedPlanApprovalAction(target)
  ) {
    throw new Error('Bootstrap Terraform acceptance approval action is invalid.');
  }
  const reviewedPlanChecksum = checksum(
    approval['reviewedPlanChecksum'],
    'Bootstrap Terraform acceptance reviewed plan checksum',
  );
  if (reviewedPlanChecksum !== acceptedPlanChecksum) {
    throw new Error('Bootstrap Terraform acceptance approval is detached from its accepted plan.');
  }
  const approverPattern = new RegExp(
    `^arn:${target.partition}:(?:iam|sts)::${target.accountId}:(?:user|role|assumed-role)/[^\\s]+$`,
    'u',
  );
  let approver;
  try {
    approver = requireString(approval['approver'], 'Bootstrap Terraform acceptance approver');
  } catch (error) {
    throw new Error('Bootstrap Terraform acceptance approver is invalid.', { cause: error });
  }
  if (Buffer.byteLength(approver, 'utf8') > 2048 || !approverPattern.test(approver)) {
    throw new Error('Bootstrap Terraform acceptance approver is invalid.');
  }
  return deepFreeze({
    approvalType: /** @type {const} */ ('bootstrap-saved-plan-approval'),
    stageName: /** @type {const} */ ('ManualApproval'),
    actionName: resolveBootstrapSavedPlanApprovalAction(target),
    actionExecutionId: uuid(
      approval['actionExecutionId'],
      'Bootstrap Terraform acceptance approval action execution ID',
    ),
    reviewedPlanChecksum,
    approver,
    approvalTimestamp: canonicalTimestamp(
      approval['approvalTimestamp'],
      'Bootstrap Terraform acceptance approval timestamp',
    ),
  });
}

/**
 * @param {unknown} value
 * @param {DeploymentLaneContext} context
 * @param {string} acceptedPlanChecksum
 * @param {string} pipelineExecutionId
 * @param {AllowedDeploymentTarget} target
 * @returns {Readonly<{result: 'passed', evidence: BootstrapAcceptanceSmokeEvidence}>}
 */
function admitSmoke(value, context, acceptedPlanChecksum, pipelineExecutionId, target) {
  const smoke = exactKeys(value, SMOKE_KEYS, 'Bootstrap Terraform acceptance smoke');
  if (smoke['result'] !== 'passed') {
    throw new Error('Bootstrap Terraform acceptance smoke result is invalid.');
  }
  if (target.targetKey === 'stark-prod/main') {
    return deepFreeze({
      result: 'passed',
      evidence: admitBootstrapLogGroupInventoryEvidence(
        smoke['evidence'],
        context,
        acceptedPlanChecksum,
        pipelineExecutionId,
      ),
    });
  }
  const evidence = exactKeys(
    smoke['evidence'],
    SMOKE_EVIDENCE_KEYS,
    'Bootstrap Terraform acceptance specialized smoke evidence',
  );
  const expectedMoveCount = evidence['expectedMoveCount'];
  if (
    evidence['evidenceType'] !== 'bootstrap-codebuild-log-group-state' ||
    evidence['targetKey'] !== target.targetKey ||
    evidence['stateIdentity'] !== context.root.stateIdentity ||
    evidence['backendKey'] !== context.root.backendKey ||
    evidence['controlSourceSha'] !== context.source.requestedControlSourceSha ||
    evidence['frameworkSourceSha'] !== context.source.frameworkSourceSha ||
    evidence['acceptedPlanChecksum'] !== acceptedPlanChecksum ||
    evidence['pipelineExecutionId'] !== pipelineExecutionId ||
    typeof expectedMoveCount !== 'number' ||
    !Number.isSafeInteger(expectedMoveCount) ||
    expectedMoveCount <= 0 ||
    evidence['verifiedNewAddressCount'] !== expectedMoveCount ||
    evidence['retainedOldAddressCount'] !== 0 ||
    evidence['remoteIdentityMismatchCount'] !== 0
  ) {
    throw new Error('Bootstrap Terraform acceptance specialized smoke evidence is invalid.');
  }
  return deepFreeze({
    result: /** @type {const} */ ('passed'),
    evidence: {
      evidenceType: /** @type {const} */ ('bootstrap-codebuild-log-group-state'),
      targetKey: /** @type {const} */ ('stark-dev/develop'),
      stateIdentity: context.root.stateIdentity,
      backendKey: context.root.backendKey,
      controlSourceSha: context.source.requestedControlSourceSha,
      frameworkSourceSha: context.source.frameworkSourceSha,
      acceptedPlanChecksum,
      pipelineExecutionId,
      manifestSha256: checksum(evidence['manifestSha256'], 'Bootstrap Terraform acceptance smoke manifest SHA-256'),
      stateJsonSha256: checksum(evidence['stateJsonSha256'], 'Bootstrap Terraform acceptance smoke state SHA-256'),
      expectedMoveCount,
      verifiedNewAddressCount: expectedMoveCount,
      retainedOldAddressCount: 0,
      remoteIdentityMismatchCount: 0,
    },
  });
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {readonly unknown[]}
 */
function denseArray(value, label) {
  try {
    return snapshotDenseArray(value, label);
  } catch (error) {
    throw new Error(`${label} must be a dense array of indexed data properties.`, { cause: error });
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {readonly []}
 */
function emptyArray(value, label) {
  if (denseArray(value, label).length !== 0) {
    throw new Error(`${label} must be exactly empty.`);
  }
  return deepFreeze([]);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {RegExp | undefined} [pattern]
 * @returns {readonly string[]}
 */
function sortedUniqueStrings(value, label, pattern) {
  const entries = denseArray(value, label).map((entry) => {
    let admitted;
    try {
      admitted = requireString(entry, label, pattern);
    } catch (error) {
      throw new Error(`${label} contains an invalid value.`, { cause: error });
    }
    if (admitted.trim() !== admitted || Buffer.byteLength(admitted, 'utf8') > 4096) {
      throw new Error(`${label} contains an invalid value.`);
    }
    return admitted;
  });
  const sortedEntries = [...entries].sort();
  if (
    entries.length === 0 ||
    new Set(entries).size !== entries.length ||
    entries.some((entry, index) => entry !== sortedEntries[index])
  ) {
    throw new Error(`${label} must be nonempty, sorted, and unique.`);
  }
  return deepFreeze(entries);
}

/**
 * @param {unknown} value
 * @returns {readonly FoundationAcceptanceSmokeCheck[]}
 */
function admitFoundationSmokeChecks(value) {
  const entries = denseArray(value, 'Foundation Terraform acceptance smoke checks');
  if (entries.length !== FOUNDATION_SMOKE_CHECK_IDS.length) {
    throw new Error('Foundation Terraform acceptance smoke checks are invalid.');
  }
  const admitted = entries.map((entry, index) => {
    const check = exactKeys(entry, ['count', 'id'], 'Foundation Terraform acceptance smoke check');
    if (check['id'] !== FOUNDATION_SMOKE_CHECK_IDS[index] || check['count'] !== 0) {
      throw new Error('Foundation Terraform acceptance smoke checks are invalid.');
    }
    return { id: /** @type {string} */ (check['id']), count: /** @type {const} */ (0) };
  });
  return deepFreeze(admitted);
}

/**
 * @param {unknown} value
 * @param {DeploymentLaneContext} context
 * @returns {FoundationAcceptanceStateOwnership}
 */
function admitFoundationStateOwnership(value, context) {
  const ownership = exactKeys(
    value,
    FOUNDATION_STATE_OWNERSHIP_KEYS,
    'Foundation Terraform acceptance state ownership',
  );
  const foundationStateResources = sortedUniqueStrings(
    ownership['foundationStateResources'],
    'Foundation Terraform acceptance state resources',
  );
  const declaredFoundationResources = sortedUniqueStrings(
    ownership['declaredFoundationResources'],
    'Foundation Terraform acceptance declared resources',
  );
  const violations = exactKeys(
    ownership['violations'],
    FOUNDATION_STATE_OWNERSHIP_VIOLATION_KEYS,
    'Foundation Terraform acceptance state ownership violations',
  );
  const admittedViolations = {
    sourceModuleDeclarations: emptyArray(
      violations['sourceModuleDeclarations'],
      'Foundation Terraform acceptance source-module violations',
    ),
    moduleStateResources: emptyArray(
      violations['moduleStateResources'],
      'Foundation Terraform acceptance module-state violations',
    ),
    malformedStateResources: emptyArray(
      violations['malformedStateResources'],
      'Foundation Terraform acceptance malformed-state violations',
    ),
    undeclaredStateResources: emptyArray(
      violations['undeclaredStateResources'],
      'Foundation Terraform acceptance undeclared-state violations',
    ),
    missingDeclaredStateResources: emptyArray(
      violations['missingDeclaredStateResources'],
      'Foundation Terraform acceptance missing-declared-state violations',
    ),
    disallowedFoundationResourceTypes: emptyArray(
      violations['disallowedFoundationResourceTypes'],
      'Foundation Terraform acceptance disallowed-resource violations',
    ),
    appRuntimeStateResources: emptyArray(
      violations['appRuntimeStateResources'],
      'Foundation Terraform acceptance App-runtime-state violations',
    ),
  };
  const checks = admitFoundationSmokeChecks(ownership['checks']);
  if (
    ownership['ownershipType'] !== 'foundation-state' ||
    ownership['stateIdentity'] !== context.root.stateIdentity ||
    ownership['sourceSha'] !== context.source.frameworkSourceSha ||
    ownership['appRuntimeResourcesCreated'] !== false ||
    !Number.isSafeInteger(ownership['foundationStateResourceCount']) ||
    ownership['foundationStateResourceCount'] !== foundationStateResources.length
  ) {
    throw new Error('Foundation Terraform acceptance state ownership is invalid.');
  }
  return deepFreeze({
    ownershipType: /** @type {const} */ ('foundation-state'),
    stateIdentity: context.root.stateIdentity,
    sourceSha: context.source.frameworkSourceSha,
    stateResourcesSha256: checksum(
      ownership['stateResourcesSha256'],
      'Foundation Terraform acceptance state resources SHA-256',
    ),
    foundationStateResourceCount: foundationStateResources.length,
    foundationStateResources,
    declaredFoundationResources,
    appRuntimeResourcesCreated: /** @type {const} */ (false),
    violations: admittedViolations,
    checks,
  });
}

/**
 * @param {unknown} value
 * @param {DeploymentLaneContext} context
 * @param {string} acceptedPlanChecksum
 * @param {string} pipelineExecutionId
 * @param {Readonly<{closureIdentity: string, foundationContractHash: string}>} foundationContract
 * @param {FoundationAcceptanceNetworking} networking
 * @param {FoundationAcceptanceImageAuthority} imageAuthority
 * @returns {Readonly<{result: 'passed', evidence: FoundationAcceptanceSmokeEvidence}>}
 */
function admitFoundationSmoke(
  value,
  context,
  acceptedPlanChecksum,
  pipelineExecutionId,
  foundationContract,
  networking,
  imageAuthority,
) {
  const smoke = exactKeys(value, SMOKE_KEYS, 'Foundation Terraform acceptance smoke');
  if (smoke['result'] !== 'passed') {
    throw new Error('Foundation Terraform acceptance smoke result is invalid.');
  }
  const evidence = exactKeys(
    smoke['evidence'],
    FOUNDATION_SMOKE_EVIDENCE_KEYS,
    'Foundation Terraform acceptance specialized smoke evidence',
  );
  if (
    evidence['evidenceType'] !== 'foundation-saved-plan' ||
    evidence['manifestType'] !== 'foundation-smoke' ||
    evidence['stateIdentity'] !== context.root.stateIdentity ||
    evidence['backendKey'] !== context.root.backendKey ||
    evidence['controlSourceSha'] !== context.source.requestedControlSourceSha ||
    evidence['frameworkSourceSha'] !== context.source.frameworkSourceSha ||
    evidence['acceptedPlanChecksum'] !== acceptedPlanChecksum ||
    evidence['pipelineExecutionId'] !== pipelineExecutionId ||
    evidence['appRuntimeResourcesCreated'] !== false ||
    evidence['evidenceClass'] !== 'FoundationStateAbsenceOfAppRuntime' ||
    evidence['stateOwnershipVerified'] !== true ||
    evidence['ecrRetentionControllerVerified'] !== true ||
    evidence['releaseAuthorityRetentionProtected'] !== true ||
    evidence['foundationAcceptancePolicyVerified'] !== true ||
    evidence['acceptedMarkerPath'] !== `accepted-deployments/${context.root.stateIdentity}`
  ) {
    throw new Error('Foundation Terraform acceptance specialized smoke evidence is invalid.');
  }
  const checks = admitFoundationSmokeChecks(evidence['checks']);
  const stateOwnership = admitFoundationStateOwnership(evidence['stateOwnership'], context);
  if (canonicalRecordJson(checks) !== canonicalRecordJson(stateOwnership.checks)) {
    throw new Error('Foundation Terraform acceptance smoke checks contradict state ownership.');
  }
  const smokeFoundationContract = admitFoundationContract(evidence['foundationContract']);
  const networkingSha256 = checksum(
    evidence['networkingSha256'],
    'Foundation Terraform acceptance smoke networking SHA-256',
  );
  const imageAuthoritySha256 = checksum(
    evidence['imageAuthoritySha256'],
    'Foundation Terraform acceptance smoke image authority SHA-256',
  );
  if (
    canonicalRecordJson(smokeFoundationContract) !== canonicalRecordJson(foundationContract) ||
    networkingSha256 !== sha256Text(canonicalRecordJson(networking)) ||
    imageAuthoritySha256 !== sha256Text(canonicalRecordJson(imageAuthority))
  ) {
    throw new Error('Foundation Terraform acceptance smoke provenance is detached from its admitted authority.');
  }
  return deepFreeze({
    result: /** @type {const} */ ('passed'),
    evidence: {
      evidenceType: /** @type {const} */ ('foundation-saved-plan'),
      manifestType: /** @type {const} */ ('foundation-smoke'),
      stateIdentity: context.root.stateIdentity,
      backendKey: context.root.backendKey,
      controlSourceSha: context.source.requestedControlSourceSha,
      frameworkSourceSha: context.source.frameworkSourceSha,
      acceptedPlanChecksum,
      pipelineExecutionId,
      appRuntimeResourcesCreated: /** @type {const} */ (false),
      evidenceClass: /** @type {const} */ ('FoundationStateAbsenceOfAppRuntime'),
      stateOwnershipVerified: /** @type {const} */ (true),
      ecrRetentionControllerVerified: /** @type {const} */ (true),
      releaseAuthorityRetentionProtected: /** @type {const} */ (true),
      foundationAcceptancePolicyVerified: /** @type {const} */ (true),
      foundationContract: smokeFoundationContract,
      networkingSha256,
      imageAuthoritySha256,
      acceptedMarkerPath: `accepted-deployments/${context.root.stateIdentity}`,
      stateOwnership,
      checks,
    },
  });
}

/**
 * @param {unknown} value
 * @param {string} acceptedPlanChecksum
 * @param {AllowedDeploymentTarget} target
 * @returns {FoundationAcceptanceApproval}
 */
function admitFoundationApproval(value, acceptedPlanChecksum, target) {
  const approval = exactKeys(value, APPROVAL_KEYS, 'Foundation Terraform acceptance approval');
  if (
    approval['approvalType'] !== 'foundation-saved-plan-approval' ||
    approval['stageName'] !== 'ManualApproval' ||
    approval['actionName'] !== 'ApproveFoundationApply'
  ) {
    throw new Error('Foundation Terraform acceptance approval action is invalid.');
  }
  const reviewedPlanChecksum = checksum(
    approval['reviewedPlanChecksum'],
    'Foundation Terraform acceptance reviewed plan checksum',
  );
  if (reviewedPlanChecksum !== acceptedPlanChecksum) {
    throw new Error('Foundation Terraform acceptance approval is detached from its accepted plan.');
  }
  const approverPattern = new RegExp(
    `^arn:${target.partition}:(?:iam|sts)::${target.accountId}:(?:user|role|assumed-role)/[^\\s]+$`,
    'u',
  );
  let approver;
  try {
    approver = requireString(approval['approver'], 'Foundation Terraform acceptance approver');
  } catch (error) {
    throw new Error('Foundation Terraform acceptance approver is invalid.', { cause: error });
  }
  if (Buffer.byteLength(approver, 'utf8') > 2048 || !approverPattern.test(approver)) {
    throw new Error('Foundation Terraform acceptance approver is invalid.');
  }
  return deepFreeze({
    approvalType: /** @type {const} */ ('foundation-saved-plan-approval'),
    stageName: /** @type {const} */ ('ManualApproval'),
    actionName: /** @type {const} */ ('ApproveFoundationApply'),
    actionExecutionId: uuid(
      approval['actionExecutionId'],
      'Foundation Terraform acceptance approval action execution ID',
    ),
    reviewedPlanChecksum,
    approver,
    approvalTimestamp: canonicalTimestamp(
      approval['approvalTimestamp'],
      'Foundation Terraform acceptance approval timestamp',
    ),
  });
}

/**
 * @param {unknown} value
 * @param {AllowedDeploymentTarget} target
 * @returns {FoundationAcceptanceNetworking}
 */
function admitFoundationNetworking(value, target) {
  const networking = exactKeys(value, FOUNDATION_NETWORKING_KEYS, 'Foundation Terraform acceptance networking');
  if (
    networking['networkAuthority'] !== 'foundation-owned' ||
    networking['publicSubnetException'] !== resolveFoundationPublicSubnetException(target)
  ) {
    throw new Error('Foundation Terraform acceptance networking authority is invalid.');
  }
  let vpcId;
  try {
    vpcId = requireString(networking['vpcId'], 'Foundation Terraform acceptance VPC ID', /^vpc-[0-9a-f]+$/u);
  } catch (error) {
    throw new Error('Foundation Terraform acceptance VPC ID is invalid.', { cause: error });
  }
  return deepFreeze({
    vpcId,
    proverSubnetIds: sortedUniqueStrings(
      networking['proverSubnetIds'],
      'Foundation Terraform acceptance Prover subnet IDs',
      /^subnet-[0-9a-f]+$/u,
    ),
    proverSecurityGroupIds: sortedUniqueStrings(
      networking['proverSecurityGroupIds'],
      'Foundation Terraform acceptance Prover security-group IDs',
      /^sg-[0-9a-f]+$/u,
    ),
    networkAuthority: /** @type {const} */ ('foundation-owned'),
    publicSubnetException: resolveFoundationPublicSubnetException(target),
  });
}

/**
 * @param {unknown} value
 * @param {'prover' | 'toolchain'} kind
 * @param {AllowedDeploymentTarget} target
 * @returns {Readonly<{name: string, url: string}>}
 */
function admitFoundationRepository(value, kind, target) {
  const imageSigningIdentity = resolveImageSigningIdentity(target);
  const repository = exactKeys(value, ['name', 'url'], `Foundation Terraform acceptance ${kind} repository`);
  const name = imageSigningIdentity.repositories[kind];
  const url = `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${name}`;
  if (repository['name'] !== name || repository['url'] !== url) {
    throw new Error(`Foundation Terraform acceptance ${kind} repository is invalid.`);
  }
  return deepFreeze({ name, url });
}

/**
 * @param {unknown} value
 * @param {AllowedDeploymentTarget} target
 * @returns {FoundationAcceptanceImageAuthority}
 */
function admitFoundationImageAuthority(value, target) {
  const imageSigningIdentity = resolveImageSigningIdentity(target);
  const authority = exactKeys(
    value,
    FOUNDATION_IMAGE_AUTHORITY_KEYS,
    'Foundation Terraform acceptance image authority',
  );
  const repositories = exactKeys(
    authority['repositories'],
    ['prover', 'toolchain'],
    'Foundation Terraform acceptance image repositories',
  );
  const filters = denseArray(
    authority['signingRepositoryFilters'],
    'Foundation Terraform acceptance signing repository filters',
  );
  if (filters.length !== 1) {
    throw new Error('Foundation Terraform acceptance signing repository filters are invalid.');
  }
  const filter = exactKeys(
    filters[0],
    ['filter', 'filterType'],
    'Foundation Terraform acceptance signing repository filter',
  );
  if (
    authority['signingProfileName'] !== imageSigningIdentity.signingProfileName ||
    authority['signingProfileArn'] !== imageSigningIdentity.signingProfileArn ||
    filter['filterType'] !== 'WILDCARD_MATCH' ||
    filter['filter'] !== imageSigningIdentity.repositories.prover ||
    authority['tagMutability'] !== 'IMMUTABLE' ||
    authority['scanOnPush'] !== true ||
    authority['proverSigningStatusRequired'] !== 'COMPLETE' ||
    authority['retentionPolicy'] !== 'reference-aware-controller-target-10'
  ) {
    throw new Error('Foundation Terraform acceptance image authority is invalid.');
  }
  return deepFreeze({
    repositories: {
      prover: admitFoundationRepository(repositories['prover'], 'prover', target),
      toolchain: admitFoundationRepository(repositories['toolchain'], 'toolchain', target),
    },
    signingProfileName: imageSigningIdentity.signingProfileName,
    signingProfileArn: imageSigningIdentity.signingProfileArn,
    signingRepositoryFilters: [
      {
        filterType: /** @type {const} */ ('WILDCARD_MATCH'),
        filter: imageSigningIdentity.repositories.prover,
      },
    ],
    tagMutability: /** @type {const} */ ('IMMUTABLE'),
    scanOnPush: /** @type {const} */ (true),
    proverSigningStatusRequired: /** @type {const} */ ('COMPLETE'),
    retentionPolicy: /** @type {const} */ ('reference-aware-controller-target-10'),
  });
}

/**
 * @param {unknown} value
 * @returns {Readonly<{closureIdentity: string, foundationContractHash: string}>}
 */
function admitFoundationContract(value) {
  return admitFoundationSourceContract(snapshotDataTree(value, 'Foundation Terraform acceptance contract'));
}

/**
 * @param {unknown} value
 * @param {AllowedDeploymentTarget} target
 * @returns {FoundationTerraformAcceptance}
 */
function admitFoundationAcceptanceRecord(value, target) {
  const record = exactKeys(value, FOUNDATION_ACCEPTANCE_KEYS, 'Foundation Terraform acceptance');
  if (record['kind'] !== FOUNDATION_ACCEPTANCE_KIND || record['targetKey'] !== target.targetKey) {
    throw new Error('Foundation Terraform acceptance kind or target is invalid.');
  }
  const targetContext = parseDeploymentLaneContext(
    snapshotDataTree(record['targetContext'], 'Foundation Terraform acceptance target context'),
  );
  if (
    targetContext.target.accountLabel !== target.accountLabel ||
    targetContext.target.environmentId !== target.environmentId
  ) {
    throw new Error('Foundation Terraform acceptance context is detached from its expected target.');
  }
  if (targetContext.root.lane !== 'foundation' || targetContext.root.scope !== 'foundation') {
    throw new Error('Foundation Terraform acceptance context is not the Foundation root.');
  }
  const backend = validateTerraformBackendAuthority(
    snapshotDataTree(record['backend'], 'Foundation Terraform acceptance backend'),
    'foundation',
    target.targetKey,
  );
  if (backend.bucketName !== targetContext.names.terraformStateBucket) {
    throw new Error('Foundation Terraform acceptance state bucket is invalid.');
  }
  const provider = admitProvider(record['provider'], targetContext, 'Foundation');
  const nonsecretInputs = validateTerraformBaselineInputIdentity(
    snapshotDataTree(record['nonsecretInputs'], 'Foundation Terraform acceptance nonsecret inputs'),
    targetContext,
    {
      terraformVersion: provider.terraformVersion,
    },
  );
  const secretReferences = emptySecretReferences(record['secretReferences'], 'Foundation');
  const acceptedPlanChecksum = checksum(
    record['acceptedPlanChecksum'],
    'Foundation Terraform acceptance plan checksum',
  );
  const pipelineExecutionId = uuid(
    record['pipelineExecutionId'],
    'Foundation Terraform acceptance pipeline execution ID',
  );
  const acceptanceAttemptId = uuid(record['acceptanceAttemptId'], 'Foundation Terraform acceptance attempt ID');
  const approval = admitFoundationApproval(record['approval'], acceptedPlanChecksum, target);
  const acceptedAt = canonicalTimestamp(record['acceptedAt'], 'Foundation Terraform acceptance timestamp');
  if (acceptedAt < approval.approvalTimestamp) {
    throw new Error('Foundation Terraform acceptance predates its saved-plan approval.');
  }
  const foundationContract = admitFoundationContract(record['foundationContract']);
  const networking = admitFoundationNetworking(record['networking'], target);
  const imageAuthority = admitFoundationImageAuthority(record['imageAuthority'], target);
  const smoke = admitFoundationSmoke(
    record['smoke'],
    targetContext,
    acceptedPlanChecksum,
    pipelineExecutionId,
    foundationContract,
    networking,
    imageAuthority,
  );
  return deepFreeze({
    kind: FOUNDATION_ACCEPTANCE_KIND,
    targetKey: target.targetKey,
    targetContext,
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
    foundationContract,
    networking,
    imageAuthority,
  });
}

/**
 * @overload
 * @param {typeof BOOTSTRAP_ACCEPTANCE_KIND} kind
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {BootstrapTerraformAcceptance}
 */
/**
 * @overload
 * @param {typeof FOUNDATION_ACCEPTANCE_KIND} kind
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {FoundationTerraformAcceptance}
 */
/**
 * @param {typeof BOOTSTRAP_ACCEPTANCE_KIND | typeof FOUNDATION_ACCEPTANCE_KIND} kind
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {BootstrapTerraformAcceptance | FoundationTerraformAcceptance}
 */
export function admitTerraformAcceptanceRecord(kind, value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Terraform acceptance expected target'),
  );
  if (kind === FOUNDATION_ACCEPTANCE_KIND) {
    return admitFoundationAcceptanceRecord(value, target);
  }
  if (kind !== BOOTSTRAP_ACCEPTANCE_KIND) {
    throw new Error('Terraform acceptance record kind is not registered.');
  }
  const record = exactKeys(value, ACCEPTANCE_KEYS, 'Bootstrap Terraform acceptance');
  if (record['kind'] !== kind || record['targetKey'] !== target.targetKey) {
    throw new Error('Bootstrap Terraform acceptance kind or target is invalid.');
  }
  const targetContext = parseDeploymentLaneContext(
    snapshotDataTree(record['targetContext'], 'Bootstrap Terraform acceptance target context'),
  );
  if (
    targetContext.target.accountLabel !== target.accountLabel ||
    targetContext.target.environmentId !== target.environmentId
  ) {
    throw new Error('Bootstrap Terraform acceptance context is detached from its expected target.');
  }
  if (targetContext.root.lane !== 'bootstrap' || targetContext.root.scope !== 'bootstrap') {
    throw new Error('Bootstrap Terraform acceptance context is not the Bootstrap root.');
  }
  const backend = validateTerraformBackendAuthority(
    snapshotDataTree(record['backend'], 'Bootstrap Terraform acceptance backend'),
    'bootstrap',
    target.targetKey,
  );
  if (backend.bucketName !== targetContext.names.terraformStateBucket) {
    throw new Error('Bootstrap Terraform acceptance state bucket is invalid.');
  }
  const provider = admitProvider(record['provider'], targetContext);
  const nonsecretInputs = validateTerraformBaselineInputIdentity(
    snapshotDataTree(record['nonsecretInputs'], 'Bootstrap Terraform acceptance nonsecret inputs'),
    targetContext,
    {
      terraformVersion: provider.terraformVersion,
      stateBucketName: backend.bucketName,
      stateKmsAlias: targetContext.names.terraformStateKmsAlias,
      stateKmsKeyArn: backend.kmsKeyArn,
    },
  );
  const secretReferences = emptySecretReferences(record['secretReferences']);
  const acceptedPlanChecksum = checksum(record['acceptedPlanChecksum'], 'Bootstrap Terraform acceptance plan checksum');
  const pipelineExecutionId = uuid(
    record['pipelineExecutionId'],
    'Bootstrap Terraform acceptance pipeline execution ID',
  );
  const acceptanceAttemptId = uuid(record['acceptanceAttemptId'], 'Bootstrap Terraform acceptance attempt ID');
  const approval = admitApproval(record['approval'], acceptedPlanChecksum, target);
  const acceptedAt = canonicalTimestamp(record['acceptedAt'], 'Bootstrap Terraform acceptance timestamp');
  if (acceptedAt < approval.approvalTimestamp) {
    throw new Error('Bootstrap Terraform acceptance predates its saved-plan approval.');
  }
  return deepFreeze({
    kind: BOOTSTRAP_ACCEPTANCE_KIND,
    targetKey: target.targetKey,
    targetContext,
    backend,
    nonsecretInputs,
    secretReferences,
    provider,
    acceptedPlanChecksum,
    approval,
    smoke: admitSmoke(record['smoke'], targetContext, acceptedPlanChecksum, pipelineExecutionId, target),
    pipelineExecutionId,
    acceptanceAttemptId,
    acceptedAt,
  });
}

/**
 * @param {typeof BOOTSTRAP_ACCEPTANCE_KIND | typeof FOUNDATION_ACCEPTANCE_KIND} kind
 * @param {unknown} record
 * @returns {string}
 * @param {unknown} expectedTargetKey
 */
export function deriveTerraformAcceptanceRecordKey(kind, record, expectedTargetKey) {
  if (kind !== BOOTSTRAP_ACCEPTANCE_KIND && kind !== FOUNDATION_ACCEPTANCE_KIND) {
    throw new Error('Terraform acceptance record kind is not registered.');
  }
  const isFoundation = kind === FOUNDATION_ACCEPTANCE_KIND;
  const admitted = isFoundation
    ? admitTerraformAcceptanceRecord(FOUNDATION_ACCEPTANCE_KIND, record, expectedTargetKey)
    : admitTerraformAcceptanceRecord(BOOTSTRAP_ACCEPTANCE_KIND, record, expectedTargetKey);
  const prefix = acceptanceRecordPrefix(kind, admitted.targetKey);
  return `${prefix}${sha256Text(canonicalRecordJson(admitted))}.json`;
}

/**
 * @param {typeof BOOTSTRAP_ACCEPTANCE_KIND | typeof FOUNDATION_ACCEPTANCE_KIND} kind
 * @param {unknown} expectedTargetKey
 * @returns {string}
 */
function acceptanceRecordPrefix(kind, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Terraform acceptance expected target'),
  );
  const authority = resolveDeploymentLaneAuthority(
    target,
    kind === FOUNDATION_ACCEPTANCE_KIND ? 'foundation' : 'bootstrap',
  );
  return `${authority.names.terraformBaselinePrefix}/${authority.stateIdentity}/acceptances/`;
}

/**
 * @param {typeof BOOTSTRAP_ACCEPTANCE_KIND | typeof FOUNDATION_ACCEPTANCE_KIND} kind
 * @param {unknown} key
 * @param {unknown} expectedTargetKey
 * @returns {string}
 */
export function admitTerraformAcceptanceRecordKey(kind, key, expectedTargetKey) {
  if (kind !== BOOTSTRAP_ACCEPTANCE_KIND && kind !== FOUNDATION_ACCEPTANCE_KIND) {
    throw new Error('Terraform acceptance record kind is not registered.');
  }
  const prefix = acceptanceRecordPrefix(kind, expectedTargetKey);
  if (typeof key !== 'string' || !key.startsWith(prefix) || !RECORD_SUFFIX_PATTERN.test(key.slice(prefix.length))) {
    const label = kind === FOUNDATION_ACCEPTANCE_KIND ? 'Foundation' : 'Bootstrap';
    throw new Error(`${label} Terraform acceptance record key is outside its exact namespace.`);
  }
  return key;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function opaqueEtag(value, label) {
  const etag = requireString(value, label);
  if (etag.trim() !== etag || /\s/u.test(etag) || Buffer.byteLength(etag, 'utf8') > 1024) {
    throw new Error(`${label} is invalid.`);
  }
  return etag;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {TerraformAcceptancePointerObservation}
 */
function admitPointerObservation(value, label) {
  const observation = exactKeys(value, ['etag', 'versionId'], label);
  return deepFreeze({
    etag: opaqueEtag(observation['etag'], `${label} ETag`),
    versionId: parseS3VersionId(observation['versionId'], `${label} VersionId`),
  });
}

/**
 * @param {unknown} value
 * @param {import('./index.js').AllowedDeploymentTarget} target
 * @returns {FoundationTerraformAcceptancePointer}
 */
function admitFoundationAcceptancePointer(value, target) {
  const pointer = exactKeys(value, POINTER_KEYS, 'Foundation Terraform current acceptance pointer');
  if (pointer['kind'] !== FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND || pointer['targetKey'] !== target.targetKey) {
    throw new Error('Foundation Terraform current acceptance pointer kind or target is invalid.');
  }
  const pipelineExecutionId = uuid(
    pointer['pipelineExecutionId'],
    'Foundation Terraform current acceptance pipeline execution ID',
  );
  const acceptanceAttemptId = uuid(
    pointer['acceptanceAttemptId'],
    'Foundation Terraform current acceptance attempt ID',
  );
  const compareAndSwapEvidenceId = `cas/foundation-acceptance/${pipelineExecutionId}/${acceptanceAttemptId}`;
  if (pointer['compareAndSwapEvidenceId'] !== compareAndSwapEvidenceId) {
    throw new Error('Foundation Terraform current acceptance CAS evidence is detached from its execution.');
  }
  return deepFreeze({
    kind: FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND,
    targetKey: target.targetKey,
    recordKey: admitTerraformAcceptanceRecordKey(FOUNDATION_ACCEPTANCE_KIND, pointer['recordKey'], target.targetKey),
    pipelineExecutionId,
    acceptanceAttemptId,
    previous:
      pointer['previous'] === null
        ? null
        : admitPointerObservation(pointer['previous'], 'Foundation Terraform current acceptance predecessor'),
    compareAndSwapEvidenceId,
  });
}

/**
 * Admit the current-acceptance pointer for an independently selected target.
 *
 * @param {typeof BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND | typeof FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND} kind
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {BootstrapTerraformAcceptancePointer | FoundationTerraformAcceptancePointer}
 */
export function admitTerraformAcceptancePointer(kind, value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Terraform acceptance expected target'),
  );
  if (kind === FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND) {
    return admitFoundationAcceptancePointer(value, target);
  }
  if (kind !== BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND) {
    throw new Error('Terraform acceptance pointer kind is not registered.');
  }
  const pointer = exactKeys(value, POINTER_KEYS, 'Bootstrap Terraform current acceptance pointer');
  if (pointer['kind'] !== kind || pointer['targetKey'] !== target.targetKey) {
    throw new Error('Bootstrap Terraform current acceptance pointer kind or target is invalid.');
  }
  const pipelineExecutionId = uuid(
    pointer['pipelineExecutionId'],
    'Bootstrap Terraform current acceptance pipeline execution ID',
  );
  const acceptanceAttemptId = uuid(pointer['acceptanceAttemptId'], 'Bootstrap Terraform current acceptance attempt ID');
  const compareAndSwapEvidenceId = `cas/bootstrap-acceptance/${pipelineExecutionId}/${acceptanceAttemptId}`;
  if (pointer['compareAndSwapEvidenceId'] !== compareAndSwapEvidenceId) {
    throw new Error('Bootstrap Terraform current acceptance CAS evidence is detached from its execution.');
  }
  return deepFreeze({
    kind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
    targetKey: target.targetKey,
    recordKey: admitTerraformAcceptanceRecordKey(BOOTSTRAP_ACCEPTANCE_KIND, pointer['recordKey'], target.targetKey),
    pipelineExecutionId,
    acceptanceAttemptId,
    previous:
      pointer['previous'] === null
        ? null
        : admitPointerObservation(pointer['previous'], 'Bootstrap Terraform current acceptance predecessor'),
    compareAndSwapEvidenceId,
  });
}

/**
 * @param {typeof BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND | typeof FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND} kind
 * @param {unknown} expectedTargetKey
 * @returns {string}
 */
export function deriveTerraformAcceptancePointerKey(kind, expectedTargetKey) {
  if (kind !== BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND && kind !== FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND) {
    throw new Error('Terraform acceptance pointer kind is not registered.');
  }
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Terraform acceptance expected target'),
  );
  const authority = resolveDeploymentLaneAuthority(
    target,
    kind === FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND ? 'foundation' : 'bootstrap',
  );
  return `${authority.names.terraformBaselinePrefix}/${authority.stateIdentity}/current.json`;
}
