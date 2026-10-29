import { canonicalRecordJson, parseGitCommitSha, requireGroupedLowercaseUuid, requireRecord } from './internal.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import {
  canonicalAppDeploymentStatusJson,
  parseCanonicalAppDeploymentStatus,
  projectAppDeploymentStatus,
} from './app-deployment-status.js';
import { deriveRootCheckpointKey, parseRootCheckpoint } from './root-checkpoint.js';
import { assertObjectPrecondition } from './mutation-owner.js';
/** @typedef {import('./plan-package.js').ObjectObservation} ObjectObservation */
/** @typedef {{body:string,observation:ObjectObservation}} StoredObject */
/**
 * A status is a projection of acceptance, never a new acceptance. Equal
 * timestamps with different content are ambiguous and cannot replace one another.
 * @param {string} previousBody
 * @param {string} nextBody
 * @param {string} targetKey
 */
export function assertAppStatusPublicationOrder(previousBody, nextBody, targetKey) {
  const previous = parseCanonicalAppDeploymentStatus(previousBody, targetKey);
  const next = parseCanonicalAppDeploymentStatus(nextBody, targetKey);
  if (previousBody === nextBody) return;
  if (next.acceptedAt <= previous.acceptedAt)
    throw new Error('App status cannot replace newer or equally dated acceptance.');
}
/**
 * Asynchronous status delivery: immutable checkpoint observation, bounded public DTO,
 * a final current check and one CAS. A conflict fails this delivery; a bounded
 * scheduler retry re-reads authority. It never retries infrastructure mutation.
 * @param {{read:(key:string,versionId?:string)=>StoredObject|null|Promise<StoredObject|null>,write:(key:string,body:string,expected:ObjectObservation|null)=>StoredObject|Promise<StoredObject>}} store
 * @param {{targetKey:string,executionId:string,sourceSha:string}} expected
 */
export async function publishCurrentAppDeploymentStatus(store, expected) {
  const key = deriveRootCheckpointKey(expected.targetKey, 'app');
  const object = await store.read(key);
  if (object === null) throw new Error('App checkpoint missing.');
  const { etag: _etag, ...reference } = object.observation;
  const checkpoint = parseRootCheckpoint(object.body, reference, expected.targetKey, 'app');
  if (
    checkpoint.root !== 'app' ||
    checkpoint.execution.executionId !== expected.executionId ||
    checkpoint.sourceSha !== expected.sourceSha
  )
    return { status: 'superseded', reference: object.observation };
  const body = canonicalAppDeploymentStatusJson(
    projectAppDeploymentStatus(checkpoint, expected.targetKey),
    expected.targetKey,
  );
  const currentStatus = await store.read('status/current.json');
  if (currentStatus !== null) assertAppStatusPublicationOrder(currentStatus.body, body, expected.targetKey);
  const currentCheckpoint = await store.read(key);
  assertObjectPrecondition(object.observation, currentCheckpoint?.observation ?? null);
  if (currentStatus?.body === body) return { status: 'unchanged', reference: currentStatus.observation };
  const stored = await store.write('status/current.json', body, currentStatus?.observation ?? null);
  if (
    stored.body !== body ||
    canonicalRecordJson(parseCanonicalAppDeploymentStatus(stored.body, expected.targetKey)) !== body
  )
    throw new Error('Status publication exact readback mismatch.');
  return { status: 'published', reference: stored.observation };
}
/** @typedef {Record<string, unknown>} NativeRecord */
/** @typedef {ReturnType<typeof resolveAllowedDeploymentTarget>} DeploymentTarget */
/**
 * A notification schedules work; only authenticated native observations and a
 * successful checkpoint admit status publication. This build cannot apply a
 * plan or extend acceptance freshness.
 * @param {{targetKey:string,sourceSha:string,executionId:string,buildId:string,region:string,caller:unknown,build:unknown,pipelineExecution:unknown,actions:unknown}} input
 */
export function admitAsyncAppStatusBuild(input) {
  const target = resolveAllowedDeploymentTarget(input.targetKey);
  const names = resolveDeploymentLaneAuthority(target, 'app').names;
  const sourceSha = parseGitCommitSha(input.sourceSha, 'Status source');
  const executionId = requireGroupedLowercaseUuid(input.executionId, 'Status execution');
  const project = names.appDeploymentStatusPublisherProject;
  const role = names.appDeploymentStatusPublisherRole;
  assertStatusCaller(input.caller, input.region, target, role);
  if (!input.buildId.startsWith(`${project}:`)) throw new Error('Status project mismatch.');
  requireGroupedLowercaseUuid(input.buildId.slice(project.length + 1), 'Status build UUID');
  const build = requireRecord(input.build, 'Status native build');
  const source = requireRecord(build['source'], 'Status build source');
  const environment = requireRecord(build['environment'], 'Status build environment');
  assertStatusBuildIdentity(build, input.buildId, project, role, sourceSha, target);
  assertStatusBuildSource(source, target);
  assertStatusRuntime(environment);
  assertStatusEnvironment(environment, executionId, sourceSha);
  assertStatusPipeline(input.pipelineExecution, names.pipeline, executionId, sourceSha);
  assertStatusSmokePredecessor(input.actions, executionId);
  return Object.freeze({ targetKey: target.targetKey, executionId, sourceSha });
}

/** @param {unknown} value @param {string} region @param {DeploymentTarget} target @param {string} role */
function assertStatusCaller(value, region, target, role) {
  const caller = requireRecord(value, 'Status caller');
  const callerPrefix = `arn:${target.partition}:sts::${target.accountId}:assumed-role/${role}/`;
  if (
    caller['Account'] !== target.accountId ||
    typeof caller['Arn'] !== 'string' ||
    !caller['Arn'].startsWith(callerPrefix) ||
    !/^[\w+=,.@-]{2,64}$/u.test(caller['Arn'].slice(callerPrefix.length)) ||
    region !== target.region
  )
    throw new Error('Status caller does not belong to the selected target.');
}
/** @param {NativeRecord} build @param {string} buildId @param {string} project @param {string} role @param {string} sourceSha @param {DeploymentTarget} target */
function assertStatusBuildIdentity(build, buildId, project, role, sourceSha, target) {
  if (
    build['id'] !== buildId ||
    build['projectName'] !== project ||
    build['buildStatus'] !== 'IN_PROGRESS' ||
    build['serviceRole'] !== `arn:${target.partition}:iam::${target.accountId}:role/${role}` ||
    build['sourceVersion'] !== sourceSha ||
    build['resolvedSourceVersion'] !== sourceSha
  )
    throw new Error('Status build does not bind the exact source-owned runtime.');
}
/** @param {NativeRecord} source @param {DeploymentTarget} target */
function assertStatusBuildSource(source, target) {
  if (
    source['type'] !== 'GITHUB' ||
    source['location'] !== `${target.repositoryUrl}.git` ||
    source['buildspec'] !== 'infra/terraform/bootstrap/buildspec-app-publish-current-status.yml'
  )
    throw new Error('Status build does not bind the exact source-owned runtime.');
}
/** @param {NativeRecord} environment */
function assertStatusRuntime(environment) {
  if (
    environment['computeType'] !== 'BUILD_GENERAL1_SMALL' ||
    environment['type'] !== 'LINUX_CONTAINER' ||
    environment['privilegedMode'] !== false ||
    environment['image'] !== 'aws/codebuild/standard:8.0'
  )
    throw new Error('Status build does not bind the exact source-owned runtime.');
}
/** @param {NativeRecord} environment @param {string} executionId @param {string} sourceSha */
function assertStatusEnvironment(environment, executionId, sourceSha) {
  const variables = environment['environmentVariables'];
  if (!Array.isArray(variables)) throw new Error('Status build environment is missing.');
  for (const [name, value] of [
    ['APP_PIPELINE_EXECUTION_ID', executionId],
    ['APP_STATUS_SOURCE_SHA', sourceSha],
  ]) {
    const matches = variables.map((v) => requireRecord(v, 'Status variable')).filter((v) => v['name'] === name);
    if (matches.length !== 1 || matches[0]?.['type'] !== 'PLAINTEXT' || matches[0]?.['value'] !== value)
      throw new Error('Status native environment is detached from the selected execution.');
  }
}
/** @param {unknown} value @param {string} pipeline @param {string} executionId @param {string} sourceSha */
function assertStatusPipeline(value, pipeline, executionId, sourceSha) {
  const execution = requireRecord(value, 'Status native pipeline execution');
  const revisions = execution['artifactRevisions'];
  if (
    execution['pipelineName'] !== pipeline ||
    execution['pipelineExecutionId'] !== executionId ||
    execution['status'] !== 'Succeeded' ||
    !Array.isArray(revisions) ||
    revisions.length !== 1
  )
    throw new Error('Status requires the exact successful App pipeline.');
  const revision = requireRecord(revisions[0], 'Status native source revision');
  if (revision['name'] !== 'SourceOutput' || revision['revisionId'] !== sourceSha)
    throw new Error('Status pipeline source mismatch.');
}
/** @param {unknown} actions @param {string} executionId */
function assertStatusSmokePredecessor(actions, executionId) {
  if (!Array.isArray(actions)) throw new Error('Status action inventory missing.');
  const smoke = actions
    .map((a) => requireRecord(a, 'Status predecessor'))
    .filter(
      (a) =>
        a['pipelineExecutionId'] === executionId &&
        a['stageName'] === 'DeployApplication' &&
        a['actionName'] === 'TargetRuntimeSmoke',
    );
  if (smoke.length !== 1 || smoke[0]?.['status'] !== 'Succeeded')
    throw new Error('Status requires a unique successful Smoke predecessor.');
}
