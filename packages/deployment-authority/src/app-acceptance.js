import { isDeepStrictEqual } from 'node:util';
import {
  isPlainRecord,
  parseFullSourceSha,
  parseImmutableObjectReference,
  parseS3VersionId,
  parseSha256,
  requireExactKeys,
  requireGroupedLowercaseUuid,
  requireString as requireAdmittedString,
} from './internal.js';
import { parseDynamoDbRecoveryPhase, validateDynamoDbRecoverySelection } from './dynamodb-recovery-phase.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';

const DEPLOYMENT_TARGET = resolveAllowedDeploymentTarget('stark-dev/develop');
const APP_LANE_AUTHORITY = resolveDeploymentLaneAuthority(DEPLOYMENT_TARGET, 'app');

export const PENDING_MANIFEST_VERSION_ID = '__PENDING_APP_ACCEPTANCE_PUBLICATION__';

export const CURRENT_AUTHORITY_KEYS = Object.freeze([
  'acceptedDeployments',
  'authorityType',
  'maxRetainedAcceptedDeployments',
  'retentionDays',
  'stateIdentity',
]);

export const CURRENT_AUTHORITY_ENTRY_KEYS = Object.freeze([
  'acceptanceAttemptId',
  'accountId',
  'appDeploymentRecordGenerationPath',
  'applyOutputsPath',
  'applyOutputsSha256',
  'approvalEvidencePath',
  'approvalEvidenceSha256',
  'approvalEvidenceVersionId',
  'approvalReason',
  'controlSourceSha',
  'denialSmokePath',
  'deploymentEnvironment',
  'deploymentId',
  'deploymentIdentityAuthoritySha256',
  'deploymentIdentityPath',
  'deploymentMode',
  'dynamodbDataPlaneSmokePath',
  'dynamodbRecoveryManifest',
  'dynamodbRecoveryPhase',
  'dynamodbRecoveryPhaseSmokePath',
  'dynamodbRecoverySelectionPath',
  'imageSignatureVerifierApplyIdentityPath',
  'imageSignatureVerifierPlanIdentityPath',
  'imageSignatureVerifierSmokeIdentityPath',
  'importingResourceChangeCount',
  'manifestPath',
  'manifestSha256',
  'manifestVersionId',
  'manualApprovalSkipped',
  'movedResourceChangeCount',
  'mutationDenialSimulationPath',
  'outputChangeCount',
  'pipelineExecutionId',
  'planChecksum',
  'planChecksumPath',
  'planEmpty',
  'planEmptyPath',
  'planJsonPath',
  'planPath',
  'planSummaryPath',
  'resourceChangeCount',
  'rollbackSelection',
  'rollbackSelectionPath',
  'selectedSourceSha',
  'smokeCallerPath',
  'smokeDeclaredBlocksPath',
  'smokeReportPath',
  'smokeTerraformFilesPath',
  'sourcePreflightPath',
  'sourceSha',
  'stateDenialSimulationPath',
  'staticFrontendDeployPath',
  'targetLambdaArtifactsPath',
  'terraformProvidersPath',
  'terraformVersionPath',
]);

const ACCEPTED_DEPLOYMENT_KEYS = [
  'acceptanceAttemptId',
  'accepted',
  'acceptedAfter',
  'accountId',
  'approvalEvidence',
  'approvalReason',
  'backendKey',
  'controlSourceSha',
  'deploymentEnvironment',
  'deploymentId',
  'deploymentIdentityAuthoritySha256',
  'deploymentMode',
  'dynamodbRecoveryPhase',
  'dynamodbRecoveryPhaseEvidence',
  'dynamodbRecoverySelection',
  'importingResourceChangeCount',
  'manualApprovalSkipped',
  'movedResourceChangeCount',
  'outputChangeCount',
  'pipelineExecutionId',
  'planChecksum',
  'planEmpty',
  'recordType',
  'releaseAuthority',
  'resourceChangeCount',
  'retainedDeployables',
  'retainedDeploymentArtifacts',
  'rollbackSelection',
  'selectedSourceSha',
  'sourceSha',
  'stateIdentity',
  'staticFrontendDeploy',
];

const RETAINED_DEPLOYMENT_ARTIFACT_KEYS = [
  'appDeploymentRecordGenerationPath',
  'applyOutputsPath',
  'approvalEvidencePath',
  'denialSmokePath',
  'deploymentIdentityPath',
  'dynamodbDataPlaneSmokePath',
  'dynamodbRecoveryPhaseSmokePath',
  'dynamodbRecoverySelectionPath',
  'imageSignatureVerifierApplyIdentityPath',
  'imageSignatureVerifierPlanIdentityPath',
  'imageSignatureVerifierSmokeIdentityPath',
  'mutationDenialSimulationPath',
  'planChecksumPath',
  'planEmptyPath',
  'planJsonPath',
  'planPath',
  'planSummaryPath',
  'rollbackSelectionPath',
  'smokeCallerPath',
  'smokeDeclaredBlocksPath',
  'smokeReportPath',
  'smokeTerraformFilesPath',
  'sourcePreflightPath',
  'stateDenialSimulationPath',
  'staticFrontendDeployPath',
  'targetLambdaArtifactsPath',
  'terraformProvidersPath',
  'terraformVersionPath',
];

export const RETAINED_DEPLOYMENT_ARTIFACT_BASENAMES = Object.freeze({
  appDeploymentRecordGenerationPath: 'app-deployment-record-generation.json',
  applyOutputsPath: 'apply-outputs.json',
  denialSmokePath: 'app-smoke-denial-evidence.json',
  deploymentIdentityPath: 'deployment-identity.json',
  dynamodbDataPlaneSmokePath: 'app-smoke-dynamodb-data-plane-evidence.json',
  dynamodbRecoveryPhaseSmokePath: 'app-smoke-dynamodb-recovery-phase-evidence.json',
  dynamodbRecoverySelectionPath: 'dynamodb-recovery-selection.json',
  imageSignatureVerifierApplyIdentityPath: 'image-signature-verifier-apply-identity.json',
  imageSignatureVerifierPlanIdentityPath: 'image-signature-verifier-plan-identity.json',
  imageSignatureVerifierSmokeIdentityPath: 'image-signature-verifier-smoke-identity.json',
  mutationDenialSimulationPath: 'app-smoke-mutation-denial-simulation.json',
  planChecksumPath: 'tfplan.sha256',
  planEmptyPath: 'app-plan-empty.json',
  planJsonPath: 'tfplan.json',
  planPath: 'tfplan',
  planSummaryPath: 'tfplan.txt',
  rollbackSelectionPath: 'rollback-selection.json',
  smokeCallerPath: 'app-smoke-caller.json',
  smokeDeclaredBlocksPath: 'app-smoke-declared-blocks.txt',
  smokeReportPath: 'app-smoke-report.json',
  smokeTerraformFilesPath: 'app-smoke-terraform-files.txt',
  sourcePreflightPath: 'source-preflight.json',
  stateDenialSimulationPath: 'app-smoke-state-denial-simulation.json',
  staticFrontendDeployPath: 'static-frontend-deploy.json',
  targetLambdaArtifactsPath: 'target-lambda-artifacts.json',
  terraformProvidersPath: 'terraform-providers.txt',
  terraformVersionPath: 'terraform-version.json',
});

const RETAINED_LAMBDA_ARTIFACT_NAMES = Object.freeze([
  'public_api',
  'finalization_writer',
  'proof_dispatcher',
  'verification_worker',
  'image_signature_verifier',
  'semaphore_janitor',
]);
const RETAINED_LAMBDA_ARTIFACT_KEYS = ['s3_bucket', 's3_key', 's3_object_version', 'source_code_hash', 'sha256'];
const RETAINED_IMAGE_SIGNATURE_VERIFIER_ARTIFACT_KEYS = [
  ...RETAINED_LAMBDA_ARTIFACT_KEYS,
  'asset_manifest_sha256',
  'trust_root_sha256',
];
const DYNAMODB_RECOVERY_SMOKE_CHECK_KEYS = [
  'selectionMatchesOutput',
  'servedPairMatchesPhase',
  'admissionMatchesPhase',
  'liveAdmissionMatchesOutput',
  'manifestMatchesSelectionAndOutput',
  'liveStoreLambdaConfigsMatchServedPair',
  'eventSourceMappingDesiredStateMatchesPhase',
  'liveEventSourceMappingsMatchDesiredState',
];

const APP_APPROVAL_COMMON_KEYS = [
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
const APP_EMPTY_PLAN_EVIDENCE_KEYS = [
  'evidenceType',
  'importingResourceChangeCount',
  'movedResourceChangeCount',
  'outputChangeCount',
  'planEmpty',
  'resourceChangeCount',
];

const APP_SMOKE_REPORT_KEYS = [
  'acceptanceAttemptId',
  'accountId',
  'applyOutputsPath',
  'applyOutputsSha256',
  'approvalEvidence',
  'approvalReason',
  'backendKey',
  'callerArn',
  'checks',
  'controlSourceSha',
  'deploymentEnvironment',
  'deploymentId',
  'deploymentIdentityAuthoritySha256',
  'deploymentMode',
  'dynamodbRecoveryPhase',
  'dynamodbRecoveryPhaseEvidence',
  'dynamodbRecoverySelection',
  'importingResourceChangeCount',
  'manualApprovalSkipped',
  'movedResourceChangeCount',
  'outputChangeCount',
  'pipelineExecutionId',
  'planChecksum',
  'planEmpty',
  'releaseAuthority',
  'reportType',
  'resourceChangeCount',
  'retainedDeployables',
  'retainedDeploymentArtifacts',
  'rollbackSelection',
  'selectedSourceSha',
  'sourceSha',
  'stateIdentity',
  'staticFrontendDeploy',
];
const APP_SMOKE_BOOLEAN_CHECK_KEYS = [
  'applyOutputsMatchExpectedState',
  'applyOutputsPresent',
  'dynamodbDataPlaneSmokePassed',
  'dynamodbRecoveryPhaseSmokePassed',
  'mutationAccessDenied',
  'runtimeResourcesCreated',
  'stateAccessDenied',
  'targetRuntimeOutputsPresent',
];
const CURRENT_ENTRY_ACCEPTED_FIELDS = [
  'acceptanceAttemptId',
  'accountId',
  'approvalReason',
  'controlSourceSha',
  'deploymentEnvironment',
  'deploymentId',
  'deploymentIdentityAuthoritySha256',
  'deploymentMode',
  'dynamodbRecoveryPhase',
  'importingResourceChangeCount',
  'manualApprovalSkipped',
  'movedResourceChangeCount',
  'outputChangeCount',
  'pipelineExecutionId',
  'planChecksum',
  'planEmpty',
  'resourceChangeCount',
  'rollbackSelection',
  'selectedSourceSha',
  'sourceSha',
];

export const SMOKE_DENIAL_KEYS = Object.freeze([
  'evidenceType',
  'mutationAccessDenied',
  'mutationSimulationPath',
  'stateAccessDenied',
  'stateSimulationPath',
]);

const RELEASE_AUTHORITY_KEYS = [
  'appDeploymentRecord',
  'compatibility',
  'failureMarkerContractSha256',
  'failureMarkerSmokeStatus',
  'imageArchitectures',
  'imageSignaturePreflight',
  'imageSignatureVerifierIdentity',
  'proverImageUri',
  'proverReleaseRecord',
  'toolchainArtifactRecord',
];

export class ExactSemanticShapeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ExactSemanticShapeError';
  }
}

export function exactKeys(value, expectedKeys, label) {
  try {
    return requireExactKeys(value, expectedKeys, label);
  } catch (error) {
    if (!isPlainRecord(value)) {
      throw new Error(`${label} must be an object.`, { cause: error });
    }
    throw new ExactSemanticShapeError(`${label} must use the exact semantic shape.`, { cause: error });
  }
}

function requireString(value, label, pattern) {
  try {
    if (typeof value === 'string' && value.trim() !== value) {
      throw new Error(`${label} is invalid`);
    }
    return requireAdmittedString(value, label, pattern);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

function requireUuid(value, label) {
  try {
    return requireGroupedLowercaseUuid(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function requireNullableRecord(value, label) {
  if (value !== null && !isPlainRecord(value)) {
    throw new Error(`${label} must be null or an object.`);
  }
}

function validateImmutableReference(value, label) {
  const reference = exactKeys(value, ['key', 'sha256', 'versionId'], label);
  try {
    return parseImmutableObjectReference(reference);
  } catch (error) {
    if (reference.versionId === 'null') {
      throw new Error(`${label} versionId must identify an immutable S3 object version.`, { cause: error });
    }
    throw new Error(`${label} must contain an exact key, VersionId, and SHA-256.`, { cause: error });
  }
}

function requireSourceSha(value, label) {
  try {
    return parseFullSourceSha(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

function requireSha256(value, label) {
  try {
    return parseSha256(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

function requireImmutableVersionId(value, label) {
  try {
    return parseS3VersionId(value, label);
  } catch (error) {
    throw new Error(`${label} is not an immutable S3 VersionId.`, { cause: error });
  }
}

function validateApprovalDisposition(record, label) {
  if (!['normal', 'rollback'].includes(record.deploymentMode)) {
    throw new Error(`${label} deploymentMode is invalid.`);
  }
  const countFields = [
    'resourceChangeCount',
    'outputChangeCount',
    'movedResourceChangeCount',
    'importingResourceChangeCount',
  ];
  for (const field of countFields) {
    requireNonNegativeInteger(record[field], `${label} ${field}`);
  }
  if (typeof record.planEmpty !== 'boolean' || typeof record.manualApprovalSkipped !== 'boolean') {
    throw new Error(`${label} planEmpty and manualApprovalSkipped must be booleans.`);
  }
  const derivedPlanEmpty = countFields.every((field) => record[field] === 0);
  if (record.planEmpty !== derivedPlanEmpty) {
    throw new Error(`${label} planEmpty must match all saved-plan change counts.`);
  }
  const expectedSkip = record.deploymentMode === 'normal' && record.planEmpty;
  if (record.manualApprovalSkipped !== expectedSkip) {
    throw new Error(`${label} manualApprovalSkipped does not match the approval policy.`);
  }
  const expectedReason = expectedSkip ? 'empty-plan' : 'manual-approval';
  if (record.approvalReason !== expectedReason) {
    throw new Error(`${label} approvalReason does not match the approval policy.`);
  }
}

function validateSourceAuthority(record, label) {
  const sourceSha = requireSourceSha(record.sourceSha, `${label} sourceSha`);
  const selectedSourceSha = requireSourceSha(record.selectedSourceSha, `${label} selectedSourceSha`);
  const controlSourceSha = requireSourceSha(record.controlSourceSha, `${label} controlSourceSha`);
  if (
    sourceSha !== selectedSourceSha ||
    (record.deploymentMode === 'normal' && selectedSourceSha !== controlSourceSha)
  ) {
    throw new Error(`${label} source authority is invalid.`);
  }
  return Object.freeze({ sourceSha, selectedSourceSha, controlSourceSha });
}

function validateDeploymentIdentity(record, label) {
  const deploymentIdentityAuthoritySha256 = requireSha256(
    record.deploymentIdentityAuthoritySha256,
    `${label} deploymentIdentityAuthoritySha256`,
  );
  const deploymentId = requireString(record.deploymentId, `${label} deploymentId`, /^dep_[0-9a-f]{32}$/u);
  if (deploymentId !== `dep_${deploymentIdentityAuthoritySha256.slice(0, 32)}`) {
    throw new Error(`${label} deploymentId does not match its deployment identity authority.`);
  }
  return Object.freeze({ deploymentId, deploymentIdentityAuthoritySha256 });
}

function validateDynamoDbRecoveryPhase(value, label) {
  try {
    return parseDynamoDbRecoveryPhase(value);
  } catch {
    throw new Error(`${label} dynamodbRecoveryPhase is invalid.`);
  }
}

function expectedAcceptedAfter(manualApprovalSkipped) {
  return [
    'validate',
    'plan',
    ...(manualApprovalSkipped ? [] : ['manual-approval']),
    'saved-plan-apply',
    'static-frontend-deploy',
    'resource-smoke',
  ];
}

function validateAcceptedAfter(record, label) {
  if (!isDeepStrictEqual(record.acceptedAfter, expectedAcceptedAfter(record.manualApprovalSkipped))) {
    throw new Error(`${label} acceptedAfter does not match the approval disposition and completed stages.`);
  }
}

function acceptanceAttemptPrefix(record) {
  return (
    `${APP_LANE_AUTHORITY.names.acceptedDeploymentPrefix}/executions/${record.pipelineExecutionId}/attempts/` +
    record.acceptanceAttemptId
  );
}

function canonicalApprovalEvidencePath(record) {
  return `${APP_LANE_AUTHORITY.names.approvalEvidencePrefix}/${record.pipelineExecutionId}.json`;
}

function validateRetainedArtifactPaths(artifacts, record, label) {
  const attemptPrefix = `${acceptanceAttemptPrefix(record)}/`;
  const observedPaths = new Set();
  for (const field of RETAINED_DEPLOYMENT_ARTIFACT_KEYS) {
    const artifactPath = requireString(artifacts[field], `${label} ${field}`);
    if (field === 'approvalEvidencePath') {
      if (artifactPath !== canonicalApprovalEvidencePath(record)) {
        throw new Error(`${label} approvalEvidencePath is not canonical.`);
      }
    } else {
      const expectedPath = `${attemptPrefix}${RETAINED_DEPLOYMENT_ARTIFACT_BASENAMES[field]}`;
      if (artifactPath !== expectedPath) {
        throw new Error(`${label} ${field} is not canonical.`);
      }
    }
    if (observedPaths.has(artifactPath)) {
      throw new Error(`${label} contains duplicate artifact paths.`);
    }
    observedPaths.add(artifactPath);
  }
}

function validateRetainedLambdaArtifactSet(value, record, preflightVerifierPackage, proverImageUri) {
  const artifactSet = exactKeys(
    value,
    [
      'artifacts',
      'bucket',
      'expectedImageId',
      'imageIdMappingEvidence',
      'manifestType',
      'prefix',
      'proverImageUri',
      'sourceSha',
    ],
    'Accepted deployment retained Lambda artifacts',
  );
  const expectedPrefix = `${APP_LANE_AUTHORITY.names.lambdaArtifactPrefix}/${record.selectedSourceSha}`;
  if (
    artifactSet.manifestType !== 'app-lambda-artifact-set' ||
    artifactSet.sourceSha !== record.selectedSourceSha ||
    artifactSet.bucket !== APP_LANE_AUTHORITY.names.appRetainedArtifactBucket ||
    artifactSet.prefix !== expectedPrefix ||
    artifactSet.proverImageUri !== proverImageUri
  ) {
    throw new Error('Accepted deployment retained Lambda artifact authority is inconsistent.');
  }
  requireString(
    artifactSet.expectedImageId,
    'Accepted deployment retained Lambda artifacts expectedImageId',
    /^0x[0-9a-f]{64}$/u,
  );
  const imageIdMappingEvidence = exactKeys(
    artifactSet.imageIdMappingEvidence,
    ['mappingSha256'],
    'Accepted deployment retained Lambda artifacts ImageID mapping evidence',
  );
  const mappingSha256 = requireSha256(
    imageIdMappingEvidence.mappingSha256,
    'Accepted deployment retained Lambda artifacts ImageID mapping SHA-256',
  );
  const artifacts = exactKeys(
    artifactSet.artifacts,
    RETAINED_LAMBDA_ARTIFACT_NAMES,
    'Accepted deployment retained Lambda artifact entries',
  );
  for (const name of RETAINED_LAMBDA_ARTIFACT_NAMES) {
    const isVerifier = name === 'image_signature_verifier';
    const artifact = exactKeys(
      artifacts[name],
      isVerifier ? RETAINED_IMAGE_SIGNATURE_VERIFIER_ARTIFACT_KEYS : RETAINED_LAMBDA_ARTIFACT_KEYS,
      `Accepted deployment retained Lambda artifact ${name}`,
    );
    const artifactSha256 = requireSha256(
      artifact.sha256,
      `Accepted deployment retained Lambda artifact ${name} SHA-256`,
    );
    requireImmutableVersionId(
      artifact.s3_object_version,
      `Accepted deployment retained Lambda artifact ${name} versionId`,
    );
    const expectedKey = isVerifier ? preflightVerifierPackage.s3_key : `${expectedPrefix}/${name}.zip`;
    if (
      artifact.s3_bucket !== artifactSet.bucket ||
      artifact.s3_key !== expectedKey ||
      artifact.source_code_hash !== Buffer.from(artifactSha256, 'hex').toString('base64')
    ) {
      throw new Error(`Accepted deployment retained Lambda artifact ${name} is inconsistent.`);
    }
    if (isVerifier) {
      requireSha256(
        artifact.asset_manifest_sha256,
        `Accepted deployment retained Lambda artifact ${name} asset manifest SHA-256`,
      );
      requireSha256(
        artifact.trust_root_sha256,
        `Accepted deployment retained Lambda artifact ${name} trust root SHA-256`,
      );
      if (!isDeepStrictEqual(artifact, preflightVerifierPackage)) {
        throw new Error(
          'Accepted deployment retained image-signature verifier must match the preflight package authority.',
        );
      }
    }
  }
  return Object.freeze({ artifactSet, mappingSha256 });
}

function validateRetainedStaticFrontend(value, record) {
  const staticFrontend = exactKeys(
    value,
    ['artifactSha256', 'bucket', 'key', 'sha256', 'versionId'],
    'Accepted deployment retained static frontend',
  );
  const expectedKey =
    `${APP_LANE_AUTHORITY.names.staticFrontendArtifactPrefix}/${record.selectedSourceSha}/` +
    `${record.deploymentId}/dist.tar.gz`;
  if (
    staticFrontend.bucket !== APP_LANE_AUTHORITY.names.appRetainedArtifactBucket ||
    staticFrontend.key !== expectedKey
  ) {
    throw new Error('Accepted deployment retained static frontend authority is inconsistent.');
  }
  requireImmutableVersionId(staticFrontend.versionId, 'Accepted deployment retained static frontend versionId');
  requireSha256(staticFrontend.sha256, 'Accepted deployment retained static frontend SHA-256');
  const artifactSha256 = requireSha256(
    staticFrontend.artifactSha256,
    'Accepted deployment retained static frontend artifact SHA-256',
  );
  return Object.freeze({ staticFrontend, artifactSha256 });
}

function validateRetainedDeployables(value, record, preflightVerifierPackage, proverImageUri) {
  const retainedDeployables = exactKeys(
    value,
    ['lambdaArtifacts', 'staticFrontend'],
    'Accepted deployment retained deployables',
  );
  const lambda = validateRetainedLambdaArtifactSet(
    retainedDeployables.lambdaArtifacts,
    record,
    preflightVerifierPackage,
    proverImageUri,
  );
  const staticFrontend = validateRetainedStaticFrontend(retainedDeployables.staticFrontend, record);
  return Object.freeze({ retainedDeployables, lambda, staticFrontend });
}

function validateAcceptedDynamoDbRecoverySelection(value, expectedPhase) {
  const phase = validateDynamoDbRecoveryPhase(
    isPlainRecord(value) ? value.phase : undefined,
    'Accepted deployment DynamoDB recovery selection',
  );
  const manifestPresent = phase !== 'primary_active';
  const selection = exactKeys(
    value,
    ['enabled', ...(manifestPresent ? ['manifest'] : []), 'phase', 'quiesced', 'selectionType', 'servesReplacement'],
    'Accepted deployment DynamoDB recovery selection',
  );
  const quiesced = phase.endsWith('_quiesced');
  const servesReplacement = phase.startsWith('replacement_');
  if (
    selection.selectionType !== 'dynamodb-recovery' ||
    phase !== expectedPhase ||
    selection.quiesced !== quiesced ||
    selection.servesReplacement !== servesReplacement ||
    selection.enabled !== manifestPresent
  ) {
    throw new Error('Accepted deployment DynamoDB recovery selection semantics are inconsistent.');
  }
  const validatedSelection = validateDynamoDbRecoverySelection({
    phase,
    manifest: manifestPresent
      ? validateImmutableReference(selection.manifest, 'Accepted deployment DynamoDB recovery selection manifest')
      : null,
  });
  return Object.freeze({ selection, ...validatedSelection });
}

function requireCanonicalTimestamp(value, label) {
  const timestamp = requireString(value, label);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical UTC timestamp.`);
  }
  return timestamp;
}

function validateDynamoDbRecoveryPhaseEvidence(value, selection) {
  const evidence = exactKeys(
    value,
    [
      'admissionEnabled',
      'checks',
      'eventSourceMappingsEnabled',
      'evidenceType',
      'manifest',
      'phase',
      'quiesced',
      'servesReplacement',
    ],
    'Accepted deployment DynamoDB recovery phase evidence',
  );
  const phase = validateDynamoDbRecoveryPhase(evidence.phase, 'Accepted deployment DynamoDB recovery phase evidence');
  const quiesced = phase.endsWith('_quiesced');
  const servesReplacement = phase.startsWith('replacement_');
  if (
    evidence.evidenceType !== 'dynamodb-recovery-phase-smoke' ||
    phase !== selection.phase ||
    evidence.quiesced !== quiesced ||
    evidence.servesReplacement !== servesReplacement ||
    evidence.admissionEnabled !== !quiesced ||
    evidence.eventSourceMappingsEnabled !== !quiesced
  ) {
    throw new Error('Accepted deployment DynamoDB recovery phase evidence semantics are inconsistent.');
  }

  if (selection.manifest === null) {
    if (evidence.manifest !== null) {
      throw new Error('Accepted primary_active deployment must not retain a DynamoDB recovery manifest.');
    }
  } else {
    const manifest = exactKeys(
      evidence.manifest,
      ['key', 'recoveryId', 'recoveryPoint', 'replacement', 'sha256', 'versionId'],
      'Accepted deployment DynamoDB recovery phase evidence manifest',
    );
    const manifestReference = validateImmutableReference(
      { key: manifest.key, sha256: manifest.sha256, versionId: manifest.versionId },
      'Accepted deployment DynamoDB recovery phase evidence manifest reference',
    );
    const recoveryId = requireSha256(
      manifest.recoveryId,
      'Accepted deployment DynamoDB recovery phase evidence recoveryId',
    );
    requireCanonicalTimestamp(
      manifest.recoveryPoint,
      'Accepted deployment DynamoDB recovery phase evidence recoveryPoint',
    );
    const replacement = exactKeys(
      manifest.replacement,
      ['sessionsTableArn', 'votesTableArn'],
      'Accepted deployment DynamoDB recovery replacement tables',
    );
    const tableArnPattern = new RegExp(
      `^arn:${DEPLOYMENT_TARGET.partition}:dynamodb:${DEPLOYMENT_TARGET.region}:` +
        `${DEPLOYMENT_TARGET.accountId}:table/[A-Za-z0-9_.-]+$`,
      'u',
    );
    for (const field of ['sessionsTableArn', 'votesTableArn']) {
      requireString(replacement[field], `Accepted deployment DynamoDB recovery replacement ${field}`, tableArnPattern);
    }
    if (
      !isDeepStrictEqual(manifestReference, selection.manifest) ||
      manifest.key !== `${APP_LANE_AUTHORITY.names.recoveryManifestPrefix}/${recoveryId}.json`
    ) {
      throw new Error('Accepted deployment DynamoDB recovery manifest authority is inconsistent.');
    }
  }

  const checks = exactKeys(
    evidence.checks,
    DYNAMODB_RECOVERY_SMOKE_CHECK_KEYS,
    'Accepted deployment DynamoDB recovery phase evidence checks',
  );
  if (DYNAMODB_RECOVERY_SMOKE_CHECK_KEYS.some((field) => checks[field] !== true)) {
    throw new Error('Accepted deployment DynamoDB recovery phase evidence checks are incomplete.');
  }
  return evidence;
}

function validateStaticFrontendDeploy(value, artifacts, retainedDeployables) {
  const deployment = exactKeys(
    value,
    [
      'artifactSha256',
      'cloudfrontDistributionDomain',
      'cloudfrontDistributionId',
      'frontendBucketName',
      'imageIdMapping',
      'invalidationId',
      'operatorGateEnabled',
      'path',
      'publicFrontendConfigSha256',
      'stablePublicAssets',
    ],
    'Accepted deployment static frontend deployment',
  );
  if (
    deployment.path !== artifacts.staticFrontendDeployPath ||
    deployment.operatorGateEnabled !== true ||
    deployment.artifactSha256 !== retainedDeployables.staticFrontend.artifactSha256
  ) {
    throw new Error('Accepted deployment static frontend deployment authority is inconsistent.');
  }
  for (const field of [
    'frontendBucketName',
    'cloudfrontDistributionId',
    'cloudfrontDistributionDomain',
    'invalidationId',
  ]) {
    requireString(deployment[field], `Accepted deployment static frontend deployment ${field}`);
  }
  requireSha256(deployment.artifactSha256, 'Accepted deployment static frontend deployment artifact SHA-256');
  requireSha256(deployment.publicFrontendConfigSha256, 'Accepted deployment static frontend public config SHA-256');
  const imageIdMapping = exactKeys(
    deployment.imageIdMapping,
    ['cacheControl', 'deployedPath', 'sha256'],
    'Accepted deployment static frontend ImageID mapping',
  );
  if (
    imageIdMapping.deployedPath !== '/imageId-mapping.json' ||
    imageIdMapping.cacheControl !== 'no-cache' ||
    requireSha256(imageIdMapping.sha256, 'Accepted deployment static frontend ImageID mapping SHA-256') !==
      retainedDeployables.lambda.mappingSha256
  ) {
    throw new Error('Accepted deployment static frontend ImageID mapping authority is inconsistent.');
  }
  const stablePublicAssets = exactKeys(
    deployment.stablePublicAssets,
    ['cacheControl', 'cloudFrontCachePolicy', 'paths'],
    'Accepted deployment stable public assets',
  );
  if (
    !isDeepStrictEqual(stablePublicAssets.paths, ['/patterns/*', '/textures/*']) ||
    stablePublicAssets.cacheControl !== 'public,max-age=300' ||
    stablePublicAssets.cloudFrontCachePolicy !== 'frontend_app_shell'
  ) {
    throw new Error('Accepted deployment stable public asset authority is inconsistent.');
  }
  return deployment;
}

function validateApprovalReference(value, record, label) {
  const reference = exactKeys(value, ['path', 'sha256', 'versionId'], label);
  const path = requireString(reference.path, `${label} path`);
  if (path !== canonicalApprovalEvidencePath(record)) {
    throw new Error(`${label} path is not canonical.`);
  }
  requireSha256(reference.sha256, `${label} SHA-256`);
  requireImmutableVersionId(reference.versionId, `${label} versionId`);
  return reference;
}

export function validateAppApprovalEvidence(value) {
  if (!isPlainRecord(value)) {
    throw new Error('App approval evidence must be an object.');
  }
  const skipped = value.approvalMode === 'empty-plan-skip';
  const approval = exactKeys(
    value,
    skipped
      ? [...APP_APPROVAL_COMMON_KEYS, 'planEmptyEvidence']
      : [...APP_APPROVAL_COMMON_KEYS, 'actionName', 'stageName'],
    'App approval evidence',
  );
  if (approval.evidenceType !== 'app-approval') {
    throw new Error('App approval evidence type is invalid.');
  }
  const pipelineExecutionId = requireUuid(approval.pipelineExecutionId, 'App approval pipeline execution ID');
  const deploymentMode = approval.deploymentMode;
  if (deploymentMode !== 'normal' && deploymentMode !== 'rollback') {
    throw new Error('App approval deployment mode is invalid.');
  }
  const controlSourceSha = requireSourceSha(approval.controlSourceSha, 'App approval control source SHA');
  const selectedSourceSha = requireSourceSha(approval.selectedSourceSha, 'App approval selected source SHA');
  const sourceSha = requireSourceSha(approval.sourceSha, 'App approval source SHA');
  if (sourceSha !== selectedSourceSha || (deploymentMode === 'normal' && selectedSourceSha !== controlSourceSha)) {
    throw new Error('App approval source authority is invalid.');
  }
  if (
    approval.accountId !== DEPLOYMENT_TARGET.accountId ||
    approval.deploymentEnvironment !== DEPLOYMENT_TARGET.environmentId
  ) {
    throw new Error('App approval target is invalid.');
  }
  const reviewedPlanChecksum = requireSha256(approval.reviewedPlanChecksum, 'App approval reviewed plan checksum');
  const common = {
    evidenceType: 'app-approval',
    approvalMode: approval.approvalMode,
    pipelineExecutionId,
    deploymentMode,
    controlSourceSha,
    selectedSourceSha,
    sourceSha,
    accountId: DEPLOYMENT_TARGET.accountId,
    deploymentEnvironment: DEPLOYMENT_TARGET.environmentId,
    reviewedPlanChecksum,
    manualApprovalSkipped: approval.manualApprovalSkipped,
    approver: approval.approver,
    approvalTimestamp: approval.approvalTimestamp,
  };

  if (skipped) {
    if (
      deploymentMode !== 'normal' ||
      approval.manualApprovalSkipped !== true ||
      approval.approver !== null ||
      approval.approvalTimestamp !== null
    ) {
      throw new Error('App empty-plan approval disposition is invalid.');
    }
    const planEmptyEvidence = exactKeys(
      approval.planEmptyEvidence,
      APP_EMPTY_PLAN_EVIDENCE_KEYS,
      'App empty-plan approval evidence',
    );
    if (planEmptyEvidence.evidenceType !== 'app-plan-empty' || planEmptyEvidence.planEmpty !== true) {
      throw new Error('App empty-plan approval evidence type is invalid.');
    }
    const countFields = APP_EMPTY_PLAN_EVIDENCE_KEYS.filter((key) => key.endsWith('Count'));
    if (
      countFields.some((field) => !Number.isSafeInteger(planEmptyEvidence[field]) || planEmptyEvidence[field] !== 0)
    ) {
      throw new Error('App empty-plan approval evidence must contain zero Terraform changes.');
    }
    return Object.freeze({
      ...common,
      approvalMode: 'empty-plan-skip',
      manualApprovalSkipped: true,
      approver: null,
      approvalTimestamp: null,
      planEmptyEvidence: Object.freeze({ ...planEmptyEvidence }),
    });
  }

  if (
    approval.approvalMode !== 'manual-approval' ||
    approval.manualApprovalSkipped !== false ||
    approval.stageName !== 'ManualApproval' ||
    approval.actionName !== 'ApproveTargetRuntimeApply'
  ) {
    throw new Error('App manual approval disposition is invalid.');
  }
  const approverPattern = new RegExp(
    `^arn:${DEPLOYMENT_TARGET.partition}:(?:iam|sts)::${DEPLOYMENT_TARGET.accountId}:` +
      '(?:user|role|assumed-role)/[^\\s]+$',
    'u',
  );
  const approvalTimestamp = approval.approvalTimestamp;
  if (
    typeof approval.approver !== 'string' ||
    !approverPattern.test(approval.approver) ||
    typeof approvalTimestamp !== 'string' ||
    Number.isNaN(Date.parse(approvalTimestamp)) ||
    new Date(approvalTimestamp).toISOString() !== approvalTimestamp
  ) {
    throw new Error('App manual approval authority is invalid.');
  }
  return Object.freeze({
    ...common,
    approvalMode: 'manual-approval',
    stageName: 'ManualApproval',
    actionName: 'ApproveTargetRuntimeApply',
    manualApprovalSkipped: false,
    approver: approval.approver,
    approvalTimestamp,
  });
}

function validateImageSignaturePreflight(value) {
  const preflight = exactKeys(
    value,
    [
      'evidence',
      'evidenceType',
      'proverImageUri',
      'selectedSourceSha',
      'signingProfileArn',
      'sourceSha',
      'trustPolicySha256',
      'verifier',
      'verifierVersion',
    ],
    'Accepted deployment image-signature preflight',
  );
  if (preflight.evidenceType !== 'app-image-signature-preflight-validation') {
    throw new Error('Accepted deployment image-signature preflight type is invalid.');
  }
  const evidence = validateImmutableReference(
    preflight.evidence,
    'Accepted deployment image-signature preflight evidence',
  );
  const sourceSha = requireSourceSha(preflight.sourceSha, 'Accepted deployment image-signature preflight sourceSha');
  const selectedSourceSha = requireSourceSha(
    preflight.selectedSourceSha,
    'Accepted deployment image-signature preflight selectedSourceSha',
  );
  requireString(preflight.proverImageUri, 'Accepted deployment image-signature preflight proverImageUri');
  requireString(preflight.signingProfileArn, 'Accepted deployment image-signature preflight signingProfileArn');
  requireSha256(preflight.trustPolicySha256, 'Accepted deployment image-signature preflight trustPolicySha256');
  requireString(preflight.verifierVersion, 'Accepted deployment image-signature preflight verifierVersion');
  const verifier = exactKeys(
    preflight.verifier,
    [
      'architecture',
      'environmentSha256',
      'executionRoleArn',
      'executionRoleAssumePolicySha256',
      'executionRolePermissionsBoundaryArn',
      'executionRolePermissionsBoundaryPolicySha256',
      'executionRolePolicySha256',
      'functionArn',
      'functionConfigurationSha256',
      'functionVersion',
      'package',
      'preflightAliasArn',
      'runtime',
      'runtimeAliasArn',
      'timeoutSeconds',
    ],
    'Accepted deployment image-signature preflight verifier',
  );
  if (verifier.architecture !== 'x86_64' || !Number.isSafeInteger(verifier.timeoutSeconds)) {
    throw new Error('Accepted deployment image-signature verifier runtime is invalid.');
  }
  for (const field of [
    'environmentSha256',
    'executionRoleAssumePolicySha256',
    'executionRolePermissionsBoundaryPolicySha256',
    'executionRolePolicySha256',
    'functionConfigurationSha256',
  ]) {
    requireSha256(verifier[field], `Accepted deployment image-signature verifier ${field}`);
  }
  const verifierPackage = exactKeys(
    verifier.package,
    [
      'asset_manifest_sha256',
      's3_bucket',
      's3_key',
      's3_object_version',
      'sha256',
      'source_code_hash',
      'trust_root_sha256',
    ],
    'Accepted deployment image-signature verifier package',
  );
  for (const field of ['asset_manifest_sha256', 'sha256', 'trust_root_sha256']) {
    requireSha256(verifierPackage[field], `Accepted deployment image-signature verifier package ${field}`);
  }
  requireImmutableVersionId(
    verifierPackage.s3_object_version,
    'Accepted deployment image-signature verifier package s3_object_version',
  );
  return Object.freeze({ evidence, preflight, selectedSourceSha, sourceSha, verifier, verifierPackage });
}

function validateImageSignatureVerifierIdentity(value) {
  const identity = exactKeys(
    value,
    ['applyPath', 'identitySha256', 'planPath', 'smokePath'],
    'Accepted deployment image-signature verifier identity',
  );
  for (const field of ['planPath', 'applyPath', 'smokePath']) {
    requireString(identity[field], `Accepted deployment image-signature verifier identity ${field}`);
  }
  requireSha256(identity.identitySha256, 'Accepted deployment image-signature verifier identity sha256');
  return identity;
}

export function validateAcceptedDeploymentCurrentAuthorityEntry(entry, options = {}) {
  const record = exactKeys(entry, CURRENT_AUTHORITY_ENTRY_KEYS, 'Accepted deployment current authority entry');

  if (!['normal', 'rollback'].includes(record.deploymentMode)) {
    throw new Error('Accepted deployment current authority entry deploymentMode is invalid.');
  }
  validateSourceAuthority(record, 'Accepted deployment current authority entry');
  requireUuid(record.pipelineExecutionId, 'Accepted deployment current authority entry pipelineExecutionId');
  requireUuid(record.acceptanceAttemptId, 'Accepted deployment current authority entry acceptanceAttemptId');
  validateDeploymentIdentity(record, 'Accepted deployment current authority entry');
  requireSha256(record.applyOutputsSha256, 'Accepted deployment current authority entry applyOutputsSha256');
  requireSha256(record.planChecksum, 'Accepted deployment current authority entry planChecksum');
  requireSha256(record.approvalEvidenceSha256, 'Accepted deployment current authority entry approvalEvidenceSha256');
  requireSha256(record.manifestSha256, 'Accepted deployment current authority entry manifestSha256');

  const dynamodbRecoveryPhase = validateDynamoDbRecoveryPhase(
    record.dynamodbRecoveryPhase,
    'Accepted deployment current authority entry',
  );
  if (
    record.accountId !== DEPLOYMENT_TARGET.accountId ||
    record.deploymentEnvironment !== DEPLOYMENT_TARGET.environmentId
  ) {
    throw new Error('Accepted deployment current authority entry target is invalid.');
  }
  if (!['empty-plan', 'manual-approval'].includes(record.approvalReason)) {
    throw new Error('Accepted deployment current authority entry approvalReason is invalid.');
  }

  const pathFields = CURRENT_AUTHORITY_ENTRY_KEYS.filter((field) => field.endsWith('Path'));
  for (const field of pathFields) {
    requireString(record[field], `Accepted deployment current authority entry ${field}`);
  }
  const expectedManifestPath = `${acceptanceAttemptPrefix(record)}/authoritative-app-deployment.json`;
  if (record.manifestPath !== expectedManifestPath) {
    throw new Error('Accepted deployment current authority entry manifestPath is not canonical.');
  }
  validateRetainedArtifactPaths(record, record, 'Accepted deployment current authority entry');
  requireImmutableVersionId(
    record.approvalEvidenceVersionId,
    'Accepted deployment current authority entry approvalEvidenceVersionId',
  );
  if (record.manifestVersionId !== PENDING_MANIFEST_VERSION_ID || options.allowPendingManifestVersion !== true) {
    requireImmutableVersionId(
      record.manifestVersionId,
      'Accepted deployment current authority entry manifestVersionId',
    );
  }

  for (const field of [
    'resourceChangeCount',
    'outputChangeCount',
    'movedResourceChangeCount',
    'importingResourceChangeCount',
  ]) {
    requireNonNegativeInteger(record[field], `Accepted deployment current authority entry ${field}`);
  }
  for (const field of ['planEmpty', 'manualApprovalSkipped']) {
    if (typeof record[field] !== 'boolean') {
      throw new Error(`Accepted deployment current authority entry ${field} must be boolean.`);
    }
  }
  validateApprovalDisposition(record, 'Accepted deployment current authority entry');
  validateDynamoDbRecoverySelection({
    phase: dynamodbRecoveryPhase,
    manifest: record.dynamodbRecoveryManifest,
  });
  requireNullableRecord(record.rollbackSelection, 'Accepted deployment current authority entry rollbackSelection');
  return record;
}

export function validateAcceptedDeploymentCurrentAuthority(authority, options = {}) {
  const record = exactKeys(authority, CURRENT_AUTHORITY_KEYS, 'Accepted deployment current authority');
  if (record.authorityType !== 'app-accepted-deployment-authority') {
    throw new Error('Accepted deployment current authority has an unsupported authorityType.');
  }
  if (record.stateIdentity !== APP_LANE_AUTHORITY.stateIdentity) {
    throw new Error('Accepted deployment current authority has the wrong stateIdentity.');
  }
  if (!Number.isSafeInteger(record.retentionDays) || record.retentionDays <= 0) {
    throw new Error('Accepted deployment current authority retentionDays must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(record.maxRetainedAcceptedDeployments) || record.maxRetainedAcceptedDeployments <= 0) {
    throw new Error(
      'Accepted deployment current authority maxRetainedAcceptedDeployments must be a positive safe integer.',
    );
  }
  if (
    !Array.isArray(record.acceptedDeployments) ||
    record.acceptedDeployments.length > record.maxRetainedAcceptedDeployments
  ) {
    throw new Error('Accepted deployment current authority acceptedDeployments is invalid.');
  }
  const acceptanceIdentities = new Set();
  for (const [entryIndex, entry] of record.acceptedDeployments.entries()) {
    const validatedEntry = validateAcceptedDeploymentCurrentAuthorityEntry(entry, {
      allowPendingManifestVersion: options.allowPendingFirst === true && entryIndex === 0,
    });
    const acceptanceIdentity = `${validatedEntry.pipelineExecutionId}\0${validatedEntry.acceptanceAttemptId}`;
    if (acceptanceIdentities.has(acceptanceIdentity)) {
      throw new Error('Accepted deployment current authority contains a duplicate acceptance identity.');
    }
    acceptanceIdentities.add(acceptanceIdentity);
  }
  return record;
}

export function validateAcceptedDeploymentCurrentAuthorityUpdate(previousAuthority, candidateAuthority, options = {}) {
  const { priorExists } = options;
  if (typeof priorExists !== 'boolean') {
    throw new Error('Accepted deployment current authority prior existence is invalid.');
  }

  const candidate = validateAcceptedDeploymentCurrentAuthority(candidateAuthority);
  const candidateHead = candidate.acceptedDeployments[0];
  if (!candidateHead) {
    throw new Error('Accepted deployment current authority candidate must contain a current accepted deployment.');
  }

  if (!priorExists) {
    if (candidate.acceptedDeployments.length !== 1) {
      throw new Error('Initial publication must contain exactly one accepted deployment.');
    }
    return candidate;
  }

  const previous = validateAcceptedDeploymentCurrentAuthority(previousAuthority);
  for (const field of ['authorityType', 'stateIdentity', 'retentionDays', 'maxRetainedAcceptedDeployments']) {
    if (candidate[field] !== previous[field]) {
      throw new Error(`Accepted deployment current authority update must preserve ${field}.`);
    }
  }

  const expectedDeployments = [
    candidateHead,
    ...previous.acceptedDeployments.filter(
      (deployment) =>
        deployment.pipelineExecutionId !== candidateHead.pipelineExecutionId ||
        deployment.acceptanceAttemptId !== candidateHead.acceptanceAttemptId,
    ),
  ].slice(0, candidate.maxRetainedAcceptedDeployments);
  if (!isDeepStrictEqual(candidate.acceptedDeployments, expectedDeployments)) {
    throw new Error(
      'Accepted deployment current authority update must prepend, deduplicate, and truncate the exact prior accepted deployment history.',
    );
  }
  return candidate;
}

export function validateAcceptedDeploymentForwardProjection(
  previousAuthority,
  retainedAuthority,
  classificationEvidence,
  options = {},
) {
  const previous = validateAcceptedDeploymentCurrentAuthority(previousAuthority);
  const retained = validateAcceptedDeploymentCurrentAuthority(retainedAuthority);
  const expectedPredecessorAuthoritySha256 = requireSha256(
    options.expectedPredecessorAuthoritySha256,
    'Accepted deployment predecessor authority SHA-256',
  );
  const evidence = exactKeys(
    classificationEvidence,
    [
      'acceptedDeploymentClassifications',
      'evidenceType',
      'predecessorAuthoritySha256',
      'priorAcceptedDeploymentCount',
      'rejectedAcceptedDeploymentCount',
      'retainedAcceptedDeploymentCount',
      'stateIdentity',
      'validationMode',
    ],
    'Accepted deployment normal-forward classification',
  );
  if (
    evidence.evidenceType !== 'app-normal-forward-retained-acceptance-classification' ||
    evidence.validationMode !== 'normal-forward' ||
    evidence.predecessorAuthoritySha256 !== expectedPredecessorAuthoritySha256 ||
    evidence.stateIdentity !== previous.stateIdentity
  ) {
    throw new Error('Accepted deployment normal-forward classification authority is invalid.');
  }
  for (const field of ['authorityType', 'stateIdentity', 'retentionDays', 'maxRetainedAcceptedDeployments']) {
    if (retained[field] !== previous[field]) {
      throw new Error(`Accepted deployment forward projection must preserve ${field}.`);
    }
  }
  const classifications = evidence.acceptedDeploymentClassifications;
  if (!Array.isArray(classifications) || classifications.length !== previous.acceptedDeployments.length) {
    throw new Error('Accepted deployment normal-forward classification coverage is incomplete.');
  }
  const expectedRetainedEntries = [];
  let rejectedCount = 0;
  for (const [entryIndex, entry] of previous.acceptedDeployments.entries()) {
    const classification = exactKeys(
      classifications[entryIndex],
      ['acceptanceIdentity', 'disposition', 'manifest'],
      'Accepted deployment normal-forward entry classification',
    );
    const acceptanceIdentity = exactKeys(
      classification.acceptanceIdentity,
      ['acceptanceAttemptId', 'pipelineExecutionId'],
      'Accepted deployment normal-forward acceptance identity',
    );
    requireUuid(acceptanceIdentity.pipelineExecutionId, 'Accepted deployment normal-forward pipelineExecutionId');
    requireUuid(acceptanceIdentity.acceptanceAttemptId, 'Accepted deployment normal-forward acceptanceAttemptId');
    const manifest = validateImmutableReference(classification.manifest, 'Accepted deployment normal-forward manifest');
    if (
      acceptanceIdentity.pipelineExecutionId !== entry.pipelineExecutionId ||
      acceptanceIdentity.acceptanceAttemptId !== entry.acceptanceAttemptId ||
      manifest.key !== entry.manifestPath ||
      manifest.versionId !== entry.manifestVersionId ||
      manifest.sha256 !== entry.manifestSha256
    ) {
      throw new Error('Accepted deployment normal-forward classification does not match its predecessor entry.');
    }
    if (classification.disposition === 'retained-current') {
      expectedRetainedEntries.push(entry);
    } else if (classification.disposition === 'rejected-exact-semantic-shape') {
      rejectedCount += 1;
    } else {
      throw new Error('Accepted deployment normal-forward classification disposition is invalid.');
    }
  }
  if (
    evidence.priorAcceptedDeploymentCount !== previous.acceptedDeployments.length ||
    evidence.retainedAcceptedDeploymentCount !== expectedRetainedEntries.length ||
    evidence.rejectedAcceptedDeploymentCount !== rejectedCount ||
    evidence.priorAcceptedDeploymentCount !==
      evidence.retainedAcceptedDeploymentCount + evidence.rejectedAcceptedDeploymentCount ||
    !isDeepStrictEqual(retained.acceptedDeployments, expectedRetainedEntries)
  ) {
    throw new Error('Accepted deployment normal-forward classification and retained projection disagree.');
  }
  return Object.freeze({ previous, retained, evidence });
}

export function validateSmokeDenialEvidence(evidence) {
  const record = exactKeys(evidence, SMOKE_DENIAL_KEYS, 'App smoke denial evidence');
  if (record.evidenceType !== 'app-smoke-denial') {
    throw new Error('App smoke denial evidence has an unsupported evidenceType.');
  }
  for (const field of ['stateAccessDenied', 'mutationAccessDenied']) {
    if (typeof record[field] !== 'boolean') {
      throw new Error(`App smoke denial evidence ${field} must be boolean.`);
    }
  }
  requireString(record.stateSimulationPath, 'App smoke denial evidence stateSimulationPath');
  requireString(record.mutationSimulationPath, 'App smoke denial evidence mutationSimulationPath');
  return record;
}

export function validateAcceptedDeploymentRecord(value) {
  const record = exactKeys(value, ACCEPTED_DEPLOYMENT_KEYS, 'Accepted deployment record');
  if (record.recordType !== 'app-accepted-deployment' || record.accepted !== true) {
    throw new Error('Accepted deployment record has an unsupported recordType or acceptance state.');
  }
  if (!['normal', 'rollback'].includes(record.deploymentMode)) {
    throw new Error('Accepted deployment record deploymentMode is invalid.');
  }
  const sourceAuthority = validateSourceAuthority(record, 'Accepted deployment record');
  requireUuid(record.pipelineExecutionId, 'Accepted deployment record pipelineExecutionId');
  requireUuid(record.acceptanceAttemptId, 'Accepted deployment record acceptanceAttemptId');
  validateDeploymentIdentity(record, 'Accepted deployment record');
  requireSha256(record.planChecksum, 'Accepted deployment record planChecksum');
  validateDynamoDbRecoveryPhase(record.dynamodbRecoveryPhase, 'Accepted deployment record');
  if (
    record.accountId !== DEPLOYMENT_TARGET.accountId ||
    record.deploymentEnvironment !== DEPLOYMENT_TARGET.environmentId ||
    record.stateIdentity !== APP_LANE_AUTHORITY.stateIdentity ||
    record.backendKey !== APP_LANE_AUTHORITY.backendKey
  ) {
    throw new Error('Accepted deployment record target authority is invalid.');
  }
  validateApprovalDisposition(record, 'Accepted deployment record');
  validateAcceptedAfter(record, 'Accepted deployment record');
  validateApprovalReference(record.approvalEvidence, record, 'Accepted deployment approval evidence');
  const artifacts = exactKeys(
    record.retainedDeploymentArtifacts,
    RETAINED_DEPLOYMENT_ARTIFACT_KEYS,
    'Accepted deployment retained artifacts',
  );
  validateRetainedArtifactPaths(artifacts, record, 'Accepted deployment retained artifacts');
  if (
    (record.deploymentMode === 'normal' && record.rollbackSelection !== null) ||
    (record.deploymentMode === 'rollback' && !isPlainRecord(record.rollbackSelection))
  ) {
    throw new Error('Accepted deployment rollback selection does not match deploymentMode.');
  }
  const releaseAuthority = exactKeys(
    record.releaseAuthority,
    RELEASE_AUTHORITY_KEYS,
    'Accepted deployment release authority',
  );
  for (const field of ['appDeploymentRecord', 'toolchainArtifactRecord', 'proverReleaseRecord']) {
    validateImmutableReference(releaseAuthority[field], `Accepted deployment release authority ${field}`);
  }
  const imageArchitectures = exactKeys(
    releaseAuthority.imageArchitectures,
    ['prover', 'toolchain'],
    'Accepted deployment release image architectures',
  );
  if (imageArchitectures.prover !== 'arm64' || imageArchitectures.toolchain !== 'arm64') {
    throw new Error('Accepted deployment release image architectures are invalid.');
  }
  const proverImageUri = requireString(
    releaseAuthority.proverImageUri,
    'Accepted deployment release prover image URI',
    new RegExp(
      `^${DEPLOYMENT_TARGET.accountId}\\.dkr\\.ecr\\.${DEPLOYMENT_TARGET.region}\\.amazonaws\\.com/` +
        `${APP_LANE_AUTHORITY.names.proverRepository}@sha256:[0-9a-f]{64}$`,
      'u',
    ),
  );
  const compatibility = exactKeys(
    releaseAuthority.compatibility,
    ['appSourceZkvmContractHash', 'matchEvidenceId', 'proverReleaseZkvmContractHash', 'zkvmContractHash'],
    'Accepted deployment zkVM contract authority',
  );
  for (const field of ['appSourceZkvmContractHash', 'proverReleaseZkvmContractHash', 'zkvmContractHash']) {
    requireSha256(compatibility[field], `Accepted deployment zkVM contract authority ${field}`);
  }
  if (
    compatibility.zkvmContractHash !== compatibility.appSourceZkvmContractHash ||
    compatibility.zkvmContractHash !== compatibility.proverReleaseZkvmContractHash
  ) {
    throw new Error('Accepted deployment zkVM contract hashes must be identical.');
  }
  requireString(
    compatibility.matchEvidenceId,
    'Accepted deployment zkVM contract match evidence',
    /^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,1023}$/u,
  );
  requireSha256(releaseAuthority.failureMarkerContractSha256, 'Accepted deployment failure-marker contract checksum');
  if (releaseAuthority.failureMarkerSmokeStatus !== 'PASS') {
    throw new Error('Accepted deployment failure-marker smoke status must be PASS.');
  }
  const preflight = validateImageSignaturePreflight(releaseAuthority.imageSignaturePreflight);
  const expectedPreflightEvidencePattern = new RegExp(
    `^${APP_LANE_AUTHORITY.names.signaturePreflightPrefix}/executions/${record.pipelineExecutionId}/` +
      'attempts/[0-9a-f]{64}/verification\\.json$',
    'u',
  );
  if (
    preflight.sourceSha !== sourceAuthority.selectedSourceSha ||
    preflight.selectedSourceSha !== sourceAuthority.selectedSourceSha ||
    preflight.preflight.proverImageUri !== proverImageUri ||
    !expectedPreflightEvidencePattern.test(preflight.evidence.key) ||
    preflight.verifierPackage.s3_bucket !== APP_LANE_AUTHORITY.names.appRetainedArtifactBucket ||
    preflight.verifierPackage.s3_key !==
      `${APP_LANE_AUTHORITY.names.lambdaArtifactPrefix}/${sourceAuthority.selectedSourceSha}/image-signature-verifier.zip`
  ) {
    throw new Error('Accepted deployment image-signature preflight authority is inconsistent.');
  }
  const verifierIdentity = validateImageSignatureVerifierIdentity(releaseAuthority.imageSignatureVerifierIdentity);
  if (
    verifierIdentity.planPath !== artifacts.imageSignatureVerifierPlanIdentityPath ||
    verifierIdentity.applyPath !== artifacts.imageSignatureVerifierApplyIdentityPath ||
    verifierIdentity.smokePath !== artifacts.imageSignatureVerifierSmokeIdentityPath
  ) {
    throw new Error('Accepted deployment image-signature verifier identity paths are inconsistent.');
  }
  const retainedDeployables = validateRetainedDeployables(
    record.retainedDeployables,
    record,
    preflight.verifierPackage,
    proverImageUri,
  );
  const recoverySelection = validateAcceptedDynamoDbRecoverySelection(
    record.dynamodbRecoverySelection,
    record.dynamodbRecoveryPhase,
  );
  validateDynamoDbRecoveryPhaseEvidence(record.dynamodbRecoveryPhaseEvidence, recoverySelection);
  validateStaticFrontendDeploy(record.staticFrontendDeploy, artifacts, retainedDeployables);
  return record;
}

export function validateAppSmokeReport(value) {
  const report = exactKeys(value, APP_SMOKE_REPORT_KEYS, 'App smoke report');
  if (report.reportType !== 'app-smoke-report') {
    throw new Error('App smoke report type is invalid.');
  }
  const sourceSha = requireSourceSha(report.sourceSha, 'App smoke report sourceSha');
  const selectedSourceSha = requireSourceSha(report.selectedSourceSha, 'App smoke report selectedSourceSha');
  const controlSourceSha = requireSourceSha(report.controlSourceSha, 'App smoke report controlSourceSha');
  if (
    sourceSha !== selectedSourceSha ||
    (report.deploymentMode === 'normal' && selectedSourceSha !== controlSourceSha)
  ) {
    throw new Error('App smoke report source authority is invalid.');
  }
  const pipelineExecutionId = requireUuid(report.pipelineExecutionId, 'App smoke report pipelineExecutionId');
  const acceptanceAttemptId = requireUuid(report.acceptanceAttemptId, 'App smoke report acceptanceAttemptId');
  requireString(report.deploymentId, 'App smoke report deploymentId', /^dep_[0-9a-f]{32}$/u);
  requireSha256(report.deploymentIdentityAuthoritySha256, 'App smoke report deployment identity SHA-256');
  requireSha256(report.applyOutputsSha256, 'App smoke report apply outputs SHA-256');
  requireSha256(report.planChecksum, 'App smoke report plan checksum');
  if (
    report.accountId !== DEPLOYMENT_TARGET.accountId ||
    report.deploymentEnvironment !== DEPLOYMENT_TARGET.environmentId ||
    report.stateIdentity !== APP_LANE_AUTHORITY.stateIdentity ||
    report.backendKey !== APP_LANE_AUTHORITY.backendKey
  ) {
    throw new Error('App smoke report target authority is invalid.');
  }
  validateDynamoDbRecoveryPhase(report.dynamodbRecoveryPhase, 'App smoke report');
  validateApprovalDisposition(report, 'App smoke report');
  const approvalEvidence = exactKeys(
    report.approvalEvidence,
    ['path', 'sha256', 'versionId'],
    'App smoke report approval evidence',
  );
  const expectedApprovalPath = `${APP_LANE_AUTHORITY.names.approvalEvidencePrefix}/${pipelineExecutionId}.json`;
  if (approvalEvidence.path !== expectedApprovalPath) {
    throw new Error('App smoke report approval evidence path is not canonical.');
  }
  requireImmutableVersionId(approvalEvidence.versionId, 'App smoke report approval evidence versionId');
  requireSha256(approvalEvidence.sha256, 'App smoke report approval evidence SHA-256');
  requireString(report.applyOutputsPath, 'App smoke report applyOutputsPath');
  const acceptedShape = validateAcceptedDeploymentRecord({
    recordType: 'app-accepted-deployment',
    sourceSha,
    selectedSourceSha,
    controlSourceSha,
    deploymentMode: report.deploymentMode,
    dynamodbRecoveryPhase: report.dynamodbRecoveryPhase,
    deploymentEnvironment: report.deploymentEnvironment,
    pipelineExecutionId,
    acceptanceAttemptId,
    deploymentId: report.deploymentId,
    deploymentIdentityAuthoritySha256: report.deploymentIdentityAuthoritySha256,
    accountId: report.accountId,
    stateIdentity: report.stateIdentity,
    backendKey: report.backendKey,
    accepted: true,
    acceptedAfter: expectedAcceptedAfter(report.manualApprovalSkipped),
    planChecksum: report.planChecksum,
    planEmpty: report.planEmpty,
    resourceChangeCount: report.resourceChangeCount,
    outputChangeCount: report.outputChangeCount,
    movedResourceChangeCount: report.movedResourceChangeCount,
    importingResourceChangeCount: report.importingResourceChangeCount,
    manualApprovalSkipped: report.manualApprovalSkipped,
    approvalReason: report.approvalReason,
    approvalEvidence: report.approvalEvidence,
    releaseAuthority: report.releaseAuthority,
    retainedDeployables: report.retainedDeployables,
    dynamodbRecoverySelection: report.dynamodbRecoverySelection,
    dynamodbRecoveryPhaseEvidence: report.dynamodbRecoveryPhaseEvidence,
    rollbackSelection: report.rollbackSelection,
    staticFrontendDeploy: report.staticFrontendDeploy,
    retainedDeploymentArtifacts: report.retainedDeploymentArtifacts,
  });
  if (report.applyOutputsPath !== acceptedShape.retainedDeploymentArtifacts.applyOutputsPath) {
    throw new Error('App smoke report applyOutputsPath does not match its retained evidence.');
  }
  requireNullableRecord(report.rollbackSelection, 'App smoke report rollback selection');
  const checks = exactKeys(
    report.checks,
    ['expectedSmokeRole', ...APP_SMOKE_BOOLEAN_CHECK_KEYS],
    'App smoke report checks',
  );
  const expectedSmokeRole =
    `arn:${DEPLOYMENT_TARGET.partition}:sts::${DEPLOYMENT_TARGET.accountId}:assumed-role/` +
    `${APP_LANE_AUTHORITY.names.terraformSmokeRole}/*`;
  const callerPattern = new RegExp(
    `^arn:${DEPLOYMENT_TARGET.partition}:sts::${DEPLOYMENT_TARGET.accountId}:assumed-role/` +
      `${APP_LANE_AUTHORITY.names.terraformSmokeRole}/[^\\s]+$`,
    'u',
  );
  if (checks.expectedSmokeRole !== expectedSmokeRole || !callerPattern.test(report.callerArn)) {
    throw new Error('App smoke report caller authority is invalid.');
  }
  if (APP_SMOKE_BOOLEAN_CHECK_KEYS.some((field) => checks[field] !== true)) {
    throw new Error('App smoke report checks are incomplete.');
  }
  return report;
}

export function validateAcceptedDeploymentCurrentAuthorityProjection(acceptedValue, entryValue, options) {
  if (!isPlainRecord(options)) {
    throw new Error('Accepted deployment manifest SHA-256 is required for current-authority projection validation.');
  }
  const accepted = validateAcceptedDeploymentRecord(acceptedValue);
  const entry = validateAcceptedDeploymentCurrentAuthorityEntry(entryValue, {
    allowPendingManifestVersion: options.allowPendingManifestVersion === true,
  });
  const disagree = (field) => {
    throw new Error(`Accepted deployment current authority and record disagree on ${field}.`);
  };
  for (const field of CURRENT_ENTRY_ACCEPTED_FIELDS) {
    if (!isDeepStrictEqual(entry[field], accepted[field])) {
      disagree(field);
    }
  }
  for (const field of RETAINED_DEPLOYMENT_ARTIFACT_KEYS) {
    if (entry[field] !== accepted.retainedDeploymentArtifacts[field]) {
      disagree(field);
    }
  }
  const approvalEvidence = exactKeys(
    accepted.approvalEvidence,
    ['path', 'sha256', 'versionId'],
    'Accepted deployment approval evidence',
  );
  if (
    entry.approvalEvidencePath !== approvalEvidence.path ||
    entry.approvalEvidenceVersionId !== approvalEvidence.versionId ||
    entry.approvalEvidenceSha256 !== approvalEvidence.sha256
  ) {
    disagree('approval evidence');
  }
  const expectedRecoveryManifest =
    accepted.dynamodbRecoverySelection.enabled === true ? accepted.dynamodbRecoverySelection.manifest : null;
  if (!isDeepStrictEqual(entry.dynamodbRecoveryManifest, expectedRecoveryManifest)) {
    disagree('DynamoDB recovery manifest');
  }
  const expectedManifestSha256 = requireSha256(options.expectedManifestSha256, 'Accepted deployment manifest SHA-256');
  if (entry.manifestSha256 !== expectedManifestSha256) {
    disagree('manifestSha256');
  }
  if (options.expectedApplyOutputsSha256 !== undefined) {
    const expectedApplyOutputsSha256 = requireSha256(
      options.expectedApplyOutputsSha256,
      'Accepted deployment apply outputs SHA-256',
    );
    if (entry.applyOutputsSha256 !== expectedApplyOutputsSha256) {
      disagree('applyOutputsSha256');
    }
  }
  return Object.freeze({ accepted, entry });
}
