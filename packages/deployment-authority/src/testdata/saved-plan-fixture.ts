import { allowsAppEmptyPlanSkip } from '../plan-approval.js';
import { createHash } from 'node:crypto';
import { canonicalJsonSha256, canonicalRecordJson } from '../internal.js';
import { FOUNDATION_CONTRACT_CLOSURE_IDENTITY } from '../foundation-contract.js';
import {
  renderDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  resolveBootstrapSavedPlanApprovalAction,
} from '../index.js';
import { buildSavedPlanCorrespondence } from '../saved-plan-correspondence.js';
import { classifySavedPlanDisposition } from '../saved-plan-disposition.js';
import { buildSavedPlanReview } from '../saved-plan-review.js';
import {
  buildAppVerifierInitializationInputs,
  resolveAppVerifierInitializationScope,
} from '../app-verifier-initialization.js';

const PIPELINE_EXECUTION_ID = '11111111-2222-4333-8444-555555555555';
const ACTION_EXECUTION_ID = '22222222-3333-4444-8555-666666666666';
const PLAN_ACTION_EXECUTION_ID = '33333333-4444-4555-8666-777777777777';
const SOURCE_SHA = 'a'.repeat(40);

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function initialVerifierPlan(
  context: ReturnType<typeof renderDeploymentLaneContext>,
  target: ReturnType<typeof resolveAllowedDeploymentTarget>,
) {
  const prover = resolveDeploymentLaneAuthority(target, 'prover');
  const scope = resolveAppVerifierInitializationScope('prerequisite', target.targetKey);
  const inputs = buildAppVerifierInitializationInputs(
    {
      context,
      phase: 'prerequisite',
      proverImageUri: `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${prover.names.proverRepository}@sha256:${'4'.repeat(64)}`,
      package: {
        s3_bucket: context.names.appRetainedArtifactBucket,
        s3_key: `${context.names.lambdaArtifactPrefix}/${SOURCE_SHA}/image-signature-verifier.zip`,
        s3_object_version: 'verifier-package-object-id',
        source_code_hash: Buffer.alloc(32, 1).toString('base64'),
        asset_manifest_sha256: 'a'.repeat(64),
        trust_root_sha256: 'b'.repeat(64),
      },
    },
    target.targetKey,
  );
  return {
    variables: Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name, { value }])),
    configuration: {
      root_module: { resources: [...scope.resourceAddresses, ...scope.dataAddresses].map((address) => ({ address })) },
    },
    resource_changes: scope.resourceAddresses.map((address) => ({
      address,
      mode: 'managed',
      change: {
        actions: ['create'],
        before: null,
        after: address === 'aws_lambda_function.image_signature_verifier' ? { publish: true } : { input: null },
        before_sensitive: false,
        after_sensitive: {},
        after_unknown: {},
      },
    })),
    output_changes: { image_signature_preflight: { actions: ['create'], before: null, after_sensitive: false } },
  };
}

function buildSavedPlanFixtureValue(
  options: {
    targetKey?: string;
    lane?: 'app' | 'bootstrap' | 'foundation';
    gate?: 'terraform' | 'verifier-preflight';
    deploymentMode?: 'normal' | 'rollback';
    selectedSourceSha?: string;
    semanticChange?: boolean;
    verifierPrerequisite?: boolean;
    foundationInitial?: boolean;
    resourceChangeCount?: number;
    driftChangeCount?: number;
  } = {},
) {
  const TARGET =
    options.targetKey === undefined
      ? resolveAllowedDeploymentTarget('stark-dev/develop')
      : resolveAllowedDeploymentTarget(options.targetKey);
  const foundation = resolveDeploymentLaneAuthority(TARGET, 'foundation');
  const lane = options.lane ?? 'bootstrap';
  const gate = options.gate ?? 'terraform';
  const deploymentMode = options.deploymentMode ?? 'normal';
  const selectedSourceSha = options.selectedSourceSha === undefined ? SOURCE_SHA : options.selectedSourceSha;
  const semanticChange = options.semanticChange ?? true;
  const prerequisite = options.verifierPrerequisite === true;
  const foundationInitial = options.foundationInitial === true;
  if (
    foundationInitial &&
    (TARGET.environmentId !== 'main' || lane !== 'foundation' || gate !== 'terraform' || !semanticChange)
  ) {
    throw new Error('Initial Foundation fixture requires a production Foundation create plan.');
  }
  if (
    prerequisite &&
    (lane !== 'app' || gate !== 'verifier-preflight' || !semanticChange || deploymentMode !== 'normal')
  ) {
    throw new Error('Initial verifier fixtures require a changed normal App preflight plan.');
  }
  const targetContext = renderDeploymentLaneContext({
    target: TARGET,
    lane,
    accountId: TARGET.accountId,
    requestedControlSourceSha: SOURCE_SHA,
    selectedApplicationSourceSha: selectedSourceSha,
    frameworkSourceSha: SOURCE_SHA,
  });
  const tfplan = Buffer.from('opaque Terraform saved plan\0bytes');
  const freshFoundationOutputs = {
    foundation_state_identity: { sensitive: false, type: 'string', value: targetContext.root.stateIdentity },
    public_hostname_disposition: {
      sensitive: false,
      type: ['object', { disposition: 'string' }],
      value: { disposition: 'external-dns-acm' },
    },
  };
  const planJson = {
    format_version: '1.2',
    terraform_version: '1.15.8',
    applyable: semanticChange,
    complete: gate !== 'verifier-preflight',
    errored: false,
    deferred_changes: [],
    action_invocations: [],
    deferred_action_invocations: [],
    resource_changes: semanticChange
      ? Array.from({ length: options.resourceChangeCount ?? 1 }, (_, index) => ({
          address:
            options.resourceChangeCount === undefined
              ? 'aws_s3_bucket.target'
              : `aws_s3_bucket.target_${String(index).padStart(4, '0')}`,
          change: {
            actions: ['update'],
            before: {},
            after: {},
            before_sensitive: {},
            after_sensitive: {},
            after_unknown: {},
          },
        }))
      : [],
    output_changes: {},
    resource_drift: Array.from({ length: options.driftChangeCount ?? 0 }, (_, index) => ({
      address: `aws_s3_bucket.drifted_${String(index).padStart(4, '0')}`,
      change: { actions: ['update'] },
    })),
    checks: [{ status: 'pass' }],
    ...(prerequisite ? initialVerifierPlan(targetContext, TARGET) : {}),
    ...(foundationInitial
      ? {
          planned_values: { outputs: freshFoundationOutputs },
          output_changes: Object.fromEntries(
            Object.entries(freshFoundationOutputs).map(([name, output]) => [
              name,
              {
                actions: ['create'],
                before: null,
                after: output.value,
                after_unknown: false,
                before_sensitive: false,
                after_sensitive: false,
              },
            ]),
          ),
          prior_state: {
            format_version: '1.0',
            values: {
              outputs: freshFoundationOutputs,
              root_module: {
                resources: [
                  {
                    address: 'data.aws_caller_identity.current',
                    mode: 'data',
                    type: 'aws_caller_identity',
                    name: 'current',
                    values: { account_id: TARGET.accountId },
                  },
                ],
              },
            },
          },
          resource_changes: [
            {
              address: 'aws_s3_bucket.release_manifest',
              mode: 'managed',
              change: {
                actions: ['create'],
                before: null,
                after: {},
                before_sensitive: false,
                after_sensitive: {},
                after_unknown: {},
              },
            },
          ],
        }
      : {}),
  };
  const tfplanJson = Buffer.from(canonicalRecordJson(planJson));
  const backend = {
    bucketName: targetContext.names.terraformStateBucket,
    backendKey: targetContext.root.backendKey,
    region: targetContext.target.region,
    kmsKeyId: targetContext.names.terraformStateKmsAlias,
    encrypt: true,
    useLockfile: true,
  };
  const approval =
    lane === 'app' && gate === 'terraform'
      ? {
          deploymentMode,
          controlSourceSha: SOURCE_SHA,
          selectedSourceSha,
          accountId: TARGET.accountId,
          deploymentEnvironment: targetContext.target.environmentId,
          reviewedPlanChecksum: sha256(tfplan),
        }
      : {
          sourceSha: SOURCE_SHA,
          accountId: TARGET.accountId,
          deploymentEnvironment: targetContext.target.environmentId,
          reviewedPlanChecksum: sha256(tfplan),
        };
  const authority =
    lane !== 'app'
      ? null
      : gate === 'verifier-preflight'
        ? {
            ...(prerequisite
              ? {
                  authorityType: 'app-verifier-prerequisite' as const,
                  expectedFunctionVersion: null,
                  reconciliationDesiredSha256: null,
                }
              : {
                  authorityType: 'app-verifier-preflight' as const,
                  expectedFunctionVersion: '29',
                  reconciliationDesiredSha256: 'c'.repeat(64),
                }),
            packageSourceSha: selectedSourceSha,
            proverImageDigest: `sha256:${'4'.repeat(64)}`,
            package: {
              key: prerequisite
                ? `${targetContext.names.lambdaArtifactPrefix}/${SOURCE_SHA}/image-signature-verifier.zip`
                : 'artifacts/app/verifier/exact-package.zip',
              versionId: 'verifier-package-object-id',
              sha256: prerequisite ? Buffer.alloc(32, 1).toString('hex') : '9'.repeat(64),
            },
            sourceCodeHash: Buffer.alloc(32, 1).toString('base64'),
            assetManifestSha256: 'a'.repeat(64),
            trustRootSha256: 'b'.repeat(64),
            foundationAcceptance: {
              foundationAcceptanceKey: `${foundation.names.terraformBaselinePrefix}/${foundation.stateIdentity}/acceptances/${'d'.repeat(64)}.json`,
              foundationAcceptedSourceSha: SOURCE_SHA,
              closureIdentity: FOUNDATION_CONTRACT_CLOSURE_IDENTITY,
              foundationContractHash: 'e'.repeat(64),
            },
          }
        : {
            authorityType: 'app-deployment' as const,
            deploymentMode,
            selectedSourceSha,
            deploymentId: `dep_${'1'.repeat(32)}`,
            appExecutionAuthoritySha256: '1'.repeat(64),
            selectedProverSelector: 'accepted' as const,
            expectedImageId: `0x${'2'.repeat(64)}`,
            methodVersion: 14,
            imageIdVariant: 'default' as const,
            imageIdMappingSha256: '3'.repeat(64),
            proverImageDigest: `sha256:${'4'.repeat(64)}`,
            toolchainImageDigest: `sha256:${'5'.repeat(64)}`,
            proverReleaseKey: `artifacts/prover/releases/${'6'.repeat(64)}.json`,
            toolchainReleaseKey: `artifacts/toolchain/releases/${'7'.repeat(64)}.json`,
            lambdaSourceSha: selectedSourceSha,
            lambdaCount: 6 as const,
            lambdaSetSha256: '8'.repeat(64),
            verifierFunctionVersion: '28',
          };
  const review = buildSavedPlanReview(
    {
      context: {
        accountId: TARGET.accountId,
        backendKey: targetContext.root.backendKey,
        deploymentEnvironment: targetContext.target.environmentId,
        gate,
        lane,
        pipelineExecutionId: PIPELINE_EXECUTION_ID,
        region: targetContext.target.region,
        sourceSha: SOURCE_SHA,
        stateIdentity: targetContext.root.stateIdentity,
      },
      artifact: {
        bucket: targetContext.names.artifactBucket,
        key: 'pipeline/PlanOutput/exact-artifact.zip',
        versionId: 'artifact-object-id',
        sha256: 'e'.repeat(64),
      },
      state: {
        bucket: targetContext.names.terraformStateBucket,
        key: targetContext.root.backendKey,
        ...(prerequisite || foundationInitial
          ? { versionId: null, etag: null }
          : { versionId: 'state-object-id', etag: `"${'1'.repeat(32)}"` }),
      },
      plan: {
        planJson,
        planJsonSha256: sha256(tfplanJson),
        tfplanSha256: sha256(tfplan),
      },
      approval,
      authority,
    },
    TARGET.targetKey,
  );
  const semanticReview = {
    reviewType: 'saved-plan-semantic-review' as const,
    context: review.context,
    summary: review.summary,
    approval: review.approval,
    authority: review.authority,
  };
  const foundationAcceptanceKey = `${foundation.names.terraformBaselinePrefix}/${foundation.stateIdentity}/acceptances/${'9'.repeat(64)}.json`;
  const foundationContractHash = 'a'.repeat(64);
  const proverReleaseKey = `artifacts/prover/releases/${'b'.repeat(64)}.json`;
  const toolchainReleaseKey = `artifacts/toolchain/releases/${'c'.repeat(64)}.json`;
  const releaseChainSha256 = canonicalJsonSha256({
    foundationAcceptanceKey,
    foundationContractHash,
    proverReleaseKey,
    toolchainReleaseKey,
  });
  const resolvedInputs =
    lane === 'app'
      ? {
          inputType: 'app-release-chain' as const,
          currentAcceptedReleaseChainSha256:
            !semanticChange && gate === 'terraform' && allowsAppEmptyPlanSkip(TARGET.environmentId, deploymentMode)
              ? releaseChainSha256
              : null,
          foundationAcceptanceKey,
          foundationContractHash,
          proverReleaseKey,
          toolchainReleaseKey,
          releaseChainSha256,
        }
      : null;
  const contract = classifySavedPlanDisposition(
    {
      appReleaseChain:
        resolvedInputs?.currentAcceptedReleaseChainSha256 === null || resolvedInputs === null
          ? null
          : {
              deploymentMode: 'normal',
              selectedReleaseChainSha256: resolvedInputs.releaseChainSha256,
              currentAcceptedReleaseChainSha256: resolvedInputs.currentAcceptedReleaseChainSha256,
            },
      review: semanticReview,
    },
    TARGET.targetKey,
  );
  const providerLock = Buffer.from(
    '# This file is maintained automatically by "terraform init".\n' +
      '# Manual edits may be lost in future updates.\n\n' +
      'provider "registry.terraform.io/hashicorp/aws" {\n' +
      '  version     = "6.58.0"\n' +
      '  constraints = "= 6.58.0"\n' +
      '  hashes = [\n' +
      `    "zh:${'1'.repeat(64)}",\n` +
      '  ]\n' +
      '}\n',
  );
  const terraformIdentity = Buffer.from(
    canonicalRecordJson({
      terraform_version: '1.15.8',
      platform: 'linux_amd64',
      terraform_outdated: false,
      provider_selections: { 'registry.terraform.io/hashicorp/aws': '6.58.0' },
    }),
  );
  const providerSelections = Buffer.from(
    'Providers required by configuration:\n.\n└── provider[registry.terraform.io/hashicorp/aws] 6.58.0\n',
  );
  const projectKey = gate === 'verifier-preflight' ? 'appSignaturePreflightPlanProject' : 'terraformPlanProject';
  const projectName = targetContext.names[projectKey];
  const buildId = `${projectName}:44444444-5555-4666-8777-888888888888`;
  const runtime = {
    evidenceType: 'codebuild-runtime' as const,
    targetKey: TARGET.targetKey,
    lane,
    stateIdentity: targetContext.root.stateIdentity,
    sourceSha: SOURCE_SHA,
    project: {
      key: projectKey,
      name: projectName,
      arn: `arn:${TARGET.partition}:codebuild:${targetContext.target.region}:${TARGET.accountId}:project/${projectName}`,
      buildId,
    },
    runtime: {
      configuredImage: 'aws/codebuild/standard:8.0',
      observedImage: 'aws/codebuild/standard:8.0',
      computeType: 'BUILD_GENERAL1_SMALL',
      environmentType: 'LINUX_CONTAINER',
      privilegedMode: false,
    },
  };
  const files = {
    backend: Buffer.from(
      `bucket       = "${backend.bucketName}"\n` +
        `key          = "${backend.backendKey}"\n` +
        `region       = "${backend.region}"\n` +
        'encrypt      = true\n' +
        `kms_key_id   = "${backend.kmsKeyId}"\n` +
        'use_lockfile = true\n',
    ),
    providerLock,
    providerSelections,
    terraformIdentity,
    tfplan,
    tfplanJson,
  };
  const buildInput = {
    contract,
    targetContext,
    source: {
      requestedControlSourceSha: SOURCE_SHA,
      sourceActionControlSourceSha: SOURCE_SHA,
      resolvedControlSourceSha: SOURCE_SHA,
      frameworkSourceSha: SOURCE_SHA,
      selectedApplicationSourceSha: lane === 'app' ? selectedSourceSha : null,
    },
    backend,
    execution: {
      pipelineExecutionId: PIPELINE_EXECUTION_ID,
      planActionExecutionId: PLAN_ACTION_EXECUTION_ID,
      buildId,
    },
    terraformIdentity: { terraformVersion: '1.15.8', platform: 'linux_amd64', outdated: false },
    providerIdentity: {
      address: 'registry.terraform.io/hashicorp/aws',
      providerVersion: '6.58.0',
      providerLockSha256: sha256(providerLock),
      providerSelectionsSha256: sha256(providerSelections),
    },
    runtime,
    resolvedInputs,
    files,
  };
  const manifest = buildSavedPlanCorrespondence(buildInput, TARGET.targetKey);
  const manifestBody = Buffer.from(canonicalRecordJson(manifest));
  const { files: exactFiles, ...expected } = buildInput;
  const correspondence = {
    manifestBody,
    expected,
    files: exactFiles,
  };
  const pending =
    lane === 'bootstrap'
      ? { stageName: 'ManualApproval', actionName: resolveBootstrapSavedPlanApprovalAction(TARGET) }
      : lane === 'foundation'
        ? { stageName: 'ManualApproval', actionName: 'ApproveFoundationApply' }
        : gate === 'verifier-preflight'
          ? { stageName: 'VerifierPreflightApproval', actionName: 'ApproveVerifierPreflightApply' }
          : { stageName: 'ManualApproval', actionName: 'ApproveTargetRuntimeApply' };
  const artifactObservation = {
    ...review.artifact,
    metadata: {
      contentLength: 65_536,
      etag: `"${'f'.repeat(32)}"`,
      kmsKeyArn: `arn:${TARGET.partition}:kms:${targetContext.target.region}:${TARGET.accountId}:key/55555555-6666-7777-8888-999999999999`,
      lastModified: '2026-08-14T12:34:56.789Z',
      serverSideEncryption: 'aws:kms' as const,
    },
  };
  const pendingAction = {
    pipelineExecutionId: PIPELINE_EXECUTION_ID,
    ...pending,
    actionExecutionId: ACTION_EXECUTION_ID,
  };
  const reviewerIdentity = {
    Account: TARGET.accountId,
    Arn:
      `arn:${TARGET.partition}:sts::${TARGET.accountId}:assumed-role/` +
      'AWSReservedSSO_AdministratorAccess_0123456789abcdef/reviewer',
    UserId: 'AROABCDEFGHIJKLMNOP:reviewer',
  };

  return { artifactObservation, correspondence, pendingAction, review, reviewerIdentity, targetContext };
}

export function buildSavedPlanFixture(
  options: Parameters<typeof buildSavedPlanFixtureValue>[0] = {},
): ReturnType<typeof buildSavedPlanFixtureValue> {
  return buildSavedPlanFixtureValue(options);
}
