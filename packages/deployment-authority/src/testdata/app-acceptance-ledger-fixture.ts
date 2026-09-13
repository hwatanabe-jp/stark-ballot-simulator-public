import { createHash } from 'node:crypto';
import {
  canonicalJson,
  canonicalRecordJson,
  renderDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
} from '../index.js';
import { buildTerraformBaselineSecretReferences } from '../terraform-authority.js';
import {
  APP_ACCEPTANCE_KIND,
  bindAppAcceptanceSelection,
  deriveAppAcceptanceRecordKey,
  projectInitialAppAcceptancePointer,
} from '../app-acceptance-ledger.js';
import { desiredState as imageSignatureVerifierDesiredState } from './app-image-signature-verifier-fixture.js';

export const APP_SOURCE_SHA = 'a'.repeat(40);
export const PIPELINE_EXECUTION_ID = '11111111-2222-3333-4444-555555555555';
export const ACCEPTANCE_ATTEMPT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
export const ACCEPTED_AT = '2026-08-14T01:04:05.000Z';

const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const appAuthority = resolveDeploymentLaneAuthority(target, 'app');
const foundationAuthority = resolveDeploymentLaneAuthority(target, 'foundation');
export const APP_ACCEPTANCE_RECORD_PREFIX = `${appAuthority.names.acceptedDeploymentPrefix}/acceptances/`;
const targetContext = renderDeploymentLaneContext({
  target,
  lane: 'app',
  accountId: target.accountId,
  requestedControlSourceSha: APP_SOURCE_SHA,
  selectedApplicationSourceSha: APP_SOURCE_SHA,
  frameworkSourceSha: APP_SOURCE_SHA,
});
const deploymentIdentityAuthoritySha256 = 'd'.repeat(64);
export const DEPLOYMENT_ID = `dep_${deploymentIdentityAuthoritySha256.slice(0, 32)}`;
const expectedImageId = `0x${'e'.repeat(64)}`;
const toolchainImageDigest = `sha256:${'1'.repeat(64)}`;
const proverImageDigest = `sha256:${'e'.repeat(64)}`;
const toolchainImageUri =
  `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/` +
  `${appAuthority.names.toolchainRepository}@${toolchainImageDigest}`;
const proverImageUri =
  `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/` +
  `${appAuthority.names.proverRepository}@${proverImageDigest}`;
const acceptedPlanChecksum = '3'.repeat(64);
const imageIdMappingSha256 = '4'.repeat(64);
const zkvmContractHash = '5'.repeat(64);
const lambdaArtifactNames = [
  'finalization_writer',
  'image_signature_verifier',
  'proof_dispatcher',
  'public_api',
  'semaphore_janitor',
  'verification_worker',
] as const;

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalRecordJson(value)).digest('hex');
}

export function createAppAcceptanceProviderLockFixture(providerVersion = '6.58.0'): string {
  return (
    '# This file is maintained automatically by "terraform init".\n' +
    '# Manual edits may be lost in future updates.\n\n' +
    'provider "registry.terraform.io/hashicorp/aws" {\n' +
    `  version     = "${providerVersion}"\n` +
    `  constraints = "= ${providerVersion}"\n` +
    '  hashes = [\n' +
    `    "zh:${'6'.repeat(64)}",\n` +
    '  ]\n' +
    '}\n'
  );
}

function lambdaArtifacts(): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  return Object.freeze(
    Object.fromEntries(
      lambdaArtifactNames.map((name, index) => {
        const sha256 = name === 'image_signature_verifier' ? 'b'.repeat(64) : (index + 7).toString(16).repeat(64);
        return [
          name,
          Object.freeze({
            bucket: appAuthority.names.appRetainedArtifactBucket,
            key:
              `${appAuthority.names.lambdaArtifactPrefix}/${APP_SOURCE_SHA}/` +
              `${name === 'image_signature_verifier' ? 'image-signature-verifier' : name}.zip`,
            versionId: name === 'image_signature_verifier' ? 'immutable-package-object' : `lambda-version-${index}`,
            sha256,
            sourceCodeHash: Buffer.from(sha256, 'hex').toString('base64'),
            assetManifestSha256: name === 'image_signature_verifier' ? 'c'.repeat(64) : null,
            trustRootSha256: name === 'image_signature_verifier' ? 'd'.repeat(64) : null,
          }),
        ];
      }),
    ),
  );
}

function appInputValues(artifacts: Readonly<Record<string, Readonly<Record<string, unknown>>>>) {
  const reconciliationDesired = imageSignatureVerifierDesiredState();
  const reconciliationDesiredJson = canonicalJson(reconciliationDesired);
  return {
    account_alias: target.accountLabel,
    app_source_sha: APP_SOURCE_SHA,
    aws_account_id: target.accountId,
    aws_region: target.region,
    cloudfront_acm_certificate_arn: null,
    deploy_mode: 'normal',
    deployment_environment: target.environmentId,
    deployment_id: DEPLOYMENT_ID,
    develop_operator_gate_enabled: true,
    dynamodb_recovery_activation: null,
    dynamodb_recovery_phase: 'primary_active',
    enable_dynamodb_deletion_protection: true,
    expected_image_id: expectedImageId,
    fargate_vcpu_alarm_threshold: 40,
    image_id_mapping_evidence: {
      mapping_path: 'public/imageId-mapping.json',
      mapping_sha256: imageIdMappingSha256,
      current_method_version: 14,
      current_method_version_key: '14',
      variant: 'default',
      expected_image_id: expectedImageId,
    },
    image_signature_preflight_prover_image_uri: proverImageUri,
    image_signature_status_attempt_timeout_ms: 4_000,
    image_signature_status_max_attempts: 4,
    image_signature_status_retry_delay_ms: 5_000,
    image_signature_verifier_base_prover_image_uri: null,
    image_signature_verifier_handler_deadline_ms: 100_000,
    image_signature_verifier_lambda_timeout_seconds: 120,
    image_signature_verifier_permissions_boundary_arn:
      `arn:${target.partition}:iam::${target.accountId}:policy/` +
      appAuthority.names.signatureVerifierPermissionsBoundary,
    image_signature_verifier_process_timeout_ms: 60_000,
    image_signature_verifier_reconciliation_desired_json: reconciliationDesiredJson,
    image_signature_verifier_reconciliation_desired_sha256: createHash('sha256')
      .update(reconciliationDesiredJson)
      .digest('hex'),
    image_signature_verifier_reconciled_function_version: '42',
    image_signature_verifier_selected_authority: null,
    image_signature_verifier_step_timeout_seconds: 130,
    lambda_artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([name, artifact]) => [
        name,
        {
          asset_manifest_sha256: artifact['assetManifestSha256'],
          s3_bucket: artifact['bucket'],
          s3_key: artifact['key'],
          s3_object_version: artifact['versionId'],
          source_code_hash: artifact['sourceCodeHash'],
          trust_root_sha256: artifact['trustRootSha256'],
        },
      ]),
    ),
    lambda_runtime: 'nodejs24.x',
    project_name: target.projectId,
    proof_artifact_lifecycle_days: 7,
    prover_cpu: 16_384,
    prover_image_uri: proverImageUri,
    prover_max_concurrent_provers: 2,
    prover_memory: 32_768,
    prover_security_group_ids: [`sg-${'0123456789abcdef0'}`],
    prover_subnet_ids: [`subnet-${'0123456789abcdef0'}`],
    prover_task_timeout_seconds: 1_800,
    public_hostname: 'example.invalid',
    public_hostname_disposition: 'external-dns-acm',
    session_live_ttl_seconds: 1_800,
    state_backend_key: targetContext.root.backendKey,
    state_scope: targetContext.root.scope,
    verification_artifact_ttl_seconds: 7_200,
    verifier_public_base_url: 'https://example.invalid',
    verifier_service_bin_path: '/opt/verifier-service',
    vote_duplicate_detector_ttl_seconds: 1_800,
  } as const;
}

function nonsecretInputs(artifacts: Readonly<Record<string, Readonly<Record<string, unknown>>>>) {
  const body = canonicalRecordJson(appInputValues(artifacts));
  return {
    evidenceType: 'terraform-baseline-nonsecret-inputs',
    root: 'app',
    files: [
      {
        path: 'pipeline.auto.tfvars.json',
        sha256: createHash('sha256').update(body).digest('hex'),
        contentBase64: Buffer.from(body).toString('base64'),
      },
    ],
    secretValuesIncluded: false,
  } as const;
}

export function createAppAcceptanceFixture(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const artifacts = lambdaArtifacts();
  const verifierPackage = artifacts['image_signature_verifier'];
  if (verifierPackage === undefined) {
    throw new Error('test fixture verifier package is missing');
  }
  const foundationAcceptanceKey =
    `${foundationAuthority.names.terraformBaselinePrefix}/${foundationAuthority.stateIdentity}/acceptances/` +
    `${'7'.repeat(64)}.json`;
  const toolchainReleaseKey = `${appAuthority.names.toolchainArtifactPrefix}/releases/${'8'.repeat(64)}.json`;
  const proverReleaseKey = `${appAuthority.names.proverReleasePrefix}/releases/${'9'.repeat(64)}.json`;
  return {
    kind: APP_ACCEPTANCE_KIND,
    targetKey: 'stark-dev/develop',
    targetContext,
    backend: {
      bucketName: targetContext.names.terraformStateBucket,
      backendKey: targetContext.root.backendKey,
      kmsKeyArn:
        `arn:${target.partition}:kms:${target.region}:${target.accountId}:key/` +
        '22222222-3333-4444-5555-666666666666',
      region: target.region,
    },
    nonsecretInputs: nonsecretInputs(artifacts),
    secretReferences: buildTerraformBaselineSecretReferences('app', targetContext),
    provider: {
      lock: createAppAcceptanceProviderLockFixture(),
      selections: { 'registry.terraform.io/hashicorp/aws': '6.58.0' },
      terraformVersion: '1.15.8',
      platform: 'linux_amd64',
      runtime: {
        evidenceType: 'codebuild-runtime',
        targetKey: 'stark-dev/develop',
        lane: 'app',
        stateIdentity: targetContext.root.stateIdentity,
        sourceSha: APP_SOURCE_SHA,
        project: {
          key: 'terraformPlanProject',
          name: targetContext.names.terraformPlanProject,
          arn:
            `arn:${target.partition}:codebuild:${target.region}:${target.accountId}:project/` +
            targetContext.names.terraformPlanProject,
          buildId: `${targetContext.names.terraformPlanProject}:33333333-4444-5555-6666-777777777777`,
        },
        runtime: {
          configuredImage: 'aws/codebuild/standard:8.0',
          observedImage: 'aws/codebuild/standard:8.0',
          computeType: 'BUILD_GENERAL1_SMALL',
          environmentType: 'LINUX_CONTAINER',
          privilegedMode: false,
        },
      },
    },
    acceptedPlanChecksum,
    approval: {
      approvalMode: 'manual-approval',
      approvedAt: '2026-08-14T01:03:04.000Z',
      evidence: {
        key: `${appAuthority.names.approvalEvidencePrefix}/${PIPELINE_EXECUTION_ID}.json`,
        versionId: 'approval-version',
        sha256: 'a'.repeat(64),
      },
      reviewedPlanChecksum: acceptedPlanChecksum,
    },
    smoke: {
      result: 'passed',
      evidence: {
        key:
          `${appAuthority.names.acceptedDeploymentPrefix}/executions/${PIPELINE_EXECUTION_ID}/attempts/` +
          `${ACCEPTANCE_ATTEMPT_ID}/app-smoke-report.json`,
        versionId: 'smoke-version',
        sha256: 'b'.repeat(64),
      },
      acceptedPlanChecksum,
      pipelineExecutionId: PIPELINE_EXECUTION_ID,
      deploymentId: DEPLOYMENT_ID,
    },
    pipelineExecutionId: PIPELINE_EXECUTION_ID,
    acceptanceAttemptId: ACCEPTANCE_ATTEMPT_ID,
    acceptedAt: ACCEPTED_AT,
    controlSourceSha: APP_SOURCE_SHA,
    selectedApplicationSourceSha: APP_SOURCE_SHA,
    deploymentId: DEPLOYMENT_ID,
    deploymentMode: 'normal',
    planDisposition: 'changed',
    rollbackSelection: null,
    releaseAuthority: {
      foundationAcceptanceKey,
      foundationContractHash: 'c'.repeat(64),
      toolchainReleaseKey,
      proverReleaseKey,
      toolchainImage: { imageUri: toolchainImageUri, imageDigest: toolchainImageDigest },
      proverImage: { imageUri: proverImageUri, imageDigest: proverImageDigest },
      zkvm: {
        applicationZkvmContractHash: zkvmContractHash,
        proverZkvmContractHash: zkvmContractHash,
        zkvmContractHash,
        expectedImageId,
        methodVersion: 14,
        imageIdVariant: 'default',
        imageIdMappingSha256,
        failureMarkerContractSha256: 'f'.repeat(64),
      },
    },
    verifier: {
      confirmedImageIdMapping: {
        proverReleaseKey,
        proverImageDigest,
        expectedImageId,
        methodVersion: 14,
        imageIdVariant: 'default',
        imageIdMappingSha256,
        zkvmContractHash,
      },
      signaturePreflight: {
        result: 'passed',
        selectedApplicationSourceSha: APP_SOURCE_SHA,
        proverReleaseKey,
        proverImageUri,
        managedSigningStatus: 'COMPLETE',
        evidence: { key: 'signature-preflight/result.json', versionId: 'preflight-version', sha256: '1'.repeat(64) },
        verifierIdentitySha256: '2'.repeat(64),
        verifierPackage,
      },
    },
    deployables: {
      lambdaArtifacts: {
        artifactType: 'app-lambda-artifacts',
        sourceSha: APP_SOURCE_SHA,
        bucket: appAuthority.names.appRetainedArtifactBucket,
        prefix: `${appAuthority.names.lambdaArtifactPrefix}/${APP_SOURCE_SHA}`,
        artifacts,
      },
      staticFrontend: {
        bucket: appAuthority.names.appRetainedArtifactBucket,
        key: `${appAuthority.names.staticFrontendArtifactPrefix}/${APP_SOURCE_SHA}/${DEPLOYMENT_ID}/dist.tar.gz`,
        versionId: 'static-version',
        sha256: '3'.repeat(64),
        artifactSha256: '4'.repeat(64),
      },
    },
    runtime: {
      applyOutputsSha256: '5'.repeat(64),
      deploymentIdentityAuthoritySha256,
      dynamodbRecovery: { phase: 'primary_active', manifest: null },
    },
    ...overrides,
  };
}

export function createBoundSelectionFixture(
  selectionType: 'current' | 'retained' = 'current',
  targetKey = 'stark-dev/develop',
): ReturnType<typeof bindAppAcceptanceSelection> {
  const record =
    targetKey === 'stark-prod/main' ? createProductionAppAcceptanceFixture() : createAppAcceptanceFixture();
  const acceptanceKey = deriveAppAcceptanceRecordKey(record, targetKey);
  const headKey =
    selectionType === 'current'
      ? acceptanceKey
      : acceptanceKey.replace(/[0-9a-f]{64}\.json$/u, `${'0'.repeat(64)}.json`);
  const pointer = projectInitialAppAcceptancePointer(
    {
      history: selectionType === 'current' ? [acceptanceKey] : [headKey, acceptanceKey],
      predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
    },
    targetKey,
  );
  return bindAppAcceptanceSelection(
    {
      pointer,
      pointerObservation: { etag: 'pointer-etag', versionId: 'pointer-version' },
      recordKey: acceptanceKey,
      record,
      recordObservation: { etag: 'record-etag', versionId: 'record-version' },
    },
    targetKey,
  );
}

/** Synthetic production evidence; callers install the reviewed test configuration first. */
export function createProductionAppAcceptanceFixture(): Readonly<Record<string, unknown>> {
  const production = resolveAllowedDeploymentTarget('stark-prod/main');
  function project(value: unknown): unknown {
    if (typeof value === 'string') {
      return value
        .replaceAll(target.accountId, production.accountId)
        .replaceAll('stark-dev', 'stark-prod')
        .replaceAll('stark_dev', 'stark_prod')
        .replaceAll('develop', 'main');
    }
    if (Array.isArray(value)) return value.map((entry: unknown) => project(entry));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]: [string, unknown]) => [key, project(entry)]));
    }
    return value;
  }
  function rehashConfigurations(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach((entry: unknown) => rehashConfigurations(entry));
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    Object.values(record).forEach(rehashConfigurations);
    if (Object.hasOwn(record, 'functionConfigurationAuthority')) {
      record['functionConfigurationSha256'] = createHash('sha256')
        .update(canonicalJson(record['functionConfigurationAuthority']))
        .digest('hex');
    }
  }
  const body = project(createAppAcceptanceFixture()) as Record<string, unknown>;
  body['targetContext'] = renderDeploymentLaneContext({
    target: production,
    lane: 'app',
    accountId: production.accountId,
    requestedControlSourceSha: APP_SOURCE_SHA,
    selectedApplicationSourceSha: APP_SOURCE_SHA,
    frameworkSourceSha: APP_SOURCE_SHA,
  });
  const values = project(appInputValues(lambdaArtifacts())) as Record<string, unknown>;
  values['develop_operator_gate_enabled'] = false;
  values['cloudfront_acm_certificate_arn'] =
    `arn:aws:acm:us-east-1:${production.accountId}:certificate/11111111-2222-3333-4444-555555555555`;
  const desired: unknown = JSON.parse(String(values['image_signature_verifier_reconciliation_desired_json']));
  rehashConfigurations(desired);
  const desiredJson = canonicalJson(desired);
  values['image_signature_verifier_reconciliation_desired_json'] = desiredJson;
  values['image_signature_verifier_reconciliation_desired_sha256'] = createHash('sha256')
    .update(desiredJson)
    .digest('hex');
  const content = canonicalRecordJson(values);
  body['nonsecretInputs'] = {
    evidenceType: 'terraform-baseline-nonsecret-inputs',
    root: 'app',
    secretValuesIncluded: false,
    files: [
      {
        path: 'pipeline.auto.tfvars.json',
        sha256: createHash('sha256').update(content).digest('hex'),
        contentBase64: Buffer.from(content).toString('base64'),
      },
    ],
  };
  return body;
}
