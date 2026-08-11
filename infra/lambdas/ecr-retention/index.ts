import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  ListBuildsForProjectCommand,
  type BatchGetBuildsCommandInput,
  type BatchGetBuildsCommandOutput,
  type ListBuildsForProjectCommandInput,
  type ListBuildsForProjectCommandOutput,
} from '@aws-sdk/client-codebuild';
import {
  CodePipelineClient,
  ListPipelineExecutionsCommand,
  type ListPipelineExecutionsCommandInput,
  type ListPipelineExecutionsCommandOutput,
} from '@aws-sdk/client-codepipeline';
import {
  BatchDeleteImageCommand,
  DescribeImagesCommand,
  ECRClient,
  ListImageReferrersCommand,
  type BatchDeleteImageCommandInput,
  type BatchDeleteImageCommandOutput,
  type DescribeImagesCommandInput,
  type DescribeImagesCommandOutput,
  type ListImageReferrersCommandInput,
  type ListImageReferrersCommandOutput,
} from '@aws-sdk/client-ecr';
import {
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListTasksCommand,
  type DescribeTaskDefinitionCommandInput,
  type DescribeTaskDefinitionCommandOutput,
  type ListTasksCommandInput,
  type ListTasksCommandOutput,
} from '@aws-sdk/client-ecs';
import {
  GetObjectCommand,
  S3Client,
  type GetObjectCommandInput,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import {
  DescribeStateMachineCommand,
  ListExecutionsCommand,
  SFNClient,
  type DescribeStateMachineCommandInput,
  type DescribeStateMachineCommandOutput,
  type ListExecutionsCommandInput,
  type ListExecutionsCommandOutput,
} from '@aws-sdk/client-sfn';
import { GetCallerIdentityCommand, STSClient, type GetCallerIdentityCommandOutput } from '@aws-sdk/client-sts';
import {
  canonicalRecordJson,
  canonicalJsonSha256,
  parseDigestPinnedImageReference,
  parseImmutableObjectReference,
  parseS3VersionId,
  parseSha256,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  validateAcceptedReleasePointer,
  type DigestPinnedImagePolicy,
  type ImmutableObjectReference,
} from '@stark-ballot/deployment-authority';
import {
  validateAcceptedDeploymentCurrentAuthority,
  validateAcceptedDeploymentCurrentAuthorityProjection,
} from '@stark-ballot/deployment-authority/app-acceptance';
import {
  validateProverReleaseRecord,
  validateToolchainArtifactRecord,
} from '@stark-ballot/deployment-authority/ecr-retention';
import { logger } from '@stark-ballot/diagnostics/logger';
import { createHash } from 'node:crypto';
import {
  createEcrRetentionHandler,
  type EcrRetentionConfig,
  type EcrRetentionDependencies,
  type EcrRetentionEvidence,
} from './handler.js';

type RepositoryKind = 'prover' | 'toolchain';
type AwsResponse<T extends { readonly $metadata: unknown }> = Readonly<Partial<Omit<T, '$metadata'>>>;

export interface EcrRetentionAwsOperations {
  readonly batchDeleteImage: (
    input: BatchDeleteImageCommandInput,
  ) => Promise<AwsResponse<BatchDeleteImageCommandOutput>>;
  readonly batchGetBuilds: (input: BatchGetBuildsCommandInput) => Promise<AwsResponse<BatchGetBuildsCommandOutput>>;
  readonly describeImages: (input: DescribeImagesCommandInput) => Promise<AwsResponse<DescribeImagesCommandOutput>>;
  readonly describeStateMachine: (
    input: DescribeStateMachineCommandInput,
  ) => Promise<AwsResponse<DescribeStateMachineCommandOutput>>;
  readonly describeTaskDefinition: (
    input: DescribeTaskDefinitionCommandInput,
  ) => Promise<AwsResponse<DescribeTaskDefinitionCommandOutput>>;
  readonly getCallerIdentity: () => Promise<AwsResponse<GetCallerIdentityCommandOutput>>;
  readonly getObject: (input: GetObjectCommandInput) => Promise<AwsResponse<GetObjectCommandOutput>>;
  readonly listBuildsForProject: (
    input: ListBuildsForProjectCommandInput,
  ) => Promise<AwsResponse<ListBuildsForProjectCommandOutput>>;
  readonly listExecutions: (input: ListExecutionsCommandInput) => Promise<AwsResponse<ListExecutionsCommandOutput>>;
  readonly listImageReferrers: (
    input: ListImageReferrersCommandInput,
  ) => Promise<AwsResponse<ListImageReferrersCommandOutput>>;
  readonly listPipelineExecutions: (
    input: ListPipelineExecutionsCommandInput,
  ) => Promise<AwsResponse<ListPipelineExecutionsCommandOutput>>;
  readonly listTasks: (input: ListTasksCommandInput) => Promise<AwsResponse<ListTasksCommandOutput>>;
}

export interface EcrRetentionProtectionAuthority {
  readonly authoritySnapshotSha256: string;
  readonly protectedDigests: Readonly<Record<RepositoryKind, readonly string[]>>;
}

interface ToolchainProtectionRecord {
  readonly imageDigest: string;
  readonly imageUri: string;
}

interface ProverProtectionRecord {
  readonly imageDigest: string;
  readonly imageUri: string;
  readonly selectedToolchain: ImmutableObjectReference & {
    readonly imageDigest: string;
    readonly imageUri: string;
  };
}

interface AcceptedDeploymentProtectionRecord {
  readonly releaseAuthority: Readonly<Record<string, unknown>>;
}

export interface EcrRetentionAuthorityValidators {
  readonly acceptedCurrent: (value: unknown) => Readonly<Record<string, unknown>>;
  readonly acceptedProjection: (
    accepted: unknown,
    entry: unknown,
    options: Readonly<{ expectedManifestSha256: string }>,
  ) => Readonly<{
    accepted: AcceptedDeploymentProtectionRecord;
    entry: Readonly<Record<string, unknown>>;
  }>;
  readonly acceptedReleasePointer: (value: unknown, kind: RepositoryKind) => Readonly<Record<string, unknown>>;
  readonly proverRelease: (
    value: unknown,
    policies: Readonly<{ prover: DigestPinnedImagePolicy; toolchain: DigestPinnedImagePolicy }>,
  ) => ProverProtectionRecord;
  readonly toolchainArtifact: (value: unknown, policy: DigestPinnedImagePolicy) => ToolchainProtectionRecord;
}

export interface EcrRetentionRuntimeConfig {
  readonly handler: EcrRetentionConfig;
  readonly releaseAuthorityBucket: string;
  readonly appAcceptedAuthorityBucket: string;
  readonly appAcceptedAuthorityKey: string;
  readonly acceptedPointerKeys: Readonly<Record<RepositoryKind, string>>;
  readonly pipelines: readonly [string, string, string, string];
  readonly candidateProjects: readonly [string, string];
  readonly stateMachineArn: string;
  readonly ecsClusterName: string;
  readonly ecsTaskFamily: string;
}

const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const foundation = resolveDeploymentLaneAuthority(target, 'foundation');
const appLane = resolveDeploymentLaneAuthority(target, 'app');
const toolchainLane = resolveDeploymentLaneAuthority(target, 'toolchain');
const proverLane = resolveDeploymentLaneAuthority(target, 'prover');
const SUBJECT_MANIFEST_MEDIA_TYPE = 'application/vnd.docker.distribution.manifest.v2+json';
const SUBJECT_ARTIFACT_MEDIA_TYPE = 'application/vnd.docker.container.image.v1+json';
const ACTIVE_PIPELINE_STATUSES = new Set(['InProgress', 'Stopping']);
const ACTIVE_BUILD_STATUSES = new Set(['IN_PROGRESS']);
const KNOWN_PIPELINE_STATUSES = new Set([
  'Cancelled',
  'Failed',
  'InProgress',
  'Stopped',
  'Stopping',
  'Succeeded',
  'Superseded',
]);
const KNOWN_BUILD_STATUSES = new Set(['FAILED', 'FAULT', 'IN_PROGRESS', 'STOPPED', 'SUCCEEDED', 'TIMED_OUT']);
const MAX_AUTHORITY_OBJECT_BYTES = 1024 * 1024;
const DEFAULT_AUTHORITY_VALIDATORS: EcrRetentionAuthorityValidators = Object.freeze({
  acceptedCurrent: validateAcceptedDeploymentCurrentAuthority,
  acceptedProjection: validateAcceptedDeploymentCurrentAuthorityProjection,
  acceptedReleasePointer: validateAcceptedReleasePointer,
  proverRelease: validateProverReleaseRecord,
  toolchainArtifact: validateToolchainArtifactRecord,
});
const RETRYABLE_BLOCKERS = new Set([
  'BATCH_DELETE_FAILED',
  'CALLER_IDENTITY_FAILED',
  'OBSERVATION_FAILED',
  'POST_DELETE_READ_FAILED',
  'POST_DELETE_REQUIRED_PRESENT_MISSING',
  'POST_DELETE_TARGET_PRESENT',
]);

function requiredEnv(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`ECR retention runtime configuration ${name} is invalid.`);
  }
  return value;
}

export function parseEcrRetentionRuntimeConfig(environment: NodeJS.ProcessEnv): EcrRetentionRuntimeConfig {
  const targetKey = requiredEnv(environment, 'TARGET_KEY');
  const accountId = requiredEnv(environment, 'EXPECTED_ACCOUNT_ID');
  const expectedRegion = requiredEnv(environment, 'EXPECTED_REGION');
  const runtimeRegion = environment['AWS_REGION'] ?? environment['AWS_DEFAULT_REGION'];
  if (
    targetKey !== target.targetKey ||
    accountId !== target.accountId ||
    expectedRegion !== target.region ||
    runtimeRegion !== target.region ||
    (environment['AWS_REGION'] !== undefined && environment['AWS_REGION'] !== target.region) ||
    (environment['AWS_DEFAULT_REGION'] !== undefined && environment['AWS_DEFAULT_REGION'] !== target.region)
  ) {
    throw new Error('ECR retention runtime target/account/region authority is invalid.');
  }
  const expectedScheduleArn = requiredEnv(environment, 'EXPECTED_SCHEDULE_ARN');
  const expectedStateMachineArn =
    `arn:aws:states:${target.region}:${target.accountId}:stateMachine:` + foundation.names.finalizationStateMachine;
  const exact = {
    APP_PIPELINE_NAME: appLane.names.pipeline,
    APP_ACCEPTED_AUTHORITY_BUCKET: foundation.names.appRetainedArtifactBucket,
    APP_ACCEPTED_AUTHORITY_KEY: foundation.names.acceptedDeploymentPointerKey,
    EXPECTED_SCHEDULE_ARN:
      `arn:aws:events:${target.region}:${target.accountId}:rule/` + foundation.names.ecrRetentionSchedule,
    FOUNDATION_PIPELINE_NAME: foundation.names.pipeline,
    PROVER_ACCEPTED_POINTER_KEY: foundation.names.proverAcceptedPointerKey,
    PROVER_CANDIDATE_PROJECT_NAME: foundation.names.proverCandidateProject,
    PROVER_ECS_CLUSTER_NAME: foundation.names.proverEcsCluster,
    PROVER_ECS_TASK_FAMILY: foundation.names.proverEcsTaskFamily,
    PROVER_PIPELINE_NAME: proverLane.names.pipeline,
    PROVER_REPOSITORY_NAME: foundation.names.proverRepository,
    PROVER_STATE_MACHINE_ARN: expectedStateMachineArn,
    RELEASE_AUTHORITY_BUCKET: foundation.names.releaseManifestBucket,
    RETAINED_SUBJECT_COUNT: '10',
    TOOLCHAIN_ACCEPTED_POINTER_KEY: foundation.names.toolchainAcceptedPointerKey,
    TOOLCHAIN_CANDIDATE_PROJECT_NAME: foundation.names.toolchainCandidateProject,
    TOOLCHAIN_PIPELINE_NAME: toolchainLane.names.pipeline,
    TOOLCHAIN_REPOSITORY_NAME: foundation.names.toolchainRepository,
  } as const;
  for (const [name, expected] of Object.entries(exact)) {
    if (requiredEnv(environment, name) !== expected) {
      throw new Error(`ECR retention runtime configuration ${name} does not match deployment authority.`);
    }
  }
  return Object.freeze({
    handler: Object.freeze({
      expectedAccountId: accountId,
      expectedRegion,
      expectedScheduleArn,
      retainedSubjectCount: 10,
      targetKey: 'stark-dev/develop',
      repositories: Object.freeze({
        prover: foundation.names.proverRepository,
        toolchain: foundation.names.toolchainRepository,
      }),
    }),
    releaseAuthorityBucket: exact.RELEASE_AUTHORITY_BUCKET,
    appAcceptedAuthorityBucket: exact.APP_ACCEPTED_AUTHORITY_BUCKET,
    appAcceptedAuthorityKey: exact.APP_ACCEPTED_AUTHORITY_KEY,
    acceptedPointerKeys: Object.freeze({
      prover: exact.PROVER_ACCEPTED_POINTER_KEY,
      toolchain: exact.TOOLCHAIN_ACCEPTED_POINTER_KEY,
    }),
    pipelines: Object.freeze([
      exact.FOUNDATION_PIPELINE_NAME,
      exact.APP_PIPELINE_NAME,
      exact.TOOLCHAIN_PIPELINE_NAME,
      exact.PROVER_PIPELINE_NAME,
    ] as const),
    candidateProjects: Object.freeze([
      exact.TOOLCHAIN_CANDIDATE_PROJECT_NAME,
      exact.PROVER_CANDIDATE_PROJECT_NAME,
    ] as const),
    stateMachineArn: exact.PROVER_STATE_MACHINE_ARN,
    ecsClusterName: exact.PROVER_ECS_CLUSTER_NAME,
    ecsTaskFamily: exact.PROVER_ECS_TASK_FAMILY,
  });
}

function createDefaultOperations(region: string): EcrRetentionAwsOperations {
  const codeBuild = new CodeBuildClient({ region });
  const codePipeline = new CodePipelineClient({ region });
  const ecr = new ECRClient({ region });
  const ecs = new ECSClient({ region });
  const s3 = new S3Client({ region });
  const sfn = new SFNClient({ region });
  const sts = new STSClient({ region });
  return {
    batchDeleteImage: (input) => ecr.send(new BatchDeleteImageCommand(input)),
    batchGetBuilds: (input) => codeBuild.send(new BatchGetBuildsCommand(input)),
    describeImages: (input) => ecr.send(new DescribeImagesCommand(input)),
    describeStateMachine: (input) => sfn.send(new DescribeStateMachineCommand(input)),
    describeTaskDefinition: (input) => ecs.send(new DescribeTaskDefinitionCommand(input)),
    getCallerIdentity: () => sts.send(new GetCallerIdentityCommand({})),
    getObject: (input) => s3.send(new GetObjectCommand(input)),
    listBuildsForProject: (input) => codeBuild.send(new ListBuildsForProjectCommand(input)),
    listExecutions: (input) => sfn.send(new ListExecutionsCommand(input)),
    listImageReferrers: (input) => ecr.send(new ListImageReferrersCommand(input)),
    listPipelineExecutions: (input) => codePipeline.send(new ListPipelineExecutionsCommand(input)),
    listTasks: (input) => ecs.send(new ListTasksCommand(input)),
  };
}

function assertNextToken(current: string | undefined, next: string | undefined, seen: Set<string>): void {
  if (next === undefined) return;
  if (next.length === 0 || next === current || seen.has(next)) {
    throw new Error('AWS pagination token repeated or was invalid.');
  }
  seen.add(next);
}

async function listRepositoryImages(
  operations: EcrRetentionAwsOperations,
  config: EcrRetentionRuntimeConfig,
  repositoryName: string,
): Promise<readonly Record<string, unknown>[]> {
  const images: Record<string, unknown>[] = [];
  const seenTokens = new Set<string>();
  let nextToken: string | undefined;
  do {
    const currentToken = nextToken;
    const page = await operations.describeImages({
      registryId: config.handler.expectedAccountId,
      repositoryName,
      filter: { imageStatus: 'ANY' },
      maxResults: 100,
      ...(currentToken === undefined ? {} : { nextToken: currentToken }),
    });
    for (const detail of page.imageDetails ?? []) {
      if (
        detail.registryId !== config.handler.expectedAccountId ||
        detail.repositoryName !== repositoryName ||
        !(detail.imagePushedAt instanceof Date)
      ) {
        throw new Error('ECR image detail target or timestamp is invalid.');
      }
      images.push({
        artifactMediaType: detail.artifactMediaType ?? '',
        imageDigest: detail.imageDigest ?? '',
        imageManifestMediaType: detail.imageManifestMediaType ?? '',
        imagePushedAt: detail.imagePushedAt.toISOString(),
        imageStatus: detail.imageStatus ?? '',
      });
    }
    assertNextToken(currentToken, page.nextToken, seenTokens);
    nextToken = page.nextToken;
  } while (nextToken !== undefined);
  return images;
}

async function listSubjectReferrers(
  operations: EcrRetentionAwsOperations,
  config: EcrRetentionRuntimeConfig,
  repositoryName: string,
  subjectDigest: string,
): Promise<readonly Record<string, unknown>[]> {
  const referrers: Record<string, unknown>[] = [];
  const seenTokens = new Set<string>();
  let nextToken: string | undefined;
  do {
    const currentToken = nextToken;
    const page = await operations.listImageReferrers({
      registryId: config.handler.expectedAccountId,
      repositoryName,
      subjectId: { imageDigest: subjectDigest },
      filter: { artifactStatus: 'ANY' },
      maxResults: 50,
      ...(currentToken === undefined ? {} : { nextToken: currentToken }),
    });
    for (const referrer of page.referrers ?? []) {
      referrers.push({
        artifactDigest: referrer.digest ?? '',
        artifactStatus: referrer.artifactStatus ?? '',
        artifactType: referrer.artifactType ?? '',
        mediaType: referrer.mediaType ?? '',
      });
    }
    assertNextToken(currentToken, page.nextToken, seenTokens);
    nextToken = page.nextToken;
  } while (nextToken !== undefined);
  return referrers;
}

async function repositoryObservation(
  operations: EcrRetentionAwsOperations,
  config: EcrRetentionRuntimeConfig,
  kind: RepositoryKind,
  protectedDigests: readonly string[],
): Promise<Record<string, unknown>> {
  const repositoryName = config.handler.repositories[kind];
  const images = await listRepositoryImages(operations, config, repositoryName);
  const subjectDigests = images
    .filter(
      (image) =>
        image['artifactMediaType'] === SUBJECT_ARTIFACT_MEDIA_TYPE &&
        image['imageManifestMediaType'] === SUBJECT_MANIFEST_MEDIA_TYPE,
    )
    .map((image) => String(image['imageDigest']));
  const referrers = [];
  for (const subjectDigest of subjectDigests) {
    referrers.push({
      paginationComplete: true,
      referrers: await listSubjectReferrers(operations, config, repositoryName, subjectDigest),
      subjectDigest,
    });
  }
  return {
    images,
    paginationComplete: true,
    protectedDigests: [...protectedDigests].sort(),
    referrers,
    repositoryName,
  };
}

async function pipelineActivity(operations: EcrRetentionAwsOperations, pipelines: readonly string[]): Promise<boolean> {
  let active = false;
  for (const pipelineName of pipelines) {
    const seenTokens = new Set<string>();
    let nextToken: string | undefined;
    do {
      const currentToken = nextToken;
      const page = await operations.listPipelineExecutions({
        pipelineName,
        maxResults: 100,
        ...(currentToken === undefined ? {} : { nextToken: currentToken }),
      });
      for (const execution of page.pipelineExecutionSummaries ?? []) {
        if (execution.status === undefined || !KNOWN_PIPELINE_STATUSES.has(execution.status)) {
          throw new Error('CodePipeline activity status is missing or unknown.');
        }
        active ||= ACTIVE_PIPELINE_STATUSES.has(execution.status);
      }
      assertNextToken(currentToken, page.nextToken, seenTokens);
      nextToken = page.nextToken;
    } while (nextToken !== undefined);
  }
  return active;
}

function chunk<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function buildActivity(operations: EcrRetentionAwsOperations, projects: readonly string[]): Promise<boolean> {
  let active = false;
  for (const projectName of projects) {
    const seenTokens = new Set<string>();
    const seenIds = new Set<string>();
    let nextToken: string | undefined;
    do {
      const currentToken = nextToken;
      const page = await operations.listBuildsForProject({
        projectName,
        ...(currentToken === undefined ? {} : { nextToken: currentToken }),
      });
      const ids = page.ids ?? [];
      if (ids.some((id) => seenIds.has(id)) || new Set(ids).size !== ids.length) {
        throw new Error('CodeBuild activity IDs contain duplicates.');
      }
      for (const id of ids) seenIds.add(id);
      for (const idBatch of chunk(ids, 100)) {
        const buildPage = await operations.batchGetBuilds({ ids: [...idBatch] });
        const builds = buildPage.builds ?? [];
        const observedIds = builds.map((build) => build.id);
        if (
          builds.length !== idBatch.length ||
          buildPage.buildsNotFound?.length ||
          observedIds.some((id) => id === undefined || !idBatch.includes(id)) ||
          new Set(observedIds).size !== observedIds.length ||
          idBatch.some((id) => !observedIds.includes(id))
        ) {
          throw new Error('CodeBuild activity coverage is incomplete.');
        }
        for (const build of builds) {
          if (
            build.id === undefined ||
            build.buildStatus === undefined ||
            !KNOWN_BUILD_STATUSES.has(build.buildStatus)
          ) {
            throw new Error('CodeBuild activity result or status is invalid.');
          }
          active ||= ACTIVE_BUILD_STATUSES.has(build.buildStatus);
        }
      }
      assertNextToken(currentToken, page.nextToken, seenTokens);
      nextToken = page.nextToken;
    } while (nextToken !== undefined);
  }
  return active;
}

async function stateMachineActivity(operations: EcrRetentionAwsOperations, stateMachineArn: string): Promise<boolean> {
  const page = await operations.listExecutions({ stateMachineArn, statusFilter: 'RUNNING', maxResults: 100 });
  return (page.executions?.length ?? 0) > 0 || page.nextToken !== undefined;
}

async function ecsActivity(operations: EcrRetentionAwsOperations, config: EcrRetentionRuntimeConfig): Promise<boolean> {
  let active = false;
  for (const desiredStatus of ['PENDING', 'RUNNING'] as const) {
    const page = await operations.listTasks({
      cluster: config.ecsClusterName,
      family: config.ecsTaskFamily,
      desiredStatus,
      maxResults: 100,
    });
    active ||= (page.taskArns?.length ?? 0) > 0 || page.nextToken !== undefined;
  }
  return active;
}

export function createEcrRetentionAwsDependencies(
  operations: EcrRetentionAwsOperations,
  config: EcrRetentionRuntimeConfig,
  readAuthority: () => Promise<EcrRetentionProtectionAuthority>,
): EcrRetentionDependencies {
  return {
    getCallerAccountId: async () => (await operations.getCallerIdentity()).Account ?? '',
    observeActivity: async () => ({
      codeBuild: await buildActivity(operations, config.candidateProjects),
      codePipeline: await pipelineActivity(operations, config.pipelines),
      ecs: await ecsActivity(operations, config),
      stepFunctions: await stateMachineActivity(operations, config.stateMachineArn),
    }),
    observe: async () => {
      const authority = await readAuthority();
      return {
        authoritySnapshotSha256: authority.authoritySnapshotSha256,
        repositories: {
          prover: await repositoryObservation(operations, config, 'prover', authority.protectedDigests.prover),
          toolchain: await repositoryObservation(operations, config, 'toolchain', authority.protectedDigests.toolchain),
        },
      };
    },
    observeAuthoritySnapshotSha256: async () => (await readAuthority()).authoritySnapshotSha256,
    deleteImages: async (request) => {
      const result = await operations.batchDeleteImage({
        registryId: config.handler.expectedAccountId,
        repositoryName: request.repositoryName,
        imageIds: request.imageDigests.map((imageDigest) => ({ imageDigest })),
      });
      return {
        deletedImageDigests: (result.imageIds ?? []).map((imageId) => imageId.imageDigest ?? ''),
        failures: (result.failures ?? []).map((failure) => ({
          failureCode: failure.failureCode ?? '',
          imageDigest: failure.imageId?.imageDigest ?? '',
        })),
      };
    },
    readImagePresence: async (request) => {
      const images = await listRepositoryImages(operations, config, request.repositoryName);
      const existing = new Set(images.map((image) => String(image['imageDigest'])));
      const activeSubjects = new Set(
        images
          .filter(
            (image) =>
              image['artifactMediaType'] === SUBJECT_ARTIFACT_MEDIA_TYPE &&
              image['imageManifestMediaType'] === SUBJECT_MANIFEST_MEDIA_TYPE &&
              image['imageStatus'] === 'ACTIVE',
          )
          .map((image) => String(image['imageDigest'])),
      );
      return {
        existingExpectedAbsentDigests: request.expectedAbsentDigests.filter((digest) => existing.has(digest)),
        missingExpectedPresentDigests: request.expectedPresentDigests.filter((digest) => !activeSubjects.has(digest)),
      };
    },
  };
}

function isRetryableEvidence(value: EcrRetentionEvidence): boolean {
  return (
    value.disposition === 'delete-failed' ||
    value.disposition === 'delete-unverified' ||
    value.blockers.some((blocker) => RETRYABLE_BLOCKERS.has(blocker))
  );
}

export async function runEcrRetentionBoundary(
  execute: (event: unknown) => Promise<EcrRetentionEvidence>,
  event: unknown,
  logEvidence: (evidence: EcrRetentionEvidence) => void,
): Promise<EcrRetentionEvidence> {
  const evidence = await execute(event);
  logEvidence(evidence);
  if (isRetryableEvidence(evidence)) {
    throw new Error('ECR retention transient failure');
  }
  return evidence;
}

interface AuthorityObjectReference extends ImmutableObjectReference {
  readonly bucket: string;
}

interface AuthorityObjectRead {
  readonly reference: AuthorityObjectReference;
  readonly value: unknown;
}

function asRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as { readonly [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

async function bodyBytes(output: AwsResponse<GetObjectCommandOutput>): Promise<Uint8Array> {
  if (output.Body === undefined) throw new Error('S3 authority object body is missing.');
  if (
    !Number.isSafeInteger(output.ContentLength) ||
    (output.ContentLength ?? 0) <= 0 ||
    (output.ContentLength ?? 0) > MAX_AUTHORITY_OBJECT_BYTES
  ) {
    throw new Error('S3 authority object ContentLength is invalid.');
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const append = (part: unknown): void => {
    if (!(part instanceof Uint8Array)) throw new Error('S3 authority object body emitted an unsupported chunk.');
    totalBytes += part.byteLength;
    if (totalBytes > MAX_AUTHORITY_OBJECT_BYTES) throw new Error('S3 authority object exceeds the byte limit.');
    chunks.push(part);
  };

  if (output.Body instanceof Uint8Array) {
    append(output.Body);
  } else if (isAsyncIterable(output.Body)) {
    for await (const part of output.Body) append(part);
  } else {
    throw new Error('S3 authority object body is not a bounded byte stream.');
  }
  if (output.ContentLength !== totalBytes) {
    throw new Error('S3 authority object ContentLength does not match its body.');
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of chunks) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

async function readAuthorityObject(
  operations: EcrRetentionAwsOperations,
  request: Readonly<{
    bucket: string;
    expectedBucketOwner: string;
    expectedSha256?: string;
    key: string;
    versionId?: string;
  }>,
): Promise<AuthorityObjectRead> {
  const expectedVersionId =
    request.versionId === undefined ? undefined : parseS3VersionId(request.versionId, 'authority object VersionId');
  const expectedSha256 =
    request.expectedSha256 === undefined ? undefined : parseSha256(request.expectedSha256, 'authority object SHA-256');
  const output = await operations.getObject({
    Bucket: request.bucket,
    ExpectedBucketOwner: request.expectedBucketOwner,
    Key: request.key,
    ...(expectedVersionId === undefined ? {} : { VersionId: expectedVersionId }),
  });
  const observedVersionId = parseS3VersionId(output.VersionId, 'observed authority object VersionId');
  if (expectedVersionId !== undefined && observedVersionId !== expectedVersionId) {
    throw new Error('Observed authority object VersionId does not match its immutable reference.');
  }
  const bytes = await bodyBytes(output);
  const observedSha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 !== undefined && observedSha256 !== expectedSha256) {
    throw new Error('Observed authority object SHA-256 does not match its immutable reference.');
  }
  let body: string;
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error('S3 authority object body is not valid UTF-8.', { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error('S3 authority object body is not valid JSON.', { cause: error });
  }
  const canonicalBytes = new TextEncoder().encode(canonicalRecordJson(value));
  if (canonicalBytes.byteLength !== bytes.byteLength || canonicalBytes.some((byte, index) => byte !== bytes[index])) {
    throw new Error('S3 authority object body must use canonical JSON bytes.');
  }
  return Object.freeze({
    reference: Object.freeze({
      bucket: request.bucket,
      key: request.key,
      sha256: observedSha256,
      versionId: observedVersionId,
    }),
    value,
  });
}

function pointerRecordReference(
  pointer: Readonly<Record<string, unknown>>,
  kind: RepositoryKind,
): ImmutableObjectReference {
  const prefix = kind === 'toolchain' ? 'artifactRecord' : 'releaseRecord';
  return parseImmutableObjectReference({
    key: pointer[`${prefix}Key`],
    sha256: pointer[`${prefix}Sha256`],
    versionId: pointer[`${prefix}VersionId`],
  });
}

function appManifestReference(entry: Readonly<Record<string, unknown>>): ImmutableObjectReference {
  return parseImmutableObjectReference({
    key: entry['manifestPath'],
    sha256: entry['manifestSha256'],
    versionId: entry['manifestVersionId'],
  });
}

function immutableReferencesEqual(left: ImmutableObjectReference, right: ImmutableObjectReference): boolean {
  return left.key === right.key && left.sha256 === right.sha256 && left.versionId === right.versionId;
}

function selectedToolchainReference(value: ProverProtectionRecord['selectedToolchain']): ImmutableObjectReference {
  return parseImmutableObjectReference({ key: value.key, sha256: value.sha256, versionId: value.versionId });
}

function authorityReferenceKey(reference: AuthorityObjectReference): string {
  return `${reference.bucket}\0${reference.key}\0${reference.versionId}\0${reference.sha256}`;
}

async function readLiveProverImage(
  operations: EcrRetentionAwsOperations,
  config: EcrRetentionRuntimeConfig,
  policy: DigestPinnedImagePolicy,
): Promise<Readonly<Record<string, unknown>> & { readonly imageDigest: string }> {
  const stateMachine = await operations.describeStateMachine({ stateMachineArn: config.stateMachineArn });
  if (
    stateMachine.stateMachineArn !== config.stateMachineArn ||
    stateMachine.status !== 'ACTIVE' ||
    typeof stateMachine.definition !== 'string'
  ) {
    throw new Error('Live Prover state machine identity or definition is invalid.');
  }
  let definitionValue: unknown;
  try {
    definitionValue = JSON.parse(stateMachine.definition) as unknown;
  } catch (error) {
    throw new Error('Live Prover state machine definition is not valid JSON.', { cause: error });
  }
  const definition = asRecord(definitionValue, 'Live Prover state machine definition');
  const states = asRecord(definition['States'], 'Live Prover state machine states');
  const runProver = asRecord(states['RunProver'], 'Live Prover RunProver state');
  const parameters = asRecord(runProver['Parameters'], 'Live Prover RunProver parameters');
  const taskDefinitionArn = parameters['TaskDefinition'];
  const expectedClusterArn =
    `arn:aws:ecs:${config.handler.expectedRegion}:${config.handler.expectedAccountId}:cluster/` + config.ecsClusterName;
  const expectedTaskPrefix =
    `arn:aws:ecs:${config.handler.expectedRegion}:${config.handler.expectedAccountId}:task-definition/` +
    `${config.ecsTaskFamily}:`;
  if (
    runProver['Type'] !== 'Task' ||
    runProver['Resource'] !== 'arn:aws:states:::ecs:runTask.sync' ||
    parameters['Cluster'] !== expectedClusterArn ||
    typeof taskDefinitionArn !== 'string' ||
    !taskDefinitionArn.startsWith(expectedTaskPrefix) ||
    !/^\d+$/u.test(taskDefinitionArn.slice(expectedTaskPrefix.length))
  ) {
    throw new Error('Live Prover RunProver task-definition authority is invalid.');
  }
  const described = await operations.describeTaskDefinition({ taskDefinition: taskDefinitionArn });
  const taskDefinition = described.taskDefinition;
  const taskDefinitionRevision =
    typeof taskDefinitionArn === 'string' ? Number(taskDefinitionArn.slice(expectedTaskPrefix.length)) : Number.NaN;
  if (
    taskDefinition === undefined ||
    taskDefinition.taskDefinitionArn !== taskDefinitionArn ||
    taskDefinition.family !== config.ecsTaskFamily ||
    taskDefinition.status !== 'ACTIVE' ||
    !Number.isSafeInteger(taskDefinition.revision) ||
    (taskDefinition.revision ?? 0) <= 0 ||
    taskDefinition.revision !== taskDefinitionRevision
  ) {
    throw new Error('Live Prover ECS task definition identity is invalid.');
  }
  const proverContainers = (taskDefinition.containerDefinitions ?? []).filter(
    (container) => container.name === 'prover',
  );
  if (proverContainers.length !== 1 || typeof proverContainers[0]?.image !== 'string') {
    throw new Error('Live Prover ECS task definition must contain one exact prover container.');
  }
  const image = parseDigestPinnedImageReference(proverContainers[0].image, policy);
  return Object.freeze({
    imageDigest: image.digest,
    imageUri: image.imageUri,
    stateMachineArn: config.stateMachineArn,
    stateMachineDefinitionSha256: createHash('sha256').update(stateMachine.definition, 'utf8').digest('hex'),
    taskDefinitionArn,
    taskDefinitionRevision: taskDefinition.revision,
  });
}

export function createEcrRetentionProtectionAuthorityReader(
  operations: EcrRetentionAwsOperations,
  config: EcrRetentionRuntimeConfig,
  validators: EcrRetentionAuthorityValidators = DEFAULT_AUTHORITY_VALIDATORS,
): () => Promise<EcrRetentionProtectionAuthority> {
  return async () => readProtectionAuthority(operations, config, validators);
}

async function readProtectionAuthority(
  operations: EcrRetentionAwsOperations,
  config: EcrRetentionRuntimeConfig,
  validators: EcrRetentionAuthorityValidators,
): Promise<EcrRetentionProtectionAuthority> {
  const imagePolicies = Object.freeze({
    prover: Object.freeze({
      accountId: config.handler.expectedAccountId,
      partition: 'aws' as const,
      region: config.handler.expectedRegion,
      repository: config.handler.repositories.prover,
    }),
    toolchain: Object.freeze({
      accountId: config.handler.expectedAccountId,
      partition: 'aws' as const,
      region: config.handler.expectedRegion,
      repository: config.handler.repositories.toolchain,
    }),
  });
  const protectedDigests = {
    prover: new Set<string>(),
    toolchain: new Set<string>(),
  };
  const currentReferences: AuthorityObjectReference[] = [];
  const immutableReferences = new Map<string, AuthorityObjectReference>();
  const immutableReads = new Map<string, Promise<AuthorityObjectRead>>();

  const readImmutable = (bucket: string, rawReference: unknown): Promise<AuthorityObjectRead> => {
    const reference = parseImmutableObjectReference(rawReference);
    const cacheKey = `${bucket}\0${reference.key}\0${reference.versionId}\0${reference.sha256}`;
    let result = immutableReads.get(cacheKey);
    if (result === undefined) {
      result = readAuthorityObject(operations, {
        bucket,
        expectedBucketOwner: config.handler.expectedAccountId,
        expectedSha256: reference.sha256,
        key: reference.key,
        versionId: reference.versionId,
      });
      immutableReads.set(cacheKey, result);
    }
    return result.then((read) => {
      immutableReferences.set(authorityReferenceKey(read.reference), read.reference);
      return read;
    });
  };

  const toolchainRecords = new Map<string, Promise<ToolchainProtectionRecord>>();
  const readToolchain = async (rawReference: unknown): Promise<ToolchainProtectionRecord> => {
    const reference = parseImmutableObjectReference(rawReference);
    const key = `${reference.key}\0${reference.versionId}\0${reference.sha256}`;
    let result = toolchainRecords.get(key);
    if (result === undefined) {
      result = readImmutable(config.releaseAuthorityBucket, reference).then((read) =>
        validators.toolchainArtifact(read.value, imagePolicies.toolchain),
      );
      toolchainRecords.set(key, result);
    }
    const record = await result;
    protectedDigests.toolchain.add(record.imageDigest);
    return record;
  };

  const proverRecords = new Map<string, Promise<ProverProtectionRecord>>();
  const readProver = async (rawReference: unknown): Promise<ProverProtectionRecord> => {
    const reference = parseImmutableObjectReference(rawReference);
    const key = `${reference.key}\0${reference.versionId}\0${reference.sha256}`;
    let result = proverRecords.get(key);
    if (result === undefined) {
      result = readImmutable(config.releaseAuthorityBucket, reference).then((read) =>
        validators.proverRelease(read.value, imagePolicies),
      );
      proverRecords.set(key, result);
    }
    const record = await result;
    protectedDigests.prover.add(record.imageDigest);
    const selectedToolchain = await readToolchain(selectedToolchainReference(record.selectedToolchain));
    if (
      selectedToolchain.imageDigest !== record.selectedToolchain.imageDigest ||
      selectedToolchain.imageUri !== record.selectedToolchain.imageUri
    ) {
      throw new Error('Prover release selected Toolchain authority is inconsistent.');
    }
    return record;
  };

  const readCurrent = async (bucket: string, key: string): Promise<AuthorityObjectRead> => {
    const read = await readAuthorityObject(operations, {
      bucket,
      expectedBucketOwner: config.handler.expectedAccountId,
      key,
    });
    currentReferences.push(read.reference);
    return read;
  };

  const toolchainPointerRead = await readCurrent(config.releaseAuthorityBucket, config.acceptedPointerKeys.toolchain);
  const toolchainPointer = validators.acceptedReleasePointer(toolchainPointerRead.value, 'toolchain');
  await readToolchain(pointerRecordReference(toolchainPointer, 'toolchain'));

  const proverPointerRead = await readCurrent(config.releaseAuthorityBucket, config.acceptedPointerKeys.prover);
  const proverPointer = validators.acceptedReleasePointer(proverPointerRead.value, 'prover');
  await readProver(pointerRecordReference(proverPointer, 'prover'));

  const appAuthorityRead = await readCurrent(config.appAcceptedAuthorityBucket, config.appAcceptedAuthorityKey);
  const appAuthority = validators.acceptedCurrent(appAuthorityRead.value);
  const acceptedDeployments = appAuthority['acceptedDeployments'];
  if (!Array.isArray(acceptedDeployments) || acceptedDeployments.length === 0 || acceptedDeployments.length > 10) {
    throw new Error('Accepted App deployment protection authority must retain between one and ten records.');
  }
  for (const entryValue of acceptedDeployments) {
    const entry = asRecord(entryValue, 'Accepted App deployment authority entry');
    const manifestReference = appManifestReference(entry);
    const manifestRead = await readImmutable(config.appAcceptedAuthorityBucket, manifestReference);
    const projection = validators.acceptedProjection(manifestRead.value, entry, {
      expectedManifestSha256: manifestReference.sha256,
    });
    const releaseAuthority = asRecord(
      projection.accepted.releaseAuthority,
      'Accepted App deployment release authority',
    );
    const toolchainReference = parseImmutableObjectReference(releaseAuthority['toolchainArtifactRecord']);
    const proverReference = parseImmutableObjectReference(releaseAuthority['proverReleaseRecord']);
    const [toolchainRecord, proverRecord] = await Promise.all([
      readToolchain(toolchainReference),
      readProver(proverReference),
    ]);
    if (
      !immutableReferencesEqual(toolchainReference, proverRecord.selectedToolchain) ||
      toolchainRecord.imageDigest !== proverRecord.selectedToolchain.imageDigest ||
      toolchainRecord.imageUri !== proverRecord.selectedToolchain.imageUri ||
      releaseAuthority['proverImageUri'] !== proverRecord.imageUri
    ) {
      throw new Error('Accepted App deployment release authority is not a closed Prover/Toolchain selection.');
    }
  }

  const liveProver = await readLiveProverImage(operations, config, imagePolicies.prover);
  protectedDigests.prover.add(liveProver.imageDigest);
  const sortedCurrentReferences = [...currentReferences].sort((left, right) =>
    authorityReferenceKey(left).localeCompare(authorityReferenceKey(right)),
  );
  const sortedImmutableReferences = [...immutableReferences.values()].sort((left, right) =>
    authorityReferenceKey(left).localeCompare(authorityReferenceKey(right)),
  );
  const sortedProtectedDigests = Object.freeze({
    prover: Object.freeze([...protectedDigests.prover].sort()),
    toolchain: Object.freeze([...protectedDigests.toolchain].sort()),
  });
  return Object.freeze({
    authoritySnapshotSha256: canonicalJsonSha256({
      currentReferences: sortedCurrentReferences,
      immutableReferences: sortedImmutableReferences,
      liveProver,
      protectedDigests: sortedProtectedDigests,
      targetKey: config.handler.targetKey,
    }),
    protectedDigests: sortedProtectedDigests,
  });
}

let resolvedHandler: ((event: unknown) => Promise<EcrRetentionEvidence>) | undefined;

export async function handler(event: unknown): Promise<EcrRetentionEvidence> {
  try {
    if (resolvedHandler === undefined) {
      const config = parseEcrRetentionRuntimeConfig(process.env);
      const operations = createDefaultOperations(config.handler.expectedRegion);
      const dependencies = createEcrRetentionAwsDependencies(
        operations,
        config,
        createEcrRetentionProtectionAuthorityReader(operations, config),
      );
      resolvedHandler = createEcrRetentionHandler(dependencies, config.handler);
    }
    return await runEcrRetentionBoundary(resolvedHandler, event, (evidence) => {
      logger.info('ECR retention evidence', { evidence });
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'ECR retention transient failure') throw error;
    logger.error('ECR retention boundary failed', { reason: 'runtime_initialization_failed' });
    throw new Error('ECR retention runtime failure');
  }
}
