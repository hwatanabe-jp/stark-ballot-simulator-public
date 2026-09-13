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
  parseS3VersionId,
  parseSha256,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  type DigestPinnedImagePolicy,
  type ImmutableObjectReference,
} from '@stark-ballot/deployment-authority';
import {
  PROVER_RELEASE_KIND,
  TOOLCHAIN_RELEASE_KIND,
  createReleaseLedger,
} from '@stark-ballot/deployment-authority/release-ledger';
import { logger } from '@stark-ballot/diagnostics/logger';
import { createHash } from 'node:crypto';
import {
  bindAppAcceptanceSelection,
  admitAppCurrentAcceptancePointer,
} from '@stark-ballot/deployment-authority/app-acceptance-ledger';
import {
  assertUnproxiedPortShell,
  captureExactPortRecord,
  invokeExactPort,
} from '@stark-ballot/deployment-authority/conditional-object-ledger';
import { snapshotDataTree, snapshotDenseArray } from '@stark-ballot/deployment-authority/descriptor-snapshot';
import { snapshotBoundedBytes } from '@stark-ballot/deployment-authority/exact-bytes';
import { projectAppEcrRetentionAuthority } from '../../terraform/bootstrap/app-acceptance-scripts/project-app-ecr-retention-authority.mjs';
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

type EcrRetentionAuthorityReadOperations = Readonly<
  Pick<EcrRetentionAwsOperations, 'describeStateMachine' | 'describeTaskDefinition' | 'getObject'>
>;

export interface EcrRetentionProtectionAuthority {
  readonly authoritySnapshotSha256: string;
  readonly protectedDigests: Readonly<Record<RepositoryKind, readonly string[]>>;
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
const APP_ACCEPTANCE_POINTER_MAX_BYTES = 64 * 1024;
const APP_ACCEPTANCE_RECORD_MAX_BYTES = 8 * 1024 * 1024;
const RELEASE_LEDGER_OBJECT_MAX_BYTES = 1024 * 1024;
const AUTHORITY_OPERATION_KEYS = [
  'batchDeleteImage',
  'batchGetBuilds',
  'describeImages',
  'describeStateMachine',
  'describeTaskDefinition',
  'getCallerIdentity',
  'getObject',
  'listBuildsForProject',
  'listExecutions',
  'listImageReferrers',
  'listPipelineExecutions',
  'listTasks',
] as const;
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
  const target = resolveAllowedDeploymentTarget(targetKey);
  const foundation = resolveDeploymentLaneAuthority(target, 'foundation');
  const appLane = resolveDeploymentLaneAuthority(target, 'app');
  const toolchainLane = resolveDeploymentLaneAuthority(target, 'toolchain');
  const proverLane = resolveDeploymentLaneAuthority(target, 'prover');
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
      targetKey: target.targetKey,
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
  readonly etag?: string;
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

function captureAuthorityOperations(operations: EcrRetentionAwsOperations): EcrRetentionAwsOperations {
  return captureExactPortRecord(
    operations,
    AUTHORITY_OPERATION_KEYS,
    'ECR retention authority operations',
  ) as unknown as EcrRetentionAwsOperations;
}

function projectAuthorityReadOperations(operations: EcrRetentionAwsOperations): EcrRetentionAuthorityReadOperations {
  return Object.freeze({
    describeStateMachine: operations.describeStateMachine,
    describeTaskDefinition: operations.describeTaskDefinition,
    getObject: operations.getObject,
  });
}

function rejectThenDescriptor(value: object, label: string): void {
  let current: object | null = value;
  while (current !== null) {
    if (Reflect.getOwnPropertyDescriptor(current, 'then') !== undefined) {
      throw new Error(`${label} must not be thenable.`);
    }
    current = Reflect.getPrototypeOf(current);
  }
}

function admitPlainDescriptorRecord(value: unknown, label: string): object {
  assertUnproxiedPortShell(value, label);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  rejectThenDescriptor(value, label);
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must use a plain object prototype.`);
  }
  return value;
}

function ownDataProperty(value: object, key: string, label: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(`${label} ${key} must be an own data property.`);
  }
  return descriptor.value;
}

function requiredOwnDataProperty(value: object, key: string, label: string): unknown {
  const result = ownDataProperty(value, key, label);
  if (result === undefined) throw new Error(`${label} ${key} is required.`);
  return result;
}

function requiredStringDataProperty(value: object, key: string, label: string): string {
  const result = requiredOwnDataProperty(value, key, label);
  if (typeof result !== 'string') throw new Error(`${label} ${key} must be a string.`);
  return result;
}

interface ProjectedStateMachineDescription {
  readonly definition: string;
  readonly stateMachineArn: string;
  readonly status: string;
}

function projectStateMachineDescription(value: unknown): ProjectedStateMachineDescription {
  const label = 'ECR retention describeStateMachine result';
  const response = admitPlainDescriptorRecord(value, label);
  return Object.freeze({
    definition: requiredStringDataProperty(response, 'definition', label),
    stateMachineArn: requiredStringDataProperty(response, 'stateMachineArn', label),
    status: requiredStringDataProperty(response, 'status', label),
  });
}

interface ProjectedContainerDefinition {
  readonly image: string;
  readonly name: string;
}

interface ProjectedTaskDefinitionDescription {
  readonly taskDefinition: Readonly<{
    readonly containerDefinitions: readonly ProjectedContainerDefinition[];
    readonly family: string;
    readonly revision: number;
    readonly status: string;
    readonly taskDefinitionArn: string;
  }>;
}

interface ProjectedGetObjectResponse {
  readonly Body?: unknown;
  readonly ContentLength?: number;
  readonly ETag?: string;
  readonly VersionId?: string;
}

function projectContainerDefinition(value: unknown, index: number): ProjectedContainerDefinition {
  const label = `ECR retention task containerDefinitions[${index}]`;
  const container = admitPlainDescriptorRecord(value, label);
  return Object.freeze({
    image: requiredStringDataProperty(container, 'image', label),
    name: requiredStringDataProperty(container, 'name', label),
  });
}

function projectTaskDefinitionDescription(value: unknown): ProjectedTaskDefinitionDescription {
  const resultLabel = 'ECR retention describeTaskDefinition result';
  const response = admitPlainDescriptorRecord(value, resultLabel);
  const taskDefinitionLabel = 'ECR retention task definition';
  const taskDefinition = admitPlainDescriptorRecord(
    requiredOwnDataProperty(response, 'taskDefinition', resultLabel),
    taskDefinitionLabel,
  );
  const rawContainerDefinitions = requiredOwnDataProperty(taskDefinition, 'containerDefinitions', taskDefinitionLabel);
  assertUnproxiedPortShell(rawContainerDefinitions, 'ECR retention task containerDefinitions');
  if (!Array.isArray(rawContainerDefinitions)) {
    throw new Error('ECR retention task containerDefinitions must use a dense array.');
  }
  if (Reflect.getPrototypeOf(rawContainerDefinitions) !== Array.prototype) {
    throw new Error('ECR retention task containerDefinitions must use the exact array prototype.');
  }
  rejectThenDescriptor(rawContainerDefinitions, 'ECR retention task containerDefinitions');
  const containerDefinitions = Object.freeze(
    snapshotDenseArray(rawContainerDefinitions, 'ECR retention task containerDefinitions').map((container, index) =>
      projectContainerDefinition(container, index),
    ),
  );
  const revision = requiredOwnDataProperty(taskDefinition, 'revision', taskDefinitionLabel);
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error('ECR retention task definition revision must be a positive safe integer.');
  }
  return Object.freeze({
    taskDefinition: Object.freeze({
      containerDefinitions,
      family: requiredStringDataProperty(taskDefinition, 'family', taskDefinitionLabel),
      revision,
      status: requiredStringDataProperty(taskDefinition, 'status', taskDefinitionLabel),
      taskDefinitionArn: requiredStringDataProperty(taskDefinition, 'taskDefinitionArn', taskDefinitionLabel),
    }),
  });
}

function admitGetObjectResponse(value: unknown, maxBytes: number): ProjectedGetObjectResponse {
  const label = 'ECR retention authority getObject result';
  const response = admitPlainDescriptorRecord(value, label);
  const body = ownDataProperty(response, 'Body', 'ECR retention authority getObject result');
  assertUnproxiedPortShell(body, 'ECR retention authority object body');
  const admitted: {
    Body?: unknown;
    ContentLength?: number;
    ETag?: string;
    VersionId?: string;
  } = {};
  if (body instanceof Uint8Array) {
    admitted.Body = snapshotBoundedBytes(body, {
      label: 'ECR retention authority direct object body',
      maxBytes,
    });
  } else if (body !== undefined) {
    admitted.Body = body;
  }
  const contentLength = ownDataProperty(response, 'ContentLength', 'ECR retention authority getObject result');
  if (contentLength !== undefined) {
    if (typeof contentLength !== 'number') throw new Error(`${label} ContentLength must be a number.`);
    admitted.ContentLength = contentLength;
  }
  const etag = ownDataProperty(response, 'ETag', 'ECR retention authority getObject result');
  if (etag !== undefined) {
    if (typeof etag !== 'string') throw new Error(`${label} ETag must be a string.`);
    admitted.ETag = etag;
  }
  const versionId = ownDataProperty(response, 'VersionId', 'ECR retention authority getObject result');
  if (versionId !== undefined) {
    if (typeof versionId !== 'string') throw new Error(`${label} VersionId must be a string.`);
    admitted.VersionId = versionId;
  }
  return Object.freeze(admitted);
}

async function bodyBytes(output: ProjectedGetObjectResponse, maxBytes: number): Promise<Uint8Array> {
  if (output.Body === undefined) throw new Error('S3 authority object body is missing.');
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(output.ContentLength) ||
    (output.ContentLength ?? 0) <= 0 ||
    (output.ContentLength ?? 0) > maxBytes
  ) {
    throw new Error('S3 authority object ContentLength is invalid.');
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const append = (part: unknown): void => {
    const remainingBytes = maxBytes - totalBytes;
    const chunk = snapshotBoundedBytes(part, {
      label: 'S3 authority object stream chunk',
      maxBytes: remainingBytes,
    });
    totalBytes += chunk.byteLength;
    chunks.push(chunk);
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
  operations: EcrRetentionAuthorityReadOperations,
  request: Readonly<{
    bucket: string;
    expectedBucketOwner: string;
    expectedSha256?: string;
    key: string;
    maxBytes: number;
    requireEtag?: boolean;
    versionId?: string;
  }>,
): Promise<AuthorityObjectRead> {
  const expectedVersionId =
    request.versionId === undefined ? undefined : parseS3VersionId(request.versionId, 'authority object VersionId');
  const expectedSha256 =
    request.expectedSha256 === undefined ? undefined : parseSha256(request.expectedSha256, 'authority object SHA-256');
  const output = await invokeExactPort(
    operations.getObject,
    [
      {
        Bucket: request.bucket,
        ExpectedBucketOwner: request.expectedBucketOwner,
        Key: request.key,
        ...(expectedVersionId === undefined ? {} : { VersionId: expectedVersionId }),
      },
    ],
    'ECR retention authority getObject',
    (value) => admitGetObjectResponse(value, request.maxBytes),
  );
  const observedVersionId = parseS3VersionId(output.VersionId, 'observed authority object VersionId');
  const observedEtag = output.ETag;
  if (
    request.requireEtag === true &&
    (typeof observedEtag !== 'string' || observedEtag.length === 0 || observedEtag.trim() !== observedEtag)
  ) {
    throw new Error('Observed authority object ETag is invalid.');
  }
  if (expectedVersionId !== undefined && observedVersionId !== expectedVersionId) {
    throw new Error('Observed authority object VersionId does not match its immutable reference.');
  }
  const bytes = await bodyBytes(output, request.maxBytes);
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
    ...(observedEtag === undefined ? {} : { etag: observedEtag }),
    value,
  });
}

function authorityReferenceKey(reference: AuthorityObjectReference): string {
  return `${reference.bucket}\0${reference.key}\0${reference.versionId}\0${reference.sha256}`;
}

function requiredAuthorityEtag(read: AuthorityObjectRead, label: string): string {
  if (typeof read.etag !== 'string') {
    throw new Error(`${label} ETag is invalid.`);
  }
  return read.etag;
}

async function readLiveProverImage(
  operations: EcrRetentionAuthorityReadOperations,
  config: EcrRetentionRuntimeConfig,
  policy: DigestPinnedImagePolicy,
): Promise<Readonly<Record<string, unknown>> & { readonly imageDigest: string }> {
  const stateMachine = await invokeExactPort(
    operations.describeStateMachine,
    [{ stateMachineArn: config.stateMachineArn }],
    'ECR retention describeStateMachine',
    projectStateMachineDescription,
  );
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
  const definition = asRecord(
    snapshotDataTree(definitionValue, 'Live Prover state machine definition snapshot'),
    'Live Prover state machine definition',
  );
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
  const described = await invokeExactPort(
    operations.describeTaskDefinition,
    [{ taskDefinition: taskDefinitionArn }],
    'ECR retention describeTaskDefinition',
    projectTaskDefinitionDescription,
  );
  const taskDefinition = described.taskDefinition;
  const taskDefinitionRevision = Number(taskDefinitionArn.slice(expectedTaskPrefix.length));
  if (
    taskDefinition.taskDefinitionArn !== taskDefinitionArn ||
    taskDefinition.family !== config.ecsTaskFamily ||
    taskDefinition.status !== 'ACTIVE' ||
    taskDefinition.revision !== taskDefinitionRevision
  ) {
    throw new Error('Live Prover ECS task definition identity is invalid.');
  }
  const proverContainers = taskDefinition.containerDefinitions.filter((container) => container.name === 'prover');
  const proverContainer = proverContainers[0];
  if (proverContainers.length !== 1 || proverContainer === undefined) {
    throw new Error('Live Prover ECS task definition must contain one exact prover container.');
  }
  const image = parseDigestPinnedImageReference(proverContainer.image, policy);
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
): () => Promise<EcrRetentionProtectionAuthority> {
  const capturedOperations = captureAuthorityOperations(operations);
  const authorityReadOperations = projectAuthorityReadOperations(capturedOperations);
  return async () => readProtectionAuthority(authorityReadOperations, config);
}

async function readProtectionAuthority(
  operations: EcrRetentionAuthorityReadOperations,
  config: EcrRetentionRuntimeConfig,
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

  const readCurrent = async (
    bucket: string,
    key: string,
    maxBytes: number,
    requireEtag = false,
  ): Promise<AuthorityObjectRead> => {
    const read = await readAuthorityObject(operations, {
      bucket,
      expectedBucketOwner: config.handler.expectedAccountId,
      key,
      maxBytes,
      requireEtag,
    });
    currentReferences.push(read.reference);
    return read;
  };

  const releaseLedger = createReleaseLedger(
    {
      getObject: async ({ key }: Readonly<{ key: string }>) => {
        const read = await readAuthorityObject(operations, {
          bucket: config.releaseAuthorityBucket,
          expectedBucketOwner: config.handler.expectedAccountId,
          key,
          maxBytes: RELEASE_LEDGER_OBJECT_MAX_BYTES,
          requireEtag: true,
        });
        const body = canonicalRecordJson(read.value);
        const reference = read.reference;
        if (key === config.acceptedPointerKeys.toolchain || key === config.acceptedPointerKeys.prover) {
          currentReferences.push(reference);
        } else {
          immutableReferences.set(authorityReferenceKey(reference), reference);
        }
        return {
          body,
          etag: read.etag,
          versionId: reference.versionId,
        };
      },
      putObject: () => {
        throw new Error('ECR retention release-ledger transport is read-only.');
      },
    },
    config.handler.targetKey,
  );
  const resolvedToolchain = await releaseLedger.resolvePointer(config.acceptedPointerKeys.toolchain);
  if (resolvedToolchain.record.kind !== TOOLCHAIN_RELEASE_KIND) {
    throw new Error('Current Toolchain authority did not resolve a Toolchain release.');
  }
  protectedDigests.toolchain.add(resolvedToolchain.record.imageDigest);

  const resolvedProver = await releaseLedger.resolvePointer(config.acceptedPointerKeys.prover);
  if (resolvedProver.record.kind !== PROVER_RELEASE_KIND) {
    throw new Error('Current Prover authority did not resolve a Prover release.');
  }
  protectedDigests.prover.add(resolvedProver.record.imageDigest);
  protectedDigests.toolchain.add(resolvedProver.record.selectedToolchainImageDigest);

  const appPointerRead = await readCurrent(
    config.appAcceptedAuthorityBucket,
    config.appAcceptedAuthorityKey,
    APP_ACCEPTANCE_POINTER_MAX_BYTES,
    true,
  );
  const appPointer = admitAppCurrentAcceptancePointer(appPointerRead.value, config.handler.targetKey);
  const appPointerObservation = Object.freeze({
    etag: requiredAuthorityEtag(appPointerRead, 'App acceptance pointer observation'),
    versionId: appPointerRead.reference.versionId,
  });
  const appRecordObservations: Array<Readonly<AuthorityObjectReference & { readonly etag: string }>> = [];
  const appSelections: unknown[] = [];
  for (const acceptanceKey of appPointer.history) {
    const acceptanceRead = await readAuthorityObject(operations, {
      bucket: config.appAcceptedAuthorityBucket,
      expectedBucketOwner: config.handler.expectedAccountId,
      key: acceptanceKey,
      maxBytes: APP_ACCEPTANCE_RECORD_MAX_BYTES,
      requireEtag: true,
    });
    immutableReferences.set(authorityReferenceKey(acceptanceRead.reference), acceptanceRead.reference);
    const acceptanceObservation = Object.freeze({
      etag: requiredAuthorityEtag(acceptanceRead, 'App acceptance record observation'),
      versionId: acceptanceRead.reference.versionId,
    });
    const selection = bindAppAcceptanceSelection(
      {
        pointer: appPointer,
        pointerObservation: appPointerObservation,
        recordKey: acceptanceKey,
        record: acceptanceRead.value,
        recordObservation: acceptanceObservation,
      },
      config.handler.targetKey,
    );
    appSelections.push(selection);
    appRecordObservations.push(
      Object.freeze({
        ...acceptanceRead.reference,
        etag: acceptanceObservation.etag,
      }),
    );
  }
  const appImageAuthority = projectAppEcrRetentionAuthority(
    {
      resolutionType: 'app-acceptance-history',
      pointerKey: config.appAcceptedAuthorityKey,
      pointer: appPointer,
      pointerObservation: appPointerObservation,
      selections: appSelections,
    },
    config.handler.targetKey,
  );
  for (const imageAuthorityValue of appImageAuthority.retainedImageAuthorities) {
    const imageAuthority = asRecord(imageAuthorityValue, 'Retained App image authority');
    const proverImageAuthority = asRecord(imageAuthority['proverImage'], 'Retained App Prover image authority');
    const toolchainImageAuthority = asRecord(
      imageAuthority['toolchainImage'],
      'Retained App Toolchain image authority',
    );
    const proverImage = parseDigestPinnedImageReference(proverImageAuthority['imageUri'], imagePolicies.prover);
    const toolchainImage = parseDigestPinnedImageReference(
      toolchainImageAuthority['imageUri'],
      imagePolicies.toolchain,
    );
    if (
      proverImage.digest !== proverImageAuthority['imageDigest'] ||
      toolchainImage.digest !== toolchainImageAuthority['imageDigest']
    ) {
      throw new Error('Retained App image authority digest is detached from its immutable image URI.');
    }
    protectedDigests.prover.add(proverImage.digest);
    protectedDigests.toolchain.add(toolchainImage.digest);
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
      appAcceptanceHistory: {
        pointer: {
          ...appPointerRead.reference,
          etag: appPointerObservation.etag,
        },
        records: appRecordObservations,
      },
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
