import { createHash } from 'node:crypto';

import { FOUNDATION_CONTRACT_CLOSURE_IDENTITY } from '../foundation-contract.js';
import {
  canonicalRecordJson,
  renderDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  resolveImageSigningIdentity,
  resolveFoundationPublicSubnetException,
} from '../index.js';
import {
  PROVER_ACCEPTED_POINTER_KIND,
  PROVER_CANDIDATE_KIND,
  PROVER_RELEASE_KIND,
  TOOLCHAIN_ACCEPTED_POINTER_KIND,
  TOOLCHAIN_CANDIDATE_KIND,
  TOOLCHAIN_RELEASE_KIND,
  admitReleasePointer,
  admitReleaseRecord,
  deriveReleaseRecordKey,
} from '../release-ledger.js';
import {
  FOUNDATION_ACCEPTANCE_KIND,
  FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND,
  admitTerraformAcceptancePointer,
  admitTerraformAcceptanceRecord,
  deriveTerraformAcceptanceRecordKey,
} from '../terraform-acceptance.js';

const FOUNDATION_SOURCE_SHA = 'a'.repeat(40);
const APP_SOURCE_SHA = 'b'.repeat(40);
const TOOLCHAIN_SOURCE_SHA = 'c'.repeat(40);
const PROVER_SOURCE_SHA = 'd'.repeat(40);
const FOUNDATION_PIPELINE_EXECUTION_ID = '11111111-2222-3333-4444-555555555555';
const FOUNDATION_ACCEPTANCE_ATTEMPT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FOUNDATION_APPROVAL_ACTION_ID = '44444444-5555-6666-7777-888888888888';
const TOOLCHAIN_EXECUTION_ID = '22222222-3333-4444-5555-666666666666';
const PROVER_EXECUTION_ID = '33333333-4444-5555-6666-777777777777';
const FOUNDATION_CONTRACT_HASH = '6'.repeat(64);
const TOOLCHAIN_IMAGE_DIGEST = `sha256:${'7'.repeat(64)}`;
const PROVER_IMAGE_DIGEST = `sha256:${'8'.repeat(64)}`;

function createFixtureAuthority(targetKey: string) {
  const target = resolveAllowedDeploymentTarget(targetKey);
  const foundationAuthority = resolveDeploymentLaneAuthority(target, 'foundation');
  const toolchainAuthority = resolveDeploymentLaneAuthority(target, 'toolchain');
  const proverAuthority = resolveDeploymentLaneAuthority(target, 'prover');
  const signingIdentity = resolveImageSigningIdentity(target);
  const foundationTargetContext = renderDeploymentLaneContext({
    target,
    lane: 'foundation',
    accountId: target.accountId,
    requestedControlSourceSha: FOUNDATION_SOURCE_SHA,
    selectedApplicationSourceSha: FOUNDATION_SOURCE_SHA,
    frameworkSourceSha: FOUNDATION_SOURCE_SHA,
  });
  const stateKmsKeyArn =
    `arn:${target.partition}:kms:${target.region}:${target.accountId}:key/` + '55555555-6666-7777-8888-999999999999';
  const toolchainImageUri =
    `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/` +
    `${toolchainAuthority.names.toolchainRepository}@${TOOLCHAIN_IMAGE_DIGEST}`;
  const proverImageUri =
    `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/` +
    `${proverAuthority.names.proverRepository}@${PROVER_IMAGE_DIGEST}`;

  return {
    target,
    foundationAuthority,
    toolchainAuthority,
    proverAuthority,
    signingIdentity,
    foundationTargetContext,
    stateKmsKeyArn,
    toolchainImageUri,
    proverImageUri,
  };
}
type FixtureAuthority = ReturnType<typeof createFixtureAuthority>;

type ObjectObservation = Readonly<{
  etag: string;
  versionId: string;
}>;

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalRecordJson(value)).digest('hex');
}

function observation(name: string): ObjectObservation {
  return Object.freeze({
    etag: `"${name}-etag"`,
    versionId: `${name}-object-id`,
  });
}

function providerLock(): string {
  return (
    '# This file is maintained automatically by "terraform init".\n' +
    '# Manual edits may be lost in future updates.\n\n' +
    'provider "registry.terraform.io/hashicorp/aws" {\n' +
    '  version     = "6.58.0"\n' +
    '  constraints = "= 6.58.0"\n' +
    '  hashes = [\n' +
    `    "zh:${'1'.repeat(64)}",\n` +
    '  ]\n' +
    '}\n'
  );
}

function foundationNonsecretInputs(fixture: FixtureAuthority) {
  const { foundationTargetContext } = fixture;
  const body = canonicalRecordJson({
    account_alias: foundationTargetContext.target.accountLabel,
    aws_account_id: foundationTargetContext.target.accountId,
    aws_region: foundationTargetContext.target.region,
    deployment_environment: foundationTargetContext.target.environmentId,
    project_name: foundationTargetContext.project.projectId,
    public_hostname_disposition: 'external-dns-acm',
    state_backend_key: foundationTargetContext.root.backendKey,
    state_scope: foundationTargetContext.root.scope,
  });
  return {
    evidenceType: 'terraform-baseline-nonsecret-inputs',
    root: 'foundation',
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

function foundationContract() {
  return Object.freeze({
    closureIdentity: FOUNDATION_CONTRACT_CLOSURE_IDENTITY,
    foundationContractHash: FOUNDATION_CONTRACT_HASH,
  });
}

function foundationNetworking(fixture: FixtureAuthority) {
  const { target } = fixture;
  return Object.freeze({
    vpcId: `vpc-${'1'.repeat(8)}`,
    proverSubnetIds: Object.freeze([`subnet-${'2'.repeat(8)}`, `subnet-${'3'.repeat(8)}`]),
    proverSecurityGroupIds: Object.freeze([`sg-${'4'.repeat(8)}`]),
    networkAuthority: 'foundation-owned' as const,
    publicSubnetException: resolveFoundationPublicSubnetException(target),
  });
}

function foundationImageAuthority(fixture: FixtureAuthority) {
  const { target, signingIdentity } = fixture;
  const registryPrefix = `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/`;
  return Object.freeze({
    repositories: Object.freeze({
      prover: Object.freeze({
        name: signingIdentity.repositories.prover,
        url: `${registryPrefix}${signingIdentity.repositories.prover}`,
      }),
      toolchain: Object.freeze({
        name: signingIdentity.repositories.toolchain,
        url: `${registryPrefix}${signingIdentity.repositories.toolchain}`,
      }),
    }),
    signingProfileName: signingIdentity.signingProfileName,
    signingProfileArn: signingIdentity.signingProfileArn,
    signingRepositoryFilters: Object.freeze([
      Object.freeze({ filterType: 'WILDCARD_MATCH' as const, filter: signingIdentity.repositories.prover }),
    ]),
    tagMutability: 'IMMUTABLE' as const,
    scanOnPush: true as const,
    proverSigningStatusRequired: 'COMPLETE' as const,
    retentionPolicy: 'reference-aware-controller-target-10' as const,
  });
}

function foundationChecks() {
  return Object.freeze(
    [
      'foundation_state_nonempty',
      'source_module_declarations_absent',
      'module_state_resources_absent',
      'malformed_state_resources_absent',
      'undeclared_state_resources_absent',
      'missing_declared_state_resources_absent',
      'disallowed_foundation_resource_types_absent',
      'app_runtime_state_resources_absent',
    ].map((id) => Object.freeze({ id, count: 0 })),
  );
}

function createFoundationAcceptanceRecord(fixture: FixtureAuthority) {
  const { target, foundationTargetContext, stateKmsKeyArn } = fixture;
  const contract = foundationContract();
  const networking = foundationNetworking(fixture);
  const imageAuthority = foundationImageAuthority(fixture);
  const checks = foundationChecks();
  const stateResources = Object.freeze(['aws_ecr_repository.prover', 'aws_ecr_repository.toolchain']);
  const acceptedPlanChecksum = '2'.repeat(64);
  return admitTerraformAcceptanceRecord(
    FOUNDATION_ACCEPTANCE_KIND,
    {
      kind: FOUNDATION_ACCEPTANCE_KIND,
      targetKey: target.targetKey,
      targetContext: foundationTargetContext,
      backend: {
        bucketName: foundationTargetContext.names.terraformStateBucket,
        backendKey: foundationTargetContext.root.backendKey,
        kmsKeyArn: stateKmsKeyArn,
        region: target.region,
      },
      nonsecretInputs: foundationNonsecretInputs(fixture),
      secretReferences: [],
      provider: {
        lock: providerLock(),
        selections: { 'registry.terraform.io/hashicorp/aws': '6.58.0' },
        terraformVersion: '1.15.8',
        platform: 'linux_amd64',
        runtime: {
          evidenceType: 'codebuild-runtime',
          targetKey: target.targetKey,
          lane: 'foundation',
          stateIdentity: foundationTargetContext.root.stateIdentity,
          sourceSha: FOUNDATION_SOURCE_SHA,
          project: {
            key: 'terraformPlanProject',
            name: foundationTargetContext.names.terraformPlanProject,
            arn:
              `arn:${target.partition}:codebuild:${target.region}:${target.accountId}:project/` +
              foundationTargetContext.names.terraformPlanProject,
            buildId: `${foundationTargetContext.names.terraformPlanProject}:${FOUNDATION_PIPELINE_EXECUTION_ID}`,
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
        approvalType: 'foundation-saved-plan-approval',
        stageName: 'ManualApproval',
        actionName: 'ApproveFoundationApply',
        actionExecutionId: FOUNDATION_APPROVAL_ACTION_ID,
        reviewedPlanChecksum: acceptedPlanChecksum,
        approver: `arn:${target.partition}:sts::${target.accountId}:assumed-role/operator/session`,
        approvalTimestamp: '2026-08-14T01:02:03.000Z',
      },
      smoke: {
        result: 'passed',
        evidence: {
          evidenceType: 'foundation-saved-plan',
          manifestType: 'foundation-smoke',
          stateIdentity: foundationTargetContext.root.stateIdentity,
          backendKey: foundationTargetContext.root.backendKey,
          controlSourceSha: FOUNDATION_SOURCE_SHA,
          frameworkSourceSha: FOUNDATION_SOURCE_SHA,
          acceptedPlanChecksum,
          pipelineExecutionId: FOUNDATION_PIPELINE_EXECUTION_ID,
          foundationContract: contract,
          networkingSha256: canonicalSha256(networking),
          imageAuthoritySha256: canonicalSha256(imageAuthority),
          appRuntimeResourcesCreated: false,
          evidenceClass: 'FoundationStateAbsenceOfAppRuntime',
          stateOwnershipVerified: true,
          ecrRetentionControllerVerified: true,
          releaseAuthorityRetentionProtected: true,
          foundationAcceptancePolicyVerified: true,
          acceptedMarkerPath: `accepted-deployments/${foundationTargetContext.root.stateIdentity}`,
          stateOwnership: {
            ownershipType: 'foundation-state',
            stateIdentity: foundationTargetContext.root.stateIdentity,
            sourceSha: FOUNDATION_SOURCE_SHA,
            stateResourcesSha256: '3'.repeat(64),
            foundationStateResourceCount: stateResources.length,
            foundationStateResources: stateResources,
            declaredFoundationResources: stateResources,
            appRuntimeResourcesCreated: false,
            violations: {
              sourceModuleDeclarations: [],
              moduleStateResources: [],
              malformedStateResources: [],
              undeclaredStateResources: [],
              missingDeclaredStateResources: [],
              disallowedFoundationResourceTypes: [],
              appRuntimeStateResources: [],
            },
            checks,
          },
          checks,
        },
      },
      pipelineExecutionId: FOUNDATION_PIPELINE_EXECUTION_ID,
      acceptanceAttemptId: FOUNDATION_ACCEPTANCE_ATTEMPT_ID,
      acceptedAt: '2026-08-14T01:04:05.000Z',
      foundationContract: contract,
      networking,
      imageAuthority,
    },
    target.targetKey,
  );
}

function createFoundationSelection(fixture: FixtureAuthority) {
  const { target, foundationAuthority } = fixture;
  const record = createFoundationAcceptanceRecord(fixture);
  const recordKey = deriveTerraformAcceptanceRecordKey(FOUNDATION_ACCEPTANCE_KIND, record, target.targetKey);
  const pointerKey = `${foundationAuthority.names.terraformBaselinePrefix}/${foundationAuthority.stateIdentity}/current.json`;
  const pointer = admitTerraformAcceptancePointer(
    FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND,
    {
      kind: FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND,
      targetKey: target.targetKey,
      recordKey,
      pipelineExecutionId: record.pipelineExecutionId,
      acceptanceAttemptId: record.acceptanceAttemptId,
      previous: null,
      compareAndSwapEvidenceId: `cas/foundation-acceptance/${record.pipelineExecutionId}/${record.acceptanceAttemptId}`,
    },
    target.targetKey,
  );
  return Object.freeze({
    consumerAuthority: Object.freeze({
      admissionType: 'foundation-app-consumer-contract' as const,
      consumerLane: 'app' as const,
      consumerSourceSha: APP_SOURCE_SHA,
      foundationAcceptanceKey: recordKey,
      foundationAcceptedSourceSha: record.targetContext.source.requestedControlSourceSha,
      closureIdentity: record.foundationContract.closureIdentity,
      foundationContractHash: record.foundationContract.foundationContractHash,
      networking: record.networking,
    }),
    pointerKey,
    pointer,
    pointerObservation: observation('foundation-pointer'),
    recordKey,
    record,
    recordObservation: observation('foundation-record'),
  });
}

function createToolchainCandidateRecord(fixture: FixtureAuthority) {
  const { target, toolchainImageUri } = fixture;
  return admitReleaseRecord(
    TOOLCHAIN_CANDIDATE_KIND,
    {
      kind: TOOLCHAIN_CANDIDATE_KIND,
      targetKey: target.targetKey,
      requestedSourceSha: TOOLCHAIN_SOURCE_SHA,
      sourceActionSourceSha: TOOLCHAIN_SOURCE_SHA,
      resolvedSourceSha: TOOLCHAIN_SOURCE_SHA,
      candidateExecutionId: `toolchain-candidate/${TOOLCHAIN_EXECUTION_ID}`,
      candidateMetadataSha256: '4'.repeat(64),
      imageUri: toolchainImageUri,
      imageTag: `candidate-${TOOLCHAIN_EXECUTION_ID}`,
      imageDigest: TOOLCHAIN_IMAGE_DIGEST,
      risc0Version: '3.0.6',
      rustVersion: '1.97.1',
      rustToolchainTag: 'r0.1.97.0',
      scanStatus: 'PASS',
      criticalHighCount: 0,
      buildApprovalEvidenceId: `toolchain-build/${TOOLCHAIN_EXECUTION_ID}`,
    },
    target.targetKey,
  );
}

function createToolchainSelection(fixture: FixtureAuthority) {
  const { target, toolchainAuthority } = fixture;
  const candidateRecord = createToolchainCandidateRecord(fixture);
  const candidateRecordKey = deriveReleaseRecordKey(TOOLCHAIN_CANDIDATE_KIND, candidateRecord, target.targetKey);
  const releaseRecord = admitReleaseRecord(
    TOOLCHAIN_RELEASE_KIND,
    {
      kind: TOOLCHAIN_RELEASE_KIND,
      targetKey: target.targetKey,
      requestedControlSourceSha: TOOLCHAIN_SOURCE_SHA,
      sourceActionControlSourceSha: TOOLCHAIN_SOURCE_SHA,
      resolvedControlSourceSha: TOOLCHAIN_SOURCE_SHA,
      selectionMode: 'build',
      selectedCandidateKey: candidateRecordKey,
      candidateExecutionId: candidateRecord.candidateExecutionId,
      candidateMetadataSha256: candidateRecord.candidateMetadataSha256,
      imageUri: candidateRecord.imageUri,
      imageTag: candidateRecord.imageTag,
      imageDigest: candidateRecord.imageDigest,
      risc0Version: candidateRecord.risc0Version,
      rustVersion: candidateRecord.rustVersion,
      rustToolchainTag: candidateRecord.rustToolchainTag,
      scanStatus: candidateRecord.scanStatus,
      criticalHighCount: candidateRecord.criticalHighCount,
      buildApprovalEvidenceId: candidateRecord.buildApprovalEvidenceId,
      candidateSelectionApprovalEvidenceId: `toolchain-candidate-selection/${TOOLCHAIN_EXECUTION_ID}`,
      promotionExecutionId: TOOLCHAIN_EXECUTION_ID,
      promotionApprovalEvidenceId: `toolchain-promotion/${TOOLCHAIN_EXECUTION_ID}`,
    },
    target.targetKey,
  );
  const releaseRecordKey = deriveReleaseRecordKey(TOOLCHAIN_RELEASE_KIND, releaseRecord, target.targetKey);
  const pointer = admitReleasePointer(
    TOOLCHAIN_ACCEPTED_POINTER_KIND,
    {
      kind: TOOLCHAIN_ACCEPTED_POINTER_KIND,
      targetKey: target.targetKey,
      recordKey: releaseRecordKey,
      promotionExecutionId: releaseRecord.promotionExecutionId,
      previous: null,
      compareAndSwapEvidenceId: `cas/toolchain/${releaseRecord.promotionExecutionId}`,
    },
    target.targetKey,
  );
  return Object.freeze({
    pointerKey: toolchainAuthority.names.toolchainAcceptedPointerKey,
    pointer,
    pointerObservation: observation('toolchain-pointer'),
    releaseRecordKey,
    releaseRecord,
    releaseRecordObservation: observation('toolchain-release-record'),
    candidateRecordKey,
    candidateRecord,
    candidateRecordObservation: observation('toolchain-candidate-record'),
  });
}

function createProverFoundationAcceptance(foundation: ReturnType<typeof createFoundationSelection>) {
  return Object.freeze({
    recordKey: foundation.recordKey,
    acceptedSourceSha: foundation.consumerAuthority.foundationAcceptedSourceSha,
    closureIdentity: foundation.consumerAuthority.closureIdentity,
    foundationContractHash: foundation.consumerAuthority.foundationContractHash,
  });
}

function createProverCandidateRecord(
  foundation: ReturnType<typeof createFoundationSelection>,
  toolchain: ReturnType<typeof createToolchainSelection>,
  fixture: FixtureAuthority,
) {
  const { target, proverImageUri } = fixture;
  const foundationAcceptance = createProverFoundationAcceptance(foundation);
  return admitReleaseRecord(
    PROVER_CANDIDATE_KIND,
    {
      kind: PROVER_CANDIDATE_KIND,
      targetKey: target.targetKey,
      requestedSourceSha: PROVER_SOURCE_SHA,
      sourceActionSourceSha: PROVER_SOURCE_SHA,
      resolvedSourceSha: PROVER_SOURCE_SHA,
      candidateExecutionId: `prover-candidate/${PROVER_EXECUTION_ID}`,
      candidateMetadataSha256: 'a'.repeat(64),
      selectedToolchainReleaseKey: toolchain.releaseRecordKey,
      selectedToolchainImageUri: toolchain.releaseRecord.imageUri,
      selectedToolchainImageDigest: toolchain.releaseRecord.imageDigest,
      foundationAcceptance,
      imageUri: proverImageUri,
      imageTag: `candidate-${PROVER_EXECUTION_ID}`,
      imageDigest: PROVER_IMAGE_DIGEST,
      expectedImageId: `0x${'b'.repeat(64)}`,
      prePushImageId: `0x${'b'.repeat(64)}`,
      postPushImageId: `0x${'b'.repeat(64)}`,
      methodVersion: 14,
      prePushMethodVersion: 14,
      postPushMethodVersion: 14,
      imageIdVariant: 'default',
      zkvmContractHash: 'c'.repeat(64),
      scanStatus: 'PASS',
      criticalHighCount: 0,
      containerPostureSmokeStatus: 'PASS',
      failureMarkerContractSha256: 'd'.repeat(64),
      failureMarkerSmokeStatus: 'PASS',
      managedSigningStatus: 'COMPLETE',
      buildApprovalEvidenceId: `prover-build/${PROVER_EXECUTION_ID}`,
    },
    target.targetKey,
  );
}

function createProverSelection(
  foundation: ReturnType<typeof createFoundationSelection>,
  toolchain: ReturnType<typeof createToolchainSelection>,
  fixture: FixtureAuthority,
) {
  const { target, proverAuthority } = fixture;
  const candidateRecord = createProverCandidateRecord(foundation, toolchain, fixture);
  const candidateRecordKey = deriveReleaseRecordKey(PROVER_CANDIDATE_KIND, candidateRecord, target.targetKey);
  const releaseRecord = admitReleaseRecord(
    PROVER_RELEASE_KIND,
    {
      kind: PROVER_RELEASE_KIND,
      targetKey: target.targetKey,
      requestedControlSourceSha: PROVER_SOURCE_SHA,
      sourceActionControlSourceSha: PROVER_SOURCE_SHA,
      resolvedControlSourceSha: PROVER_SOURCE_SHA,
      selectionMode: 'build',
      selectedCandidateKey: candidateRecordKey,
      candidateExecutionId: candidateRecord.candidateExecutionId,
      candidateMetadataSha256: candidateRecord.candidateMetadataSha256,
      selectedToolchainReleaseKey: candidateRecord.selectedToolchainReleaseKey,
      selectedToolchainImageUri: candidateRecord.selectedToolchainImageUri,
      selectedToolchainImageDigest: candidateRecord.selectedToolchainImageDigest,
      foundationAcceptance: candidateRecord.foundationAcceptance,
      promotionFoundationAcceptance: candidateRecord.foundationAcceptance,
      imageUri: candidateRecord.imageUri,
      imageTag: candidateRecord.imageTag,
      imageDigest: candidateRecord.imageDigest,
      expectedImageId: candidateRecord.expectedImageId,
      prePushImageId: candidateRecord.prePushImageId,
      postPushImageId: candidateRecord.postPushImageId,
      methodVersion: candidateRecord.methodVersion,
      prePushMethodVersion: candidateRecord.prePushMethodVersion,
      postPushMethodVersion: candidateRecord.postPushMethodVersion,
      imageIdVariant: candidateRecord.imageIdVariant,
      zkvmContractHash: candidateRecord.zkvmContractHash,
      scanStatus: candidateRecord.scanStatus,
      criticalHighCount: candidateRecord.criticalHighCount,
      containerPostureSmokeStatus: candidateRecord.containerPostureSmokeStatus,
      failureMarkerContractSha256: candidateRecord.failureMarkerContractSha256,
      failureMarkerSmokeStatus: candidateRecord.failureMarkerSmokeStatus,
      managedSigningStatus: candidateRecord.managedSigningStatus,
      buildApprovalEvidenceId: candidateRecord.buildApprovalEvidenceId,
      candidateSelectionApprovalEvidenceId: candidateRecord.buildApprovalEvidenceId,
      promotionExecutionId: PROVER_EXECUTION_ID,
      promotionApprovalEvidenceId: `prover-promotion/${PROVER_EXECUTION_ID}`,
    },
    target.targetKey,
  );
  const releaseRecordKey = deriveReleaseRecordKey(PROVER_RELEASE_KIND, releaseRecord, target.targetKey);
  const pointer = admitReleasePointer(
    PROVER_ACCEPTED_POINTER_KIND,
    {
      kind: PROVER_ACCEPTED_POINTER_KIND,
      targetKey: target.targetKey,
      recordKey: releaseRecordKey,
      promotionExecutionId: releaseRecord.promotionExecutionId,
      previous: null,
      compareAndSwapEvidenceId: `cas/prover/${releaseRecord.promotionExecutionId}`,
    },
    target.targetKey,
  );
  return Object.freeze({
    pointerKey: proverAuthority.names.proverAcceptedPointerKey,
    pointer,
    pointerObservation: observation('prover-pointer'),
    releaseRecordKey,
    releaseRecord,
    releaseRecordObservation: observation('prover-release-record'),
    candidateRecordKey,
    candidateRecord,
    candidateRecordObservation: observation('prover-candidate-record'),
  });
}

export type AppReleaseSelectionFixture = Readonly<{
  selectedSourceSha: string;
  foundation: ReturnType<typeof createFoundationSelection>;
  toolchain: ReturnType<typeof createToolchainSelection>;
  prover: ReturnType<typeof createProverSelection>;
}>;

export type SelectedReleaseFacts = Readonly<{
  foundationAcceptanceKey: string;
  foundationContractHash: string;
  proverImageDigest: string;
  proverReleaseKey: string;
  toolchainImageDigest: string;
  toolchainReleaseKey: string;
}>;

export function createAppReleaseSelectionFixture(targetKey = 'stark-dev/develop'): AppReleaseSelectionFixture {
  const fixture = createFixtureAuthority(targetKey);
  const foundation = createFoundationSelection(fixture);
  const toolchain = createToolchainSelection(fixture);
  const prover = createProverSelection(foundation, toolchain, fixture);
  return Object.freeze({ selectedSourceSha: APP_SOURCE_SHA, foundation, toolchain, prover });
}

export function deriveSelectedReleaseFacts(selection: AppReleaseSelectionFixture): SelectedReleaseFacts {
  return Object.freeze({
    foundationAcceptanceKey: selection.foundation.recordKey,
    foundationContractHash: selection.foundation.record.foundationContract.foundationContractHash,
    proverImageDigest: selection.prover.releaseRecord.imageDigest,
    proverReleaseKey: selection.prover.releaseRecordKey,
    toolchainImageDigest: selection.toolchain.releaseRecord.imageDigest,
    toolchainReleaseKey: selection.toolchain.releaseRecordKey,
  });
}
