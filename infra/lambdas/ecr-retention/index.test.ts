import { describe, expect, it, vi } from 'vitest';
import {
  canonicalRecordJson,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
} from '@stark-ballot/deployment-authority';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  createEcrRetentionAwsDependencies,
  createEcrRetentionProtectionAuthorityReader,
  parseEcrRetentionRuntimeConfig,
  runEcrRetentionBoundary,
  type EcrRetentionAuthorityValidators,
  type EcrRetentionAwsOperations,
  type EcrRetentionProtectionAuthority,
} from './index.js';
import type { EcrRetentionEvidence } from './handler.js';

const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const foundation = resolveDeploymentLaneAuthority(target, 'foundation');
const SUBJECT_MANIFEST_MEDIA_TYPE = 'application/vnd.docker.distribution.manifest.v2+json';
const SUBJECT_ARTIFACT_MEDIA_TYPE = 'application/vnd.docker.container.image.v1+json';
const REFERRER_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const REFERRER_ARTIFACT_MEDIA_TYPE = 'application/vnd.cncf.notary.signature';
const TOOLCHAIN_DIGEST = `sha256:${'1'.repeat(64)}`;
const PROVER_DIGEST = `sha256:${'2'.repeat(64)}`;
const SIGNATURE_DIGEST = `sha256:${'3'.repeat(64)}`;

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
  VersionId: string | undefined;
};

function authorityObjectKey(bucket: string, key: string, versionId?: string): string {
  return `${bucket}\0${key}\0${versionId ?? ''}`;
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
      VersionId: versionId,
    });
    return reference;
  };
  const putCurrent = (bucket: string, key: string, versionId: string, value: unknown) => {
    const Body = new TextEncoder().encode(canonicalRecordJson(value));
    stored.set(authorityObjectKey(bucket, key), {
      Body,
      ContentLength: Body.byteLength,
      VersionId: versionId,
    });
  };

  const toolchainDigests = ['4', '5', '6', '7'].map((value) => `sha256:${value.repeat(64)}`);
  const proverDigests = ['8', '9', 'a'].map((value) => `sha256:${value.repeat(64)}`);
  const liveProverDigest = `sha256:${'b'.repeat(64)}`;
  const toolchainReferences = toolchainDigests.map((digest, index) =>
    putImmutable(
      config.releaseAuthorityBucket,
      `artifacts/toolchain/toolchain-${index}/manifest.json`,
      `toolchain-version-${index}`,
      {
        imageDigest: digest,
        imageUri: imageUri(config.handler.repositories.toolchain, digest),
        recordType: 'test-toolchain',
      },
    ),
  );
  const proverReferences = proverDigests.map((digest, index) => {
    const selectedToolchain = toolchainReferences[index + 1];
    const selectedDigest = toolchainDigests[index + 1];
    if (selectedToolchain === undefined || selectedDigest === undefined) throw new Error('invalid test fixture');
    return putImmutable(
      config.releaseAuthorityBucket,
      `releases/prover/prover-${index}/manifest.json`,
      `prover-version-${index}`,
      {
        imageDigest: digest,
        imageUri: imageUri(config.handler.repositories.prover, digest),
        recordType: 'test-prover',
        selectedToolchain: {
          ...selectedToolchain,
          imageDigest: selectedDigest,
          imageUri: imageUri(config.handler.repositories.toolchain, selectedDigest),
        },
      },
    );
  });
  const appEntries = [0, 1].map((index) => {
    const toolchainReference = toolchainReferences[index + 2];
    const proverReference = proverReferences[index + 1];
    const proverDigest = proverDigests[index + 1];
    if (toolchainReference === undefined || proverReference === undefined || proverDigest === undefined) {
      throw new Error('invalid test fixture');
    }
    const manifestPath = `accepted-deployments/stark-dev/develop/app/executions/app-${index}/manifest.json`;
    const record = {
      releaseAuthority: {
        proverImageUri: imageUri(config.handler.repositories.prover, proverDigest),
        proverReleaseRecord: proverReference,
        toolchainArtifactRecord: toolchainReference,
      },
    };
    const reference = putImmutable(config.appAcceptedAuthorityBucket, manifestPath, `app-version-${index}`, record);
    return {
      manifestPath: reference.key,
      manifestSha256: reference.sha256,
      manifestVersionId: reference.versionId,
    };
  });
  const toolchainPointer = {
    artifactRecordKey: toolchainReferences[0]?.key,
    artifactRecordSha256: toolchainReferences[0]?.sha256,
    artifactRecordVersionId: toolchainReferences[0]?.versionId,
  };
  const proverPointer = {
    releaseRecordKey: proverReferences[0]?.key,
    releaseRecordSha256: proverReferences[0]?.sha256,
    releaseRecordVersionId: proverReferences[0]?.versionId,
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
  putCurrent(config.appAcceptedAuthorityBucket, config.appAcceptedAuthorityKey, 'app-authority-current-version', {
    acceptedDeployments: appEntries,
  });

  vi.mocked(aws.getObject).mockImplementation((input) => {
    const result = stored.get(authorityObjectKey(input.Bucket ?? '', input.Key ?? '', input.VersionId));
    if (result === undefined) return Promise.reject(new Error('unexpected test S3 object'));
    return Promise.resolve({
      ...(result.Body === undefined ? {} : { Body: sdkStream(result.Body) }),
      ...(result.ContentLength === undefined ? {} : { ContentLength: result.ContentLength }),
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
  const validators: EcrRetentionAuthorityValidators = {
    acceptedCurrent: (value) => value as Readonly<Record<string, unknown>>,
    acceptedProjection: (accepted, entry) => ({
      accepted: accepted as { readonly releaseAuthority: Readonly<Record<string, unknown>> },
      entry: entry as Readonly<Record<string, unknown>>,
    }),
    acceptedReleasePointer: (value) => value as Readonly<Record<string, unknown>>,
    proverRelease: (value) =>
      value as {
        readonly imageDigest: string;
        readonly imageUri: string;
        readonly selectedToolchain: {
          readonly imageDigest: string;
          readonly imageUri: string;
          readonly key: string;
          readonly sha256: string;
          readonly versionId: string;
        };
      },
    toolchainArtifact: (value) => value as { readonly imageDigest: string; readonly imageUri: string },
  };
  return {
    aws,
    config,
    currentToolchainPointerStorageKey: authorityObjectKey(
      config.releaseAuthorityBucket,
      config.acceptedPointerKeys.toolchain,
    ),
    liveProverDigest,
    proverDigests,
    proverReferences,
    reader: createEcrRetentionProtectionAuthorityReader(aws, config, validators),
    stored,
    toolchainDigests,
    toolchainReferences,
  };
}

describe('ECR retention runtime config', () => {
  it('admits only the exact develop authority, current region, and daily schedule ARN', () => {
    const config = parseEcrRetentionRuntimeConfig(env());

    expect(config.handler.expectedScheduleArn).toBe(
      `arn:aws:events:${target.region}:${target.accountId}:rule/${foundation.names.ecrRetentionSchedule}`,
    );
    expect(config.stateMachineArn).toContain(foundation.names.finalizationStateMachine);
  });

  it.each([
    ['AWS_REGION', 'us-east-1'],
    ['TARGET_KEY', 'stark-prod/main'],
    ['RETAINED_SUBJECT_COUNT', '11'],
    ['EXPECTED_SCHEDULE_ARN', `${env()['EXPECTED_SCHEDULE_ARN']}-other`],
  ])('rejects an altered %s', (key, value) => {
    expect(() => parseEcrRetentionRuntimeConfig({ ...env(), [key]: value })).toThrow();
  });
});

describe('ECR retention protection authority', () => {
  it('protects current releases, every accepted App release closure, and the live Prover task image', async () => {
    const fixture = protectionAuthorityFixture();

    const result = await fixture.reader();

    expect(result.protectedDigests).toEqual({
      prover: [...fixture.proverDigests, fixture.liveProverDigest].sort(),
      toolchain: [...fixture.toolchainDigests].sort(),
    });
    expect(result.authoritySnapshotSha256).toMatch(/^[0-9a-f]{64}$/u);
    for (const reference of [...fixture.toolchainReferences, ...fixture.proverReferences]) {
      expect(fixture.aws.getObject).toHaveBeenCalledWith({
        Bucket: fixture.config.releaseAuthorityBucket,
        ExpectedBucketOwner: target.accountId,
        Key: reference.key,
        VersionId: reference.versionId,
      });
    }
    expect(fixture.aws.getObject).toHaveBeenCalledWith({
      Bucket: fixture.config.appAcceptedAuthorityBucket,
      ExpectedBucketOwner: target.accountId,
      Key: fixture.config.appAcceptedAuthorityKey,
    });
    expect(fixture.aws.describeTaskDefinition).toHaveBeenCalledWith({
      taskDefinition: `arn:aws:ecs:${target.region}:${target.accountId}:task-definition/${fixture.config.ecsTaskFamily}:42`,
    });
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
        object.Body = new TextEncoder().encode('{ "artifactRecordKey": "not-canonical" }\n');
        object.ContentLength = object.Body.byteLength;
      },
      name: 'noncanonical JSON bytes',
    },
  ])('fails closed for a current authority object with $name', async ({ expected, mutate }) => {
    const fixture = protectionAuthorityFixture();
    const object = fixture.stored.get(fixture.currentToolchainPointerStorageKey);
    if (object === undefined) throw new Error('missing test object');
    mutate(object);

    await expect(fixture.reader()).rejects.toThrow(expected);
  });

  it('requires the exact immutable raw SHA-256 and returned VersionId', async () => {
    const fixture = protectionAuthorityFixture();
    const reference = fixture.toolchainReferences[0];
    if (reference === undefined) throw new Error('missing test reference');
    const key = authorityObjectKey(fixture.config.releaseAuthorityBucket, reference.key, reference.versionId);
    const object = fixture.stored.get(key);
    if (object === undefined) throw new Error('missing test object');
    const alteredBody = new TextEncoder().encode(canonicalRecordJson({ altered: true }));
    object.Body = alteredBody;
    object.ContentLength = alteredBody.byteLength;

    await expect(fixture.reader()).rejects.toThrow('SHA-256 does not match');

    object.Body = new TextEncoder().encode(
      canonicalRecordJson({
        imageDigest: fixture.toolchainDigests[0],
        imageUri: imageUri(fixture.config.handler.repositories.toolchain, fixture.toolchainDigests[0] ?? ''),
        recordType: 'test-toolchain',
      }),
    );
    object.ContentLength = object.Body.byteLength;
    object.VersionId = 'unexpected-version';
    await expect(fixture.reader()).rejects.toThrow('VersionId does not match');
  });

  it('applies the same declared byte bound to immutable authority records', async () => {
    const fixture = protectionAuthorityFixture();
    const reference = fixture.toolchainReferences[0];
    if (reference === undefined) throw new Error('missing test reference');
    const object = fixture.stored.get(
      authorityObjectKey(fixture.config.releaseAuthorityBucket, reference.key, reference.versionId),
    );
    if (object === undefined) throw new Error('missing test object');
    object.ContentLength = 1024 * 1024 + 1;

    await expect(fixture.reader()).rejects.toThrow('ContentLength is invalid');
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
        { image: `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/other@${PROVER_DIGEST}`, name: 'prover' },
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
    expect(vi.mocked(aws.describeImages).mock.calls.every(([input]) => input.filter?.imageStatus === 'ANY')).toBe(true);
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
    expect(vi.mocked(aws.listBuildsForProject).mock.calls.every(([input]) => input.sortOrder === undefined)).toBe(true);
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

function evidence(blockers: readonly string[], disposition: EcrRetentionEvidence['disposition']): EcrRetentionEvidence {
  return {
    evidenceType: 'ecr-subject-retention',
    targetKey: 'stark-dev/develop',
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
