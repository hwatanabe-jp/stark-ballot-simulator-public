import { describe, expect, it, vi } from 'vitest';
import { productionConfigurationFixture } from './test-support/deployment-target-fixtures';
import {
  CODEBUILD_EXECUTION_CODE_AUTHORITIES,
  CODEBUILD_PROJECT_FAMILIES,
  START_BUILD_CONDITION_KEYS,
  START_BUILD_REQUEST_FIELDS,
  admitCodeBuildProjectFamily,
  admitBuildRuntimePosture,
  admitConfiguredSourceBuildExecution,
  admitConfiguredSourcePathBuildProject,
  admitFoundationPlanComposition,
  admitSourcePathBuildAction,
  admitSourcePathBuildProject,
  assertPrivilegedProjectInventory,
  buildCodeBuildProjectInventory,
  buildStartBuildOverrideDenyStatements,
  classifyStartBuildRequestFields,
} from './source-path-build-authority.js';

const ACCOUNT_ID = '123456789012';
const REGION = 'ap-northeast-1';
const SOURCE_SHA = 'a'.repeat(40);
const PROJECT_NAME = 'stark-ballot-simulator-pipeline-stark-dev-develop-terraform-plan';
const ROLE_NAME = 'stark-ballot-sim-tf-plan-stark-dev-develop-bootstrap';
const BUILDSPEC_PATH = 'infra/terraform/bootstrap/buildspec-bootstrap-plan.yml';

function countingProxy<T extends object>(target: T): { proxy: T; trapCalls: () => number } {
  let calls = 0;
  const reject = (): never => {
    calls += 1;
    throw new Error('proxy trap executed');
  };
  return {
    proxy: new Proxy(target, {
      get: reject,
      getOwnPropertyDescriptor: reject,
      getPrototypeOf: reject,
      ownKeys: reject,
    }),
    trapCalls: () => calls,
  };
}

const expectedRequestFields = [
  'artifactsOverride',
  'autoRetryLimitOverride',
  'buildStatusConfigOverride',
  'buildspecOverride',
  'cacheOverride',
  'certificateOverride',
  'computeTypeOverride',
  'debugSessionEnabled',
  'encryptionKeyOverride',
  'environmentTypeOverride',
  'environmentVariablesOverride',
  'fleetOverride',
  'gitCloneDepthOverride',
  'gitSubmodulesConfigOverride',
  'hostKernelOverride',
  'idempotencyToken',
  'imageOverride',
  'imagePullCredentialsTypeOverride',
  'insecureSslOverride',
  'logsConfigOverride',
  'privilegedModeOverride',
  'projectName',
  'queuedTimeoutInMinutesOverride',
  'registryCredentialOverride',
  'reportBuildStatusOverride',
  'secondaryArtifactsOverride',
  'secondarySourcesOverride',
  'secondarySourcesVersionOverride',
  'serviceRoleOverride',
  'sourceAuthOverride',
  'sourceLocationOverride',
  'sourceTypeOverride',
  'sourceVersion',
  'timeoutInMinutesOverride',
] as const;

const expectedConditionKeys = [
  'aws:ResourceTag/${TagKey}',
  'codebuild:artifacts',
  'codebuild:artifacts.bucketOwnerAccess',
  'codebuild:artifacts.encryptionDisabled',
  'codebuild:artifacts.location',
  'codebuild:autoRetryLimit',
  'codebuild:cache',
  'codebuild:cache.location',
  'codebuild:cache.modes',
  'codebuild:cache.type',
  'codebuild:encryptionKey',
  'codebuild:environment',
  'codebuild:environment.certificate',
  'codebuild:environment.computeType',
  'codebuild:environment.environmentVariables',
  'codebuild:environment.environmentVariables.name',
  'codebuild:environment.environmentVariables.value',
  'codebuild:environment.environmentVariables/${name}.value',
  'codebuild:environment.fleet.fleetArn',
  'codebuild:environment.image',
  'codebuild:environment.imagePullCredentialsType',
  'codebuild:environment.privilegedMode',
  'codebuild:environment.registryCredential',
  'codebuild:environment.registryCredential.credential',
  'codebuild:environment.registryCredential.credentialProvider',
  'codebuild:environment.type',
  'codebuild:logsConfig',
  'codebuild:logsConfig.s3Logs',
  'codebuild:logsConfig.s3Logs.bucketOwnerAccess',
  'codebuild:logsConfig.s3Logs.encryptionDisabled',
  'codebuild:logsConfig.s3Logs.location',
  'codebuild:logsConfig.s3Logs.status',
  'codebuild:secondaryArtifacts',
  'codebuild:secondaryArtifacts.artifactIdentifier',
  'codebuild:secondaryArtifacts.bucketOwnerAccess',
  'codebuild:secondaryArtifacts.encryptionDisabled',
  'codebuild:secondaryArtifacts.location',
  'codebuild:secondaryArtifacts/${artifactIdentifier}.bucketOwnerAccess',
  'codebuild:secondaryArtifacts/${artifactIdentifier}.encryptionDisabled',
  'codebuild:secondaryArtifacts/${artifactIdentifier}.location',
  'codebuild:secondarySources',
  'codebuild:secondarySources.auth.resource',
  'codebuild:secondarySources.auth.type',
  'codebuild:secondarySources.buildStatusConfig.context',
  'codebuild:secondarySources.buildStatusConfig.targetUrl',
  'codebuild:secondarySources.buildspec',
  'codebuild:secondarySources.insecureSsl',
  'codebuild:secondarySources.location',
  'codebuild:secondarySources.sourceIdentifier',
  'codebuild:secondarySources/${sourceIdentifier}.auth.resource',
  'codebuild:secondarySources/${sourceIdentifier}.auth.type',
  'codebuild:secondarySources/${sourceIdentifier}.buildStatusConfig.context',
  'codebuild:secondarySources/${sourceIdentifier}.buildStatusConfig.targetUrl',
  'codebuild:secondarySources/${sourceIdentifier}.buildspec',
  'codebuild:secondarySources/${sourceIdentifier}.insecureSsl',
  'codebuild:secondarySources/${sourceIdentifier}.location',
  'codebuild:serviceRole',
  'codebuild:source',
  'codebuild:source.auth.resource',
  'codebuild:source.auth.type',
  'codebuild:source.buildStatusConfig.context',
  'codebuild:source.buildStatusConfig.targetUrl',
  'codebuild:source.buildspec',
  'codebuild:source.insecureSsl',
  'codebuild:source.location',
] as const;

function buildProjectAuthority() {
  return {
    accountId: ACCOUNT_ID,
    buildspecPath: BUILDSPEC_PATH,
    computeType: 'BUILD_GENERAL1_SMALL',
    environmentType: 'LINUX_CONTAINER',
    partition: 'aws',
    privilegedMode: false,
    projectName: PROJECT_NAME,
    region: REGION,
    roleName: ROLE_NAME,
    sourceType: 'CODEPIPELINE',
  };
}

function buildProjectObservation() {
  return {
    artifactsType: 'CODEPIPELINE',
    buildspecPath: BUILDSPEC_PATH,
    computeType: 'BUILD_GENERAL1_SMALL',
    environmentType: 'LINUX_CONTAINER',
    imagePullCredentialsType: 'CODEBUILD',
    configuredManagedImage: 'aws/codebuild/standard:8.0',
    privilegedMode: false,
    projectArn: `arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/${PROJECT_NAME}`,
    projectName: PROJECT_NAME,
    serviceRoleArn: `arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}`,
    sourceType: 'CODEPIPELINE',
  };
}

function buildActionAuthority() {
  return {
    actionName: 'Plan',
    environmentVariables: [
      {
        name: 'BOOTSTRAP_SOURCE_ACTION_SHA',
        type: 'PLAINTEXT',
        value: '#{BootstrapSource.CommitId}',
      },
    ],
    inputArtifacts: ['SourceOutput'],
    outputArtifacts: ['PlanOutput'],
    primarySource: 'SourceOutput',
    projectName: PROJECT_NAME,
    region: REGION,
    runOrder: 1,
  };
}

function buildActionObservation() {
  return {
    actionName: 'Plan',
    category: 'Build',
    configuration: {
      EnvironmentVariables: JSON.stringify(buildActionAuthority().environmentVariables),
      PrimarySource: 'SourceOutput',
      ProjectName: PROJECT_NAME,
    },
    inputArtifacts: ['SourceOutput'],
    outputArtifacts: ['PlanOutput'],
    owner: 'AWS',
    provider: 'CodeBuild',
    region: REGION,
    runOrder: 1,
    version: '1',
  };
}

describe('CodeBuild StartBuild authorization surface', () => {
  it('keeps exact parity with the current request and action condition-key inventories', () => {
    expect(START_BUILD_REQUEST_FIELDS).toEqual(expectedRequestFields);
    expect(START_BUILD_CONDITION_KEYS).toEqual(expectedConditionKeys);
    expect(Object.isFrozen(START_BUILD_REQUEST_FIELDS)).toBe(true);
    expect(Object.isFrozen(START_BUILD_CONDITION_KEYS)).toBe(true);

    const classification = classifyStartBuildRequestFields();
    expect(classification).toEqual({
      conditionAddressable: [
        'artifactsOverride',
        'autoRetryLimitOverride',
        'buildStatusConfigOverride',
        'buildspecOverride',
        'cacheOverride',
        'certificateOverride',
        'computeTypeOverride',
        'encryptionKeyOverride',
        'environmentTypeOverride',
        'environmentVariablesOverride',
        'fleetOverride',
        'imageOverride',
        'imagePullCredentialsTypeOverride',
        'insecureSslOverride',
        'logsConfigOverride',
        'privilegedModeOverride',
        'registryCredentialOverride',
        'secondaryArtifactsOverride',
        'secondarySourcesOverride',
        'serviceRoleOverride',
        'sourceAuthOverride',
        'sourceLocationOverride',
        'sourceTypeOverride',
      ],
      requestMetadata: ['idempotencyToken'],
      resourceEnforced: ['projectName'],
      compositionExcluded: [
        'debugSessionEnabled',
        'gitCloneDepthOverride',
        'gitSubmodulesConfigOverride',
        'hostKernelOverride',
        'queuedTimeoutInMinutesOverride',
        'reportBuildStatusOverride',
        'secondarySourcesVersionOverride',
        'sourceVersion',
        'timeoutInMinutesOverride',
      ],
    });
    expect(Object.isFrozen(classification)).toBe(true);
    expect(Object.values(classification).flat().sort()).toEqual([...expectedRequestFields].sort());
  });

  it('renders absence conditions for every supported override surface', () => {
    const projectArn = `arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/${PROJECT_NAME}`;
    const admission = buildStartBuildOverrideDenyStatements({
      allowedEnvironmentVariableNames: [],
      projectArns: [projectArn],
    });

    expect(admission).toContainEqual({
      action: 'codebuild:StartBuild',
      condition: { test: 'Null', values: ['false'], variable: 'codebuild:source.buildspec' },
      effect: 'Deny',
      resources: [projectArn],
    });
    expect(admission).toContainEqual({
      action: 'codebuild:StartBuild',
      condition: { test: 'Null', values: ['false'], variable: 'codebuild:environment.privilegedMode' },
      effect: 'Deny',
      resources: [projectArn],
    });
    expect(admission).toContainEqual({
      action: 'codebuild:StartBuild',
      condition: { test: 'Null', values: ['false'], variable: 'codebuild:environment.computeType' },
      effect: 'Deny',
      resources: [projectArn],
    });
    expect(admission).toContainEqual({
      action: 'codebuild:StartBuild',
      condition: {
        test: 'Null',
        values: ['false'],
        variable: 'codebuild:environment.environmentVariables',
      },
      effect: 'Deny',
      resources: [projectArn],
    });
    expect(new Set(admission.map(({ condition }) => condition.variable)).size).toBe(admission.length);
    expect(Object.isFrozen(admission)).toBe(true);
    expect(admission.every(Object.isFrozen)).toBe(true);
    expect(
      admission.every(({ condition, resources }) => Object.isFrozen(condition) && Object.isFrozen(resources)),
    ).toBe(true);
  });

  it('admits only named action variables while every other supported override stays absent', () => {
    const projectArn = `arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/${PROJECT_NAME}`;
    const admission = buildStartBuildOverrideDenyStatements({
      allowedEnvironmentVariableNames: ['BOOTSTRAP_SOURCE_ACTION_SHA', 'PIPELINE_EXECUTION_ID'],
      projectArns: [projectArn],
    });

    expect(admission).toContainEqual({
      action: 'codebuild:StartBuild',
      condition: {
        test: 'ForAnyValue:StringNotEquals',
        values: ['BOOTSTRAP_SOURCE_ACTION_SHA', 'PIPELINE_EXECUTION_ID'],
        variable: 'codebuild:environment.environmentVariables.name',
      },
      effect: 'Deny',
      resources: [projectArn],
    });
    expect(admission).not.toContainEqual({
      action: 'codebuild:StartBuild',
      condition: {
        test: 'Null',
        values: ['false'],
        variable: 'codebuild:environment.environmentVariables',
      },
      effect: 'Deny',
      resources: [projectArn],
    });
    expect(admission).toContainEqual({
      action: 'codebuild:StartBuild',
      condition: { test: 'Null', values: ['false'], variable: 'codebuild:environment.image' },
      effect: 'Deny',
      resources: [projectArn],
    });
  });

  it('rejects duplicate, unsafe, accessor, and Proxy variable inventories', () => {
    for (const allowedEnvironmentVariableNames of [
      ['SOURCE_SHA', 'SOURCE_SHA'],
      ['source-sha'],
      ['AWS_REGION'],
      ['CODEBUILD_RESOLVED_SOURCE_VERSION'],
    ]) {
      expect(() =>
        buildStartBuildOverrideDenyStatements({
          allowedEnvironmentVariableNames,
          projectArns: [`arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/${PROJECT_NAME}`],
        }),
      ).toThrow();
    }
    let getterCalls = 0;
    expect(() =>
      buildStartBuildOverrideDenyStatements({
        get allowedEnvironmentVariableNames() {
          getterCalls += 1;
          throw new Error('getter executed');
        },
        projectArns: [`arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/${PROJECT_NAME}`],
      }),
    ).toThrow();
    expect(getterCalls).toBe(0);
    let proxyTrapCalls = 0;
    expect(() =>
      buildStartBuildOverrideDenyStatements(
        new Proxy(
          {
            allowedEnvironmentVariableNames: [],
            projectArns: [`arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/${PROJECT_NAME}`],
          },
          {
            ownKeys() {
              proxyTrapCalls += 1;
              throw new Error('proxy trap');
            },
          },
        ),
      ),
    ).toThrow();
    expect(proxyTrapCalls).toBe(0);
  });
});

describe('source-path CodeBuild project and action admission', () => {
  it('admits one exact unprivileged source-path project and records its observed managed image', () => {
    const admitted = admitSourcePathBuildProject({
      authority: buildProjectAuthority(),
      observation: buildProjectObservation(),
    });

    expect(admitted).toEqual(buildProjectObservation());
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(admitted.configuredManagedImage).toBe('aws/codebuild/standard:8.0');
  });

  it.each([
    ['artifactsType', 'S3'],
    ['buildspecPath', 'other.yml'],
    ['computeType', 'BUILD_GENERAL1_LARGE'],
    ['configuredManagedImage', 'registry.example.invalid/custom:latest'],
    ['configuredManagedImage', 'aws/codebuild/standard:8.0-26.08.30'],
    ['environmentType', 'ARM_CONTAINER'],
    ['imagePullCredentialsType', 'SERVICE_ROLE'],
    ['privilegedMode', true],
    ['projectName', 'other-project'],
    ['serviceRoleArn', `arn:aws:iam::${ACCOUNT_ID}:role/other-role`],
    ['sourceType', 'GITHUB'],
  ] as const)('rejects a project with changed %s', (field, value) => {
    expect(() =>
      admitSourcePathBuildProject({
        authority: buildProjectAuthority(),
        observation: { ...buildProjectObservation(), [field]: value },
      }),
    ).toThrow();
  });

  it.each([
    '/buildspec.yml',
    './buildspec.yml',
    '../buildspec.yml',
    'infra//buildspec.yml',
    'infra/./buildspec.yml',
    'buildspec.yml.tftpl',
    'buildspec.yml\n',
  ])('rejects unsafe buildspec path %s', (buildspecPath) => {
    expect(() =>
      admitSourcePathBuildProject({
        authority: { ...buildProjectAuthority(), buildspecPath },
        observation: { ...buildProjectObservation(), buildspecPath },
      }),
    ).toThrow();
  });

  it('rejects extra fields, accessors, and Proxies before admission', () => {
    let getterCalls = 0;
    expect(() =>
      admitSourcePathBuildProject({
        authority: { ...buildProjectAuthority(), expectedImage: 'aws/codebuild/standard:8.0' },
        observation: buildProjectObservation(),
      }),
    ).toThrow();
    expect(() =>
      admitSourcePathBuildProject({
        authority: buildProjectAuthority(),
        observation: {
          ...buildProjectObservation(),
          get privilegedMode() {
            getterCalls += 1;
            throw new Error('getter executed');
          },
        },
      }),
    ).toThrow();
    expect(getterCalls).toBe(0);
    let proxyTrapCalls = 0;
    expect(() =>
      admitSourcePathBuildProject(
        new Proxy(
          { authority: buildProjectAuthority(), observation: buildProjectObservation() },
          {
            ownKeys() {
              proxyTrapCalls += 1;
              throw new Error('proxy trap');
            },
          },
        ),
      ),
    ).toThrow();
    expect(proxyTrapCalls).toBe(0);
  });

  it('admits the exact primary-source action with no buildspec override', () => {
    const admitted = admitSourcePathBuildAction({
      authority: buildActionAuthority(),
      observation: buildActionObservation(),
    });

    expect(admitted).toEqual({
      ...buildActionObservation(),
      configuration: {
        EnvironmentVariables: buildActionAuthority().environmentVariables,
        PrimarySource: 'SourceOutput',
        ProjectName: PROJECT_NAME,
      },
    });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.configuration)).toBe(true);
    expect(Object.isFrozen(admitted.configuration.EnvironmentVariables)).toBe(true);
  });

  it.each([
    ['BuildspecOverride', BUILDSPEC_PATH],
    ['BatchEnabled', 'true'],
    ['CombineArtifacts', 'true'],
  ])('rejects the optional action configuration %s', (field, value) => {
    expect(() =>
      admitSourcePathBuildAction({
        authority: buildActionAuthority(),
        observation: {
          ...buildActionObservation(),
          configuration: { ...buildActionObservation().configuration, [field]: value },
        },
      }),
    ).toThrow();
  });

  it('rejects changed artifacts, project, primary source, or environment variables', () => {
    const cases = [
      { ...buildActionObservation(), inputArtifacts: ['OtherSource'] },
      { ...buildActionObservation(), outputArtifacts: [] },
      { ...buildActionObservation(), region: 'us-east-1' },
      { ...buildActionObservation(), runOrder: 2 },
      { ...buildActionObservation(), version: '' },
      {
        ...buildActionObservation(),
        configuration: { ...buildActionObservation().configuration, PrimarySource: 'OtherSource' },
      },
      {
        ...buildActionObservation(),
        configuration: { ...buildActionObservation().configuration, ProjectName: 'other-project' },
      },
      {
        ...buildActionObservation(),
        configuration: {
          ...buildActionObservation().configuration,
          EnvironmentVariables: JSON.stringify([
            ...buildActionAuthority().environmentVariables,
            { name: 'EXTRA', type: 'PLAINTEXT', value: 'unsafe' },
          ]),
        },
      },
    ];
    for (const observation of cases) {
      expect(() => admitSourcePathBuildAction({ authority: buildActionAuthority(), observation })).toThrow();
    }
  });
});

describe('CodeBuild runtime posture', () => {
  function runtimeObservation() {
    return {
      accountId: ACCOUNT_ID,
      buildId: `${PROJECT_NAME}:11111111-2222-3333-4444-555555555555`,
      callerArn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/${ROLE_NAME}/codebuild-session`,
      project: buildProjectObservation(),
      region: REGION,
      resolvedSourceSha: SOURCE_SHA,
      runningManagedImage: 'aws/codebuild/standard:7.0',
    };
  }

  it('binds caller, project, region, source, privilege, and compute while preserving the observed image', () => {
    const admitted = admitBuildRuntimePosture({
      authority: { project: buildProjectAuthority(), sourceSha: SOURCE_SHA },
      observation: runtimeObservation(),
    });

    expect(admitted).toMatchObject({
      accountId: ACCOUNT_ID,
      buildspecPath: BUILDSPEC_PATH,
      computeType: 'BUILD_GENERAL1_SMALL',
      configuredManagedImage: 'aws/codebuild/standard:8.0',
      privilegedMode: false,
      projectName: PROJECT_NAME,
      region: REGION,
      resolvedSourceSha: SOURCE_SHA,
      runningManagedImage: 'aws/codebuild/standard:7.0',
    });
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  it('rejects mismatched caller, build, account, region, source, and project posture', () => {
    const cases = [
      { ...runtimeObservation(), accountId: '999999999999' },
      { ...runtimeObservation(), region: 'us-east-1' },
      { ...runtimeObservation(), resolvedSourceSha: 'b'.repeat(40) },
      { ...runtimeObservation(), callerArn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/other-role/session` },
      { ...runtimeObservation(), buildId: 'other-project:11111111-2222-3333-4444-555555555555' },
      { ...runtimeObservation(), runningManagedImage: '' },
      { ...runtimeObservation(), runningManagedImage: 'detached-image' },
      { ...runtimeObservation(), runningManagedImage: 'aws/codebuild/standard:8.0-26.08.30' },
      { ...runtimeObservation(), project: { ...buildProjectObservation(), privilegedMode: true } },
    ];
    for (const observation of cases) {
      expect(() =>
        admitBuildRuntimePosture({
          authority: { project: buildProjectAuthority(), sourceSha: SOURCE_SHA },
          observation,
        }),
      ).toThrow();
    }
  });
});

describe('CodeBuild privileged project inventory', () => {
  const toolchain = 'stark-ballot-simulator-pipeline-stark-dev-develop-toolchain-release-candidate';
  const prover = 'stark-ballot-simulator-pipeline-stark-dev-develop-prover-release-candidate';
  const projects = [
    { privilegedMode: false, projectName: PROJECT_NAME },
    { privilegedMode: true, projectName: toolchain },
    { privilegedMode: true, projectName: prover },
  ];

  it('admits only the exact two candidate builders as privileged', () => {
    const admitted = assertPrivilegedProjectInventory({ projects, targetKey: 'stark-dev/develop' });

    expect(admitted).toEqual({ privilegedProjectNames: [prover, toolchain] });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.privilegedProjectNames)).toBe(true);
  });

  it('rejects a third, missing, disabled, duplicated, or unlisted privileged project', () => {
    const cases = [
      [...projects, { privilegedMode: true, projectName: 'other-project' }],
      projects.slice(0, 2),
      projects.map((project) => (project.projectName === prover ? { ...project, privilegedMode: false } : project)),
      [...projects, projects[0]],
      projects.map((project) =>
        project.projectName === PROJECT_NAME ? { ...project, privilegedMode: true } : project,
      ),
    ];
    for (const candidateProjects of cases) {
      expect(() =>
        assertPrivilegedProjectInventory({ projects: candidateProjects, targetKey: 'stark-dev/develop' }),
      ).toThrow();
    }
    expect(() => assertPrivilegedProjectInventory({ projects, targetKey: 'stark-prod/main' })).toThrow();
  });
});

describe('source-path authority descriptor boundary', () => {
  it('rejects direct Proxies without executing any trap', () => {
    const startBuildInput = countingProxy({
      allowedEnvironmentVariableNames: [],
      projectArns: [`arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/${PROJECT_NAME}`],
    });
    expect(() => buildStartBuildOverrideDenyStatements(startBuildInput.proxy)).toThrow();

    const projectInput = countingProxy({
      authority: buildProjectAuthority(),
      observation: buildProjectObservation(),
    });
    expect(() => admitSourcePathBuildProject(projectInput.proxy)).toThrow();

    const actionInput = countingProxy({
      authority: buildActionAuthority(),
      observation: buildActionObservation(),
    });
    expect(() => admitSourcePathBuildAction(actionInput.proxy)).toThrow();

    const runtimeInput = countingProxy({
      authority: { project: buildProjectAuthority(), sourceSha: SOURCE_SHA },
      observation: {
        accountId: ACCOUNT_ID,
        buildId: `${PROJECT_NAME}:11111111-2222-3333-4444-555555555555`,
        callerArn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/${ROLE_NAME}/codebuild-session`,
        project: buildProjectObservation(),
        region: REGION,
        resolvedSourceSha: SOURCE_SHA,
        runningManagedImage: 'aws/codebuild/standard:7.0',
      },
    });
    expect(() => admitBuildRuntimePosture(runtimeInput.proxy)).toThrow();

    const privilegeInput = countingProxy({
      projects: [
        { privilegedMode: false, projectName: PROJECT_NAME },
        {
          privilegedMode: true,
          projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-toolchain-release-candidate',
        },
        {
          privilegedMode: true,
          projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-prover-release-candidate',
        },
      ],
      targetKey: 'stark-dev/develop',
    });
    expect(() => assertPrivilegedProjectInventory(privilegeInput.proxy)).toThrow();

    for (const trapped of [startBuildInput, projectInput, actionInput, runtimeInput, privilegeInput]) {
      expect(trapped.trapCalls()).toBe(0);
    }
  });

  it('rejects nested Proxies without executing any trap', () => {
    const namesProxy = countingProxy(['BOOTSTRAP_SOURCE_ACTION_SHA']);
    expect(() =>
      buildStartBuildOverrideDenyStatements({
        allowedEnvironmentVariableNames: namesProxy.proxy,
        projectArns: [`arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/${PROJECT_NAME}`],
      }),
    ).toThrow();

    const projectArnsProxy = countingProxy([`arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/${PROJECT_NAME}`]);
    expect(() =>
      buildStartBuildOverrideDenyStatements({
        allowedEnvironmentVariableNames: [],
        projectArns: projectArnsProxy.proxy,
      }),
    ).toThrow();

    const projectAuthorityProxy = countingProxy(buildProjectAuthority());
    expect(() =>
      admitSourcePathBuildProject({
        authority: projectAuthorityProxy.proxy,
        observation: buildProjectObservation(),
      }),
    ).toThrow();

    const projectObservationProxy = countingProxy(buildProjectObservation());
    expect(() =>
      admitSourcePathBuildProject({
        authority: buildProjectAuthority(),
        observation: projectObservationProxy.proxy,
      }),
    ).toThrow();

    const actionAuthorityProxy = countingProxy(buildActionAuthority());
    expect(() =>
      admitSourcePathBuildAction({
        authority: actionAuthorityProxy.proxy,
        observation: buildActionObservation(),
      }),
    ).toThrow();

    const actionObservationProxy = countingProxy(buildActionObservation());
    expect(() =>
      admitSourcePathBuildAction({
        authority: buildActionAuthority(),
        observation: actionObservationProxy.proxy,
      }),
    ).toThrow();

    const actionConfigurationProxy = countingProxy(buildActionObservation().configuration);
    expect(() =>
      admitSourcePathBuildAction({
        authority: buildActionAuthority(),
        observation: { ...buildActionObservation(), configuration: actionConfigurationProxy.proxy },
      }),
    ).toThrow();

    const inputArtifactsProxy = countingProxy(['SourceOutput']);
    expect(() =>
      admitSourcePathBuildAction({
        authority: { ...buildActionAuthority(), inputArtifacts: inputArtifactsProxy.proxy },
        observation: buildActionObservation(),
      }),
    ).toThrow();

    const environmentArrayProxy = countingProxy(buildActionAuthority().environmentVariables);
    expect(() =>
      admitSourcePathBuildAction({
        authority: { ...buildActionAuthority(), environmentVariables: environmentArrayProxy.proxy },
        observation: buildActionObservation(),
      }),
    ).toThrow();

    const environmentEntryProxy = countingProxy(buildActionAuthority().environmentVariables[0] ?? {});
    expect(() =>
      admitSourcePathBuildAction({
        authority: { ...buildActionAuthority(), environmentVariables: [environmentEntryProxy.proxy] },
        observation: buildActionObservation(),
      }),
    ).toThrow();

    const runtimeAuthorityProxy = countingProxy({ project: buildProjectAuthority(), sourceSha: SOURCE_SHA });
    expect(() =>
      admitBuildRuntimePosture({
        authority: runtimeAuthorityProxy.proxy,
        observation: {
          accountId: ACCOUNT_ID,
          buildId: `${PROJECT_NAME}:11111111-2222-3333-4444-555555555555`,
          callerArn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/${ROLE_NAME}/codebuild-session`,
          project: buildProjectObservation(),
          region: REGION,
          resolvedSourceSha: SOURCE_SHA,
          runningManagedImage: 'aws/codebuild/standard:7.0',
        },
      }),
    ).toThrow();

    const runtimeProjectAuthorityProxy = countingProxy(buildProjectAuthority());
    expect(() =>
      admitBuildRuntimePosture({
        authority: { project: runtimeProjectAuthorityProxy.proxy, sourceSha: SOURCE_SHA },
        observation: {
          accountId: ACCOUNT_ID,
          buildId: `${PROJECT_NAME}:11111111-2222-3333-4444-555555555555`,
          callerArn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/${ROLE_NAME}/codebuild-session`,
          project: buildProjectObservation(),
          region: REGION,
          resolvedSourceSha: SOURCE_SHA,
          runningManagedImage: 'aws/codebuild/standard:7.0',
        },
      }),
    ).toThrow();

    const runtimeObservationProxy = countingProxy({
      accountId: ACCOUNT_ID,
      buildId: `${PROJECT_NAME}:11111111-2222-3333-4444-555555555555`,
      callerArn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/${ROLE_NAME}/codebuild-session`,
      project: buildProjectObservation(),
      region: REGION,
      resolvedSourceSha: SOURCE_SHA,
      runningManagedImage: 'aws/codebuild/standard:7.0',
    });
    expect(() =>
      admitBuildRuntimePosture({
        authority: { project: buildProjectAuthority(), sourceSha: SOURCE_SHA },
        observation: runtimeObservationProxy.proxy,
      }),
    ).toThrow();

    const runtimeProjectProxy = countingProxy(buildProjectObservation());
    expect(() =>
      admitBuildRuntimePosture({
        authority: { project: buildProjectAuthority(), sourceSha: SOURCE_SHA },
        observation: {
          accountId: ACCOUNT_ID,
          buildId: `${PROJECT_NAME}:11111111-2222-3333-4444-555555555555`,
          callerArn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/${ROLE_NAME}/codebuild-session`,
          project: runtimeProjectProxy.proxy,
          region: REGION,
          resolvedSourceSha: SOURCE_SHA,
          runningManagedImage: 'aws/codebuild/standard:7.0',
        },
      }),
    ).toThrow();

    const privilegeEntryProxy = countingProxy({ privilegedMode: false, projectName: PROJECT_NAME });
    expect(() =>
      assertPrivilegedProjectInventory({
        projects: [
          privilegeEntryProxy.proxy,
          {
            privilegedMode: true,
            projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-toolchain-release-candidate',
          },
          {
            privilegedMode: true,
            projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-prover-release-candidate',
          },
        ],
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();

    const privilegeProjectsProxy = countingProxy([
      { privilegedMode: false, projectName: PROJECT_NAME },
      {
        privilegedMode: true,
        projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-toolchain-release-candidate',
      },
      {
        privilegedMode: true,
        projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-prover-release-candidate',
      },
    ]);
    expect(() =>
      assertPrivilegedProjectInventory({
        projects: privilegeProjectsProxy.proxy,
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();

    for (const trapped of [
      namesProxy,
      projectArnsProxy,
      projectAuthorityProxy,
      projectObservationProxy,
      actionAuthorityProxy,
      actionObservationProxy,
      actionConfigurationProxy,
      inputArtifactsProxy,
      environmentArrayProxy,
      environmentEntryProxy,
      runtimeAuthorityProxy,
      runtimeProjectAuthorityProxy,
      runtimeObservationProxy,
      runtimeProjectProxy,
      privilegeEntryProxy,
      privilegeProjectsProxy,
    ]) {
      expect(trapped.trapCalls()).toBe(0);
    }
  });

  it('rejects nested accessors without invoking their getters', () => {
    let getterCalls = 0;
    const rejectGetter = (): never => {
      getterCalls += 1;
      throw new Error('getter executed');
    };

    const projectArns = [`arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/${PROJECT_NAME}`];
    Object.defineProperty(projectArns, '0', { enumerable: true, get: rejectGetter });
    expect(() => buildStartBuildOverrideDenyStatements({ allowedEnvironmentVariableNames: [], projectArns })).toThrow();

    const projectObservation = buildProjectObservation();
    Object.defineProperty(projectObservation, 'privilegedMode', { enumerable: true, get: rejectGetter });
    expect(() =>
      admitSourcePathBuildProject({ authority: buildProjectAuthority(), observation: projectObservation }),
    ).toThrow();

    const actionConfiguration = buildActionObservation().configuration;
    Object.defineProperty(actionConfiguration, 'ProjectName', { enumerable: true, get: rejectGetter });
    expect(() =>
      admitSourcePathBuildAction({
        authority: buildActionAuthority(),
        observation: { ...buildActionObservation(), configuration: actionConfiguration },
      }),
    ).toThrow();

    const environmentVariables = buildActionAuthority().environmentVariables;
    Object.defineProperty(environmentVariables, '0', { enumerable: true, get: rejectGetter });
    expect(() =>
      admitSourcePathBuildAction({
        authority: { ...buildActionAuthority(), environmentVariables },
        observation: buildActionObservation(),
      }),
    ).toThrow();

    const runtimeProject = buildProjectObservation();
    Object.defineProperty(runtimeProject, 'projectName', { enumerable: true, get: rejectGetter });
    expect(() =>
      admitBuildRuntimePosture({
        authority: { project: buildProjectAuthority(), sourceSha: SOURCE_SHA },
        observation: {
          accountId: ACCOUNT_ID,
          buildId: `${PROJECT_NAME}:11111111-2222-3333-4444-555555555555`,
          callerArn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/${ROLE_NAME}/codebuild-session`,
          project: runtimeProject,
          region: REGION,
          resolvedSourceSha: SOURCE_SHA,
          runningManagedImage: 'aws/codebuild/standard:7.0',
        },
      }),
    ).toThrow();

    const privilegeEntry = { privilegedMode: false, projectName: PROJECT_NAME };
    Object.defineProperty(privilegeEntry, 'privilegedMode', { enumerable: true, get: rejectGetter });
    expect(() =>
      assertPrivilegedProjectInventory({
        projects: [
          privilegeEntry,
          {
            privilegedMode: true,
            projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-toolchain-release-candidate',
          },
          {
            privilegedMode: true,
            projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-prover-release-candidate',
          },
        ],
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();

    expect(getterCalls).toBe(0);
  });
});

const codeBuildProjectMembership = [
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'bootstrap',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-terraform-plan',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'bootstrap',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-terraform-apply',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'bootstrap',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-bootstrap-smoke',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'foundation',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-foundation-terraform-plan',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'foundation',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-foundation-terraform-apply',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'foundation',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-foundation-smoke',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'foundation',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-foundation-signing-resolver-stark-dev-develop',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'image-signature-preflight',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-app-signature-preflight-terraform-plan',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'image-signature-preflight',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-app-signature-preflight-terraform-apply',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'image-signature-preflight',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-app-signature-preflight-verify',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'app',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-app-execution-authority',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'app',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-app-terraform-plan',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'app',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-app-terraform-apply',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'app',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-app-static-deploy',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'app',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-app-smoke',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'app',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-app-publish-current-status',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'static-fast',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-app-static-fast-gate-and-build',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'static-fast',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-app-static-fast-deploy',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'static-fast',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-app-static-fast-smoke-lite',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'release',
    privilegedMode: true,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-toolchain-release-candidate',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'release',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-toolchain-release-update-accepted-pointer',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'release',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-prover-release-toolchain-resolver',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'release',
    privilegedMode: true,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-prover-release-candidate',
  },
  {
    executionCodeAuthority: 'pipeline-source-path',
    family: 'release',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-pipeline-stark-dev-develop-prover-release-update-accepted-pointer',
  },
  {
    executionCodeAuthority: 'configured-source-path',
    family: 'terraform-drift',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-stark-dev-develop-terraform-drift-bootstrap',
  },
  {
    executionCodeAuthority: 'configured-source-path',
    family: 'terraform-drift',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-stark-dev-develop-terraform-drift-foundation',
  },
  {
    executionCodeAuthority: 'configured-source-path',
    family: 'terraform-drift',
    privilegedMode: false,
    projectName: 'stark-ballot-simulator-stark-dev-develop-terraform-drift-app',
  },
] as const;

function buildProjectFamilies() {
  return CODEBUILD_PROJECT_FAMILIES.map((family) =>
    admitCodeBuildProjectFamily({
      family,
      projects: codeBuildProjectMembership.filter((membership) => membership.family === family),
      targetKey: 'stark-dev/develop',
    }),
  );
}

describe('CodeBuild project family authority', () => {
  it('admits the complete exact family membership and execution-code authority inventory', () => {
    expect(CODEBUILD_PROJECT_FAMILIES).toEqual([
      'bootstrap',
      'foundation',
      'image-signature-preflight',
      'app',
      'static-fast',
      'release',
      'terraform-drift',
    ]);
    expect(CODEBUILD_EXECUTION_CODE_AUTHORITIES).toEqual([
      'pipeline-source-path',
      'configured-source-path',
      'terraform-rendered',
    ]);

    const inventory = buildCodeBuildProjectInventory({
      families: buildProjectFamilies(),
      targetKey: 'stark-dev/develop',
    });

    expect(inventory).toHaveLength(27);
    expect(
      inventory.map(({ executionCodeAuthority, family, privilegedMode, projectName }) => ({
        executionCodeAuthority,
        family,
        privilegedMode,
        projectName,
      })),
    ).toEqual(codeBuildProjectMembership);
    expect(
      inventory.filter(({ executionCodeAuthority }) => executionCodeAuthority === 'pipeline-source-path'),
    ).toHaveLength(24);
    expect(
      inventory.filter(
        ({ executionCodeAuthority, family }) =>
          executionCodeAuthority === 'configured-source-path' && family === 'terraform-drift',
      ),
    ).toHaveLength(3);
    expect(
      inventory.filter(({ executionCodeAuthority }) => executionCodeAuthority === 'terraform-rendered'),
    ).toHaveLength(0);
    expect(new Set(inventory.map(({ projectName }) => projectName)).size).toBe(27);
    expect(inventory.every(Object.isFrozen)).toBe(true);
  });

  it('rejects incomplete, duplicate, reclassified, or unauthorized privileged membership', () => {
    const families = buildProjectFamilies();
    expect(() =>
      buildCodeBuildProjectInventory({ families: families.slice(1), targetKey: 'stark-dev/develop' }),
    ).toThrow();
    expect(() =>
      buildCodeBuildProjectInventory({ families: [...families, families[0]], targetKey: 'stark-dev/develop' }),
    ).toThrow();

    const appMembership = codeBuildProjectMembership.filter(({ family }) => family === 'app');
    expect(() =>
      admitCodeBuildProjectFamily({
        family: 'app',
        projects: appMembership.slice(1),
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();
    expect(() =>
      admitCodeBuildProjectFamily({
        family: 'app',
        projects: appMembership.map((project, index) =>
          index === 1 ? { ...project, executionCodeAuthority: 'configured-source-path' } : project,
        ),
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();
    expect(() =>
      admitCodeBuildProjectFamily({
        family: 'app',
        projects: appMembership.map((project, index) => (index === 0 ? { ...project, privilegedMode: true } : project)),
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();
  });

  it('rejects family and inventory Proxies without executing traps', () => {
    const bootstrapProjects = codeBuildProjectMembership.filter(({ family }) => family === 'bootstrap');
    const directFamily = countingProxy({
      family: 'bootstrap',
      projects: bootstrapProjects,
      targetKey: 'stark-dev/develop',
    });
    expect(() => admitCodeBuildProjectFamily(directFamily.proxy)).toThrow();

    const projects = countingProxy(bootstrapProjects);
    expect(() =>
      admitCodeBuildProjectFamily({ family: 'bootstrap', projects: projects.proxy, targetKey: 'stark-dev/develop' }),
    ).toThrow();

    const project = countingProxy(bootstrapProjects[0] ?? {});
    expect(() =>
      admitCodeBuildProjectFamily({
        family: 'bootstrap',
        projects: [project.proxy, ...bootstrapProjects.slice(1)],
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();

    const families = buildProjectFamilies();
    const directInventory = countingProxy({ families, targetKey: 'stark-dev/develop' });
    expect(() => buildCodeBuildProjectInventory(directInventory.proxy)).toThrow();

    const familyArray = countingProxy(families);
    expect(() =>
      buildCodeBuildProjectInventory({ families: familyArray.proxy, targetKey: 'stark-dev/develop' }),
    ).toThrow();

    const family = countingProxy(families[0] ?? {});
    expect(() =>
      buildCodeBuildProjectInventory({
        families: [family.proxy, ...families.slice(1)],
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();

    for (const trapped of [directFamily, projects, project, directInventory, familyArray, family]) {
      expect(trapped.trapCalls()).toBe(0);
    }
  });

  it('rejects family and inventory accessors without invoking getters', () => {
    let getterCalls = 0;
    const rejectGetter = (): never => {
      getterCalls += 1;
      throw new Error('getter executed');
    };
    const bootstrapProjects = codeBuildProjectMembership.filter(({ family }) => family === 'bootstrap');
    const project = { ...bootstrapProjects[0] };
    Object.defineProperty(project, 'projectName', { enumerable: true, get: rejectGetter });
    expect(() =>
      admitCodeBuildProjectFamily({
        family: 'bootstrap',
        projects: [project, ...bootstrapProjects.slice(1)],
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();

    const families = buildProjectFamilies().map((family) => ({ ...family }));
    Object.defineProperty(families[0], 'projects', { enumerable: true, get: rejectGetter });
    expect(() => buildCodeBuildProjectInventory({ families, targetKey: 'stark-dev/develop' })).toThrow();

    expect(getterCalls).toBe(0);
  });
});

describe('configured-source CodeBuild project authority', () => {
  const projectName = 'stark-ballot-simulator-stark-dev-develop-terraform-drift-bootstrap';
  const roleName = 'sbs-terraform-drift-runner-stark-dev-develop-bootstrap';
  const buildspecPath = 'infra/framework/buildspecs/terraform-drift-runner.yml';
  const repositoryUrl = 'https://github.com/hwatanabe-jp/stark-ballot-simulator';
  const authResourceArn = `arn:aws:codeconnections:${REGION}:${ACCOUNT_ID}:connection/11111111-2222-3333-4444-555555555555`;

  function authority() {
    return {
      accountId: ACCOUNT_ID,
      authResourceArn,
      buildspecPath,
      computeType: 'BUILD_GENERAL1_SMALL',
      configuredSourceSha: SOURCE_SHA,
      environmentType: 'LINUX_CONTAINER',
      partition: 'aws',
      privilegedMode: false,
      projectName,
      region: REGION,
      repositoryUrl,
      roleName,
      sourceType: 'GITHUB',
    };
  }

  function observation() {
    return {
      artifactsType: 'NO_ARTIFACTS',
      authResourceArn,
      authType: 'CODECONNECTIONS',
      buildspecPath,
      computeType: 'BUILD_GENERAL1_SMALL',
      configuredManagedImage: 'aws/codebuild/standard:8.0',
      configuredSourceSha: SOURCE_SHA,
      environmentType: 'LINUX_CONTAINER',
      gitCloneDepth: 0,
      gitSubmodulesFetch: false,
      imagePullCredentialsType: 'CODEBUILD',
      insecureSsl: false,
      privilegedMode: false,
      projectArn: `arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/${projectName}`,
      projectName,
      reportBuildStatus: false,
      repositoryUrl,
      secondaryArtifacts: [],
      secondarySources: [],
      serviceRoleArn: `arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`,
      sourceType: 'GITHUB',
    };
  }

  it('binds an unprivileged checked-in buildspec to one exact repository source and CodeConnections resource', () => {
    const admitted = admitConfiguredSourcePathBuildProject({ authority: authority(), observation: observation() });

    expect(admitted).toEqual(observation());
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(admitted.configuredManagedImage).toBe('aws/codebuild/standard:8.0');
  });

  it('rejects changes to its exact project, source, artifact, or runtime posture', () => {
    const cases = [
      { ...observation(), configuredSourceSha: 'b'.repeat(40) },
      { ...observation(), repositoryUrl: 'https://github.com/example/other' },
      {
        ...observation(),
        authResourceArn: `arn:aws:codeconnections:${REGION}:${ACCOUNT_ID}:connection/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
      },
      { ...observation(), artifactsType: 'CODEPIPELINE' },
      { ...observation(), authType: 'OAUTH' },
      { ...observation(), buildspecPath: 'infra/framework/buildspecs/other.yml' },
      { ...observation(), computeType: 'BUILD_GENERAL1_MEDIUM' },
      { ...observation(), configuredManagedImage: 'registry.example.invalid/custom:latest' },
      { ...observation(), configuredManagedImage: 'aws/codebuild/standard:8.0-26.08.30' },
      { ...observation(), environmentType: 'ARM_CONTAINER' },
      { ...observation(), gitCloneDepth: 1 },
      { ...observation(), gitSubmodulesFetch: true },
      { ...observation(), imagePullCredentialsType: 'SERVICE_ROLE' },
      { ...observation(), insecureSsl: true },
      { ...observation(), privilegedMode: true },
      { ...observation(), projectArn: `arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/other-project` },
      { ...observation(), reportBuildStatus: true },
      { ...observation(), secondaryArtifacts: [{ artifactIdentifier: 'unexpected' }] },
      { ...observation(), secondarySources: [{ sourceIdentifier: 'unexpected' }] },
      { ...observation(), serviceRoleArn: `arn:aws:iam::${ACCOUNT_ID}:role/other-role` },
      { ...observation(), sourceType: 'CODEPIPELINE' },
    ];
    for (const candidate of cases) {
      expect(() => admitConfiguredSourcePathBuildProject({ authority: authority(), observation: candidate })).toThrow();
    }
  });

  it('rejects configured project Proxies without executing traps', () => {
    const direct = countingProxy({ authority: authority(), observation: observation() });
    expect(() => admitConfiguredSourcePathBuildProject(direct.proxy)).toThrow();

    const authorityProxy = countingProxy(authority());
    expect(() =>
      admitConfiguredSourcePathBuildProject({ authority: authorityProxy.proxy, observation: observation() }),
    ).toThrow();

    const observationProxy = countingProxy(observation());
    expect(() =>
      admitConfiguredSourcePathBuildProject({ authority: authority(), observation: observationProxy.proxy }),
    ).toThrow();

    const secondaryArtifacts = countingProxy([]);
    expect(() =>
      admitConfiguredSourcePathBuildProject({
        authority: authority(),
        observation: { ...observation(), secondaryArtifacts: secondaryArtifacts.proxy },
      }),
    ).toThrow();

    const secondarySources = countingProxy([]);
    expect(() =>
      admitConfiguredSourcePathBuildProject({
        authority: authority(),
        observation: { ...observation(), secondarySources: secondarySources.proxy },
      }),
    ).toThrow();

    for (const trapped of [direct, authorityProxy, observationProxy, secondaryArtifacts, secondarySources]) {
      expect(trapped.trapCalls()).toBe(0);
    }
  });

  it('rejects configured project accessors without invoking getters', () => {
    let getterCalls = 0;
    const rejectGetter = (): never => {
      getterCalls += 1;
      throw new Error('getter executed');
    };
    const authorityWithAccessor = authority();
    Object.defineProperty(authorityWithAccessor, 'configuredSourceSha', { enumerable: true, get: rejectGetter });
    expect(() =>
      admitConfiguredSourcePathBuildProject({ authority: authorityWithAccessor, observation: observation() }),
    ).toThrow();

    const observationWithAccessor = observation();
    Object.defineProperty(observationWithAccessor, 'repositoryUrl', { enumerable: true, get: rejectGetter });
    expect(() =>
      admitConfiguredSourcePathBuildProject({ authority: authority(), observation: observationWithAccessor }),
    ).toThrow();

    const secondarySources = [{}];
    Object.defineProperty(secondarySources, '0', { enumerable: true, get: rejectGetter });
    expect(() =>
      admitConfiguredSourcePathBuildProject({
        authority: authority(),
        observation: { ...observation(), secondarySources },
      }),
    ).toThrow();

    expect(getterCalls).toBe(0);
  });
});

describe('configured-source CodeBuild execution composition', () => {
  const runnerProjectName = 'stark-ballot-simulator-stark-dev-develop-terraform-drift-bootstrap';
  const retiredEnvironmentVariables = [
    { name: 'TERRAFORM_BASELINE_KEY', type: 'PLAINTEXT', value: 'accepted-baselines/bootstrap/record.json' },
    { name: 'TERRAFORM_BASELINE_VERSION_ID', type: 'PLAINTEXT', value: 'opaque-object-identity' },
    { name: 'TERRAFORM_BASELINE_SHA256', type: 'PLAINTEXT', value: 'b'.repeat(64) },
    { name: 'TERRAFORM_ACCEPTED_SOURCE_SHA', type: 'PLAINTEXT', value: 'c'.repeat(40) },
  ];

  function projectAuthority() {
    return {
      accountId: ACCOUNT_ID,
      authResourceArn: `arn:aws:codeconnections:${REGION}:${ACCOUNT_ID}:connection/11111111-2222-3333-4444-555555555555`,
      buildspecPath: 'infra/framework/buildspecs/terraform-drift-runner.yml',
      computeType: 'BUILD_GENERAL1_SMALL',
      configuredSourceSha: SOURCE_SHA,
      environmentType: 'LINUX_CONTAINER',
      partition: 'aws',
      privilegedMode: false,
      projectName: runnerProjectName,
      region: REGION,
      repositoryUrl: 'https://github.com/hwatanabe-jp/stark-ballot-simulator',
      roleName: 'sbs-terraform-drift-runner-stark-dev-develop-bootstrap',
      sourceType: 'GITHUB',
    };
  }

  function projectObservation() {
    const authority = projectAuthority();
    return {
      artifactsType: 'NO_ARTIFACTS',
      authResourceArn: authority.authResourceArn,
      authType: 'CODECONNECTIONS',
      buildspecPath: authority.buildspecPath,
      computeType: authority.computeType,
      configuredManagedImage: 'aws/codebuild/standard:8.0',
      configuredSourceSha: authority.configuredSourceSha,
      environmentType: authority.environmentType,
      gitCloneDepth: 0,
      gitSubmodulesFetch: false,
      imagePullCredentialsType: 'CODEBUILD',
      insecureSsl: false,
      privilegedMode: false,
      projectArn: `arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/${authority.projectName}`,
      projectName: authority.projectName,
      reportBuildStatus: false,
      repositoryUrl: authority.repositoryUrl,
      secondaryArtifacts: [],
      secondarySources: [],
      serviceRoleArn: `arn:aws:iam::${ACCOUNT_ID}:role/${authority.roleName}`,
      sourceType: 'GITHUB',
    };
  }

  function runtime() {
    const authority = projectAuthority();
    return {
      accountId: ACCOUNT_ID,
      buildId: `${authority.projectName}:11111111-2222-3333-4444-555555555555`,
      callerArn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/${authority.roleName}/codebuild-session`,
      project: projectObservation(),
      region: REGION,
      resolvedSourceSha: SOURCE_SHA,
      runningManagedImage: 'aws/codebuild/standard:7.0',
    };
  }

  function input() {
    const project = projectAuthority();
    return {
      authority: { environmentVariables: [], project },
      request: { projectName: project.projectName },
      runtime: runtime(),
    };
  }

  it('admits an exact project-only request and binds the resulting build posture', () => {
    const admitted = admitConfiguredSourceBuildExecution(input());

    expect(admitted).toEqual({
      accountId: ACCOUNT_ID,
      buildId: `${runnerProjectName}:11111111-2222-3333-4444-555555555555`,
      buildspecPath: 'infra/framework/buildspecs/terraform-drift-runner.yml',
      callerArn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/sbs-terraform-drift-runner-stark-dev-develop-bootstrap/codebuild-session`,
      computeType: 'BUILD_GENERAL1_SMALL',
      configuredManagedImage: 'aws/codebuild/standard:8.0',
      environmentType: 'LINUX_CONTAINER',
      environmentVariablesOverride: [],
      privilegedMode: false,
      projectArn: `arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/${runnerProjectName}`,
      projectName: runnerProjectName,
      region: REGION,
      resolvedSourceSha: SOURCE_SHA,
      runningManagedImage: 'aws/codebuild/standard:7.0',
      serviceRoleArn: `arn:aws:iam::${ACCOUNT_ID}:role/sbs-terraform-drift-runner-stark-dev-develop-bootstrap`,
    });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.environmentVariablesOverride)).toBe(true);
  });

  it('rejects request changes and unrelated or differently configured running builds', () => {
    const admittedInput = input();
    const cases = [
      { ...admittedInput, request: { ...admittedInput.request, sourceVersion: SOURCE_SHA } },
      { ...admittedInput, request: { ...admittedInput.request, projectName: 'other-project' } },
      {
        ...admittedInput,
        request: { ...admittedInput.request, environmentVariablesOverride: retiredEnvironmentVariables },
      },
      { ...admittedInput, runtime: { ...admittedInput.runtime, resolvedSourceSha: 'd'.repeat(40) } },
      { ...admittedInput, runtime: { ...admittedInput.runtime, accountId: '999999999999' } },
      { ...admittedInput, runtime: { ...admittedInput.runtime, region: 'us-east-1' } },
      {
        ...admittedInput,
        runtime: { ...admittedInput.runtime, buildId: 'other-project:11111111-2222-3333-4444-555555555555' },
      },
      {
        ...admittedInput,
        runtime: {
          ...admittedInput.runtime,
          callerArn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/other-role/codebuild-session`,
        },
      },
      {
        ...admittedInput,
        runtime: {
          ...admittedInput.runtime,
          project: { ...admittedInput.runtime.project, computeType: 'BUILD_GENERAL1_MEDIUM' },
        },
      },
      {
        ...admittedInput,
        runtime: { ...admittedInput.runtime, project: { ...admittedInput.runtime.project, privilegedMode: true } },
      },
      {
        ...admittedInput,
        runtime: {
          ...admittedInput.runtime,
          project: { ...admittedInput.runtime.project, projectName: 'other-project' },
        },
      },
      {
        ...admittedInput,
        runtime: {
          ...admittedInput.runtime,
          project: { ...admittedInput.runtime.project, configuredSourceSha: 'd'.repeat(40) },
        },
      },
    ];
    for (const candidate of cases) {
      expect(() => admitConfiguredSourceBuildExecution(candidate)).toThrow();
    }
    expect(() =>
      admitConfiguredSourceBuildExecution({
        ...admittedInput,
        request: { environmentVariablesOverride: [], projectName: runnerProjectName },
      }),
    ).toThrow();
  });

  it('rejects execution Proxies without executing traps', () => {
    const admittedInput = input();
    const direct = countingProxy(admittedInput);
    expect(() => admitConfiguredSourceBuildExecution(direct.proxy)).toThrow();

    const authority = countingProxy(admittedInput.authority);
    expect(() => admitConfiguredSourceBuildExecution({ ...admittedInput, authority: authority.proxy })).toThrow();

    const authorityProject = countingProxy(admittedInput.authority.project);
    expect(() =>
      admitConfiguredSourceBuildExecution({
        ...admittedInput,
        authority: { ...admittedInput.authority, project: authorityProject.proxy },
      }),
    ).toThrow();

    const request = countingProxy(admittedInput.request);
    expect(() => admitConfiguredSourceBuildExecution({ ...admittedInput, request: request.proxy })).toThrow();

    const runtimeProxy = countingProxy(admittedInput.runtime);
    expect(() => admitConfiguredSourceBuildExecution({ ...admittedInput, runtime: runtimeProxy.proxy })).toThrow();

    const runtimeProject = countingProxy(admittedInput.runtime.project);
    expect(() =>
      admitConfiguredSourceBuildExecution({
        ...admittedInput,
        runtime: { ...admittedInput.runtime, project: runtimeProject.proxy },
      }),
    ).toThrow();

    const variableArray = countingProxy(retiredEnvironmentVariables);
    expect(() =>
      admitConfiguredSourceBuildExecution({
        ...admittedInput,
        authority: { ...admittedInput.authority, environmentVariables: variableArray.proxy },
      }),
    ).toThrow();

    const variable = countingProxy(retiredEnvironmentVariables[0] ?? {});
    expect(() =>
      admitConfiguredSourceBuildExecution({
        ...admittedInput,
        request: {
          ...admittedInput.request,
          environmentVariablesOverride: [variable.proxy, ...retiredEnvironmentVariables.slice(1)],
        },
      }),
    ).toThrow();

    for (const trapped of [
      direct,
      authority,
      authorityProject,
      request,
      runtimeProxy,
      runtimeProject,
      variableArray,
      variable,
    ]) {
      expect(trapped.trapCalls()).toBe(0);
    }
  });

  it('rejects execution accessors without invoking getters', () => {
    let getterCalls = 0;
    const rejectGetter = (): never => {
      getterCalls += 1;
      throw new Error('getter executed');
    };
    const admittedInput = input();
    const authorityProject = { ...admittedInput.authority.project };
    Object.defineProperty(authorityProject, 'configuredSourceSha', { enumerable: true, get: rejectGetter });
    expect(() =>
      admitConfiguredSourceBuildExecution({
        ...admittedInput,
        authority: { ...admittedInput.authority, project: authorityProject },
      }),
    ).toThrow();

    const variable = { ...retiredEnvironmentVariables[0] };
    Object.defineProperty(variable, 'value', { enumerable: true, get: rejectGetter });
    expect(() =>
      admitConfiguredSourceBuildExecution({
        ...admittedInput,
        request: {
          ...admittedInput.request,
          environmentVariablesOverride: [variable, ...retiredEnvironmentVariables.slice(1)],
        },
      }),
    ).toThrow();

    const runtimeWithAccessor = { ...admittedInput.runtime };
    Object.defineProperty(runtimeWithAccessor, 'callerArn', { enumerable: true, get: rejectGetter });
    expect(() =>
      admitConfiguredSourceBuildExecution({
        ...admittedInput,
        runtime: runtimeWithAccessor,
      }),
    ).toThrow();

    const runtimeProject = { ...admittedInput.runtime.project };
    Object.defineProperty(runtimeProject, 'computeType', { enumerable: true, get: rejectGetter });
    expect(() =>
      admitConfiguredSourceBuildExecution({
        ...admittedInput,
        runtime: { ...admittedInput.runtime, project: runtimeProject },
      }),
    ).toThrow();

    expect(getterCalls).toBe(0);
  });
});

describe('CodePipeline environment-variable admission', () => {
  it('admits the current mixed-case DynamoDB recovery manifest inputs', () => {
    const environmentVariables = [
      { name: 'DynamoDbRecoveryManifestKey', type: 'PLAINTEXT', value: '#{variables.DynamoDbRecoveryManifestKey}' },
      {
        name: 'DynamoDbRecoveryManifestVersionId',
        type: 'PLAINTEXT',
        value: '#{variables.DynamoDbRecoveryManifestVersionId}',
      },
      {
        name: 'DynamoDbRecoveryManifestSha256',
        type: 'PLAINTEXT',
        value: '#{variables.DynamoDbRecoveryManifestSha256}',
      },
    ];
    const admitted = admitSourcePathBuildAction({
      authority: { ...buildActionAuthority(), environmentVariables },
      observation: {
        ...buildActionObservation(),
        configuration: {
          ...buildActionObservation().configuration,
          EnvironmentVariables: JSON.stringify(environmentVariables),
        },
      },
    });

    expect(admitted.configuration.EnvironmentVariables).toEqual(environmentVariables);
  });
});

function foundationPlanComposition() {
  const pipelineName = 'stark-ballot-simulator-pipeline-stark-dev-develop-foundation';
  const action = (
    stageName: string,
    actionName: string,
    category: 'Approval' | 'Build' | 'Source',
    provider: 'CodeBuild' | 'CodeStarSourceConnection' | 'Manual',
    inputArtifacts: readonly string[],
    outputArtifacts: readonly string[],
    projectName: string | null,
    primarySource: string | null,
    projectRoleName: string | null,
  ) => ({
    actionName,
    category,
    inputArtifacts,
    outputArtifacts,
    owner: 'AWS',
    primarySource,
    projectName,
    projectRoleName,
    provider,
    runOrder: 1,
    stageName,
    version: '1',
  });
  return {
    pipelineName,
    stages: [
      action('Source', 'Source', 'Source', 'CodeStarSourceConnection', [], ['SourceOutput'], null, null, null),
      action(
        'TerraformPlan',
        'PlanFoundationState',
        'Build',
        'CodeBuild',
        ['SourceOutput'],
        ['PlanOutput'],
        'stark-ballot-simulator-pipeline-stark-dev-develop-foundation-terraform-plan',
        'SourceOutput',
        'stark-ballot-sim-tf-plan-stark-dev-develop-foundation',
      ),
      action('ManualApproval', 'ApproveFoundationApply', 'Approval', 'Manual', [], [], null, null, null),
      action(
        'TerraformApply',
        'ApplyReviewedFoundationPlan',
        'Build',
        'CodeBuild',
        ['SourceOutput', 'PlanOutput'],
        ['ApplyOutput'],
        'stark-ballot-simulator-pipeline-stark-dev-develop-foundation-terraform-apply',
        'SourceOutput',
        'stark-ballot-sim-tf-apply-stark-dev-develop-foundation',
      ),
      action(
        'PostApplySmoke',
        'FoundationStateAbsenceOfAppRuntime',
        'Build',
        'CodeBuild',
        ['SourceOutput', 'PlanOutput', 'ApplyOutput'],
        ['FoundationSmokeOutput'],
        'stark-ballot-simulator-pipeline-stark-dev-develop-foundation-smoke',
        'SourceOutput',
        'stark-ballot-sim-tf-smoke-stark-dev-develop-foundation',
      ),
    ],
  };
}

describe('Foundation saved-plan composition', () => {
  it('admits Source through smoke with validation owned by the Plan action', () => {
    const admitted = admitFoundationPlanComposition({
      observation: foundationPlanComposition(),
      targetKey: 'stark-dev/develop',
    });

    expect(admitted).toEqual(foundationPlanComposition());
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.stages)).toBe(true);
    expect(admitted.stages.every(Object.isFrozen)).toBe(true);
  });

  it('rejects a separate validation action, validation artifact, or changed target action', () => {
    const composition = foundationPlanComposition();
    expect(() =>
      admitFoundationPlanComposition({
        observation: {
          ...composition,
          stages: [
            composition.stages[0],
            { ...composition.stages[1], stageName: 'Validate' },
            ...composition.stages.slice(1),
          ],
        },
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();
    expect(() =>
      admitFoundationPlanComposition({
        observation: {
          ...composition,
          stages: composition.stages.map((stage, index) =>
            index === 1 ? { ...stage, inputArtifacts: ['SourceOutput', 'ValidateOutput'] } : stage,
          ),
        },
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();
    expect(() =>
      admitFoundationPlanComposition({
        observation: {
          ...composition,
          stages: composition.stages.map((stage, index) =>
            index === 3 ? { ...stage, projectName: 'other-project' } : stage,
          ),
        },
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();
  });

  it('rejects composition Proxies without executing traps', () => {
    const composition = foundationPlanComposition();
    const direct = countingProxy({ observation: composition, targetKey: 'stark-dev/develop' });
    expect(() => admitFoundationPlanComposition(direct.proxy)).toThrow();

    const observation = countingProxy(composition);
    expect(() =>
      admitFoundationPlanComposition({ observation: observation.proxy, targetKey: 'stark-dev/develop' }),
    ).toThrow();

    const stages = countingProxy(composition.stages);
    expect(() =>
      admitFoundationPlanComposition({
        observation: { ...composition, stages: stages.proxy },
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();

    const stage = countingProxy(composition.stages[1] ?? {});
    expect(() =>
      admitFoundationPlanComposition({
        observation: { ...composition, stages: [composition.stages[0], stage.proxy, ...composition.stages.slice(2)] },
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();

    const artifacts = countingProxy(['SourceOutput']);
    expect(() =>
      admitFoundationPlanComposition({
        observation: {
          ...composition,
          stages: composition.stages.map((entry, index) =>
            index === 1 ? { ...entry, inputArtifacts: artifacts.proxy } : entry,
          ),
        },
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();

    for (const trapped of [direct, observation, stages, stage, artifacts]) {
      expect(trapped.trapCalls()).toBe(0);
    }
  });

  it('rejects composition accessors without invoking getters', () => {
    let getterCalls = 0;
    const rejectGetter = (): never => {
      getterCalls += 1;
      throw new Error('getter executed');
    };
    const composition = foundationPlanComposition();
    const stage = { ...composition.stages[1] };
    Object.defineProperty(stage, 'projectRoleName', { enumerable: true, get: rejectGetter });
    expect(() =>
      admitFoundationPlanComposition({
        observation: { ...composition, stages: [composition.stages[0], stage, ...composition.stages.slice(2)] },
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();

    const inputArtifacts = ['SourceOutput'];
    Object.defineProperty(inputArtifacts, '0', { enumerable: true, get: rejectGetter });
    expect(() =>
      admitFoundationPlanComposition({
        observation: {
          ...composition,
          stages: composition.stages.map((entry, index) => (index === 1 ? { ...entry, inputArtifacts } : entry)),
        },
        targetKey: 'stark-dev/develop',
      }),
    ).toThrow();

    expect(getterCalls).toBe(0);
  });
});

describe('production CodeBuild project admission', () => {
  it('admits only production membership and keeps development inventory unchanged', async () => {
    const { configuration } = productionConfigurationFixture();
    const previousDevelopment = buildCodeBuildProjectInventory({
      families: buildProjectFamilies(),
      targetKey: 'stark-dev/develop',
    });
    const productionMembership = codeBuildProjectMembership
      .filter(({ family }) => family !== 'static-fast')
      .map((entry) => ({
        ...entry,
        projectName: entry.projectName.replaceAll('stark-dev-develop', 'stark-prod-main'),
      }));
    vi.resetModules();
    vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
    try {
      const configured = await import('./source-path-build-authority.js');
      const families = CODEBUILD_PROJECT_FAMILIES.filter((family) => family !== 'static-fast').map((family) => ({
        family,
        projects: productionMembership.filter((entry) => entry.family === family),
      }));
      const inventory = configured.buildCodeBuildProjectInventory({ families, targetKey: 'stark-prod/main' });
      expect(inventory).toEqual(productionMembership);
      expect(inventory).toHaveLength(24);
      expect(inventory.filter(({ privilegedMode }) => privilegedMode)).toHaveLength(2);
      expect(
        configured.buildCodeBuildProjectInventory({
          families: buildProjectFamilies(),
          targetKey: 'stark-dev/develop',
        }),
      ).toEqual(previousDevelopment);
      expect(
        configured.assertPrivilegedProjectInventory({
          projects: inventory.map(({ projectName, privilegedMode }) => ({ projectName, privilegedMode })),
          targetKey: 'stark-prod/main',
        }).privilegedProjectNames,
      ).toEqual(
        inventory
          .filter(({ privilegedMode }) => privilegedMode)
          .map(({ projectName }) => projectName)
          .sort(),
      );
      expect(() => configured.buildCodeBuildProjectInventory({ families, targetKey: 'stark-dev/develop' })).toThrow();
      expect(() =>
        configured.buildCodeBuildProjectInventory({
          families: buildProjectFamilies(),
          targetKey: 'stark-prod/main',
        }),
      ).toThrow();
      expect(() =>
        configured.buildCodeBuildProjectInventory({
          families: [...families, { family: 'static-fast', projects: [] }],
          targetKey: 'stark-prod/main',
        }),
      ).toThrow('every exact family');
      expect(() =>
        configured.admitCodeBuildProjectFamily({
          family: 'static-fast',
          projects: [],
          targetKey: 'stark-prod/main',
        }),
      ).toThrow('family is not authorized');
      for (const family of families) {
        const mixedProjects = family.projects.map((entry, index) =>
          index === 0
            ? { ...entry, projectName: entry.projectName.replaceAll('stark-prod-main', 'stark-dev-develop') }
            : entry,
        );
        expect(() =>
          configured.admitCodeBuildProjectFamily({
            ...family,
            projects: mixedProjects,
            targetKey: 'stark-prod/main',
          }),
        ).toThrow('exact target membership');
      }
      const projects = inventory.map(({ projectName, privilegedMode }) => ({ projectName, privilegedMode }));
      for (const candidate of projects.filter(({ privilegedMode }) => privilegedMode)) {
        for (const changed of [
          projects.filter(({ projectName }) => projectName !== candidate.projectName),
          projects.map((entry) =>
            entry.projectName === candidate.projectName ? { ...entry, privilegedMode: false } : entry,
          ),
        ]) {
          expect(() =>
            configured.assertPrivilegedProjectInventory({
              projects: changed,
              targetKey: 'stark-prod/main',
            }),
          ).toThrow();
        }
      }
      for (const index of projects.flatMap((entry, index) => (entry.privilegedMode ? [] : [index]))) {
        expect(() =>
          configured.assertPrivilegedProjectInventory({
            projects: projects.map((entry, current) =>
              current === index ? { ...entry, privilegedMode: true } : entry,
            ),
            targetKey: 'stark-prod/main',
          }),
        ).toThrow();
      }
      expect(() =>
        configured.assertPrivilegedProjectInventory({
          projects: projects.map((entry) => ({
            ...entry,
            projectName: entry.projectName.replaceAll('stark-prod-main', 'stark-dev-develop'),
          })),
          targetKey: 'stark-prod/main',
        }),
      ).toThrow();
    } finally {
      vi.doUnmock('../deployment-targets.json');
      vi.resetModules();
    }
  });
});
