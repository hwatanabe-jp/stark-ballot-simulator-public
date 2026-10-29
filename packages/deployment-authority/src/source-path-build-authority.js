import { snapshotExactRecord } from './descriptor-snapshot.js';
import { parseGitCommitSha, requireGroupedLowercaseUuid } from './internal.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';

/** @typedef {Extract<keyof import('./index.js').DeploymentContextNames, `${string}Project`>} ProjectKey
 * @typedef {Extract<keyof import('./index.js').DeploymentContextNames, `${string}Role`>} RoleKey
 * @typedef {'foundation'|'app'|'toolchain'|'prover'} ManagedBuildLane
 * @typedef {Readonly<{projectName:string,roleName:string,projectKey:ProjectKey,roleKey:RoleKey,lane:ManagedBuildLane,
 * family:'foundation'|'app'|'release',executionCodeAuthority:'pipeline-source-path'|'successful-app-source-path',stageName:string,actionName:string,
 * buildspecPath:string,computeType:string,environmentType:string,privilegedMode:boolean}>} CodeBuildProjectMembership
 */

/** The source inventory owns project, native action and runtime policy together.
 * @param {unknown} targetKey @returns {readonly CodeBuildProjectMembership[]}
 */
export function resolveCodeBuildProjectInventory(targetKey) {
  if (typeof targetKey !== 'string') throw new Error('An independent deployment target is required.');
  const target = resolveAllowedDeploymentTarget(targetKey);
  /** @type {CodeBuildProjectMembership[]} */
  const projects = [];
  /** @param {ManagedBuildLane} lane @param {ProjectKey} projectKey @param {RoleKey} roleKey
   * @param {string} stageName @param {string} actionName @param {string} buildspecPath
   * @param {boolean} [privilegedMode] @param {string} [computeType]
   * @param {CodeBuildProjectMembership['executionCodeAuthority']} [executionCodeAuthority] */
  const add = (
    lane,
    projectKey,
    roleKey,
    stageName,
    actionName,
    buildspecPath,
    privilegedMode = false,
    computeType = 'BUILD_GENERAL1_SMALL',
    executionCodeAuthority = 'pipeline-source-path',
  ) => {
    const names = resolveDeploymentLaneAuthority(target, lane).names;
    projects.push(
      Object.freeze({
        projectName: text(names[projectKey], 'project name'),
        roleName: text(names[roleKey], 'role name'),
        projectKey,
        roleKey,
        lane,
        family: lane === 'foundation' || lane === 'app' ? lane : 'release',
        executionCodeAuthority,
        stageName,
        actionName,
        buildspecPath,
        computeType,
        environmentType: privilegedMode ? 'ARM_CONTAINER' : 'LINUX_CONTAINER',
        privilegedMode,
      }),
    );
  };
  const root = 'infra/terraform/bootstrap/';
  add(
    'foundation',
    'terraformPlanProject',
    'terraformPlanRole',
    'TerraformPlan',
    'PlanFoundationState',
    `${root}buildspec-foundation-plan.yml`,
  );
  add(
    'foundation',
    'terraformApplyProject',
    'terraformApplyRole',
    'DeployFoundation',
    'ApplyReviewedFoundationPlan',
    `${root}buildspec-foundation-apply.yml`,
  );
  add(
    'foundation',
    'smokeProject',
    'terraformSmokeRole',
    'DeployFoundation',
    'FoundationStateAbsenceOfAppRuntime',
    `${root}buildspec-foundation-smoke.yml`,
  );
  add(
    'app',
    'terraformPlanProject',
    'terraformPlanRole',
    'Prepare',
    'PlanAppState',
    `${root}buildspec-app-terraform-plan.yml`,
  );
  add(
    'app',
    'terraformApplyProject',
    'terraformApplyRole',
    'DeployApplication',
    'ApplyReviewedAppPlan',
    `${root}buildspec-app-terraform-apply.yml`,
  );
  add(
    'app',
    'appStaticDeployProject',
    'appStaticDeployRole',
    'DeployApplication',
    'DeployStaticFrontend',
    `${root}buildspec-app-static-deploy.yml`,
  );
  add(
    'app',
    'smokeProject',
    'terraformSmokeRole',
    'DeployApplication',
    'TargetRuntimeSmoke',
    `${root}buildspec-app-smoke.yml`,
  );
  add(
    'app',
    'appDeploymentStatusPublisherProject',
    'appDeploymentStatusPublisherRole',
    'AppStatusDelivery',
    'PublishCurrentStatus',
    `${root}buildspec-app-publish-current-status.yml`,
    false,
    'BUILD_GENERAL1_SMALL',
    'successful-app-source-path',
  );
  add(
    'toolchain',
    'toolchainCandidateProject',
    'toolchainCandidateRole',
    'PrepareToolchainCandidate',
    'PrepareToolchainCandidate',
    'buildspec-risc0-toolchain.yml',
    true,
    'BUILD_GENERAL1_LARGE',
  );
  add(
    'toolchain',
    'toolchainPointerProject',
    'toolchainPointerRole',
    'UpdateAcceptedPointer',
    'UpdateAcceptedPointer',
    'buildspec-release-authority.yml',
  );
  add(
    'prover',
    'proverToolchainResolverProject',
    'proverToolchainResolverRole',
    'PrepareImage',
    'PrepareImage',
    'buildspec-prover-toolchain-authority.yml',
  );
  add(
    'prover',
    'proverCandidateProject',
    'proverCandidateRole',
    'BuildProverCandidate',
    'BuildProverCandidate',
    'buildspec.yml',
    true,
  );
  add(
    'prover',
    'proverPointerProject',
    'proverPointerRole',
    'UpdateAcceptedPointer',
    'UpdateAcceptedPointer',
    'buildspec-release-authority.yml',
  );
  if (new Set(projects.map((p) => p.projectName)).size !== 13)
    throw new Error('Managed project identities must be unique.');
  return Object.freeze(projects);
}

/** @param {unknown} value @param {string} label @returns {Readonly<Record<string,unknown>>} */
function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return /** @type {Readonly<Record<string,unknown>>} */ (value);
}
/** @param {unknown} value @param {string} label @returns {string} */
function text(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
    throw new Error(`${label} must be an exact string.`);
  return value;
}

/** @param {unknown} lane */
export function buildExecutionEnvironmentName(lane) {
  if (lane === 'foundation') return 'FOUNDATION_PIPELINE_EXECUTION_ID';
  if (lane === 'app') return 'APP_PIPELINE_EXECUTION_ID';
  if (lane === 'toolchain' || lane === 'prover') return 'RELEASE_PIPELINE_EXECUTION_ID';
  throw new Error('Only managed lanes admit CodeBuild executions.');
}

/** @param {unknown} value @returns {ReadonlyMap<string,Readonly<Record<string,unknown>>>} */
function environmentVariables(value) {
  if (!Array.isArray(value)) throw new Error('Native environment variables are missing.');
  const result = new Map();
  for (const item of value) {
    const variable = record(item, 'native environment variable');
    const name = text(variable['name'], 'environment name');
    if (result.has(name)) throw new Error('Native environment variable is duplicated.');
    result.set(name, variable);
  }
  return result;
}

/** Admit the native caller/build/action/source binding. Current action inputs are
 * required even when AWS has already populated the optional execution output.
 * @param {unknown} value
 */
export function admitBuildExecution(value) {
  const request = snapshotExactRecord(
    value,
    [
      'context',
      'projectName',
      'roleName',
      'callerIdentity',
      'region',
      'buildId',
      'resolvedSourceSha',
      'pipelineExecutionId',
      'build',
      'actions',
    ],
    'build execution',
  );
  const context = record(request['context'], 'context');
  const targetProjection = record(context['target'], 'target');
  const target = resolveAllowedDeploymentTarget(
    `${targetProjection['accountLabel']}/${targetProjection['environmentId']}`,
  );
  const lane = record(context['root'], 'root')['lane'];
  const executionEnvironmentName = buildExecutionEnvironmentName(lane);
  const authority = resolveDeploymentLaneAuthority(
    target,
    /** @type {'app'|'foundation'|'toolchain'|'prover'} */ (lane),
  );
  const names = authority.names;
  const projectName = text(request['projectName'], 'project');
  const roleName = text(request['roleName'], 'role');
  const contract = resolveCodeBuildProjectInventory(target.targetKey).find(
    (project) => project.lane === lane && project.projectName === projectName && project.roleName === roleName,
  );
  if (!contract || contract.executionCodeAuthority !== 'pipeline-source-path')
    throw new Error('Project/role is outside this managed pipeline lane.');
  const callerArn = admitBuildCaller(request, target, roleName);
  const buildId = text(request['buildId'], 'build ID');
  if (!buildId.startsWith(`${projectName}:`)) throw new Error('Build belongs to another project.');
  requireGroupedLowercaseUuid(buildId.slice(projectName.length + 1), 'build UUID');
  const executionId = text(request['pipelineExecutionId'], 'execution ID');
  requireGroupedLowercaseUuid(executionId, 'execution ID');
  const sourceSha = parseGitCommitSha(record(context['source'], 'source')['frameworkSourceSha'], 'expected source');
  const build = record(request['build'], 'native build');
  assertBuildRuntime(build, contract, target);

  const { action, actionExecutionId } = admitBuildAction(request, executionId, contract);
  const input = record(action['input'], 'action input');
  const config = record(input['resolvedConfiguration'], 'resolved action configuration');
  const type = record(input['actionTypeId'], 'action type');
  const buildSource = record(build['source'], 'build source');
  assertNativeBuildSourceBinding(build, buildSource, {
    buildId,
    projectName,
    pipeline: names.pipeline,
    sourceSha,
    resolvedSourceSha: request['resolvedSourceSha'],
  });
  assertNativeActionBinding(action, input, config, type, { projectName, region: target.region });
  assertBuildEnvironmentBinding(build, config, executionEnvironmentName, executionId);
  assertBuildSourceArtifact(input, build, buildSource, target, names);
  assertBuildActionOutput(action, buildId);
  return Object.freeze({
    targetKey: target.targetKey,
    projectName,
    buildId,
    executionId,
    actionExecutionId,
    actionName: contract.actionName,
    stageName: contract.stageName,
    sourceSha,
    callerArn,
  });
}

/** @typedef {Readonly<Record<string, unknown>>} NativeRecord */

/** @param {NativeRecord} request @param {ReturnType<typeof resolveAllowedDeploymentTarget>} target @param {string} roleName */
function admitBuildCaller(request, target, roleName) {
  const caller = record(request['callerIdentity'], 'caller');
  const prefix = `arn:aws:sts::${target.accountId}:assumed-role/${roleName}/`;
  const callerArn = text(caller['Arn'], 'caller ARN');
  if (
    caller['Account'] !== target.accountId ||
    !callerArn.startsWith(prefix) ||
    !/^[\w+=,.@-]{2,64}$/u.test(callerArn.slice(prefix.length)) ||
    request['region'] !== target.region
  )
    throw new Error('Caller or region differs from the selected target.');
  return callerArn;
}

/** @param {NativeRecord} build @param {CodeBuildProjectMembership} contract @param {ReturnType<typeof resolveAllowedDeploymentTarget>} target */
function assertBuildRuntime(build, contract, target) {
  const buildSourcePolicy = record(build['source'], 'build source');
  const buildEnvironment = record(build['environment'], 'build environment');
  if (
    buildSourcePolicy['buildspec'] !== contract.buildspecPath ||
    build['serviceRole'] !== `arn:${target.partition}:iam::${target.accountId}:role/${contract.roleName}` ||
    buildEnvironment['computeType'] !== contract.computeType ||
    buildEnvironment['type'] !== contract.environmentType ||
    buildEnvironment['privilegedMode'] !== contract.privilegedMode
  )
    throw new Error('Native build runtime differs from the source-owned project policy.');
}

/** @param {NativeRecord} request @param {string} executionId @param {CodeBuildProjectMembership} contract */
function admitBuildAction(request, executionId, contract) {
  const actions = request['actions'];
  if (!Array.isArray(actions)) throw new Error('Native action inventory is missing.');
  const matching = actions
    .map((a) => record(a, 'native action'))
    .filter(
      (a) =>
        a['pipelineExecutionId'] === executionId &&
        a['stageName'] === contract.stageName &&
        a['actionName'] === contract.actionName,
    );
  if (matching.length !== 1) throw new Error('Build has no unique admitted native action.');
  const action = record(matching[0], 'native action');
  const actionExecutionId = text(action['actionExecutionId'], 'action execution ID');
  requireGroupedLowercaseUuid(actionExecutionId, 'action execution ID');
  if (actions.filter((a) => record(a, 'native action')['actionExecutionId'] === actionExecutionId).length !== 1)
    throw new Error('Native action execution identity is ambiguous.');
  return { action, actionExecutionId };
}

/** @param {NativeRecord} build @param {NativeRecord} config @param {string} executionEnvironmentName @param {string} executionId */
function assertBuildEnvironmentBinding(build, config, executionEnvironmentName, executionId) {
  const buildVariables = environmentVariables(
    record(build['environment'], 'build environment')['environmentVariables'],
  );
  const actionVariables = environmentVariables(
    JSON.parse(text(config['EnvironmentVariables'], 'resolved action environment')),
  );
  if (
    actionVariables.get(executionEnvironmentName)?.['value'] !== executionId ||
    actionVariables.get(executionEnvironmentName)?.['type'] !== 'PLAINTEXT'
  )
    throw new Error('Native action environment does not bind the execution.');
  assertNativeEnvironmentAgreement(actionVariables, buildVariables);
}

/**
 * @param {NativeRecord} input @param {NativeRecord} build @param {NativeRecord} buildSource
 * @param {ReturnType<typeof resolveAllowedDeploymentTarget>} target
 * @param {ReturnType<typeof resolveDeploymentLaneAuthority>['names']} names
 */
function assertBuildSourceArtifact(input, build, buildSource, target, names) {
  const artifacts = input['inputArtifacts'];
  if (!Array.isArray(artifacts)) throw new Error('Native action source artifacts are missing.');
  const sources = artifacts.map((a) => record(a, 'input artifact')).filter((a) => a['name'] === 'SourceOutput');
  if (sources.length !== 1) throw new Error('Native action source artifact must be unique.');
  const location = record(sources[0]?.['s3location'], 'source artifact location');
  const key = text(location['key'], 'source artifact key');
  const sourceVersion = `arn:${target.partition}:s3:::${names.artifactBucket}/${key}`;
  if (
    location['bucket'] !== names.artifactBucket ||
    build['sourceVersion'] !== sourceVersion ||
    (buildSource['location'] !== undefined && buildSource['location'] !== sourceVersion)
  )
    throw new Error('Native action artifact differs from the build source.');
}

/** @param {NativeRecord} action @param {string} buildId */
function assertBuildActionOutput(action, buildId) {
  if (action['output'] !== undefined) {
    const output = record(action['output'], 'action output');
    if (output['executionResult'] !== undefined) {
      const result = record(output['executionResult'], 'action execution result');
      if (result['externalExecutionId'] !== undefined && result['externalExecutionId'] !== buildId)
        throw new Error('Native action output identifies another build.');
    }
  }
}

/**
 * @param {NativeRecord} build @param {NativeRecord} buildSource
 * @param {{buildId:string, projectName:string, pipeline:string, sourceSha:string, resolvedSourceSha:unknown}} expected
 */
function assertNativeBuildSourceBinding(build, buildSource, expected) {
  if (
    build['id'] !== expected.buildId ||
    build['projectName'] !== expected.projectName ||
    build['initiator'] !== `codepipeline/${expected.pipeline}` ||
    build['buildStatus'] !== 'IN_PROGRESS' ||
    build['resolvedSourceVersion'] !== expected.sourceSha ||
    expected.resolvedSourceSha !== expected.sourceSha ||
    buildSource['type'] !== 'CODEPIPELINE'
  ) {
    throw new Error('Native pipeline execution does not bind this build and source.');
  }
}

/** @param {NativeRecord} action @param {NativeRecord} input @param {NativeRecord} config @param {NativeRecord} type
 * @param {{projectName:string, region:string}} expected */
function assertNativeActionBinding(action, input, config, type, expected) {
  if (
    config['ProjectName'] !== expected.projectName ||
    config['PrimarySource'] !== 'SourceOutput' ||
    action['status'] !== 'InProgress' ||
    input['region'] !== expected.region ||
    type['category'] !== 'Build' ||
    type['owner'] !== 'AWS' ||
    type['provider'] !== 'CodeBuild' ||
    type['version'] !== '1'
  ) {
    throw new Error('Native pipeline execution does not bind this build and source.');
  }
}

/** @param {ReturnType<typeof environmentVariables>} actionVariables @param {ReturnType<typeof environmentVariables>} buildVariables */
function assertNativeEnvironmentAgreement(actionVariables, buildVariables) {
  for (const [name, variable] of actionVariables) {
    const observed = buildVariables.get(name);
    if (
      variable['type'] !== 'PLAINTEXT' ||
      typeof variable['value'] !== 'string' ||
      observed?.['type'] !== variable['type'] ||
      observed['value'] !== variable['value']
    )
      throw new Error('Native action and build environments differ.');
  }
}
