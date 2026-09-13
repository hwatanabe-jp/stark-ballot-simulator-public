import { describe, expect, it, vi } from 'vitest';
import {
  canonicalRecordJson,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
} from '@stark-ballot/deployment-authority';
import { FOUNDATION_CONTRACT_CLOSURE_IDENTITY } from '../../../packages/deployment-authority/src/foundation-contract.js';
import {
  deriveAppAcceptanceRecordKey,
  projectInitialAppAcceptancePointer,
} from '../../../packages/deployment-authority/src/app-acceptance-ledger.js';
import {
  createAppAcceptanceFixture,
  createProductionAppAcceptanceFixture,
} from '../../../packages/deployment-authority/src/testdata/app-acceptance-ledger-fixture.js';
import {
  PROVER_ACCEPTED_POINTER_KIND,
  PROVER_CANDIDATE_KIND,
  PROVER_RELEASE_KIND,
  TOOLCHAIN_ACCEPTED_POINTER_KIND,
  TOOLCHAIN_CANDIDATE_KIND,
  TOOLCHAIN_RELEASE_KIND,
  deriveReleaseRecordKey,
} from '@stark-ballot/deployment-authority/release-ledger';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  createEcrRetentionAwsDependencies,
  createEcrRetentionProtectionAuthorityReader,
  parseEcrRetentionRuntimeConfig,
  runEcrRetentionBoundary,
  type EcrRetentionAwsOperations,
  type EcrRetentionProtectionAuthority,
} from './index.js';
import type { EcrRetentionEvidence } from './handler.js';

const productionConfiguration = await vi.hoisted(async () => {
  const { productionConfigurationFixture } =
    await import('../../../packages/deployment-authority/src/test-support/deployment-target-fixtures.js');
  return productionConfigurationFixture().configuration;
});
vi.mock('../../../packages/deployment-authority/deployment-targets.json', () => ({ default: productionConfiguration }));
describe.each(['stark-dev/develop', 'stark-prod/main'])('ECR retention target %s', (targetKey) => {
  const target = resolveAllowedDeploymentTarget(targetKey);
  const foundation = resolveDeploymentLaneAuthority(target, 'foundation');
  const SUBJECT_MANIFEST_MEDIA_TYPE = 'application/vnd.docker.distribution.manifest.v2+json';
  const SUBJECT_ARTIFACT_MEDIA_TYPE = 'application/vnd.docker.container.image.v1+json';
  const REFERRER_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
  const REFERRER_ARTIFACT_MEDIA_TYPE = 'application/vnd.cncf.notary.signature';
  const TOOLCHAIN_DIGEST = `sha256:${'1'.repeat(64)}`;
  const PROVER_DIGEST = `sha256:${'2'.repeat(64)}`;
  const SIGNATURE_DIGEST = `sha256:${'3'.repeat(64)}`;
  const RETIRED_APP_DEPLOYMENT_RECORD_PREFIX = 'deployments/develop';

  function env(): NodeJS.ProcessEnv {
    return {
      AWS_REGION: target.region,
      TARGET_KEY: target.targetKey,
      EXPECTED_ACCOUNT_ID: target.accountId,
      EXPECTED_REGION: target.region,
      EXPECTED_SCHEDULE_ARN: `arn:aws:events:${target.region}:${target.accountId}:rule/${foundation.names.ecrRetentionSchedule}`,
      TOOLCHAIN_REPOSITORY_NAME: foundation.names.toolchainRepository,
      PROVER_REPOSITORY_NAME: foundation.names.proverRepository,
      RELEASE_AUTHORITY_BUCKET: foundation.names.releaseManifestBucket,
      APP_ACCEPTED_AUTHORITY_BUCKET: foundation.names.appRetainedArtifactBucket,
      APP_ACCEPTED_AUTHORITY_KEY: foundation.names.acceptedDeploymentPointerKey,
      APP_PIPELINE_NAME: resolveDeploymentLaneAuthority(target, 'app').names.pipeline,
      FOUNDATION_PIPELINE_NAME: foundation.names.pipeline,
      TOOLCHAIN_ACCEPTED_POINTER_KEY: foundation.names.toolchainAcceptedPointerKey,
      PROVER_ACCEPTED_POINTER_KEY: foundation.names.proverAcceptedPointerKey,
      TOOLCHAIN_PIPELINE_NAME: resolveDeploymentLaneAuthority(target, 'toolchain').names.pipeline,
      PROVER_PIPELINE_NAME: resolveDeploymentLaneAuthority(target, 'prover').names.pipeline,
      TOOLCHAIN_CANDIDATE_PROJECT_NAME: foundation.names.toolchainCandidateProject,
      PROVER_CANDIDATE_PROJECT_NAME: foundation.names.proverCandidateProject,
      PROVER_STATE_MACHINE_ARN: `arn:aws:states:${target.region}:${target.accountId}:stateMachine:${foundation.names.finalizationStateMachine}`,
      PROVER_ECS_CLUSTER_NAME: foundation.names.proverEcsCluster,
      PROVER_ECS_TASK_FAMILY: foundation.names.proverEcsTaskFamily,
      RETAINED_SUBJECT_COUNT: '10',
    };
  }

  function operations(): EcrRetentionAwsOperations {
    return {
      batchDeleteImage: vi.fn(() => Promise.resolve({ imageIds: [], failures: [] })),
      batchGetBuilds: vi.fn(() => Promise.resolve({ builds: [] })),
      describeImages: vi.fn(() => Promise.resolve({ imageDetails: [] })),
      describeStateMachine: vi.fn(() => Promise.resolve({ definition: '{}' })),
      describeTaskDefinition: vi.fn(() => Promise.resolve({ taskDefinition: {} })),
      getCallerIdentity: vi.fn(() => Promise.resolve({ Account: target.accountId })),
      getObject: vi.fn(() => Promise.resolve({ Body: sdkStream(new Uint8Array()), VersionId: 'version' })),
      listBuildsForProject: vi.fn(() => Promise.resolve({ ids: [] })),
      listExecutions: vi.fn(() => Promise.resolve({ executions: [] })),
      listImageReferrers: vi.fn(() => Promise.resolve({ referrers: [] })),
      listPipelineExecutions: vi.fn(() => Promise.resolve({ pipelineExecutionSummaries: [] })),
      listTasks: vi.fn(() => Promise.resolve({ taskArns: [] })),
    };
  }

  function authority(): EcrRetentionProtectionAuthority {
    return {
      authoritySnapshotSha256: 'a'.repeat(64),
      protectedDigests: {
        prover: [PROVER_DIGEST],
        toolchain: [TOOLCHAIN_DIGEST],
      },
    };
  }

  function subject(repositoryName: string, digest: string, pushedAt: Date) {
    return {
      artifactMediaType: SUBJECT_ARTIFACT_MEDIA_TYPE,
      imageDigest: digest,
      imageManifestMediaType: SUBJECT_MANIFEST_MEDIA_TYPE,
      imagePushedAt: pushedAt,
      imageStatus: 'ACTIVE' as const,
      registryId: target.accountId,
      repositoryName,
    };
  }

  function signature(repositoryName: string) {
    return {
      artifactMediaType: REFERRER_ARTIFACT_MEDIA_TYPE,
      imageDigest: SIGNATURE_DIGEST,
      imageManifestMediaType: REFERRER_MANIFEST_MEDIA_TYPE,
      imagePushedAt: new Date('2026-02-01T00:00:00.000Z'),
      imageStatus: 'ACTIVE' as const,
      registryId: target.accountId,
      repositoryName,
    };
  }

  function sha256Bytes(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  function sdkStream(bytes: Uint8Array) {
    return Object.assign(Readable.from([bytes]), {
      transformToByteArray: () => Promise.resolve(bytes),
      transformToString: () => Promise.resolve(new TextDecoder().decode(bytes)),
      transformToWebStream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
    });
  }

  function imageUri(repositoryName: string, digest: string): string {
    return `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${repositoryName}@${digest}`;
  }

  type StoredAuthorityObject = {
    Body: Uint8Array | undefined;
    ContentLength: number | undefined;
    ETag: string | undefined;
    VersionId: string | undefined;
  };

  function authorityObjectKey(bucket: string, key: string, versionId?: string): string {
    return `${bucket}\0${key}\0${versionId ?? ''}`;
  }

  type ProtectionAuthorityFixture = ReturnType<typeof protectionAuthorityFixture>;

  function validStateMachineResponse(fixture: ProtectionAuthorityFixture) {
    const taskDefinitionArn =
      `arn:aws:ecs:${target.region}:${target.accountId}:task-definition/` + `${fixture.config.ecsTaskFamily}:42`;
    return {
      definition: JSON.stringify({
        States: {
          RunProver: {
            Parameters: {
              Cluster: `arn:aws:ecs:${target.region}:${target.accountId}:cluster/${fixture.config.ecsClusterName}`,
              TaskDefinition: taskDefinitionArn,
            },
            Resource: 'arn:aws:states:::ecs:runTask.sync',
            Type: 'Task',
          },
        },
      }),
      stateMachineArn: fixture.config.stateMachineArn,
      status: 'ACTIVE',
    };
  }

  function validTaskDefinitionResponse(fixture: ProtectionAuthorityFixture) {
    const taskDefinitionArn =
      `arn:aws:ecs:${target.region}:${target.accountId}:task-definition/` + `${fixture.config.ecsTaskFamily}:42`;
    return {
      taskDefinition: {
        containerDefinitions: [
          {
            image: imageUri(fixture.config.handler.repositories.prover, fixture.liveProverDigest),
            name: 'prover',
          },
        ],
        family: fixture.config.ecsTaskFamily,
        revision: 42,
        status: 'ACTIVE',
        taskDefinitionArn,
      },
    };
  }

  function accessorRecord(
    fields: Readonly<Record<string, unknown>>,
    key: string,
    value: unknown,
    onRead: () => void,
  ): Record<string, unknown> {
    const record = { ...fields };
    Object.defineProperty(record, key, {
      enumerable: true,
      get() {
        onRead();
        return value;
      },
    });
    return record;
  }

  function trappedProxy<T extends object>(value: T, onTrap: () => void): T {
    return new Proxy(value, {
      get(targetValue, key, receiver) {
        onTrap();
        return Reflect.get(targetValue, key, receiver) as unknown;
      },
      getOwnPropertyDescriptor(targetValue, key) {
        onTrap();
        return Reflect.getOwnPropertyDescriptor(targetValue, key);
      },
      getPrototypeOf(targetValue) {
        onTrap();
        return Reflect.getPrototypeOf(targetValue);
      },
      ownKeys(targetValue) {
        onTrap();
        return Reflect.ownKeys(targetValue);
      },
    });
  }

  function protectionAuthorityFixture() {
    const aws = operations();
    const config = parseEcrRetentionRuntimeConfig(env());
    const stored = new Map<string, StoredAuthorityObject>();
    const putImmutable = (bucket: string, key: string, versionId: string, value: unknown) => {
      const Body = new TextEncoder().encode(canonicalRecordJson(value));
      const reference = { key, sha256: sha256Bytes(Body), versionId };
      stored.set(authorityObjectKey(bucket, key, versionId), {
        Body,
        ContentLength: Body.byteLength,
        ETag: `"${versionId}-etag"`,
        VersionId: versionId,
      });
      return reference;
    };
    const putCurrent = (bucket: string, key: string, versionId: string, value: unknown) => {
      const Body = new TextEncoder().encode(canonicalRecordJson(value));
      stored.set(authorityObjectKey(bucket, key), {
        Body,
        ContentLength: Body.byteLength,
        ETag: `"${versionId}-etag"`,
        VersionId: versionId,
      });
    };

    const toolchainDigests = ['4', '5', '6', '7'].map((value) => `sha256:${value.repeat(64)}`);
    const proverDigests = ['8', '9', 'a'].map((value) => `sha256:${value.repeat(64)}`);
    const liveProverDigest = `sha256:${'b'.repeat(64)}`;
    const candidateExecutionId = '11111111-2222-3333-4444-555555555555';
    const promotionExecutionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const selectedToolchainDigest = toolchainDigests[0];
    if (selectedToolchainDigest === undefined) throw new Error('invalid test fixture');
    const candidateRecord = {
      kind: TOOLCHAIN_CANDIDATE_KIND,
      targetKey: target.targetKey,
      requestedSourceSha: 'c'.repeat(40),
      sourceActionSourceSha: 'c'.repeat(40),
      resolvedSourceSha: 'c'.repeat(40),
      candidateExecutionId: `toolchain-candidate/${candidateExecutionId}`,
      candidateMetadataSha256: 'd'.repeat(64),
      imageUri: imageUri(config.handler.repositories.toolchain, selectedToolchainDigest),
      imageTag: `candidate-${candidateExecutionId}`,
      imageDigest: selectedToolchainDigest,
      risc0Version: '3.0.3',
      rustVersion: '1.93.1',
      rustToolchainTag: '1.93.1',
      scanStatus: 'PASS',
      criticalHighCount: 0,
      buildApprovalEvidenceId: `toolchain-build/${candidateExecutionId}`,
    };
    const acceptedToolchainCandidateKey = deriveReleaseRecordKey(TOOLCHAIN_CANDIDATE_KIND, candidateRecord, targetKey);
    const acceptedToolchainCandidateReference = putImmutable(
      config.releaseAuthorityBucket,
      acceptedToolchainCandidateKey,
      'accepted-toolchain-candidate-version',
      candidateRecord,
    );
    const releaseRecord = {
      kind: TOOLCHAIN_RELEASE_KIND,
      targetKey: target.targetKey,
      requestedControlSourceSha: 'e'.repeat(40),
      sourceActionControlSourceSha: 'e'.repeat(40),
      resolvedControlSourceSha: 'e'.repeat(40),
      selectionMode: 'existing',
      selectedCandidateKey: acceptedToolchainCandidateKey,
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
      candidateSelectionApprovalEvidenceId: `toolchain-candidate-selection/${promotionExecutionId}`,
      promotionExecutionId,
      promotionApprovalEvidenceId: `toolchain-promotion/${promotionExecutionId}`,
    };
    const acceptedToolchainReleaseKey = deriveReleaseRecordKey(TOOLCHAIN_RELEASE_KIND, releaseRecord, targetKey);
    const acceptedToolchainReleaseReference = putImmutable(
      config.releaseAuthorityBucket,
      acceptedToolchainReleaseKey,
      'accepted-toolchain-release-version',
      releaseRecord,
    );
    const proverCandidateExecutionId = '22222222-3333-4444-5555-666666666666';
    const proverPromotionExecutionId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const currentProverDigest = proverDigests[0];
    if (currentProverDigest === undefined) throw new Error('invalid test fixture');
    const foundationAcceptance = {
      recordKey:
        `${foundation.names.terraformBaselinePrefix}/${foundation.stateIdentity}/acceptances/` +
        `${'1'.repeat(64)}.json`,
      acceptedSourceSha: 'f'.repeat(40),
      closureIdentity: FOUNDATION_CONTRACT_CLOSURE_IDENTITY,
      foundationContractHash: '6'.repeat(64),
    };
    const proverCandidateRecord = {
      kind: PROVER_CANDIDATE_KIND,
      targetKey: target.targetKey,
      requestedSourceSha: 'f'.repeat(40),
      sourceActionSourceSha: 'f'.repeat(40),
      resolvedSourceSha: 'f'.repeat(40),
      candidateExecutionId: `prover-candidate/${proverCandidateExecutionId}`,
      candidateMetadataSha256: '2'.repeat(64),
      selectedToolchainReleaseKey: acceptedToolchainReleaseKey,
      selectedToolchainImageUri: releaseRecord.imageUri,
      selectedToolchainImageDigest: releaseRecord.imageDigest,
      foundationAcceptance,
      imageUri: imageUri(config.handler.repositories.prover, currentProverDigest),
      imageTag: `candidate-${proverCandidateExecutionId}`,
      imageDigest: currentProverDigest,
      expectedImageId: `0x${'3'.repeat(64)}`,
      prePushImageId: `0x${'3'.repeat(64)}`,
      postPushImageId: `0x${'3'.repeat(64)}`,
      methodVersion: 13,
      prePushMethodVersion: 13,
      postPushMethodVersion: 13,
      imageIdVariant: 'default',
      zkvmContractHash: '4'.repeat(64),
      scanStatus: 'PASS',
      criticalHighCount: 0,
      containerPostureSmokeStatus: 'PASS',
      failureMarkerContractSha256: '5'.repeat(64),
      failureMarkerSmokeStatus: 'PASS',
      managedSigningStatus: 'COMPLETE',
      buildApprovalEvidenceId: `prover-build/${proverCandidateExecutionId}`,
    };
    const acceptedProverCandidateKey = deriveReleaseRecordKey(PROVER_CANDIDATE_KIND, proverCandidateRecord, targetKey);
    const acceptedProverCandidateReference = putImmutable(
      config.releaseAuthorityBucket,
      acceptedProverCandidateKey,
      'accepted-prover-candidate-version',
      proverCandidateRecord,
    );
    const proverReleaseRecord = {
      ...proverCandidateRecord,
      kind: PROVER_RELEASE_KIND,
      requestedControlSourceSha: 'a'.repeat(40),
      sourceActionControlSourceSha: 'a'.repeat(40),
      resolvedControlSourceSha: 'a'.repeat(40),
      selectionMode: 'existing',
      selectedCandidateKey: acceptedProverCandidateKey,
      promotionFoundationAcceptance: foundationAcceptance,
      candidateSelectionApprovalEvidenceId: `prover-candidate-selection/${proverPromotionExecutionId}`,
      promotionExecutionId: proverPromotionExecutionId,
      promotionApprovalEvidenceId: `prover-promotion/${proverPromotionExecutionId}`,
    };
    delete (proverReleaseRecord as Partial<typeof proverReleaseRecord>).requestedSourceSha;
    delete (proverReleaseRecord as Partial<typeof proverReleaseRecord>).sourceActionSourceSha;
    delete (proverReleaseRecord as Partial<typeof proverReleaseRecord>).resolvedSourceSha;
    const acceptedProverReleaseKey = deriveReleaseRecordKey(PROVER_RELEASE_KIND, proverReleaseRecord, targetKey);
    const acceptedProverReleaseReference = putImmutable(
      config.releaseAuthorityBucket,
      acceptedProverReleaseKey,
      'accepted-prover-release-version',
      proverReleaseRecord,
    );
    const appAcceptances: Readonly<Record<string, unknown>>[] = Array.from({ length: 9 }, (_, index) => ({
      ...(target.environmentId === 'main' ? createProductionAppAcceptanceFixture() : createAppAcceptanceFixture()),
      acceptedAt: `2026-08-14T01:04:${String(index + 5).padStart(2, '0')}.000Z`,
    }));
    const retainedAppReleaseAuthority = appAcceptances[0]?.['releaseAuthority'];
    if (
      retainedAppReleaseAuthority === null ||
      typeof retainedAppReleaseAuthority !== 'object' ||
      Array.isArray(retainedAppReleaseAuthority)
    ) {
      throw new Error('invalid retained App release-authority fixture');
    }
    const retainedAppProverImage = (retainedAppReleaseAuthority as Record<string, unknown>)['proverImage'];
    if (
      retainedAppProverImage === null ||
      typeof retainedAppProverImage !== 'object' ||
      Array.isArray(retainedAppProverImage)
    ) {
      throw new Error('invalid retained App Prover-image fixture');
    }
    const retainedAppProverDigest = (retainedAppProverImage as Record<string, unknown>)['imageDigest'];
    if (typeof retainedAppProverDigest !== 'string') {
      throw new Error('invalid retained App Prover-digest fixture');
    }
    const appAcceptanceReferences = appAcceptances.map((record, index) =>
      putImmutable(
        config.appAcceptedAuthorityBucket,
        deriveAppAcceptanceRecordKey(record, targetKey),
        `app-acceptance-version-${index}`,
        record,
      ),
    );
    const appPointer = projectInitialAppAcceptancePointer(
      {
        history: appAcceptanceReferences.map((reference) => reference.key),
        predecessor: {
          etag: 'captured-old-pointer-etag',
          versionId: 'captured-old-pointer-version',
        },
      },
      targetKey,
    );
    const oldDeploymentRecordKey = `${RETIRED_APP_DEPLOYMENT_RECORD_PREFIX}/${'d'.repeat(40)}/${'e'.repeat(64)}.json`;
    const toolchainPointer = {
      kind: TOOLCHAIN_ACCEPTED_POINTER_KIND,
      targetKey: target.targetKey,
      recordKey: acceptedToolchainReleaseKey,
      promotionExecutionId,
      previous: null,
      compareAndSwapEvidenceId: `cas/toolchain/${promotionExecutionId}`,
    };
    const proverPointer = {
      kind: PROVER_ACCEPTED_POINTER_KIND,
      targetKey: target.targetKey,
      recordKey: acceptedProverReleaseKey,
      promotionExecutionId: proverPromotionExecutionId,
      previous: null,
      compareAndSwapEvidenceId: `cas/prover/${proverPromotionExecutionId}`,
    };
    putCurrent(
      config.releaseAuthorityBucket,
      config.acceptedPointerKeys.toolchain,
      'toolchain-pointer-current-version',
      toolchainPointer,
    );
    putCurrent(
      config.releaseAuthorityBucket,
      config.acceptedPointerKeys.prover,
      'prover-pointer-current-version',
      proverPointer,
    );
    putCurrent(
      config.appAcceptedAuthorityBucket,
      config.appAcceptedAuthorityKey,
      'app-authority-current-version',
      appPointer,
    );

    vi.mocked(aws.getObject).mockImplementation((input) => {
      const requestedKey = authorityObjectKey(input.Bucket ?? '', input.Key ?? '', input.VersionId);
      let result = stored.get(requestedKey);
      if (result === undefined && input.VersionId === undefined) {
        const prefix = authorityObjectKey(input.Bucket ?? '', input.Key ?? '');
        const matches = [...stored.entries()].filter(([key]) => key.startsWith(prefix) && key !== prefix);
        if (matches.length === 1) result = matches[0]?.[1];
      }
      if (result === undefined) return Promise.reject(new Error('unexpected test S3 object'));
      return Promise.resolve({
        ...(result.Body === undefined ? {} : { Body: sdkStream(result.Body) }),
        ...(result.ContentLength === undefined ? {} : { ContentLength: result.ContentLength }),
        ...(result.ETag === undefined ? {} : { ETag: result.ETag }),
        ...(result.VersionId === undefined ? {} : { VersionId: result.VersionId }),
      });
    });
    const taskDefinitionArn = `arn:aws:ecs:${target.region}:${target.accountId}:task-definition/${config.ecsTaskFamily}:42`;
    vi.mocked(aws.describeStateMachine).mockResolvedValue({
      stateMachineArn: config.stateMachineArn,
      status: 'ACTIVE',
      definition: JSON.stringify({
        States: {
          RunProver: {
            Parameters: {
              Cluster: `arn:aws:ecs:${target.region}:${target.accountId}:cluster/${config.ecsClusterName}`,
              TaskDefinition: taskDefinitionArn,
            },
            Resource: 'arn:aws:states:::ecs:runTask.sync',
            Type: 'Task',
          },
        },
      }),
    });
    vi.mocked(aws.describeTaskDefinition).mockResolvedValue({
      taskDefinition: {
        containerDefinitions: [
          {
            image: imageUri(config.handler.repositories.prover, liveProverDigest),
            name: 'prover',
          },
        ],
        family: config.ecsTaskFamily,
        revision: 42,
        status: 'ACTIVE',
        taskDefinitionArn,
      },
    });
    return {
      appAcceptanceReferences,
      appPointer,
      appPointerStorageKey: authorityObjectKey(config.appAcceptedAuthorityBucket, config.appAcceptedAuthorityKey),
      aws,
      config,
      currentToolchainPointerStorageKey: authorityObjectKey(
        config.releaseAuthorityBucket,
        config.acceptedPointerKeys.toolchain,
      ),
      liveProverDigest,
      releaseRecord,
      reader: createEcrRetentionProtectionAuthorityReader(aws, config),
      stored,
      acceptedProverCandidateReference,
      acceptedProverReleaseReference,
      acceptedToolchainCandidateReference,
      acceptedToolchainReleaseReference,
      oldDeploymentRecordKey,
      protectedToolchainDigests: [toolchainDigests[0], TOOLCHAIN_DIGEST],
      protectedProverDigests: [proverDigests[0], retainedAppProverDigest, liveProverDigest],
    };
  }

  describe('ECR retention runtime config', () => {
    it('admits only the exact target authority, current region, and daily schedule ARN', () => {
      const config = parseEcrRetentionRuntimeConfig(env());

      expect(config.handler.expectedScheduleArn).toBe(
        `arn:aws:events:${target.region}:${target.accountId}:rule/${foundation.names.ecrRetentionSchedule}`,
      );
      expect(config.stateMachineArn).toContain(foundation.names.finalizationStateMachine);
    });

    it.each([
      ['AWS_REGION', 'us-east-1'],
      ['TARGET_KEY', targetKey === 'stark-dev/develop' ? 'stark-prod/main' : 'stark-dev/develop'],
      ['RETAINED_SUBJECT_COUNT', '11'],
      ['EXPECTED_SCHEDULE_ARN', `${env()['EXPECTED_SCHEDULE_ARN']}-other`],
    ])('rejects an altered %s', (key, value) => {
      expect(() => parseEcrRetentionRuntimeConfig({ ...env(), [key]: value })).toThrow();
    });
  });

  describe('ECR retention protection authority', () => {
    it('protects accepted ledger releases, retained App history, and the live Prover task image', async () => {
      const fixture = protectionAuthorityFixture();

      const result = await fixture.reader();

      expect(result.protectedDigests).toEqual({
        prover: [...fixture.protectedProverDigests].sort(),
        toolchain: [...fixture.protectedToolchainDigests].sort(),
      });
      expect(result.authoritySnapshotSha256).toMatch(/^[0-9a-f]{64}$/u);
      for (const reference of [
        fixture.acceptedToolchainCandidateReference,
        fixture.acceptedToolchainReleaseReference,
        fixture.acceptedProverCandidateReference,
        fixture.acceptedProverReleaseReference,
      ]) {
        expect(fixture.aws.getObject).toHaveBeenCalledWith({
          Bucket: fixture.config.releaseAuthorityBucket,
          ExpectedBucketOwner: target.accountId,
          Key: reference.key,
        });
      }
      expect(fixture.aws.getObject).toHaveBeenCalledWith({
        Bucket: fixture.config.appAcceptedAuthorityBucket,
        ExpectedBucketOwner: target.accountId,
        Key: fixture.config.appAcceptedAuthorityKey,
      });
      for (const reference of fixture.appAcceptanceReferences) {
        expect(fixture.aws.getObject).toHaveBeenCalledWith({
          Bucket: fixture.config.appAcceptedAuthorityBucket,
          ExpectedBucketOwner: target.accountId,
          Key: reference.key,
        });
      }
      expect(fixture.aws.getObject).not.toHaveBeenCalledWith(
        expect.objectContaining({
          Bucket: fixture.config.releaseAuthorityBucket,
          Key: fixture.oldDeploymentRecordKey,
        }),
      );
      expect(
        vi
          .mocked(fixture.aws.getObject)
          .mock.calls.some(
            ([input]) =>
              input.Bucket === fixture.config.releaseAuthorityBucket &&
              input.Key?.startsWith(`${RETIRED_APP_DEPLOYMENT_RECORD_PREFIX}/`) === true,
          ),
      ).toBe(false);
      expect(fixture.aws.batchDeleteImage).not.toHaveBeenCalled();
      expect(fixture.aws.describeTaskDefinition).toHaveBeenCalledWith({
        taskDefinition: `arn:aws:ecs:${target.region}:${target.accountId}:task-definition/${fixture.config.ecsTaskFamily}:42`,
      });
    });

    it('rejects the retired accepted-deployments pointer shape', async () => {
      const fixture = protectionAuthorityFixture();
      const object = fixture.stored.get(fixture.appPointerStorageKey);
      if (object === undefined) throw new Error('missing test object');
      object.Body = new TextEncoder().encode(canonicalRecordJson({ acceptedDeployments: [] }));
      object.ContentLength = object.Body.byteLength;

      await expect(fixture.reader()).rejects.toThrow(/App current acceptance pointer/iu);
    });

    it('binds the pointer generation to its complete history and compare-and-swap evidence', async () => {
      const fixture = protectionAuthorityFixture();
      const object = fixture.stored.get(fixture.appPointerStorageKey);
      if (object === undefined) throw new Error('missing test object');
      object.Body = new TextEncoder().encode(
        canonicalRecordJson({ ...fixture.appPointer, generation: fixture.appPointer.generation + 1 }),
      );
      object.ContentLength = object.Body.byteLength;

      await expect(fixture.reader()).rejects.toThrow(/compare-and-swap/iu);
    });

    it.each([
      {
        expected: 'ETag is invalid',
        mutate: (object: StoredAuthorityObject) => {
          object.ETag = undefined;
        },
        name: 'missing ETag',
      },
      {
        expected: 'valid opaque S3 VersionId',
        mutate: (object: StoredAuthorityObject) => {
          object.VersionId = undefined;
        },
        name: 'missing VersionId',
      },
    ])('requires exact target App pointer coordinates for $name', async ({ expected, mutate }) => {
      const fixture = protectionAuthorityFixture();
      const object = fixture.stored.get(fixture.appPointerStorageKey);
      if (object === undefined) throw new Error('missing test object');
      mutate(object);

      await expect(fixture.reader()).rejects.toThrow(expected);
    });

    it('rejects a proxied operation port before invoking any proxy trap', () => {
      const fixture = protectionAuthorityFixture();
      let proxyTraps = 0;
      const proxied = new Proxy(fixture.aws, {
        get(targetValue, key, receiver) {
          proxyTraps += 1;
          return Reflect.get(targetValue, key, receiver) as unknown;
        },
        getOwnPropertyDescriptor(targetValue, key) {
          proxyTraps += 1;
          return Reflect.getOwnPropertyDescriptor(targetValue, key);
        },
        getPrototypeOf(targetValue) {
          proxyTraps += 1;
          return Reflect.getPrototypeOf(targetValue);
        },
        ownKeys(targetValue) {
          proxyTraps += 1;
          return Reflect.ownKeys(targetValue);
        },
      });

      expect(() => createEcrRetentionProtectionAuthorityReader(proxied, fixture.config)).toThrow(/proxy/iu);
      expect(proxyTraps).toBe(0);
    });

    it('rejects a thenable get-object result without reading its then accessor', async () => {
      const fixture = protectionAuthorityFixture();
      let thenReads = 0;
      const thenable = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(thenable, 'then', {
        enumerable: true,
        get() {
          thenReads += 1;
          return undefined;
        },
      });
      vi.mocked(fixture.aws.getObject).mockImplementation(() => thenable as never);

      const resolution = fixture.reader();
      void resolution.catch(() => undefined);
      expect(thenReads).toBe(0);
      await expect(resolution).rejects.toThrow(/getObject.*result|promise shell/iu);
      expect(thenReads).toBe(0);
    });

    it.each([
      {
        exactBytes: 64 * 1024,
        name: 'App current pointer',
        select: (fixture: ProtectionAuthorityFixture) => {
          const object = fixture.stored.get(fixture.appPointerStorageKey);
          if (object === undefined) throw new Error('missing App pointer test object');
          return object;
        },
      },
      {
        exactBytes: 8 * 1024 * 1024,
        name: 'App acceptance record',
        select: (fixture: ProtectionAuthorityFixture) => {
          const reference = fixture.appAcceptanceReferences[0];
          if (reference === undefined) throw new Error('missing App acceptance test reference');
          const object = fixture.stored.get(
            authorityObjectKey(fixture.config.appAcceptedAuthorityBucket, reference.key, reference.versionId),
          );
          if (object === undefined) throw new Error('missing App acceptance test object');
          return object;
        },
      },
      {
        exactBytes: 1024 * 1024,
        name: 'release-ledger object',
        select: (fixture: ProtectionAuthorityFixture) => {
          const object = fixture.stored.get(fixture.currentToolchainPointerStorageKey);
          if (object === undefined) throw new Error('missing release-ledger test object');
          return object;
        },
      },
    ])('applies the exact distinct byte bound to the $name', async ({ exactBytes, select }) => {
      const exactFixture = protectionAuthorityFixture();
      const exactObject = select(exactFixture);
      exactObject.Body = new Uint8Array(exactBytes).fill(0x20);
      exactObject.ContentLength = exactBytes;

      await expect(exactFixture.reader()).rejects.toThrow('body is not valid JSON');

      const oversizedFixture = protectionAuthorityFixture();
      const oversizedObject = select(oversizedFixture);
      oversizedObject.Body = new Uint8Array(exactBytes + 1).fill(0x20);
      oversizedObject.ContentLength = exactBytes + 1;

      await expect(oversizedFixture.reader()).rejects.toThrow('ContentLength is invalid');
    });

    it('detaches a direct authority body during synchronous port admission', async () => {
      const fixture = protectionAuthorityFixture();
      const stored = fixture.stored.get(fixture.currentToolchainPointerStorageKey);
      if (stored?.Body === undefined || stored.ContentLength === undefined)
        throw new Error('missing pointer test object');
      const directBody = Uint8Array.from(stored.Body);
      const original = vi.mocked(fixture.aws.getObject).getMockImplementation();
      if (original === undefined) throw new Error('missing getObject test implementation');
      vi.mocked(fixture.aws.getObject).mockImplementation((input) => {
        if (
          input.Bucket === fixture.config.releaseAuthorityBucket &&
          input.Key === fixture.config.acceptedPointerKeys.toolchain
        ) {
          return {
            Body: directBody,
            ContentLength: directBody.byteLength,
            ETag: stored.ETag,
            VersionId: stored.VersionId,
          } as never;
        }
        return original(input);
      });

      const resolution = fixture.reader();
      directBody.fill(0x20);

      await expect(resolution).resolves.toMatchObject({
        protectedDigests: {
          prover: [...fixture.protectedProverDigests].sort(),
          toolchain: [...fixture.protectedToolchainDigests].sort(),
        },
      });
    });

    it('detaches each streamed authority chunk before the producer can mutate it', async () => {
      const fixture = protectionAuthorityFixture();
      const stored = fixture.stored.get(fixture.currentToolchainPointerStorageKey);
      if (stored?.Body === undefined || stored.ContentLength === undefined)
        throw new Error('missing pointer test object');
      const original = vi.mocked(fixture.aws.getObject).getMockImplementation();
      if (original === undefined) throw new Error('missing getObject test implementation');
      vi.mocked(fixture.aws.getObject).mockImplementation((input) => {
        if (
          input.Bucket !== fixture.config.releaseAuthorityBucket ||
          input.Key !== fixture.config.acceptedPointerKeys.toolchain
        ) {
          return original(input);
        }
        const bytes = Uint8Array.from(stored.Body ?? []);
        const Body = (async function* mutatingAuthorityBody() {
          yield bytes;
          await Promise.resolve();
          bytes.fill(0x20);
        })();
        return {
          Body,
          ContentLength: bytes.byteLength,
          ETag: stored.ETag,
          VersionId: stored.VersionId,
        } as never;
      });

      await expect(fixture.reader()).resolves.toMatchObject({
        protectedDigests: {
          prover: [...fixture.protectedProverDigests].sort(),
          toolchain: [...fixture.protectedToolchainDigests].sort(),
        },
      });
    });

    it('invokes each authority-read port with the exact inert receiver', async () => {
      const fixture = protectionAuthorityFixture();
      const receivers: Record<'describeStateMachine' | 'describeTaskDefinition' | 'getObject', unknown[]> = {
        describeStateMachine: [],
        describeTaskDefinition: [],
        getObject: [],
      };
      const originalGetObject = vi.mocked(fixture.aws.getObject).getMockImplementation();
      const originalDescribeStateMachine = vi.mocked(fixture.aws.describeStateMachine).getMockImplementation();
      const originalDescribeTaskDefinition = vi.mocked(fixture.aws.describeTaskDefinition).getMockImplementation();
      if (
        originalGetObject === undefined ||
        originalDescribeStateMachine === undefined ||
        originalDescribeTaskDefinition === undefined
      ) {
        throw new Error('missing authority-read test implementation');
      }
      vi.mocked(fixture.aws.getObject).mockImplementation(function (this: unknown, input) {
        receivers.getObject.push(this);
        return originalGetObject(input);
      });
      vi.mocked(fixture.aws.describeStateMachine).mockImplementation(function (this: unknown, input) {
        receivers.describeStateMachine.push(this);
        return originalDescribeStateMachine(input);
      });
      vi.mocked(fixture.aws.describeTaskDefinition).mockImplementation(function (this: unknown, input) {
        receivers.describeTaskDefinition.push(this);
        return originalDescribeTaskDefinition(input);
      });

      await expect(fixture.reader()).resolves.toBeDefined();

      for (const method of ['getObject', 'describeStateMachine', 'describeTaskDefinition'] as const) {
        expect(receivers[method].length).toBeGreaterThan(0);
        for (const receiver of receivers[method]) {
          expect(Object.isFrozen(receiver)).toBe(true);
          expect(Reflect.getPrototypeOf(receiver as object)).toBeNull();
          expect(Reflect.ownKeys(receiver as object)).toEqual([]);
        }
      }
    });

    it.each([
      {
        expected: 'body is missing',
        mutate: (object: StoredAuthorityObject) => {
          object.Body = undefined;
        },
        name: 'missing body',
      },
      {
        expected: 'ContentLength is invalid',
        mutate: (object: StoredAuthorityObject) => {
          object.ContentLength = undefined;
        },
        name: 'missing ContentLength',
      },
      {
        expected: 'ContentLength is invalid',
        mutate: (object: StoredAuthorityObject) => {
          object.ContentLength = 1024 * 1024 + 1;
        },
        name: 'declared body above one MiB',
      },
      {
        expected: 'ContentLength does not match',
        mutate: (object: StoredAuthorityObject) => {
          object.ContentLength = (object.ContentLength ?? 0) + 1;
        },
        name: 'declared and observed length mismatch',
      },
      {
        expected: 'canonical JSON bytes',
        mutate: (object: StoredAuthorityObject) => {
          const canonicalBody = new TextDecoder().decode(object.Body);
          object.Body = new TextEncoder().encode(canonicalBody.replace('{', '{ '));
          object.ContentLength = object.Body.byteLength;
        },
        name: 'semantically identical noncanonical JSON bytes',
      },
    ])('fails closed for a current authority object with $name', async ({ expected, mutate }) => {
      const fixture = protectionAuthorityFixture();
      const object = fixture.stored.get(fixture.currentToolchainPointerStorageKey);
      if (object === undefined) throw new Error('missing test object');
      mutate(object);

      await expect(fixture.reader()).rejects.toThrow(expected);
    });

    it('requires ledger records to match their content-addressed key and return a VersionId', async () => {
      const fixture = protectionAuthorityFixture();
      const reference = fixture.acceptedToolchainReleaseReference;
      const key = authorityObjectKey(fixture.config.releaseAuthorityBucket, reference.key, reference.versionId);
      const object = fixture.stored.get(key);
      if (object === undefined) throw new Error('missing test object');
      const alteredBody = new TextEncoder().encode(
        canonicalRecordJson({ ...fixture.releaseRecord, imageTag: 'altered-tag' }),
      );
      object.Body = alteredBody;
      object.ContentLength = alteredBody.byteLength;

      await expect(fixture.reader()).rejects.toThrow('does not match its derived key');

      object.Body = new TextEncoder().encode(canonicalRecordJson(fixture.releaseRecord));
      object.ContentLength = object.Body.byteLength;
      object.VersionId = undefined;
      await expect(fixture.reader()).rejects.toThrow('valid opaque S3 VersionId');
    });

    it('applies the same declared byte bound to immutable authority records', async () => {
      const fixture = protectionAuthorityFixture();
      const reference = fixture.acceptedToolchainReleaseReference;
      const object = fixture.stored.get(
        authorityObjectKey(fixture.config.releaseAuthorityBucket, reference.key, reference.versionId),
      );
      if (object === undefined) throw new Error('missing test object');
      object.ContentLength = 1024 * 1024 + 1;

      await expect(fixture.reader()).rejects.toThrow('ContentLength is invalid');
    });

    it('fails closed when any key from the complete nine-record App history is unreadable', async () => {
      const fixture = protectionAuthorityFixture();
      const reference = fixture.appAcceptanceReferences.at(-1);
      if (reference === undefined) throw new Error('missing test reference');
      fixture.stored.delete(
        authorityObjectKey(fixture.config.appAcceptedAuthorityBucket, reference.key, reference.versionId),
      );

      await expect(fixture.reader()).rejects.toThrow('unexpected test S3 object');
    });

    it.each([
      {
        expected: 'ETag is invalid',
        mutate: (object: StoredAuthorityObject) => {
          object.ETag = undefined;
        },
        name: 'missing ETag',
      },
      {
        expected: 'valid opaque S3 VersionId',
        mutate: (object: StoredAuthorityObject) => {
          object.VersionId = undefined;
        },
        name: 'missing VersionId',
      },
      {
        expected: 'ContentLength is invalid',
        mutate: (object: StoredAuthorityObject) => {
          object.ContentLength = 8 * 1024 * 1024 + 1;
        },
        name: 'oversized body',
      },
    ])('requires exact target App record coordinates for $name', async ({ expected, mutate }) => {
      const fixture = protectionAuthorityFixture();
      const reference = fixture.appAcceptanceReferences[0];
      if (reference === undefined) throw new Error('missing test reference');
      const object = fixture.stored.get(
        authorityObjectKey(fixture.config.appAcceptedAuthorityBucket, reference.key, reference.versionId),
      );
      if (object === undefined) throw new Error('missing test object');
      mutate(object);

      await expect(fixture.reader()).rejects.toThrow(expected);
    });

    it('binds canonical App acceptance bytes to their content-addressed history key', async () => {
      const fixture = protectionAuthorityFixture();
      const reference = fixture.appAcceptanceReferences[0];
      if (reference === undefined) throw new Error('missing test reference');
      const object = fixture.stored.get(
        authorityObjectKey(fixture.config.appAcceptedAuthorityBucket, reference.key, reference.versionId),
      );
      if (object?.Body === undefined) throw new Error('missing test object');
      const record = JSON.parse(new TextDecoder().decode(object.Body)) as Record<string, unknown>;
      object.Body = new TextEncoder().encode(
        canonicalRecordJson({ ...record, acceptedAt: '2026-08-14T02:00:00.000Z' }),
      );
      object.ContentLength = object.Body.byteLength;

      await expect(fixture.reader()).rejects.toThrow(/derived key/iu);
    });

    it.each([
      {
        build: (fixture: ProtectionAuthorityFixture, onTrap: () => void) =>
          trappedProxy(validStateMachineResponse(fixture), onTrap),
        name: 'a proxied response',
      },
      {
        build: (fixture: ProtectionAuthorityFixture) =>
          Object.assign(Object.create({ custom: true }) as Record<string, unknown>, validStateMachineResponse(fixture)),
        name: 'a custom response prototype',
      },
      {
        build: (fixture: ProtectionAuthorityFixture, onTrap: () => void) => {
          const response = validStateMachineResponse(fixture);
          return accessorRecord(response, 'definition', response.definition, onTrap);
        },
        name: 'a required-field accessor',
      },
      {
        build: (fixture: ProtectionAuthorityFixture, onTrap: () => void) => {
          const response = validStateMachineResponse(fixture) as Record<string, unknown>;
          Object.defineProperty(response, 'then', {
            enumerable: true,
            get() {
              onTrap();
              return undefined;
            },
          });
          return response;
        },
        name: 'an own then accessor',
      },
      {
        build: (fixture: ProtectionAuthorityFixture, onTrap: () => void) => {
          const prototype = Object.create(null) as Record<string, unknown>;
          Object.defineProperty(prototype, 'then', {
            enumerable: true,
            get() {
              onTrap();
              return undefined;
            },
          });
          return Object.assign(Object.create(prototype) as Record<string, unknown>, validStateMachineResponse(fixture));
        },
        name: 'an inherited then accessor',
      },
      {
        build: (fixture: ProtectionAuthorityFixture) => ({
          ...validStateMachineResponse(fixture),
          definition: new TextEncoder().encode('{}'),
        }),
        name: 'a byte-array field substitution',
      },
    ])('descriptor-projects describeStateMachine and rejects $name without invoking traps', async ({ build }) => {
      const fixture = protectionAuthorityFixture();
      let traps = 0;
      const response = build(fixture, () => {
        traps += 1;
      });
      const reader = createEcrRetentionProtectionAuthorityReader(
        {
          ...fixture.aws,
          describeStateMachine: () => response as never,
        },
        fixture.config,
      );

      await expect(reader()).rejects.toThrow();
      expect(traps).toBe(0);
    });

    it.each([
      {
        build: (fixture: ProtectionAuthorityFixture, onTrap: () => void) =>
          trappedProxy(validTaskDefinitionResponse(fixture), onTrap),
        name: 'a proxied response',
      },
      {
        build: (fixture: ProtectionAuthorityFixture) =>
          Object.assign(
            Object.create({ custom: true }) as Record<string, unknown>,
            validTaskDefinitionResponse(fixture),
          ),
        name: 'a custom response prototype',
      },
      {
        build: (fixture: ProtectionAuthorityFixture, onTrap: () => void) => {
          const response = validTaskDefinitionResponse(fixture);
          return accessorRecord({}, 'taskDefinition', response.taskDefinition, onTrap);
        },
        name: 'a top-level required-field accessor',
      },
      {
        build: (fixture: ProtectionAuthorityFixture, onTrap: () => void) => {
          const response = validTaskDefinitionResponse(fixture);
          return { taskDefinition: trappedProxy(response.taskDefinition, onTrap) };
        },
        name: 'a proxied nested task definition',
      },
      {
        build: (fixture: ProtectionAuthorityFixture) => {
          const response = validTaskDefinitionResponse(fixture);
          return {
            taskDefinition: Object.assign(
              Object.create({ custom: true }) as Record<string, unknown>,
              response.taskDefinition,
            ),
          };
        },
        name: 'a custom nested task-definition prototype',
      },
      {
        build: (fixture: ProtectionAuthorityFixture, onTrap: () => void) => {
          const response = validTaskDefinitionResponse(fixture);
          return {
            taskDefinition: accessorRecord(response.taskDefinition, 'family', response.taskDefinition.family, onTrap),
          };
        },
        name: 'a nested required-field accessor',
      },
      {
        build: (fixture: ProtectionAuthorityFixture, onTrap: () => void) => {
          const response = validTaskDefinitionResponse(fixture);
          const taskDefinition = { ...response.taskDefinition } as Record<string, unknown>;
          Object.defineProperty(taskDefinition, 'then', {
            enumerable: true,
            get() {
              onTrap();
              return undefined;
            },
          });
          return { taskDefinition };
        },
        name: 'a nested own then accessor',
      },
      {
        build: (fixture: ProtectionAuthorityFixture, onTrap: () => void) => {
          const response = validTaskDefinitionResponse(fixture);
          const prototype = Object.create(null) as Record<string, unknown>;
          Object.defineProperty(prototype, 'then', {
            enumerable: true,
            get() {
              onTrap();
              return undefined;
            },
          });
          return {
            taskDefinition: Object.assign(Object.create(prototype) as Record<string, unknown>, response.taskDefinition),
          };
        },
        name: 'a nested inherited then accessor',
      },
      {
        build: (fixture: ProtectionAuthorityFixture, onTrap: () => void) => {
          const response = validTaskDefinitionResponse(fixture);
          return {
            taskDefinition: {
              ...response.taskDefinition,
              containerDefinitions: trappedProxy(response.taskDefinition.containerDefinitions, onTrap),
            },
          };
        },
        name: 'proxied container definitions',
      },
      {
        build: (fixture: ProtectionAuthorityFixture) => {
          const response = validTaskDefinitionResponse(fixture);
          const containerDefinitions: unknown[] = [];
          containerDefinitions.length = 1;
          return { taskDefinition: { ...response.taskDefinition, containerDefinitions } };
        },
        name: 'sparse container definitions',
      },
      {
        build: (fixture: ProtectionAuthorityFixture) => {
          const response = validTaskDefinitionResponse(fixture);
          return {
            taskDefinition: {
              ...response.taskDefinition,
              containerDefinitions: new Uint8Array([1]),
            },
          };
        },
        name: 'byte-array container definitions',
      },
      {
        build: (fixture: ProtectionAuthorityFixture, onTrap: () => void) => {
          const response = validTaskDefinitionResponse(fixture);
          const container = response.taskDefinition.containerDefinitions[0];
          if (container === undefined) throw new Error('missing valid container');
          return {
            taskDefinition: {
              ...response.taskDefinition,
              containerDefinitions: [trappedProxy(container, onTrap)],
            },
          };
        },
        name: 'a proxied container',
      },
      {
        build: (fixture: ProtectionAuthorityFixture) => {
          const response = validTaskDefinitionResponse(fixture);
          const container = response.taskDefinition.containerDefinitions[0];
          if (container === undefined) throw new Error('missing valid container');
          return {
            taskDefinition: {
              ...response.taskDefinition,
              containerDefinitions: [Object.assign(Object.create({ custom: true }), container)],
            },
          };
        },
        name: 'a custom container prototype',
      },
      {
        build: (fixture: ProtectionAuthorityFixture, onTrap: () => void) => {
          const response = validTaskDefinitionResponse(fixture);
          const container = response.taskDefinition.containerDefinitions[0];
          if (container === undefined) throw new Error('missing valid container');
          return {
            taskDefinition: {
              ...response.taskDefinition,
              containerDefinitions: [accessorRecord(container, 'name', container.name, onTrap)],
            },
          };
        },
        name: 'a container required-field accessor',
      },
      {
        build: (fixture: ProtectionAuthorityFixture, onTrap: () => void) => {
          const response = validTaskDefinitionResponse(fixture);
          const container = { ...response.taskDefinition.containerDefinitions[0] } as Record<string, unknown>;
          Object.defineProperty(container, 'then', {
            enumerable: true,
            get() {
              onTrap();
              return undefined;
            },
          });
          return {
            taskDefinition: { ...response.taskDefinition, containerDefinitions: [container] },
          };
        },
        name: 'a container own then accessor',
      },
      {
        build: (fixture: ProtectionAuthorityFixture, onTrap: () => void) => {
          const response = validTaskDefinitionResponse(fixture);
          const container = response.taskDefinition.containerDefinitions[0];
          if (container === undefined) throw new Error('missing valid container');
          const prototype = Object.create(null) as Record<string, unknown>;
          Object.defineProperty(prototype, 'then', {
            enumerable: true,
            get() {
              onTrap();
              return undefined;
            },
          });
          return {
            taskDefinition: {
              ...response.taskDefinition,
              containerDefinitions: [Object.assign(Object.create(prototype), container)],
            },
          };
        },
        name: 'a container inherited then accessor',
      },
      {
        build: (fixture: ProtectionAuthorityFixture) => {
          const response = validTaskDefinitionResponse(fixture);
          const container = response.taskDefinition.containerDefinitions[0];
          if (container === undefined) throw new Error('missing valid container');
          return {
            taskDefinition: {
              ...response.taskDefinition,
              containerDefinitions: [{ ...container, image: new TextEncoder().encode(container.image) }],
            },
          };
        },
        name: 'a byte-array container field substitution',
      },
    ])('descriptor-projects describeTaskDefinition and rejects $name without invoking traps', async ({ build }) => {
      const fixture = protectionAuthorityFixture();
      let traps = 0;
      const response = build(fixture, () => {
        traps += 1;
      });
      const reader = createEcrRetentionProtectionAuthorityReader(
        {
          ...fixture.aws,
          describeTaskDefinition: () => response as never,
        },
        fixture.config,
      );

      await expect(reader()).rejects.toThrow();
      expect(traps).toBe(0);
    });

    it('detaches the required state-machine and task-definition fields during port admission', async () => {
      const fixture = protectionAuthorityFixture();
      const stateMachine = validStateMachineResponse(fixture);
      const taskDefinition = validTaskDefinitionResponse(fixture);
      vi.mocked(fixture.aws.describeStateMachine).mockImplementation(() => {
        queueMicrotask(() => {
          stateMachine.definition = '{}';
        });
        return stateMachine as never;
      });
      vi.mocked(fixture.aws.describeTaskDefinition).mockImplementation(() => {
        queueMicrotask(() => {
          const container = taskDefinition.taskDefinition.containerDefinitions[0];
          if (container !== undefined) container.image = `${container.image}-mutated`;
        });
        return taskDefinition as never;
      });

      await expect(fixture.reader()).resolves.toMatchObject({
        protectedDigests: {
          prover: [...fixture.protectedProverDigests].sort(),
          toolchain: [...fixture.protectedToolchainDigests].sort(),
        },
      });
    });

    it.each([
      {
        containers: [
          { image: imageUri(foundation.names.proverRepository, PROVER_DIGEST), name: 'prover' },
          { image: imageUri(foundation.names.proverRepository, PROVER_DIGEST), name: 'prover' },
        ],
        name: 'duplicate prover containers',
      },
      {
        containers: [
          {
            image: `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/other@${PROVER_DIGEST}`,
            name: 'prover',
          },
        ],
        name: 'another repository',
      },
      {
        containers: [
          {
            image: `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${foundation.names.proverRepository}:latest`,
            name: 'prover',
          },
        ],
        name: 'a mutable tag',
      },
    ])('rejects a live task definition using $name', async ({ containers }) => {
      const fixture = protectionAuthorityFixture();
      vi.mocked(fixture.aws.describeTaskDefinition).mockImplementation((input) =>
        Promise.resolve({
          taskDefinition: {
            containerDefinitions: containers,
            family: fixture.config.ecsTaskFamily,
            revision: 42,
            status: 'ACTIVE',
            taskDefinitionArn: input.taskDefinition,
          },
        }),
      );

      await expect(fixture.reader()).rejects.toThrow();
    });

    it('binds the active state machine cluster to the monitored ECS cluster', async () => {
      const fixture = protectionAuthorityFixture();
      const taskDefinitionArn = `arn:aws:ecs:${target.region}:${target.accountId}:task-definition/${fixture.config.ecsTaskFamily}:42`;
      vi.mocked(fixture.aws.describeStateMachine).mockResolvedValue({
        definition: JSON.stringify({
          States: {
            RunProver: {
              Parameters: {
                Cluster: `arn:aws:ecs:${target.region}:${target.accountId}:cluster/unmonitored-cluster`,
                TaskDefinition: taskDefinitionArn,
              },
              Resource: 'arn:aws:states:::ecs:runTask.sync',
              Type: 'Task',
            },
          },
        }),
        stateMachineArn: fixture.config.stateMachineArn,
        status: 'ACTIVE',
      });

      await expect(fixture.reader()).rejects.toThrow('task-definition authority is invalid');
    });

    it('requires an ACTIVE state machine and the exact task-definition revision identity', async () => {
      const fixture = protectionAuthorityFixture();
      vi.mocked(fixture.aws.describeStateMachine).mockImplementation((input) =>
        Promise.resolve({
          definition: '{}',
          stateMachineArn: input.stateMachineArn,
          status: 'DELETING',
        }),
      );
      await expect(fixture.reader()).rejects.toThrow('state machine identity');

      const secondFixture = protectionAuthorityFixture();
      vi.mocked(secondFixture.aws.describeTaskDefinition).mockImplementation((input) =>
        Promise.resolve({
          taskDefinition: {
            containerDefinitions: [
              {
                image: imageUri(secondFixture.config.handler.repositories.prover, secondFixture.liveProverDigest),
                name: 'prover',
              },
            ],
            family: secondFixture.config.ecsTaskFamily,
            revision: 41,
            status: 'ACTIVE',
            taskDefinitionArn: input.taskDefinition,
          },
        }),
      );
      await expect(secondFixture.reader()).rejects.toThrow('task definition identity');
    });
  });

  describe('AWS ECR retention dependencies', () => {
    it('enumerates image and referrer pages with ANY status and reconciles exact known referrers', async () => {
      const aws = operations();
      const proverSecondSubject = `sha256:${'4'.repeat(64)}`;
      vi.mocked(aws.describeImages).mockImplementation((input) => {
        const repositoryName = input.repositoryName;
        if (repositoryName === undefined) return Promise.reject(new Error('repositoryName is required'));
        const digest = repositoryName === foundation.names.proverRepository ? PROVER_DIGEST : TOOLCHAIN_DIGEST;
        if (input.nextToken === undefined) {
          return Promise.resolve({
            imageDetails: [subject(repositoryName, digest, new Date('2026-01-01T00:00:00.000Z'))],
            ...(repositoryName === foundation.names.proverRepository ? { nextToken: 'page-2' } : {}),
          });
        }
        return Promise.resolve({
          imageDetails: [
            subject(repositoryName, proverSecondSubject, new Date('2026-01-02T00:00:00.000Z')),
            signature(repositoryName),
          ],
        });
      });
      vi.mocked(aws.listImageReferrers).mockImplementation((input) =>
        Promise.resolve({
          referrers:
            input.subjectId?.imageDigest === proverSecondSubject
              ? [
                  {
                    artifactStatus: 'ACTIVE',
                    artifactType: REFERRER_ARTIFACT_MEDIA_TYPE,
                    digest: SIGNATURE_DIGEST,
                    mediaType: REFERRER_MANIFEST_MEDIA_TYPE,
                    size: 123,
                  },
                ]
              : [],
        }),
      );
      const dependencies = createEcrRetentionAwsDependencies(
        aws,
        parseEcrRetentionRuntimeConfig(env()),
        vi.fn(() => Promise.resolve(authority())),
      );

      const result = await dependencies.observe();

      expect(result).toMatchObject({
        authoritySnapshotSha256: 'a'.repeat(64),
        repositories: {
          prover: {
            paginationComplete: true,
            protectedDigests: [PROVER_DIGEST],
          },
        },
      });
      const observed = result as {
        readonly repositories: {
          readonly prover: {
            readonly referrers: readonly {
              readonly paginationComplete: boolean;
              readonly referrers: readonly { readonly artifactDigest: string }[];
              readonly subjectDigest: string;
            }[];
          };
        };
      };
      const proverRepository = observed.repositories.prover;
      const secondSubjectReferrers = proverRepository.referrers.find(
        (entry) => entry.subjectDigest === proverSecondSubject,
      );
      expect(secondSubjectReferrers?.paginationComplete).toBe(true);
      expect(secondSubjectReferrers?.referrers.map((entry) => entry.artifactDigest)).toContain(SIGNATURE_DIGEST);
      expect(vi.mocked(aws.describeImages).mock.calls.every(([input]) => input.filter?.imageStatus === 'ANY')).toBe(
        true,
      );
      expect(
        vi
          .mocked(aws.listImageReferrers)
          .mock.calls.every(([input]) => input.filter?.artifactStatus === 'ANY' && input.maxResults === 50),
      ).toBe(true);
    });

    it('propagates pagination/API failure without returning a partial deletable observation', async () => {
      const aws = operations();
      vi.mocked(aws.describeImages).mockResolvedValue({ imageDetails: [], nextToken: 'same' });
      const dependencies = createEcrRetentionAwsDependencies(
        aws,
        parseEcrRetentionRuntimeConfig(env()),
        vi.fn(() => Promise.resolve(authority())),
      );

      await expect(dependencies.observe()).rejects.toThrow('pagination');
    });

    it('checks CodePipeline, CodeBuild, Step Functions, and ECS activity with complete pages', async () => {
      const aws = operations();
      vi.mocked(aws.listPipelineExecutions).mockResolvedValue({
        pipelineExecutionSummaries: [{ status: 'InProgress' }],
      });
      vi.mocked(aws.listBuildsForProject).mockResolvedValue({ ids: ['build-1'] });
      vi.mocked(aws.batchGetBuilds).mockResolvedValue({ builds: [{ id: 'build-1', buildStatus: 'SUCCEEDED' }] });
      vi.mocked(aws.listExecutions).mockResolvedValue({ executions: [] });
      vi.mocked(aws.listTasks).mockResolvedValue({ taskArns: ['task-1'] });
      const dependencies = createEcrRetentionAwsDependencies(
        aws,
        parseEcrRetentionRuntimeConfig(env()),
        vi.fn(() => Promise.resolve(authority())),
      );

      await expect(dependencies.observeActivity()).resolves.toEqual({
        codeBuild: false,
        codePipeline: true,
        ecs: true,
        stepFunctions: false,
      });
      expect(aws.listExecutions).toHaveBeenCalledWith(
        expect.objectContaining({ statusFilter: 'RUNNING', maxResults: 100 }),
      );
      expect(aws.listTasks).toHaveBeenCalledWith(
        expect.objectContaining({ desiredStatus: 'RUNNING', family: foundation.names.proverEcsTaskFamily }),
      );
      expect(aws.listTasks).toHaveBeenCalledWith(
        expect.objectContaining({ desiredStatus: 'PENDING', family: foundation.names.proverEcsTaskFamily }),
      );
      expect(aws.listPipelineExecutions).toHaveBeenCalledTimes(4);
    });

    it('does not treat historical CodePipeline or CodeBuild pagination as current activity', async () => {
      const aws = operations();
      vi.mocked(aws.listPipelineExecutions).mockImplementation((input) => {
        return Promise.resolve(
          input.nextToken === undefined
            ? { nextToken: 'older-pipeline-history', pipelineExecutionSummaries: [{ status: 'Succeeded' }] }
            : { pipelineExecutionSummaries: [{ status: 'Failed' }] },
        );
      });
      vi.mocked(aws.listBuildsForProject).mockImplementation((input) =>
        Promise.resolve(
          input.nextToken === undefined
            ? { ids: [`${input.projectName}:build-1`], nextToken: 'older-build-history' }
            : { ids: [`${input.projectName}:build-2`] },
        ),
      );
      vi.mocked(aws.batchGetBuilds).mockImplementation((input) =>
        input.ids === undefined
          ? Promise.reject(new Error('build ids are required'))
          : Promise.resolve({ builds: input.ids.map((id) => ({ id, buildStatus: 'SUCCEEDED' as const })) }),
      );
      const dependencies = createEcrRetentionAwsDependencies(
        aws,
        parseEcrRetentionRuntimeConfig(env()),
        vi.fn(() => Promise.resolve(authority())),
      );

      await expect(dependencies.observeActivity()).resolves.toEqual({
        codeBuild: false,
        codePipeline: false,
        ecs: false,
        stepFunctions: false,
      });
      expect(aws.listPipelineExecutions).toHaveBeenCalledTimes(8);
      expect(aws.listBuildsForProject).toHaveBeenCalledTimes(4);
      expect(vi.mocked(aws.listBuildsForProject).mock.calls.every(([input]) => input.sortOrder === undefined)).toBe(
        true,
      );
    });

    it('detects pipeline and candidate-build activity that appears only on a later page', async () => {
      const aws = operations();
      vi.mocked(aws.listPipelineExecutions).mockImplementation((input) =>
        Promise.resolve(
          input.nextToken === undefined
            ? { nextToken: 'pipeline-page-2', pipelineExecutionSummaries: [{ status: 'Succeeded' }] }
            : { pipelineExecutionSummaries: [{ status: 'InProgress' }] },
        ),
      );
      vi.mocked(aws.listBuildsForProject).mockImplementation((input) =>
        Promise.resolve(
          input.nextToken === undefined
            ? { ids: [`${input.projectName}:build-1`], nextToken: 'build-page-2' }
            : { ids: [`${input.projectName}:build-2`] },
        ),
      );
      vi.mocked(aws.batchGetBuilds).mockImplementation((input) =>
        input.ids === undefined
          ? Promise.reject(new Error('build ids are required'))
          : Promise.resolve({
              builds: input.ids.map((id) => ({
                id,
                buildStatus: id.endsWith('build-2') ? ('IN_PROGRESS' as const) : ('SUCCEEDED' as const),
              })),
            }),
      );
      const dependencies = createEcrRetentionAwsDependencies(
        aws,
        parseEcrRetentionRuntimeConfig(env()),
        vi.fn(() => Promise.resolve(authority())),
      );

      await expect(dependencies.observeActivity()).resolves.toMatchObject({
        codeBuild: true,
        codePipeline: true,
      });
    });

    it.each([
      {
        configure: (aws: EcrRetentionAwsOperations) => {
          vi.mocked(aws.listPipelineExecutions).mockResolvedValue({
            pipelineExecutionSummaries: [{ status: 'NewExternalStatus' as never }],
          });
        },
        name: 'unknown CodePipeline status',
      },
      {
        configure: (aws: EcrRetentionAwsOperations) => {
          vi.mocked(aws.listBuildsForProject).mockResolvedValue({ ids: ['build-1'] });
          vi.mocked(aws.batchGetBuilds).mockResolvedValue({
            builds: [{ buildStatus: 'NEW_EXTERNAL_STATUS' as never, id: 'build-1' }],
          });
        },
        name: 'unknown CodeBuild status',
      },
      {
        configure: (aws: EcrRetentionAwsOperations) => {
          vi.mocked(aws.listBuildsForProject).mockResolvedValue({ ids: ['build-1', 'build-1'] });
        },
        name: 'duplicate CodeBuild listing',
      },
      {
        configure: (aws: EcrRetentionAwsOperations) => {
          vi.mocked(aws.listBuildsForProject).mockResolvedValue({ ids: ['build-1', 'build-2'] });
          vi.mocked(aws.batchGetBuilds).mockResolvedValue({
            builds: [
              { buildStatus: 'SUCCEEDED', id: 'build-1' },
              { buildStatus: 'SUCCEEDED', id: 'build-1' },
            ],
          });
        },
        name: 'duplicate CodeBuild result',
      },
    ])('fails closed for $name', async ({ configure }) => {
      const aws = operations();
      configure(aws);
      const dependencies = createEcrRetentionAwsDependencies(
        aws,
        parseEcrRetentionRuntimeConfig(env()),
        vi.fn(() => Promise.resolve(authority())),
      );

      await expect(dependencies.observeActivity()).rejects.toThrow();
    });

    it('sends digest-only BatchDeleteImage requests and exact post-readback presence checks', async () => {
      const aws = operations();
      vi.mocked(aws.batchDeleteImage).mockResolvedValue({
        imageIds: [{ imageDigest: PROVER_DIGEST }],
        failures: [],
      });
      vi.mocked(aws.describeImages).mockResolvedValue({
        imageDetails: [subject(foundation.names.proverRepository, PROVER_DIGEST, new Date())],
      });
      const dependencies = createEcrRetentionAwsDependencies(
        aws,
        parseEcrRetentionRuntimeConfig(env()),
        vi.fn(() => Promise.resolve(authority())),
      );

      await expect(
        dependencies.deleteImages({
          imageDigests: [PROVER_DIGEST],
          imageKind: 'subject',
          repositoryKind: 'prover',
          repositoryName: foundation.names.proverRepository,
        }),
      ).resolves.toEqual({ deletedImageDigests: [PROVER_DIGEST], failures: [] });
      await expect(
        dependencies.readImagePresence({
          expectedAbsentDigests: [SIGNATURE_DIGEST],
          expectedPresentDigests: [PROVER_DIGEST],
          repositoryKind: 'prover',
          repositoryName: foundation.names.proverRepository,
        }),
      ).resolves.toEqual({
        existingExpectedAbsentDigests: [],
        missingExpectedPresentDigests: [],
      });
      expect(aws.batchDeleteImage).toHaveBeenCalledWith({
        registryId: target.accountId,
        repositoryName: foundation.names.proverRepository,
        imageIds: [{ imageDigest: PROVER_DIGEST }],
      });
    });

    it('requires expected-present digests to be ACTIVE reviewed subjects while detecting any expected-absent digest', async () => {
      const aws = operations();
      vi.mocked(aws.describeImages).mockResolvedValue({
        imageDetails: [
          { ...subject(foundation.names.proverRepository, PROVER_DIGEST, new Date()), imageStatus: 'ARCHIVED' },
          {
            ...signature(foundation.names.proverRepository),
            imageDigest: TOOLCHAIN_DIGEST,
            imageStatus: 'ACTIVE',
          },
          { ...signature(foundation.names.proverRepository), imageStatus: 'ARCHIVED' },
        ],
      });
      const dependencies = createEcrRetentionAwsDependencies(
        aws,
        parseEcrRetentionRuntimeConfig(env()),
        vi.fn(() => Promise.resolve(authority())),
      );

      await expect(
        dependencies.readImagePresence({
          expectedAbsentDigests: [SIGNATURE_DIGEST],
          expectedPresentDigests: [PROVER_DIGEST, TOOLCHAIN_DIGEST],
          repositoryKind: 'prover',
          repositoryName: foundation.names.proverRepository,
        }),
      ).resolves.toEqual({
        existingExpectedAbsentDigests: [SIGNATURE_DIGEST],
        missingExpectedPresentDigests: [PROVER_DIGEST, TOOLCHAIN_DIGEST],
      });
    });
  });

  function evidence(
    blockers: readonly string[],
    disposition: EcrRetentionEvidence['disposition'],
  ): EcrRetentionEvidence {
    return {
      evidenceType: 'ecr-subject-retention',
      targetKey: target.targetKey,
      reportOnly: false,
      disposition,
      blockers,
      activity: { codeBuild: false, codePipeline: false, ecs: false, stepFunctions: false },
      authoritySnapshotSha256: null,
      inventorySnapshotSha256: null,
      repositories: {
        prover: {
          repositoryName: foundation.names.proverRepository,
          subjectCount: 0,
          protectedSubjectCount: 0,
          targetSubjectCount: 10,
          plannedReferrerDeleteCount: 0,
          plannedSubjectDeleteCount: 0,
          deletedReferrerDigests: [],
          deletedSubjectDigests: [],
        },
        toolchain: {
          repositoryName: foundation.names.toolchainRepository,
          subjectCount: 0,
          protectedSubjectCount: 0,
          targetSubjectCount: 10,
          plannedReferrerDeleteCount: 0,
          plannedSubjectDeleteCount: 0,
          deletedReferrerDigests: [],
          deletedSubjectDigests: [],
        },
      },
    };
  }

  describe('production retry boundary', () => {
    it.each([
      ['OBSERVATION_FAILED', 'blocked'],
      ['BATCH_DELETE_FAILED', 'delete-failed'],
      ['POST_DELETE_READ_FAILED', 'delete-unverified'],
    ] as const)('logs bounded evidence and throws one generic retryable error for %s', async (blocker, disposition) => {
      const log = vi.fn();

      await expect(
        runEcrRetentionBoundary(() => Promise.resolve(evidence([blocker], disposition)), {}, log),
      ).rejects.toThrow('ECR retention transient failure');
      expect(log).toHaveBeenCalledWith(evidence([blocker], disposition));
    });

    it.each([
      evidence(['UNKNOWN_IMAGE_MEDIA'], 'blocked'),
      evidence([], 'skipped-active'),
      evidence([], 'no-change'),
      evidence([], 'skipped-changed'),
    ])('returns semantic/safe no-delete evidence without retry', async (result) => {
      const log = vi.fn();

      await expect(runEcrRetentionBoundary(() => Promise.resolve(result), {}, log)).resolves.toEqual(result);
      expect(log).toHaveBeenCalledWith(result);
    });
  });
});
