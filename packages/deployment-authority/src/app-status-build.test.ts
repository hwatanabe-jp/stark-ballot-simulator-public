import { describe, expect, it } from 'vitest';
import { admitAsyncAppStatusBuild } from './app-deployment-status-publication.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import { admitBuildExecution, resolveCodeBuildProjectInventory } from './source-path-build-authority.js';
import { nativeBuildFixture } from './test-support/native-build-fixture';

function fixture(targetKey = 'stark-dev/develop') {
  const target = resolveAllowedDeploymentTarget(targetKey);
  const names = resolveDeploymentLaneAuthority(target, 'app').names;
  const sourceSha = 'a'.repeat(40);
  const executionId = '11111111-2222-3333-4444-555555555555';
  const buildId = `${names.appDeploymentStatusPublisherProject}:22222222-2222-3333-4444-555555555555`;
  return {
    targetKey,
    sourceSha,
    executionId,
    buildId,
    region: target.region,
    caller: {
      Account: target.accountId,
      Arn: `arn:aws:sts::${target.accountId}:assumed-role/${names.appDeploymentStatusPublisherRole}/build`,
    },
    build: {
      id: buildId,
      projectName: names.appDeploymentStatusPublisherProject,
      buildStatus: 'IN_PROGRESS',
      sourceVersion: sourceSha,
      resolvedSourceVersion: sourceSha,
      serviceRole: `arn:aws:iam::${target.accountId}:role/${names.appDeploymentStatusPublisherRole}`,
      source: {
        type: 'GITHUB',
        location: `${target.repositoryUrl}.git`,
        buildspec: 'infra/terraform/bootstrap/buildspec-app-publish-current-status.yml',
      },
      environment: {
        computeType: 'BUILD_GENERAL1_SMALL',
        type: 'LINUX_CONTAINER',
        privilegedMode: false,
        image: 'aws/codebuild/standard:8.0',
        environmentVariables: [
          { name: 'APP_PIPELINE_EXECUTION_ID', value: executionId, type: 'PLAINTEXT' },
          { name: 'APP_STATUS_SOURCE_SHA', value: sourceSha, type: 'PLAINTEXT' },
        ],
      },
    },
    pipelineExecution: {
      pipelineName: names.pipeline,
      pipelineExecutionId: executionId,
      status: 'Succeeded',
      artifactRevisions: [{ name: 'SourceOutput', revisionId: sourceSha }],
    },
    actions: [
      {
        pipelineExecutionId: executionId,
        stageName: 'DeployApplication',
        actionName: 'TargetRuntimeSmoke',
        status: 'Succeeded',
      },
    ],
  };
}

describe('asynchronous App status native authority', () => {
  it.each(['stark-dev/develop', 'stark-prod/main'])(
    'admits exact successful source and dedicated runtime for %s',
    (targetKey) => {
      const input = fixture(targetKey);
      expect(admitAsyncAppStatusBuild(input)).toEqual({
        targetKey,
        executionId: input.executionId,
        sourceSha: input.sourceSha,
      });
    },
  );
  it.each(['Failed', 'InProgress', 'Stopped', 'Superseded'])(
    'rejects a %s pipeline despite successful Smoke',
    (status) => {
      const input = fixture();
      input.pipelineExecution.status = status;
      expect(() => admitAsyncAppStatusBuild(input)).toThrow('successful');
    },
  );
  it('rejects missing, duplicate or unsuccessful Smoke', () => {
    const input = fixture();
    for (const actions of [
      [],
      [...input.actions, ...input.actions],
      input.actions.map((a) => ({ ...a, status: 'Failed' })),
      input.actions.map((a) => ({ ...a, pipelineExecutionId: '99999999-2222-3333-4444-555555555555' })),
    ])
      expect(() => admitAsyncAppStatusBuild({ ...input, actions })).toThrow('Smoke');
  });
  it('rejects foreign target, source revision, repository, runtime, identity and overridden buildspec', () => {
    const changes: ((input: ReturnType<typeof fixture>) => void)[] = [
      (i) => {
        i.region = 'us-east-1';
      },
      (i) => {
        i.caller = fixture('stark-prod/main').caller;
      },
      (i) => {
        i.buildId = 'foreign:22222222-2222-3333-4444-555555555555';
      },
      (i) => {
        i.build.sourceVersion = 'b'.repeat(40);
      },
      (i) => {
        i.build.resolvedSourceVersion = 'b'.repeat(40);
      },
      (i) => {
        i.build.source.location = 'https://github.com/foreign/repository.git';
      },
      (i) => {
        i.build.source.buildspec = 'unreviewed.yml';
      },
      (i) => {
        i.build.environment.privilegedMode = true;
      },
      (i) => {
        i.build.environment.computeType = 'BUILD_GENERAL1_LARGE';
      },
      (i) => {
        i.build.environment.environmentVariables = [];
      },
      (i) => {
        i.build.environment.environmentVariables.push(...i.build.environment.environmentVariables);
      },
      (i) => {
        i.pipelineExecution.artifactRevisions = [];
      },
      (i) => {
        i.pipelineExecution.artifactRevisions = [{ name: 'SourceOutput', revisionId: 'b'.repeat(40) }];
      },
      (i) => {
        i.pipelineExecution.artifactRevisions.push(...i.pipelineExecution.artifactRevisions);
      },
    ];
    for (const change of changes) {
      const input = fixture();
      change(input);
      expect(() => admitAsyncAppStatusBuild(input)).toThrow();
    }
  });
  it('never admits the detached publisher through the pipeline-action authority', () => {
    const index = resolveCodeBuildProjectInventory('stark-dev/develop').findIndex(
      (p) => p.projectKey === 'appDeploymentStatusPublisherProject',
    );
    expect(() => admitBuildExecution(nativeBuildFixture('stark-dev/develop', index))).toThrow('pipeline lane');
  });
});
