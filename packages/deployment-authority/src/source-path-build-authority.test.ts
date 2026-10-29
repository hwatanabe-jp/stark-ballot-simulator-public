import { describe, expect, it } from 'vitest';
import { renderDeploymentLaneContext, resolveAllowedDeploymentTarget } from './index.js';
import { admitBuildExecution, resolveCodeBuildProjectInventory } from './source-path-build-authority.js';
import { nativeBuildFixture } from './test-support/native-build-fixture';

function item<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Required fixture item is missing.');
  return value;
}
function buildMutationFixture() {
  const input = nativeBuildFixture();
  const action = item(input.actions[0]);
  const config = action.input.resolvedConfiguration;
  const variables = JSON.parse(config.EnvironmentVariables) as { name: string; type: string; value: string }[];
  return { input, action, config, variables };
}

const invalidBuildCases: readonly {
  name: string;
  mutate: (fixture: ReturnType<typeof buildMutationFixture>) => void;
}[] = [
  {
    name: 'account',
    mutate: ({ input }) => {
      input.callerIdentity.Account = resolveAllowedDeploymentTarget('stark-prod/main').accountId;
    },
  },
  {
    name: 'role',
    mutate: ({ input }) => {
      input.callerIdentity.Arn = input.callerIdentity.Arn.replace(input.roleName, 'wrong-role');
    },
  },
  {
    name: 'region',
    mutate: ({ input }) => {
      input.region = 'us-east-1';
    },
  },
  {
    name: 'source',
    mutate: ({ input }) => {
      input.build.resolvedSourceVersion = 'b'.repeat(40);
    },
  },
  {
    name: 'direct start',
    mutate: ({ input }) => {
      input.build.initiator = 'operator';
    },
  },
  {
    name: 'build',
    mutate: ({ input }) => {
      input.build.id += 'x';
    },
  },
  {
    name: 'action build',
    mutate: ({ action }) => {
      action.output.executionResult.externalExecutionId = 'different';
    },
  },
  {
    name: 'action project',
    mutate: ({ config }) => {
      config.ProjectName = 'different';
    },
  },
  {
    name: 'completed action',
    mutate: ({ action }) => {
      action.status = 'Succeeded';
    },
  },
  {
    name: 'completed build',
    mutate: ({ input }) => {
      input.build.buildStatus = 'SUCCEEDED';
    },
  },
  {
    name: 'bootstrap',
    mutate: ({ input }) => {
      input.context = renderDeploymentLaneContext({
        target: resolveAllowedDeploymentTarget('stark-dev/develop'),
        lane: 'bootstrap',
        accountId: input.context.target.accountId,
        requestedControlSourceSha: input.resolvedSourceSha,
        selectedApplicationSourceSha: input.resolvedSourceSha,
        frameworkSourceSha: input.resolvedSourceSha,
      });
    },
  },
  {
    name: 'foreign execution',
    mutate: ({ action }) => {
      action.pipelineExecutionId = '44444444-2222-3333-4444-555555555555';
    },
  },
  {
    name: 'foreign artifact',
    mutate: ({ input }) => {
      input.build.sourceVersion += '-other';
    },
  },
  {
    name: 'foreign bucket',
    mutate: ({ action }) => {
      item(action.input.inputArtifacts[0]).s3location.bucket += '-other';
    },
  },
  {
    name: 'missing env',
    mutate: ({ config, variables }) => {
      config.EnvironmentVariables = JSON.stringify(
        variables.filter((v) => v.name !== 'FOUNDATION_PIPELINE_EXECUTION_ID'),
      );
    },
  },
  {
    name: 'duplicate env',
    mutate: ({ config, variables }) => {
      config.EnvironmentVariables = JSON.stringify([...variables, variables[1]]);
    },
  },
  {
    name: 'duplicate build env',
    mutate: ({ input }) => {
      input.build.environment.environmentVariables.push(item(input.build.environment.environmentVariables[1]));
    },
  },
  {
    name: 'foreign build execution',
    mutate: ({ input }) => {
      item(input.build.environment.environmentVariables[1]).value = '44444444-2222-3333-4444-555555555555';
    },
  },
  {
    name: 'missing source',
    mutate: ({ action }) => {
      action.input.inputArtifacts = [];
    },
  },
  {
    name: 'duplicate source',
    mutate: ({ action }) => {
      action.input.inputArtifacts.push(item(action.input.inputArtifacts[0]));
    },
  },
  {
    name: 'duplicate action',
    mutate: ({ input, action }) => {
      input.actions.push(structuredClone(action));
    },
  },
  {
    name: 'duplicate action ID',
    mutate: ({ input, action }) => {
      input.actions.push({ ...structuredClone(action), actionName: 'OtherAction' });
    },
  },
  {
    name: 'wrong stage',
    mutate: ({ action }) => {
      action.stageName = 'OtherStage';
    },
  },
  {
    name: 'wrong action',
    mutate: ({ action }) => {
      action.actionName = 'OtherAction';
    },
  },
  {
    name: 'missing action ID',
    mutate: ({ action }) => {
      Reflect.deleteProperty(action, 'actionExecutionId');
    },
  },
  {
    name: 'wrong primary',
    mutate: ({ config }) => {
      config.PrimarySource = 'SavedPlan';
    },
  },
  {
    name: 'wrong provider',
    mutate: ({ action }) => {
      action.input.actionTypeId.provider = 'Other';
    },
  },
  {
    name: 'unresolved env',
    mutate: ({ action, config }) => {
      config.EnvironmentVariables = action.input.configuration.EnvironmentVariables;
    },
  },
  {
    name: 'mismatched declared env',
    mutate: ({ input }) => {
      item(input.build.environment.environmentVariables[0]).value = 'false';
    },
  },
  {
    name: 'null output',
    mutate: ({ action }) => {
      Reflect.set(action, 'output', null);
    },
  },
];

describe('native managed execution admission', () => {
  describe.each(['stark-dev/develop', 'stark-prod/main'])('source-owned runtime policy: %s', (targetKey) => {
    const projects = resolveCodeBuildProjectInventory(targetKey);
    it.each(
      projects
        .map((project, index) => ({ ...project, index }))
        .filter((project) => project.executionCodeAuthority === 'pipeline-source-path'),
    )('admits $lane/$projectKey and rejects missing or altered runtime evidence', ({ index }) => {
      const input = nativeBuildFixture(targetKey, index);
      expect(admitBuildExecution(input)).toMatchObject({ targetKey, projectName: input.projectName });
      const other = nativeBuildFixture(
        targetKey === 'stark-dev/develop' ? 'stark-prod/main' : 'stark-dev/develop',
        index,
      );
      for (const [section, field, wrong] of [
        ['source', 'buildspec', 'unreviewed.yml'],
        ['build', 'serviceRole', other.build.serviceRole],
        ['environment', 'computeType', 'BUILD_GENERAL1_MEDIUM'],
        ['environment', 'type', 'WINDOWS_SERVER_2022_CONTAINER'],
        ['environment', 'privilegedMode', !input.build.environment.privilegedMode],
      ] as const) {
        for (const missing of [false, true]) {
          const changed = structuredClone(input);
          const parent = section === 'build' ? changed.build : changed.build[section];
          if (missing) Reflect.deleteProperty(parent, field);
          else Reflect.set(parent, field, wrong);
          expect(() => admitBuildExecution(changed), `${section}.${field}: missing=${missing}`).toThrow('runtime');
        }
      }
      expect(() => admitBuildExecution({ ...input, build: other.build, actions: other.actions })).toThrow();
    });
  });
  it.each(['present', 'missing output', 'missing result', 'missing external ID'])(
    'binds mandatory native inputs with %s',
    (shape) => {
      const input = nativeBuildFixture();
      const action = item(input.actions[0]);
      if (shape === 'missing output') Reflect.deleteProperty(action, 'output');
      if (shape === 'missing result') Reflect.deleteProperty(action.output, 'executionResult');
      if (shape === 'missing external ID') Reflect.deleteProperty(action.output.executionResult, 'externalExecutionId');
      expect(admitBuildExecution(input)).toMatchObject({
        buildId: input.buildId,
        executionId: input.pipelineExecutionId,
        actionExecutionId: action.actionExecutionId,
        sourceSha: input.resolvedSourceSha,
      });
    },
  );
  it.each(invalidBuildCases)('rejects $name even with matching source and output build ID', ({ mutate }) => {
    const fixture = buildMutationFixture();
    mutate(fixture);
    expect(() => admitBuildExecution(fixture.input)).toThrow();
  });
  it.each(['matching', 'wrong build source input', 'wrong action source input'] as const)(
    'binds App Plan native source input: %s',
    (scenario) => {
      const base = nativeBuildFixture();
      const target = resolveAllowedDeploymentTarget('stark-dev/develop');
      const context = renderDeploymentLaneContext({
        target,
        lane: 'app',
        accountId: target.accountId,
        requestedControlSourceSha: base.resolvedSourceSha,
        selectedApplicationSourceSha: base.resolvedSourceSha,
        frameworkSourceSha: base.resolvedSourceSha,
      });
      const projectName = context.names.terraformPlanProject;
      const roleName = context.names.terraformPlanRole;
      const buildId = `${projectName}:11111111-2222-3333-4444-555555555555`;
      const variables = [
        { name: 'APP_PIPELINE_EXECUTION_ID', type: 'PLAINTEXT', value: base.pipelineExecutionId },
        { name: 'APP_SOURCE_SHA', type: 'PLAINTEXT', value: base.resolvedSourceSha },
      ];
      const action = item(base.actions[0]);
      const actionVariables = structuredClone(variables);
      if (scenario === 'wrong build source input') item(variables[1]).value = 'b'.repeat(40);
      if (scenario === 'wrong action source input') item(actionVariables[1]).value = 'b'.repeat(40);
      const input = {
        ...base,
        context,
        projectName,
        roleName,
        buildId,
        callerIdentity: {
          Account: target.accountId,
          Arn: `arn:aws:sts::${target.accountId}:assumed-role/${roleName}/app-plan`,
        },
        build: {
          ...base.build,
          id: buildId,
          projectName,
          initiator: `codepipeline/${context.names.pipeline}`,
          sourceVersion: `arn:aws:s3:::${context.names.artifactBucket}/pipeline/SourceOutp/source`,
          serviceRole: `arn:aws:iam::${target.accountId}:role/${roleName}`,
          source: { ...base.build.source, buildspec: 'infra/terraform/bootstrap/buildspec-app-terraform-plan.yml' },
          environment: { ...base.build.environment, environmentVariables: variables },
        },
        actions: [
          {
            ...action,
            stageName: 'Prepare',
            actionName: 'PlanAppState',
            input: {
              ...action.input,
              resolvedConfiguration: {
                ProjectName: projectName,
                PrimarySource: 'SourceOutput',
                EnvironmentVariables: JSON.stringify(actionVariables),
              },
              inputArtifacts: [
                {
                  name: 'SourceOutput',
                  s3location: { bucket: context.names.artifactBucket, key: 'pipeline/SourceOutp/source' },
                },
              ],
            },
            output: { executionResult: { externalExecutionId: buildId } },
          },
        ],
      };
      if (scenario === 'matching')
        expect(admitBuildExecution(input)).toMatchObject({ projectName, sourceSha: base.resolvedSourceSha });
      else expect(() => admitBuildExecution(input)).toThrow('environments differ');
    },
  );
  it.each(['stark-dev/develop', 'stark-prod/main'])(
    'has exactly 13 reviewed projects and two privileged builders: %s',
    (key) => {
      const projects = resolveCodeBuildProjectInventory(key);
      expect(projects).toHaveLength(13);
      expect(projects.filter((p) => p.family === 'foundation')).toHaveLength(3);
      expect(projects.filter((p) => p.family === 'app')).toHaveLength(5);
      expect(projects.filter((p) => p.privilegedMode)).toHaveLength(2);
    },
  );
});
