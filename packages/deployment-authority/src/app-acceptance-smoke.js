import { isDeepStrictEqual } from 'node:util';
import { allowsAppEmptyPlanSkip } from './plan-approval.js';

import { snapshotDataTree, snapshotExactRecord } from './descriptor-snapshot.js';
import { parseDynamoDbRecoveryPhase, validateDynamoDbRecoverySelection } from './dynamodb-recovery-phase.js';
import {
  canonicalJsonSha256,
  parseFullSourceSha,
  parseImmutableObjectReference,
  parseS3VersionId,
  parseSha256,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  resolveImageSigningIdentity,
} from './index.js';
import { hasControlCharacter, requireGroupedLowercaseUuid, requireString } from './internal.js';

/** @typedef {ReturnType<typeof resolveAllowedDeploymentTarget>} AllowedDeploymentTarget */
const RETAINED_DEPLOYMENT_ARTIFACT_BASENAMES = Object.freeze({
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

const REPORT_KEYS = [
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
  'releaseEvidence',
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
const RELEASE_KEYS = [
  'appExecutionAuthoritySha256',
  'failureMarkerSmokeStatus',
  'imageArchitectures',
  'imageSignaturePreflight',
  'imageSignatureVerifierIdentity',
];
const PREFLIGHT_KEYS = [
  'evidence',
  'evidenceType',
  'proverImageUri',
  'selectedSourceSha',
  'signingProfileArn',
  'sourceSha',
  'trustPolicySha256',
  'verifier',
  'verifierVersion',
];
const VERIFIER_KEYS = [
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
];
const VERIFIER_PACKAGE_KEYS = [
  'asset_manifest_sha256',
  's3_bucket',
  's3_key',
  's3_object_version',
  'sha256',
  'source_code_hash',
  'trust_root_sha256',
];
const LAMBDA_NAMES = [
  'finalization_writer',
  'image_signature_verifier',
  'proof_dispatcher',
  'public_api',
  'semaphore_janitor',
  'verification_worker',
];
const LAMBDA_ARTIFACT_KEYS = ['s3_bucket', 's3_key', 's3_object_version', 'sha256', 'source_code_hash'];
const VERIFIER_ARTIFACT_KEYS = [...LAMBDA_ARTIFACT_KEYS, 'asset_manifest_sha256', 'trust_root_sha256'];
const RECOVERY_CHECK_KEYS = [
  'admissionMatchesPhase',
  'eventSourceMappingDesiredStateMatchesPhase',
  'liveAdmissionMatchesOutput',
  'liveEventSourceMappingsMatchDesiredState',
  'liveStoreLambdaConfigsMatchServedPair',
  'manifestMatchesSelectionAndOutput',
  'selectionMatchesOutput',
  'servedPairMatchesPhase',
];
const SMOKE_CHECK_KEYS = [
  'applyOutputsMatchExpectedState',
  'applyOutputsPresent',
  'dynamodbDataPlaneSmokePassed',
  'dynamodbRecoveryPhaseSmokePassed',
  'expectedSmokeRole',
  'mutationAccessDenied',
  'runtimeResourcesCreated',
  'stateAccessDenied',
  'targetRuntimeOutputsPresent',
];
const RETAINED_PATH_KEYS = ['approvalEvidencePath', ...Object.keys(RETAINED_DEPLOYMENT_ARTIFACT_BASENAMES)];

/** @param {unknown} value @param {readonly string[]} keys @param {string} label */
function exactKeys(value, keys, label) {
  return snapshotExactRecord(value, keys, label);
}

/** @param {unknown} value @param {string} label */
function sha256(value, label) {
  return parseSha256(value, label);
}

/** @param {unknown} value @param {string} label */
function sourceSha(value, label) {
  return parseFullSourceSha(value, label);
}

/** @param {unknown} value @param {string} label */
function uuid(value, label) {
  return requireGroupedLowercaseUuid(value, label);
}

/** @param {unknown} value @param {string} label */
function immutableReference(value, label) {
  const reference = exactKeys(value, ['key', 'sha256', 'versionId'], label);
  const admitted = parseImmutableObjectReference(reference);
  if (admitted.versionId === 'null') {
    throw new Error(`${label} must identify an immutable object version.`);
  }
  return admitted;
}

/** @param {unknown} value @param {string} label */
function nonNegativeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

/** @param {unknown} value @param {'normal' | 'rollback'} mode @param {AllowedDeploymentTarget} target */
function admitRollbackSelection(value, mode, target) {
  const app = resolveDeploymentLaneAuthority(target, 'app');
  if (mode === 'normal') {
    if (value !== null) throw new Error('Normal App smoke must not carry a rollback selection.');
    return null;
  }
  const selection = exactKeys(
    value,
    ['acceptanceKey', 'selectedDeploymentId', 'staticArtifactDeploymentId'],
    'Rollback App smoke selection',
  );
  const acceptanceKey = requireString(
    selection['acceptanceKey'],
    'Rollback App smoke acceptance key',
    new RegExp(`^${app.names.acceptedDeploymentPrefix}/acceptances/[0-9a-f]{64}\\.json$`, 'u'),
  );
  return Object.freeze({
    acceptanceKey,
    selectedDeploymentId: requireString(
      selection['selectedDeploymentId'],
      'Rollback App smoke selected deployment ID',
      /^dep_[0-9a-f]{32}$/u,
    ),
    staticArtifactDeploymentId: requireString(
      selection['staticArtifactDeploymentId'],
      'Rollback App smoke static artifact deployment ID',
      /^dep_[0-9a-f]{32}$/u,
    ),
  });
}

/** @param {Readonly<Record<string, unknown>>} report */
function admitDisposition(report) {
  const countFields = [
    'resourceChangeCount',
    'outputChangeCount',
    'movedResourceChangeCount',
    'importingResourceChangeCount',
  ];
  for (const field of countFields) nonNegativeInteger(report[field], `App smoke ${field}`);
  if (typeof report['planEmpty'] !== 'boolean' || typeof report['manualApprovalSkipped'] !== 'boolean') {
    throw new Error('App smoke plan disposition booleans are invalid.');
  }
  const planEmpty = countFields.every((field) => report[field] === 0);
  const skipped = allowsAppEmptyPlanSkip(report['deploymentEnvironment'], report['deploymentMode']) && planEmpty;
  if (
    report['planEmpty'] !== planEmpty ||
    report['manualApprovalSkipped'] !== skipped ||
    report['approvalReason'] !== (skipped ? 'empty-plan' : 'manual-approval')
  ) {
    throw new Error('App smoke approval disposition is inconsistent.');
  }
}

/** @param {Readonly<Record<string, unknown>>} report @param {AllowedDeploymentTarget} target */
function admitRetainedPaths(report, target) {
  const app = resolveDeploymentLaneAuthority(target, 'app');
  const paths = exactKeys(
    report['retainedDeploymentArtifacts'],
    RETAINED_PATH_KEYS,
    'App smoke retained deployment artifacts',
  );
  const attemptPrefix =
    `${app.names.acceptedDeploymentPrefix}/executions/${report['pipelineExecutionId']}/attempts/` +
    `${report['acceptanceAttemptId']}`;
  const observed = new Set();
  const approvalPath = `${app.names.approvalEvidencePrefix}/${report['pipelineExecutionId']}.json`;
  if (paths['approvalEvidencePath'] !== approvalPath) {
    throw new Error('App smoke retained artifact approvalEvidencePath is not canonical.');
  }
  observed.add(approvalPath);
  for (const [field, basename] of Object.entries(RETAINED_DEPLOYMENT_ARTIFACT_BASENAMES)) {
    const expected = `${attemptPrefix}/${basename}`;
    if (paths[field] !== expected || observed.has(expected)) {
      throw new Error(`App smoke retained artifact ${field} is not canonical.`);
    }
    observed.add(expected);
  }
  if (report['applyOutputsPath'] !== paths['applyOutputsPath']) {
    throw new Error('App smoke Apply outputs path is detached from retained artifacts.');
  }
  return paths;
}

/** @param {unknown} value @param {Readonly<Record<string, unknown>>} report @param {AllowedDeploymentTarget} target */
function admitPreflight(value, report, target) {
  const app = resolveDeploymentLaneAuthority(target, 'app');
  const signingIdentity = resolveImageSigningIdentity(target);
  const preflight = exactKeys(value, PREFLIGHT_KEYS, 'App smoke image-signature preflight');
  if (preflight['evidenceType'] !== 'app-image-signature-preflight-validation') {
    throw new Error('App smoke image-signature preflight type is invalid.');
  }
  const selected = sourceSha(preflight['selectedSourceSha'], 'App smoke preflight selected source');
  const source = sourceSha(preflight['sourceSha'], 'App smoke preflight source');
  const evidence = immutableReference(preflight['evidence'], 'App smoke preflight evidence');
  const evidencePattern = new RegExp(
    `^${app.names.signaturePreflightPrefix}/executions/` +
      '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/' +
      'attempts/[0-9a-f]{64}/verification\\.json$',
    'u',
  );
  const evidenceMatch = evidencePattern.exec(evidence.key);
  if (
    selected !== report['selectedSourceSha'] ||
    source !== selected ||
    evidenceMatch === null ||
    (report['deploymentMode'] === 'normal' && evidenceMatch[1] !== report['pipelineExecutionId'])
  ) {
    throw new Error('App smoke image-signature preflight source or execution is inconsistent.');
  }
  const proverImageUri = requireString(
    preflight['proverImageUri'],
    'App smoke preflight Prover image',
    new RegExp(
      `^${target.accountId}\\.dkr\\.ecr\\.${target.region}\\.amazonaws\\.com/` +
        `${app.names.proverRepository}@sha256:[0-9a-f]{64}$`,
      'u',
    ),
  );
  if (preflight['signingProfileArn'] !== signingIdentity.signingProfileArn) {
    throw new Error('App smoke preflight signing profile is invalid.');
  }
  sha256(preflight['trustPolicySha256'], 'App smoke preflight trust policy');
  requireString(preflight['verifierVersion'], 'App smoke preflight verifier version');
  const verifier = exactKeys(preflight['verifier'], VERIFIER_KEYS, 'App smoke preflight verifier');
  const functionArn =
    `arn:${target.partition}:lambda:${target.region}:${target.accountId}:function:` +
    app.names.signatureVerifierFunction;
  if (
    verifier['functionArn'] !== functionArn ||
    verifier['preflightAliasArn'] !== `${functionArn}:preflight` ||
    verifier['runtimeAliasArn'] !== `${functionArn}:runtime` ||
    verifier['architecture'] !== 'x86_64' ||
    verifier['runtime'] !== 'nodejs24.x' ||
    verifier['timeoutSeconds'] !== 120 ||
    typeof verifier['functionVersion'] !== 'string' ||
    !/^[1-9][0-9]*$/u.test(verifier['functionVersion']) ||
    verifier['executionRoleArn'] !==
      `arn:${target.partition}:iam::${target.accountId}:role/${app.names.signatureVerifierRole}` ||
    verifier['executionRolePermissionsBoundaryArn'] !==
      `arn:${target.partition}:iam::${target.accountId}:policy/${app.names.signatureVerifierPermissionsBoundary}`
  ) {
    throw new Error('App smoke preflight verifier runtime authority is invalid.');
  }
  for (const field of [
    'environmentSha256',
    'executionRoleAssumePolicySha256',
    'executionRolePermissionsBoundaryPolicySha256',
    'executionRolePolicySha256',
    'functionConfigurationSha256',
  ]) {
    sha256(verifier[field], `App smoke preflight verifier ${field}`);
  }
  const verifierPackage = exactKeys(verifier['package'], VERIFIER_PACKAGE_KEYS, 'App smoke verifier package');
  for (const field of ['asset_manifest_sha256', 'sha256', 'trust_root_sha256']) {
    sha256(verifierPackage[field], `App smoke verifier package ${field}`);
  }
  parseS3VersionId(verifierPackage['s3_object_version'], 'App smoke verifier package VersionId');
  if (
    verifierPackage['s3_bucket'] !== app.names.appRetainedArtifactBucket ||
    verifierPackage['s3_key'] !== `${app.names.lambdaArtifactPrefix}/${selected}/image-signature-verifier.zip` ||
    typeof verifierPackage['source_code_hash'] !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/u.test(verifierPackage['source_code_hash'])
  ) {
    throw new Error('App smoke verifier package authority is invalid.');
  }
  return Object.freeze({
    evidence,
    evidencePipelineExecutionId: evidenceMatch[1],
    preflight,
    proverImageUri,
    verifier,
    verifierPackage,
  });
}

/** @param {unknown} value @param {Readonly<Record<string, unknown>>} report @param {Readonly<Record<string, unknown>>} paths @param {AllowedDeploymentTarget} target */
function admitReleaseEvidence(value, report, paths, target) {
  const release = exactKeys(value, RELEASE_KEYS, 'App smoke release evidence');
  sha256(release['appExecutionAuthoritySha256'], 'App smoke execution authority SHA-256');
  const architectures = exactKeys(release['imageArchitectures'], ['prover', 'toolchain'], 'App smoke architectures');
  if (architectures['prover'] !== 'arm64' || architectures['toolchain'] !== 'arm64') {
    throw new Error('App smoke release architectures are invalid.');
  }
  if (release['failureMarkerSmokeStatus'] !== 'PASS') {
    throw new Error('App smoke failure-marker status is invalid.');
  }
  const preflight = admitPreflight(release['imageSignaturePreflight'], report, target);
  const identity = exactKeys(
    release['imageSignatureVerifierIdentity'],
    ['applyPath', 'identitySha256', 'planPath', 'smokePath'],
    'App smoke verifier identity',
  );
  /** @type {readonly (readonly [string, string])[]} */
  const identityPaths = [
    ['planPath', 'imageSignatureVerifierPlanIdentityPath'],
    ['applyPath', 'imageSignatureVerifierApplyIdentityPath'],
    ['smokePath', 'imageSignatureVerifierSmokeIdentityPath'],
  ];
  for (const [field, pathField] of identityPaths) {
    if (identity[field] !== paths[pathField]) {
      throw new Error(`App smoke verifier identity ${field} is detached from retained evidence.`);
    }
  }
  const expectedIdentity = canonicalJsonSha256({
    appSourceSha: preflight.preflight['selectedSourceSha'],
    preflightSourceSha: preflight.preflight['sourceSha'],
    proverImageUri: preflight.preflight['proverImageUri'],
    signingProfileArn: preflight.preflight['signingProfileArn'],
    trustPolicySha256: preflight.preflight['trustPolicySha256'],
    verifierVersion: preflight.preflight['verifierVersion'],
    preflightEvidence: preflight.evidence,
    verifier: preflight.verifier,
  });
  if (identity['identitySha256'] !== expectedIdentity) {
    throw new Error('App smoke verifier identity hash is detached from its exact authority.');
  }
  return Object.freeze({ identity, preflight, releaseEvidence: release });
}

/** @param {unknown} value @param {Readonly<Record<string, unknown>>} report @param {Readonly<Record<string, unknown>>} verifierPackage @param {Readonly<Record<string, unknown>> | null} rollbackSelection @param {AllowedDeploymentTarget} target */
function admitDeployables(value, report, verifierPackage, rollbackSelection, target) {
  const app = resolveDeploymentLaneAuthority(target, 'app');
  const deployables = exactKeys(value, ['lambdaArtifacts', 'staticFrontend'], 'App smoke retained deployables');
  const lambdaSet = exactKeys(
    deployables['lambdaArtifacts'],
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
    'App smoke retained Lambda artifact set',
  );
  const expectedPrefix = `${app.names.lambdaArtifactPrefix}/${report['selectedSourceSha']}`;
  if (
    lambdaSet['manifestType'] !== 'app-lambda-artifact-set' ||
    lambdaSet['sourceSha'] !== report['selectedSourceSha'] ||
    lambdaSet['bucket'] !== app.names.appRetainedArtifactBucket ||
    lambdaSet['prefix'] !== expectedPrefix
  ) {
    throw new Error('App smoke retained Lambda artifact set is inconsistent.');
  }
  requireString(lambdaSet['expectedImageId'], 'App smoke expected ImageID', /^0x[0-9a-f]{64}$/u);
  const mapping = exactKeys(lambdaSet['imageIdMappingEvidence'], ['mappingSha256'], 'App smoke ImageID mapping');
  const mappingSha256 = sha256(mapping['mappingSha256'], 'App smoke ImageID mapping SHA-256');
  const artifacts = exactKeys(lambdaSet['artifacts'], LAMBDA_NAMES, 'App smoke retained Lambda artifacts');
  for (const name of LAMBDA_NAMES) {
    const artifact = exactKeys(
      artifacts[name],
      name === 'image_signature_verifier' ? VERIFIER_ARTIFACT_KEYS : LAMBDA_ARTIFACT_KEYS,
      `App smoke Lambda artifact ${name}`,
    );
    const artifactSha256 = sha256(artifact['sha256'], `App smoke Lambda artifact ${name} SHA-256`);
    parseS3VersionId(artifact['s3_object_version'], `App smoke Lambda artifact ${name} VersionId`);
    if (
      artifact['s3_bucket'] !== lambdaSet['bucket'] ||
      artifact['s3_key'] !==
        (name === 'image_signature_verifier' ? verifierPackage['s3_key'] : `${expectedPrefix}/${name}.zip`) ||
      artifact['source_code_hash'] !== Buffer.from(artifactSha256, 'hex').toString('base64')
    ) {
      throw new Error(`App smoke Lambda artifact ${name} is inconsistent.`);
    }
    if (name === 'image_signature_verifier' && !isDeepStrictEqual(artifact, verifierPackage)) {
      throw new Error('App smoke verifier artifact is detached from preflight authority.');
    }
  }
  const staticFrontend = exactKeys(
    deployables['staticFrontend'],
    ['artifactSha256', 'bucket', 'key', 'sha256', 'versionId'],
    'App smoke retained static frontend',
  );
  const staticOwner =
    rollbackSelection === null ? report['deploymentId'] : rollbackSelection['staticArtifactDeploymentId'];
  const expectedStaticKey = `${app.names.staticFrontendArtifactPrefix}/${report['selectedSourceSha']}/${staticOwner}/dist.tar.gz`;
  if (staticFrontend['bucket'] !== app.names.appRetainedArtifactBucket || staticFrontend['key'] !== expectedStaticKey) {
    throw new Error('App smoke retained static frontend is inconsistent.');
  }
  parseS3VersionId(staticFrontend['versionId'], 'App smoke retained static VersionId');
  sha256(staticFrontend['sha256'], 'App smoke retained static SHA-256');
  const artifactSha256 = sha256(staticFrontend['artifactSha256'], 'App smoke retained static artifact SHA-256');
  return Object.freeze({ artifactSha256, deployables, lambdaSet, mappingSha256, staticFrontend });
}

/** @param {unknown} value @param {unknown} expectedPhase */
function admitRecoverySelection(value, expectedPhase) {
  const phase = parseDynamoDbRecoveryPhase(/** @type {Readonly<Record<string, unknown>>} */ (value)['phase']);
  const hasManifest = phase !== 'primary_active';
  const selection = exactKeys(
    value,
    ['enabled', ...(hasManifest ? ['manifest'] : []), 'phase', 'quiesced', 'selectionType', 'servesReplacement'],
    'App smoke DynamoDB recovery selection',
  );
  const manifest = hasManifest
    ? immutableReference(selection['manifest'], 'App smoke DynamoDB recovery manifest')
    : null;
  if (
    phase !== expectedPhase ||
    selection['selectionType'] !== 'dynamodb-recovery' ||
    selection['enabled'] !== hasManifest ||
    selection['quiesced'] !== phase.endsWith('_quiesced') ||
    selection['servesReplacement'] !== phase.startsWith('replacement_')
  ) {
    throw new Error('App smoke DynamoDB recovery selection is inconsistent.');
  }
  const admitted = validateDynamoDbRecoverySelection({ phase, manifest });
  return Object.freeze({ admitted, selection });
}

/** @param {unknown} value @param {ReturnType<typeof admitRecoverySelection>} recovery @param {AllowedDeploymentTarget} target */
function admitRecoveryEvidence(value, recovery, target) {
  const app = resolveDeploymentLaneAuthority(target, 'app');
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
    'App smoke DynamoDB recovery phase evidence',
  );
  const phase = parseDynamoDbRecoveryPhase(evidence['phase']);
  if (
    evidence['evidenceType'] !== 'dynamodb-recovery-phase-smoke' ||
    phase !== recovery.admitted.phase ||
    evidence['quiesced'] !== phase.endsWith('_quiesced') ||
    evidence['servesReplacement'] !== phase.startsWith('replacement_') ||
    evidence['admissionEnabled'] !== !phase.endsWith('_quiesced') ||
    evidence['eventSourceMappingsEnabled'] !== !phase.endsWith('_quiesced')
  ) {
    throw new Error('App smoke DynamoDB recovery evidence is inconsistent.');
  }
  if (recovery.admitted.manifest === null) {
    if (evidence['manifest'] !== null) throw new Error('Primary App smoke must not retain a recovery manifest.');
  } else {
    const manifest = exactKeys(
      evidence['manifest'],
      ['key', 'recoveryId', 'recoveryPoint', 'replacement', 'sha256', 'versionId'],
      'App smoke recovery evidence manifest',
    );
    const reference = immutableReference(
      { key: manifest['key'], sha256: manifest['sha256'], versionId: manifest['versionId'] },
      'App smoke recovery evidence manifest reference',
    );
    const recoveryId = sha256(manifest['recoveryId'], 'App smoke recovery ID');
    const recoveryPoint = requireString(manifest['recoveryPoint'], 'App smoke recovery point');
    if (new Date(recoveryPoint).toISOString() !== recoveryPoint) {
      throw new Error('App smoke recovery point is not canonical.');
    }
    const replacement = exactKeys(
      manifest['replacement'],
      ['sessionsTableArn', 'votesTableArn'],
      'App smoke recovery replacement',
    );
    const tableArn = new RegExp(
      `^arn:${target.partition}:dynamodb:${target.region}:${target.accountId}:table/[A-Za-z0-9_.-]+$`,
      'u',
    );
    for (const field of ['sessionsTableArn', 'votesTableArn']) {
      requireString(replacement[field], `App smoke recovery ${field}`, tableArn);
    }
    if (
      !isDeepStrictEqual(reference, recovery.admitted.manifest) ||
      manifest['key'] !== `${app.names.recoveryManifestPrefix}/${recoveryId}.json`
    ) {
      throw new Error('App smoke recovery manifest authority is inconsistent.');
    }
  }
  const checks = exactKeys(evidence['checks'], RECOVERY_CHECK_KEYS, 'App smoke recovery checks');
  if (RECOVERY_CHECK_KEYS.some((field) => checks[field] !== true)) {
    throw new Error('App smoke recovery checks are incomplete.');
  }
}

/** @param {unknown} value @param {Readonly<Record<string, unknown>>} paths @param {ReturnType<typeof admitDeployables>} deployables @param {AllowedDeploymentTarget} target */
function admitStaticDeployment(value, paths, deployables, target) {
  const app = resolveDeploymentLaneAuthority(target, 'app');
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
    'App smoke static deployment',
  );
  if (
    deployment['path'] !== paths['staticFrontendDeployPath'] ||
    deployment['operatorGateEnabled'] !== (target.environmentId === 'develop') ||
    deployment['artifactSha256'] !== deployables.artifactSha256
  ) {
    throw new Error('App smoke static deployment is inconsistent.');
  }
  for (const field of [
    'cloudfrontDistributionDomain',
    'cloudfrontDistributionId',
    'frontendBucketName',
    'invalidationId',
  ]) {
    requireString(deployment[field], `App smoke static deployment ${field}`);
  }
  if (deployment['frontendBucketName'] !== app.names.frontendBucket) {
    throw new Error('App smoke static deployment frontend bucket is invalid.');
  }
  sha256(deployment['publicFrontendConfigSha256'], 'App smoke public frontend config');
  const mapping = exactKeys(
    deployment['imageIdMapping'],
    ['cacheControl', 'deployedPath', 'sha256'],
    'App smoke deployed ImageID mapping',
  );
  if (
    mapping['deployedPath'] !== '/imageId-mapping.json' ||
    mapping['cacheControl'] !== 'no-cache' ||
    mapping['sha256'] !== deployables.mappingSha256
  ) {
    throw new Error('App smoke deployed ImageID mapping is inconsistent.');
  }
  const stable = exactKeys(
    deployment['stablePublicAssets'],
    ['cacheControl', 'cloudFrontCachePolicy', 'paths'],
    'App smoke stable assets',
  );
  if (
    !isDeepStrictEqual(stable['paths'], ['/patterns/*', '/textures/*']) ||
    stable['cacheControl'] !== 'public,max-age=300' ||
    stable['cloudFrontCachePolicy'] !== 'frontend_app_shell'
  ) {
    throw new Error('App smoke stable asset policy is invalid.');
  }
}

/**
 * Admit the target App smoke wire shape without constructing the retiring
 * accepted-deployment record family. This boundary is transport-free and
 * intentionally package-unexported until its cutover commit.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function admitAppAcceptanceSmokeReport(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App post-smoke expected target'));
  const app = resolveDeploymentLaneAuthority(target, 'app');
  const snapshot = /** @type {Readonly<Record<string, unknown>>} */ (
    snapshotDataTree(value, 'App acceptance smoke report')
  );
  const report = exactKeys(snapshot, REPORT_KEYS, 'App acceptance smoke report');
  if (report['reportType'] !== 'app-smoke-report') throw new Error('App acceptance smoke report type is invalid.');
  const mode = report['deploymentMode'];
  if (mode !== 'normal' && mode !== 'rollback') throw new Error('App acceptance smoke deployment mode is invalid.');
  const source = sourceSha(report['sourceSha'], 'App acceptance smoke source');
  const selected = sourceSha(report['selectedSourceSha'], 'App acceptance smoke selected source');
  const control = sourceSha(report['controlSourceSha'], 'App acceptance smoke control source');
  if (source !== selected || (mode === 'normal' && selected !== control)) {
    throw new Error('App acceptance smoke source authority is invalid.');
  }
  const pipelineExecutionId = uuid(report['pipelineExecutionId'], 'App acceptance smoke pipeline execution ID');
  uuid(report['acceptanceAttemptId'], 'App acceptance smoke attempt ID');
  const identitySha256 = sha256(
    report['deploymentIdentityAuthoritySha256'],
    'App acceptance smoke deployment identity',
  );
  if (report['deploymentId'] !== `dep_${identitySha256.slice(0, 32)}`) {
    throw new Error('App acceptance smoke deployment ID is detached from its identity.');
  }
  sha256(report['applyOutputsSha256'], 'App acceptance smoke Apply outputs');
  sha256(report['planChecksum'], 'App acceptance smoke saved plan');
  if (
    report['accountId'] !== target.accountId ||
    report['deploymentEnvironment'] !== target.environmentId ||
    report['stateIdentity'] !== app.stateIdentity ||
    report['backendKey'] !== app.backendKey
  ) {
    throw new Error('App acceptance smoke target authority is invalid.');
  }
  admitDisposition(report);
  const rollbackSelection = admitRollbackSelection(report['rollbackSelection'], mode, target);
  const paths = admitRetainedPaths(report, target);
  const approval = exactKeys(
    report['approvalEvidence'],
    ['path', 'sha256', 'versionId'],
    'App smoke approval evidence',
  );
  if (approval['path'] !== `${app.names.approvalEvidencePrefix}/${pipelineExecutionId}.json`) {
    throw new Error('App smoke approval evidence path is not canonical.');
  }
  parseS3VersionId(approval['versionId'], 'App smoke approval VersionId');
  sha256(approval['sha256'], 'App smoke approval SHA-256');
  const release = admitReleaseEvidence(report['releaseEvidence'], report, paths, target);
  const deployables = admitDeployables(
    report['retainedDeployables'],
    report,
    release.preflight.verifierPackage,
    rollbackSelection,
    target,
  );
  if (deployables.lambdaSet['proverImageUri'] !== release.preflight.proverImageUri) {
    throw new Error('App smoke deployable Prover image is detached from release authority.');
  }
  const phase = parseDynamoDbRecoveryPhase(report['dynamodbRecoveryPhase']);
  const recovery = admitRecoverySelection(report['dynamodbRecoverySelection'], phase);
  admitRecoveryEvidence(report['dynamodbRecoveryPhaseEvidence'], recovery, target);
  admitStaticDeployment(report['staticFrontendDeploy'], paths, deployables, target);
  const checks = exactKeys(report['checks'], SMOKE_CHECK_KEYS, 'App acceptance smoke checks');
  const expectedRole = `arn:${target.partition}:sts::${target.accountId}:assumed-role/${app.names.terraformSmokeRole}/*`;
  const callerPattern = new RegExp(
    `^arn:${target.partition}:sts::${target.accountId}:assumed-role/` + `${app.names.terraformSmokeRole}/[^\\s]+$`,
    'u',
  );
  const callerArn = requireString(report['callerArn'], 'App acceptance smoke caller ARN');
  if (
    checks['expectedSmokeRole'] !== expectedRole ||
    hasControlCharacter(callerArn) ||
    !callerPattern.test(callerArn) ||
    SMOKE_CHECK_KEYS.some((field) => field !== 'expectedSmokeRole' && checks[field] !== true)
  ) {
    throw new Error('App acceptance smoke caller or checks are invalid.');
  }
  return report;
}
