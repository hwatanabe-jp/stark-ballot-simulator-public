import { resolveCodeBuildProjectInventory, buildExecutionEnvironmentName } from '../source-path-build-authority.js';
import { renderDeploymentLaneContext, resolveAllowedDeploymentTarget } from '../index.js';

// Native AWS response structure captured from Foundation; identity and payloads are synthetic.
export function nativeBuildFixture(targetKey = 'stark-dev/develop', projectIndex = 0) {
  const policy = resolveCodeBuildProjectInventory(targetKey)[projectIndex];
  if (!policy) throw new Error('Missing fixture project.');
  const target = resolveAllowedDeploymentTarget(targetKey);
  const sourceSha = 'a'.repeat(40);
  const pipelineExecutionId = '22222222-2222-3333-4444-555555555555';
  const context = renderDeploymentLaneContext({
    target,
    lane: policy.lane,
    accountId: target.accountId,
    requestedControlSourceSha: sourceSha,
    selectedApplicationSourceSha: sourceSha,
    frameworkSourceSha: sourceSha,
  });
  const projectName = policy.projectName;
  const roleName = policy.roleName;
  const buildId = `${projectName}:11111111-2222-3333-4444-555555555555`;
  const environmentVariables = [
    { name: 'DEPLOYMENT_INITIAL_PUBLICATION', type: 'PLAINTEXT', value: 'true' },
    { name: buildExecutionEnvironmentName(policy.lane), type: 'PLAINTEXT', value: pipelineExecutionId },
    { name: 'PIPELINE_SOURCE_SHA', type: 'PLAINTEXT', value: sourceSha },
  ];
  const action = {
    pipelineExecutionId,
    actionExecutionId: '33333333-2222-3333-4444-555555555555',
    actionName: policy.actionName,
    stageName: policy.stageName,
    status: 'InProgress',
    input: {
      actionTypeId: { category: 'Build', owner: 'AWS', provider: 'CodeBuild', version: '1' },
      region: target.region,
      configuration: { ProjectName: projectName, PrimarySource: 'SourceOutput', EnvironmentVariables: '#{unresolved}' },
      resolvedConfiguration: {
        ProjectName: projectName,
        PrimarySource: 'SourceOutput',
        EnvironmentVariables: JSON.stringify(environmentVariables),
      },
      inputArtifacts: [
        {
          name: 'SourceOutput',
          s3location: { bucket: context.names.artifactBucket, key: 'pipeline/SourceOutp/source' },
        },
      ],
    },
    output: { executionResult: { externalExecutionId: buildId } },
  };
  return {
    context,
    projectName,
    roleName,
    region: target.region,
    buildId,
    pipelineExecutionId,
    resolvedSourceSha: sourceSha,
    callerIdentity: {
      Account: target.accountId,
      Arn: `arn:aws:sts::${target.accountId}:assumed-role/${roleName}/build-session`,
    },
    build: {
      id: buildId,
      projectName,
      initiator: `codepipeline/${context.names.pipeline}`,
      buildStatus: 'IN_PROGRESS',
      resolvedSourceVersion: sourceSha,
      source: {
        type: 'CODEPIPELINE',
        buildspec: policy.buildspecPath,
        insecureSsl: false,
      },
      sourceVersion: `arn:aws:s3:::${context.names.artifactBucket}/pipeline/SourceOutp/source`,
      serviceRole: `arn:aws:iam::${target.accountId}:role/${roleName}`,
      environment: {
        environmentVariables,
        computeType: policy.computeType,
        type: policy.environmentType,
        privilegedMode: policy.privilegedMode,
      },
    },
    actions: [action],
  };
}
