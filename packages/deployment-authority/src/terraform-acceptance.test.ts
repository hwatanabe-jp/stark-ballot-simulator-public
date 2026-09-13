import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { productionConfigurationFixture } from './test-support/deployment-target-fixtures';
import {
  canonicalRecordJson,
  renderDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
  resolveImageSigningIdentity,
} from './index.js';
import { FOUNDATION_CONTRACT_CLOSURE_IDENTITY } from './foundation-contract.js';
import {
  BOOTSTRAP_ACCEPTANCE_KIND,
  BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
  FOUNDATION_ACCEPTANCE_KIND,
  FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND,
  admitTerraformAcceptancePointer,
  admitTerraformAcceptanceRecord,
  admitTerraformAcceptanceRecordKey,
  deriveTerraformAcceptanceRecordKey,
} from './terraform-acceptance.js';

const sourceSha = 'a'.repeat(40);
const pipelineExecutionId = '11111111-2222-3333-4444-555555555555';
const acceptanceAttemptId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const stateKmsKeyId = '22222222-3333-4444-5555-666666666666';
const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const targetContext = renderDeploymentLaneContext({
  target,
  lane: 'bootstrap',
  accountId: target.accountId,
  requestedControlSourceSha: sourceSha,
  selectedApplicationSourceSha: sourceSha,
  frameworkSourceSha: sourceSha,
});
const foundationTargetContext = renderDeploymentLaneContext({
  target,
  lane: 'foundation',
  accountId: target.accountId,
  requestedControlSourceSha: sourceSha,
  selectedApplicationSourceSha: sourceSha,
  frameworkSourceSha: sourceSha,
});
const stateKmsKeyArn = `arn:${target.partition}:kms:${target.region}:${target.accountId}:key/${stateKmsKeyId}`;
const imageSigningIdentity = resolveImageSigningIdentity(target);

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalRecordJson(value)).digest('hex');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const bootstrapInputKeys = [
  'account_alias',
  'aws_account_id',
  'aws_region',
  'backend_principal_arns',
  'control_source_sha',
  'deployment_environment',
  'development_app_cloudfront_acm_certificate_arn',
  'development_app_public_hostname',
  'enable_development_app_pipeline',
  'enable_development_foundation_pipeline',
  'enable_development_pipeline',
  'github_full_repository_id',
  'project_name',
  'protected_production_aws_account_id',
  'source_branch',
  'state_backend_key',
  'state_bucket_name',
  'state_kms_alias',
  'state_kms_key_id',
  'state_scope',
  'terraform_version',
] as const;

function nonsecretInputs() {
  const values: Record<string, unknown> = Object.fromEntries(bootstrapInputKeys.map((key) => [key, 'fixture']));
  Object.assign(values, {
    account_alias: targetContext.target.accountLabel,
    aws_account_id: targetContext.target.accountId,
    aws_region: targetContext.target.region,
    backend_principal_arns: [`arn:aws:iam::${targetContext.target.accountId}:role/operator`],
    control_source_sha: targetContext.source.requestedControlSourceSha,
    deployment_environment: targetContext.target.environmentId,
    development_app_cloudfront_acm_certificate_arn: null,
    enable_development_app_pipeline: true,
    enable_development_foundation_pipeline: true,
    enable_development_pipeline: true,
    github_full_repository_id: targetContext.source.repository,
    project_name: targetContext.project.projectId,
    protected_production_aws_account_id: null,
    source_branch: targetContext.source.branch,
    state_backend_key: targetContext.root.backendKey,
    state_bucket_name: targetContext.names.terraformStateBucket,
    state_kms_alias: targetContext.names.terraformStateKmsAlias,
    state_kms_key_id: stateKmsKeyId,
    state_scope: targetContext.root.scope,
    terraform_version: '1.15.8',
  });
  const body = canonicalRecordJson(values);
  return {
    evidenceType: 'terraform-baseline-nonsecret-inputs',
    root: 'bootstrap',
    files: [
      {
        path: 'pipeline.auto.tfvars.json',
        sha256: createHash('sha256').update(body).digest('hex'),
        contentBase64: Buffer.from(body).toString('base64'),
      },
    ],
    secretValuesIncluded: false,
  } as const;
}

function mutateNonsecretInputValues(mutate: (values: Record<string, unknown>) => void) {
  const inputs = nonsecretInputs();
  const file = inputs.files[0];
  const values: unknown = JSON.parse(Buffer.from(file.contentBase64, 'base64').toString('utf8'));
  if (!isRecord(values)) {
    throw new Error('test invariant failed');
  }
  const mutableValues = { ...values };
  mutate(mutableValues);
  const body = canonicalRecordJson(mutableValues);
  return {
    ...inputs,
    files: [
      {
        ...file,
        sha256: createHash('sha256').update(body).digest('hex'),
        contentBase64: Buffer.from(body).toString('base64'),
      },
    ],
  };
}

function providerLock(): string {
  return (
    '# This file is maintained automatically by "terraform init".\n' +
    '# Manual edits may be lost in future updates.\n\n' +
    'provider "registry.terraform.io/hashicorp/aws" {\n' +
    '  version     = "6.58.0"\n' +
    '  constraints = "= 6.58.0"\n' +
    '  hashes = [\n' +
    `    "zh:${'1'.repeat(64)}",\n` +
    '  ]\n' +
    '}\n'
  );
}

function runtimeEvidence() {
  const projectName = targetContext.names.terraformPlanProject;
  return {
    evidenceType: 'codebuild-runtime',
    targetKey: 'stark-dev/develop',
    lane: 'bootstrap',
    stateIdentity: targetContext.root.stateIdentity,
    sourceSha,
    project: {
      key: 'terraformPlanProject',
      name: projectName,
      arn: `arn:${target.partition}:codebuild:${target.region}:${target.accountId}:project/${projectName}`,
      buildId: `${projectName}:33333333-4444-5555-6666-777777777777`,
    },
    runtime: {
      configuredImage: 'aws/codebuild/standard:8.0',
      observedImage: 'aws/codebuild/standard:8.0',
      computeType: 'BUILD_GENERAL1_SMALL',
      environmentType: 'LINUX_CONTAINER',
      privilegedMode: false,
    },
  } as const;
}

function acceptance(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: BOOTSTRAP_ACCEPTANCE_KIND,
    targetKey: 'stark-dev/develop',
    targetContext,
    backend: {
      bucketName: targetContext.names.terraformStateBucket,
      backendKey: targetContext.root.backendKey,
      kmsKeyArn: stateKmsKeyArn,
      region: targetContext.target.region,
    },
    nonsecretInputs: nonsecretInputs(),
    secretReferences: [],
    provider: {
      lock: providerLock(),
      selections: { 'registry.terraform.io/hashicorp/aws': '6.58.0' },
      terraformVersion: '1.15.8',
      platform: 'linux_amd64',
      runtime: runtimeEvidence(),
    },
    acceptedPlanChecksum: '4'.repeat(64),
    approval: {
      approvalType: 'bootstrap-saved-plan-approval',
      stageName: 'ManualApproval',
      actionName: 'ApproveInitialDevelopmentApply',
      actionExecutionId: '44444444-5555-6666-7777-888888888888',
      reviewedPlanChecksum: '4'.repeat(64),
      approver: `arn:${target.partition}:sts::${target.accountId}:assumed-role/operator/session`,
      approvalTimestamp: '2026-08-14T01:02:03.000Z',
    },
    smoke: {
      result: 'passed',
      evidence: {
        evidenceType: 'bootstrap-codebuild-log-group-state',
        targetKey: 'stark-dev/develop',
        stateIdentity: targetContext.root.stateIdentity,
        backendKey: targetContext.root.backendKey,
        controlSourceSha: sourceSha,
        frameworkSourceSha: sourceSha,
        acceptedPlanChecksum: '4'.repeat(64),
        pipelineExecutionId,
        manifestSha256: '5'.repeat(64),
        stateJsonSha256: '6'.repeat(64),
        expectedMoveCount: 27,
        verifiedNewAddressCount: 27,
        retainedOldAddressCount: 0,
        remoteIdentityMismatchCount: 0,
      },
    },
    pipelineExecutionId,
    acceptanceAttemptId,
    acceptedAt: '2026-08-14T01:04:05.000Z',
    ...overrides,
  } as const;
}

function pointer(
  recordKey: string,
  previous: Readonly<{ etag: string; versionId: string }> | null = null,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    kind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
    targetKey: 'stark-dev/develop',
    recordKey,
    pipelineExecutionId,
    acceptanceAttemptId,
    previous,
    compareAndSwapEvidenceId: `cas/bootstrap-acceptance/${pipelineExecutionId}/${acceptanceAttemptId}`,
    ...overrides,
  } as const;
}

describe('Bootstrap Terraform acceptance record', () => {
  it('admits and content-addresses one exact self-contained record', () => {
    const admitted = admitTerraformAcceptanceRecord(BOOTSTRAP_ACCEPTANCE_KIND, acceptance(), target.targetKey);

    expect(admitted).toEqual(acceptance());
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.targetContext)).toBe(true);
    expect(deriveTerraformAcceptanceRecordKey(BOOTSTRAP_ACCEPTANCE_KIND, admitted, target.targetKey)).toMatch(
      /^accepted-baselines\/stark-dev\/develop\/bootstrap\/acceptances\/[0-9a-f]{64}\.json$/u,
    );
    expect(BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND).toBe('bootstrap-current-acceptance-pointer');
  });

  it.each([
    ['unknown field', { rawPlanJson: {} }],
    ['raw state', { terraformState: '{}' }],
    ['saved plan', { savedPlan: 'binary' }],
    ['decrypted secret', { decryptedSecret: 'sentinel' }],
    ['command transcript', { commandTranscript: ['terraform apply'] }],
  ] as const)('rejects a record containing %s', (_label, prohibited) => {
    expect(() =>
      admitTerraformAcceptanceRecord(BOOTSTRAP_ACCEPTANCE_KIND, acceptance(prohibited), target.targetKey),
    ).toThrow('exact current shape');
  });

  it('rejects hidden authority without invoking accessors', () => {
    let getterCalls = 0;
    const hidden = { ...acceptance() };
    Object.defineProperty(hidden, 'hidden', {
      enumerable: false,
      get() {
        getterCalls += 1;
        return 'sentinel';
      },
    });

    expect(() => admitTerraformAcceptanceRecord(BOOTSTRAP_ACCEPTANCE_KIND, hidden, target.targetKey)).toThrow(
      'exact current shape',
    );
    expect(getterCalls).toBe(0);
  });

  it.each([
    [
      'unknown kind',
      () => admitTerraformAcceptanceRecord('foundation-acceptance' as never, acceptance(), target.targetKey),
    ],
    [
      'wrong target',
      () =>
        admitTerraformAcceptanceRecord(
          BOOTSTRAP_ACCEPTANCE_KIND,
          acceptance({ targetKey: 'stark-prod/main' }),
          target.targetKey,
        ),
    ],
    [
      'tampered context',
      () =>
        admitTerraformAcceptanceRecord(
          BOOTSTRAP_ACCEPTANCE_KIND,
          acceptance({ targetContext: { ...targetContext, targetConfigurationSha256: '9'.repeat(64) } }),
          target.targetKey,
        ),
    ],
    [
      'wrong backend',
      () =>
        admitTerraformAcceptanceRecord(
          BOOTSTRAP_ACCEPTANCE_KIND,
          acceptance({
            backend: {
              bucketName: 'different-state-bucket',
              backendKey: targetContext.root.backendKey,
              kmsKeyArn: stateKmsKeyArn,
              region: targetContext.target.region,
            },
          }),
          target.targetKey,
        ),
    ],
    [
      'secret reference',
      () =>
        admitTerraformAcceptanceRecord(
          BOOTSTRAP_ACCEPTANCE_KIND,
          acceptance({ secretReferences: [{ inputName: 'token', reference: '/secret', source: 'ssm-parameter' }] }),
          target.targetKey,
        ),
    ],
    [
      'missing nonsecret input',
      () =>
        admitTerraformAcceptanceRecord(
          BOOTSTRAP_ACCEPTANCE_KIND,
          acceptance({
            nonsecretInputs: mutateNonsecretInputValues((values) => {
              delete values['terraform_version'];
            }),
          }),
          target.targetKey,
        ),
    ],
    [
      'secret value disguised as a nonsecret input',
      () =>
        admitTerraformAcceptanceRecord(
          BOOTSTRAP_ACCEPTANCE_KIND,
          acceptance({
            nonsecretInputs: mutateNonsecretInputValues((values) => {
              values['api_secret'] = 'sentinel';
            }),
          }),
          target.targetKey,
        ),
    ],
    [
      'provider version',
      () =>
        admitTerraformAcceptanceRecord(
          BOOTSTRAP_ACCEPTANCE_KIND,
          acceptance({
            provider: {
              ...acceptance().provider,
              selections: { 'registry.terraform.io/hashicorp/aws': '6.59.0' },
            },
          }),
          target.targetKey,
        ),
    ],
    [
      'provider lock',
      () =>
        admitTerraformAcceptanceRecord(
          BOOTSTRAP_ACCEPTANCE_KIND,
          acceptance({ provider: { ...acceptance().provider, lock: `${providerLock()}\0secret` } }),
          target.targetKey,
        ),
    ],
    [
      'runtime image',
      () =>
        admitTerraformAcceptanceRecord(
          BOOTSTRAP_ACCEPTANCE_KIND,
          acceptance({
            provider: {
              ...acceptance().provider,
              runtime: {
                ...runtimeEvidence(),
                runtime: { ...runtimeEvidence().runtime, observedImage: 'detached-image' },
              },
            },
          }),
          target.targetKey,
        ),
    ],
    [
      'detached approval',
      () =>
        admitTerraformAcceptanceRecord(
          BOOTSTRAP_ACCEPTANCE_KIND,
          acceptance({ approval: { ...acceptance().approval, reviewedPlanChecksum: '7'.repeat(64) } }),
          target.targetKey,
        ),
    ],
    [
      'approval with a control character',
      () =>
        admitTerraformAcceptanceRecord(
          BOOTSTRAP_ACCEPTANCE_KIND,
          acceptance({
            approval: {
              ...acceptance().approval,
              approver: `${acceptance().approval.approver}\0sentinel`,
            },
          }),
          target.targetKey,
        ),
    ],
    [
      'acceptance before approval',
      () =>
        admitTerraformAcceptanceRecord(
          BOOTSTRAP_ACCEPTANCE_KIND,
          acceptance({ acceptedAt: '2026-08-14T01:02:02.000Z' }),
          target.targetKey,
        ),
    ],
    [
      'failed smoke',
      () =>
        admitTerraformAcceptanceRecord(
          BOOTSTRAP_ACCEPTANCE_KIND,
          acceptance({ smoke: { ...acceptance().smoke, result: 'failed' } }),
          target.targetKey,
        ),
    ],
    [
      'incomplete smoke',
      () => {
        const { verifiedNewAddressCount: _omitted, ...evidence } = acceptance().smoke.evidence;
        void _omitted;
        return admitTerraformAcceptanceRecord(
          BOOTSTRAP_ACCEPTANCE_KIND,
          acceptance({ smoke: { result: 'passed', evidence } }),
          target.targetKey,
        );
      },
    ],
    [
      'detached smoke execution',
      () =>
        admitTerraformAcceptanceRecord(
          BOOTSTRAP_ACCEPTANCE_KIND,
          acceptance({
            smoke: {
              result: 'passed',
              evidence: { ...acceptance().smoke.evidence, pipelineExecutionId: acceptanceAttemptId },
            },
          }),
          target.targetKey,
        ),
    ],
  ] as const)('rejects %s authority', (_label, reject) => {
    expect(reject).toThrow();
  });

  it('admits only the exact content-addressed namespace', () => {
    const admitted = admitTerraformAcceptanceRecord(BOOTSTRAP_ACCEPTANCE_KIND, acceptance(), target.targetKey);
    const key = deriveTerraformAcceptanceRecordKey(BOOTSTRAP_ACCEPTANCE_KIND, admitted, target.targetKey);

    expect(admitTerraformAcceptanceRecordKey(BOOTSTRAP_ACCEPTANCE_KIND, key, 'stark-dev/develop')).toBe(key);
    expect(() =>
      admitTerraformAcceptanceRecordKey(BOOTSTRAP_ACCEPTANCE_KIND, key.toUpperCase(), 'stark-dev/develop'),
    ).toThrow('namespace');
    expect(() =>
      admitTerraformAcceptanceRecordKey(BOOTSTRAP_ACCEPTANCE_KIND, `${key}.json`, 'stark-dev/develop'),
    ).toThrow('namespace');
    expect(() =>
      admitTerraformAcceptanceRecordKey(
        BOOTSTRAP_ACCEPTANCE_KIND,
        key.replace('/bootstrap/acceptances/', '/foundation/acceptances/'),
        'stark-dev/develop',
      ),
    ).toThrow('namespace');
  });
});

describe('Bootstrap Terraform current acceptance pointer', () => {
  it('admits one exact deeply frozen pointer', () => {
    const recordKey = deriveTerraformAcceptanceRecordKey(BOOTSTRAP_ACCEPTANCE_KIND, acceptance(), target.targetKey);
    const admitted = admitTerraformAcceptancePointer(
      BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
      pointer(recordKey, { etag: '"prior"', versionId: 'prior-version' }),
      target.targetKey,
    );

    expect(admitted).toEqual(pointer(recordKey, { etag: '"prior"', versionId: 'prior-version' }));
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.previous)).toBe(true);
  });

  it('admits a descriptor-stable proxied pointer and predecessor without property reads', () => {
    const recordKey = deriveTerraformAcceptanceRecordKey(
      FOUNDATION_ACCEPTANCE_KIND,
      foundationAcceptance(),
      target.targetKey,
    );
    let propertyReads = 0;
    const predecessor = new Proxy(
      { etag: '"prior"', versionId: 'prior-version' },
      {
        get() {
          propertyReads += 1;
          throw new Error('predecessor property read');
        },
      },
    );
    const value = new Proxy(foundationPointer(recordKey, predecessor), {
      get() {
        propertyReads += 1;
        throw new Error('pointer property read');
      },
    });

    expect(
      admitTerraformAcceptancePointer(FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND, value, target.targetKey),
    ).toEqual(foundationPointer(recordKey, { etag: '"prior"', versionId: 'prior-version' }));
    expect(propertyReads).toBe(0);
  });

  it.each([
    ['wrong kind', { kind: BOOTSTRAP_ACCEPTANCE_KIND }],
    ['wrong target', { targetKey: 'stark-prod/main' }],
    ['wrong key', { recordKey: 'accepted-baselines/stark-dev/develop/bootstrap/acceptances/latest.json' }],
    ['wrong execution', { pipelineExecutionId: 'not-a-uuid' }],
    ['wrong attempt', { acceptanceAttemptId: 'not-a-uuid' }],
    ['detached CAS evidence', { compareAndSwapEvidenceId: 'cas/bootstrap-acceptance/detached' }],
    ['unknown field', { transcript: 'sentinel' }],
  ] as const)('rejects %s', (_label, overrides) => {
    const recordKey = deriveTerraformAcceptanceRecordKey(BOOTSTRAP_ACCEPTANCE_KIND, acceptance(), target.targetKey);
    expect(() =>
      admitTerraformAcceptancePointer(
        BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointer(recordKey, null, overrides),
        target.targetKey,
      ),
    ).toThrow();
  });
});

const foundationInputKeys = [
  'account_alias',
  'aws_account_id',
  'aws_region',
  'deployment_environment',
  'project_name',
  'public_hostname_disposition',
  'state_backend_key',
  'state_scope',
] as const;

function foundationNonsecretInputs() {
  const values: Record<string, unknown> = Object.fromEntries(foundationInputKeys.map((key) => [key, 'fixture']));
  Object.assign(values, {
    account_alias: foundationTargetContext.target.accountLabel,
    aws_account_id: foundationTargetContext.target.accountId,
    aws_region: foundationTargetContext.target.region,
    deployment_environment: foundationTargetContext.target.environmentId,
    project_name: foundationTargetContext.project.projectId,
    public_hostname_disposition: 'external-dns-acm',
    state_backend_key: foundationTargetContext.root.backendKey,
    state_scope: foundationTargetContext.root.scope,
  });
  const body = canonicalRecordJson(values);
  return {
    evidenceType: 'terraform-baseline-nonsecret-inputs',
    root: 'foundation',
    files: [
      {
        path: 'pipeline.auto.tfvars.json',
        sha256: createHash('sha256').update(body).digest('hex'),
        contentBase64: Buffer.from(body).toString('base64'),
      },
    ],
    secretValuesIncluded: false,
  } as const;
}

function foundationRuntimeEvidence() {
  const projectName = foundationTargetContext.names.terraformPlanProject;
  return {
    evidenceType: 'codebuild-runtime',
    targetKey: 'stark-dev/develop',
    lane: 'foundation',
    stateIdentity: foundationTargetContext.root.stateIdentity,
    sourceSha,
    project: {
      key: 'terraformPlanProject',
      name: projectName,
      arn: `arn:${target.partition}:codebuild:${target.region}:${target.accountId}:project/${projectName}`,
      buildId: `${projectName}:33333333-4444-5555-6666-777777777777`,
    },
    runtime: {
      configuredImage: 'aws/codebuild/standard:8.0',
      observedImage: 'aws/codebuild/standard:8.0',
      computeType: 'BUILD_GENERAL1_SMALL',
      environmentType: 'LINUX_CONTAINER',
      privilegedMode: false,
    },
  } as const;
}

const foundationChecks = [
  'foundation_state_nonempty',
  'source_module_declarations_absent',
  'module_state_resources_absent',
  'malformed_state_resources_absent',
  'undeclared_state_resources_absent',
  'missing_declared_state_resources_absent',
  'disallowed_foundation_resource_types_absent',
  'app_runtime_state_resources_absent',
].map((id) => ({ id, count: 0 }));

function foundationContractAuthority() {
  return {
    closureIdentity: FOUNDATION_CONTRACT_CLOSURE_IDENTITY,
    foundationContractHash: '6'.repeat(64),
  } as const;
}

function foundationNetworkingAuthority() {
  return {
    vpcId: `vpc-${'1234abcd'}`,
    proverSubnetIds: [`subnet-${'1111aaaa'}`, `subnet-${'2222bbbb'}`],
    proverSecurityGroupIds: [`sg-${'1111aaaa'}`],
    networkAuthority: 'foundation-owned',
    publicSubnetException: 'accepted-for-develop-prover-egress',
  } as const;
}

function foundationImageAuthority() {
  const registryPrefix = `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/`;
  return {
    repositories: {
      prover: {
        name: imageSigningIdentity.repositories.prover,
        url: `${registryPrefix}${imageSigningIdentity.repositories.prover}`,
      },
      toolchain: {
        name: imageSigningIdentity.repositories.toolchain,
        url: `${registryPrefix}${imageSigningIdentity.repositories.toolchain}`,
      },
    },
    signingProfileName: imageSigningIdentity.signingProfileName,
    signingProfileArn: imageSigningIdentity.signingProfileArn,
    signingRepositoryFilters: [{ filterType: 'WILDCARD_MATCH', filter: imageSigningIdentity.repositories.prover }],
    tagMutability: 'IMMUTABLE',
    scanOnPush: true,
    proverSigningStatusRequired: 'COMPLETE',
    retentionPolicy: 'reference-aware-controller-target-10',
  } as const;
}

function foundationSmokeEvidence() {
  const foundationStateResources = ['aws_ecr_repository.prover', 'aws_ecr_repository.toolchain'];
  const foundationContract = foundationContractAuthority();
  const networking = foundationNetworkingAuthority();
  const imageAuthority = foundationImageAuthority();
  return {
    evidenceType: 'foundation-saved-plan',
    manifestType: 'foundation-smoke',
    stateIdentity: foundationTargetContext.root.stateIdentity,
    backendKey: foundationTargetContext.root.backendKey,
    controlSourceSha: sourceSha,
    frameworkSourceSha: sourceSha,
    acceptedPlanChecksum: '4'.repeat(64),
    pipelineExecutionId,
    appRuntimeResourcesCreated: false,
    evidenceClass: 'FoundationStateAbsenceOfAppRuntime',
    stateOwnershipVerified: true,
    ecrRetentionControllerVerified: true,
    releaseAuthorityRetentionProtected: true,
    foundationAcceptancePolicyVerified: true,
    foundationContract,
    networkingSha256: canonicalSha256(networking),
    imageAuthoritySha256: canonicalSha256(imageAuthority),
    acceptedMarkerPath: `accepted-deployments/${foundationTargetContext.root.stateIdentity}`,
    stateOwnership: {
      ownershipType: 'foundation-state',
      stateIdentity: foundationTargetContext.root.stateIdentity,
      sourceSha,
      stateResourcesSha256: '5'.repeat(64),
      foundationStateResourceCount: foundationStateResources.length,
      foundationStateResources,
      declaredFoundationResources: [...foundationStateResources],
      appRuntimeResourcesCreated: false,
      violations: {
        sourceModuleDeclarations: [],
        moduleStateResources: [],
        malformedStateResources: [],
        undeclaredStateResources: [],
        missingDeclaredStateResources: [],
        disallowedFoundationResourceTypes: [],
        appRuntimeStateResources: [],
      },
      checks: foundationChecks,
    },
    checks: foundationChecks,
  } as const;
}

function foundationAcceptance(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: FOUNDATION_ACCEPTANCE_KIND,
    targetKey: 'stark-dev/develop',
    targetContext: foundationTargetContext,
    backend: {
      bucketName: foundationTargetContext.names.terraformStateBucket,
      backendKey: foundationTargetContext.root.backendKey,
      kmsKeyArn: stateKmsKeyArn,
      region: foundationTargetContext.target.region,
    },
    nonsecretInputs: foundationNonsecretInputs(),
    secretReferences: [],
    provider: {
      lock: providerLock(),
      selections: { 'registry.terraform.io/hashicorp/aws': '6.58.0' },
      terraformVersion: '1.15.8',
      platform: 'linux_amd64',
      runtime: foundationRuntimeEvidence(),
    },
    acceptedPlanChecksum: '4'.repeat(64),
    approval: {
      approvalType: 'foundation-saved-plan-approval',
      stageName: 'ManualApproval',
      actionName: 'ApproveFoundationApply',
      actionExecutionId: '44444444-5555-6666-7777-888888888888',
      reviewedPlanChecksum: '4'.repeat(64),
      approver: `arn:${target.partition}:sts::${target.accountId}:assumed-role/operator/session`,
      approvalTimestamp: '2026-08-14T01:02:03.000Z',
    },
    smoke: { result: 'passed', evidence: foundationSmokeEvidence() },
    pipelineExecutionId,
    acceptanceAttemptId,
    acceptedAt: '2026-08-14T01:04:05.000Z',
    foundationContract: foundationContractAuthority(),
    networking: foundationNetworkingAuthority(),
    imageAuthority: foundationImageAuthority(),
    ...overrides,
  } as const;
}

describe('Foundation Terraform acceptance record', () => {
  it('admits and content-addresses one exact self-contained Foundation authority', () => {
    const admitted = admitTerraformAcceptanceRecord(
      FOUNDATION_ACCEPTANCE_KIND,
      foundationAcceptance(),
      target.targetKey,
    );

    expect(admitted).toEqual(foundationAcceptance());
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.networking)).toBe(true);
    expect(Object.isFrozen(admitted.imageAuthority.repositories.prover)).toBe(true);
    expect(deriveTerraformAcceptanceRecordKey(FOUNDATION_ACCEPTANCE_KIND, admitted, target.targetKey)).toMatch(
      /^accepted-baselines\/stark-dev\/develop\/foundation\/acceptances\/[0-9a-f]{64}\.json$/u,
    );
    expect(FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND).toBe('foundation-current-acceptance-pointer');
  });

  it('rejects the retired handoff-policy smoke claims', () => {
    const evidence = foundationSmokeEvidence();

    expect(() =>
      admitTerraformAcceptanceRecord(
        FOUNDATION_ACCEPTANCE_KIND,
        foundationAcceptance({
          smoke: {
            result: 'passed',
            evidence: {
              ...evidence,
              foundationAppNetworkingPolicyVerified: true,
              foundationImageSigningAuthorityPolicyVerified: true,
            },
          },
        }),
        target.targetKey,
      ),
    ).toThrow(/exact current shape/u);
  });

  it.each([
    ['raw plan JSON', { rawPlanJson: {} }],
    ['Terraform state', { terraformState: '{}' }],
    ['saved plan bytes', { savedPlan: 'binary' }],
    ['decrypted secret', { decryptedSecret: 'sentinel' }],
    ['command transcript', { commandTranscript: ['terraform apply'] }],
  ] as const)('rejects prohibited %s authority', (_label, prohibited) => {
    expect(() =>
      admitTerraformAcceptanceRecord(FOUNDATION_ACCEPTANCE_KIND, foundationAcceptance(prohibited), target.targetKey),
    ).toThrow('exact current shape');
  });

  it('rejects hidden authority without invoking accessors', () => {
    let getterCalls = 0;
    const hidden = { ...foundationAcceptance() };
    Object.defineProperty(hidden, 'hidden', {
      enumerable: false,
      get() {
        getterCalls += 1;
        return 'sentinel';
      },
    });

    expect(() => admitTerraformAcceptanceRecord(FOUNDATION_ACCEPTANCE_KIND, hidden, target.targetKey)).toThrow(
      'exact current shape',
    );
    expect(getterCalls).toBe(0);
  });

  it.each([
    [
      'Bootstrap context',
      () =>
        admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({ targetContext }),
          target.targetKey,
        ),
    ],
    [
      'wrong backend bucket',
      () =>
        admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({
            backend: { ...foundationAcceptance().backend, bucketName: 'different-state-bucket' },
          }),
          target.targetKey,
        ),
    ],
    [
      'secret reference',
      () =>
        admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({
            secretReferences: [{ inputName: 'token', reference: '/secret', source: 'ssm-parameter' }],
          }),
          target.targetKey,
        ),
    ],
    [
      'detached approval',
      () =>
        admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({
            approval: { ...foundationAcceptance().approval, reviewedPlanChecksum: '8'.repeat(64) },
          }),
          target.targetKey,
        ),
    ],
    [
      'wrong Plan runtime lane',
      () =>
        admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({
            provider: {
              ...foundationAcceptance().provider,
              runtime: { ...foundationRuntimeEvidence(), lane: 'bootstrap' },
            },
          }),
          target.targetKey,
        ),
    ],
    [
      'stale contract closure identity',
      () =>
        admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({
            foundationContract: {
              ...foundationAcceptance().foundationContract,
              closureIdentity: '0'.repeat(64),
            },
          }),
          target.targetKey,
        ),
    ],
    [
      'malformed contract hash',
      () =>
        admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({
            foundationContract: {
              ...foundationAcceptance().foundationContract,
              foundationContractHash: 'not-a-hash',
            },
          }),
          target.targetKey,
        ),
    ],
    [
      'unknown contract field',
      () =>
        admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({
            foundationContract: { ...foundationAcceptance().foundationContract, sourceSha },
          }),
          target.targetKey,
        ),
    ],
    [
      'unsorted networking IDs',
      () =>
        admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({
            networking: {
              ...foundationAcceptance().networking,
              proverSubnetIds: [...foundationAcceptance().networking.proverSubnetIds].reverse(),
            },
          }),
          target.targetKey,
        ),
    ],
    [
      'duplicate networking ID',
      () =>
        admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({
            networking: {
              ...foundationAcceptance().networking,
              proverSecurityGroupIds: [`sg-${'1111aaaa'}`, `sg-${'1111aaaa'}`],
            },
          }),
          target.targetKey,
        ),
    ],
    [
      'wrong Prover repository',
      () => {
        const authority = foundationAcceptance().imageAuthority;
        return admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({
            imageAuthority: {
              ...authority,
              repositories: {
                ...authority.repositories,
                prover: { ...authority.repositories.prover, name: 'unreviewed/prover' },
              },
            },
          }),
          target.targetKey,
        );
      },
    ],
    [
      'weakened tag immutability',
      () =>
        admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({
            imageAuthority: { ...foundationAcceptance().imageAuthority, tagMutability: 'MUTABLE' },
          }),
          target.targetKey,
        ),
    ],
    [
      'wrong signing filter',
      () =>
        admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({
            imageAuthority: {
              ...foundationAcceptance().imageAuthority,
              signingRepositoryFilters: [{ filterType: 'WILDCARD_MATCH', filter: 'unreviewed/*' }],
            },
          }),
          target.targetKey,
        ),
    ],
    [
      'failed smoke',
      () =>
        admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({ smoke: { ...foundationAcceptance().smoke, result: 'failed' } }),
          target.targetKey,
        ),
    ],
    [
      'smoke violation',
      () => {
        const evidence = foundationSmokeEvidence();
        return admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({
            smoke: {
              result: 'passed',
              evidence: {
                ...evidence,
                stateOwnership: {
                  ...evidence.stateOwnership,
                  violations: {
                    ...evidence.stateOwnership.violations,
                    appRuntimeStateResources: ['aws_lambda_function.public_api'],
                  },
                },
              },
            },
          }),
          target.targetKey,
        );
      },
    ],
    [
      'detached smoke execution',
      () => {
        const evidence = foundationSmokeEvidence();
        return admitTerraformAcceptanceRecord(
          FOUNDATION_ACCEPTANCE_KIND,
          foundationAcceptance({
            smoke: { result: 'passed', evidence: { ...evidence, pipelineExecutionId: acceptanceAttemptId } },
          }),
          target.targetKey,
        );
      },
    ],
  ] as const)('rejects %s', (_label, reject) => {
    expect(reject).toThrow();
  });

  it('rejects accessor smoke checks and signing filters without invoking either accessor', () => {
    const smokeEvidence = foundationSmokeEvidence();
    const checks = smokeEvidence.checks.map((check) => ({ ...check })) as Array<Record<string, unknown>>;
    let checkAccessorCalls = 0;
    Object.defineProperty(checks[0], 'id', {
      enumerable: true,
      get() {
        checkAccessorCalls += 1;
        return foundationChecks[0]?.id;
      },
    });

    expect(() =>
      admitTerraformAcceptanceRecord(
        FOUNDATION_ACCEPTANCE_KIND,
        foundationAcceptance({
          smoke: { result: 'passed', evidence: { ...smokeEvidence, checks } },
        }),
        target.targetKey,
      ),
    ).toThrow();
    expect(checkAccessorCalls).toBe(0);

    const authority = foundationAcceptance().imageAuthority;
    const filter: Record<string, unknown> = { filterType: 'WILDCARD_MATCH' };
    let filterAccessorCalls = 0;
    Object.defineProperty(filter, 'filter', {
      enumerable: true,
      get() {
        filterAccessorCalls += 1;
        return imageSigningIdentity.repositories.prover;
      },
    });
    expect(() =>
      admitTerraformAcceptanceRecord(
        FOUNDATION_ACCEPTANCE_KIND,
        foundationAcceptance({
          imageAuthority: { ...authority, signingRepositoryFilters: [filter] },
        }),
        target.targetKey,
      ),
    ).toThrow();
    expect(filterAccessorCalls).toBe(0);
  });

  it.each([
    ['targetContext', foundationAcceptance().targetContext],
    ['backend', foundationAcceptance().backend],
    ['nonsecretInputs', foundationAcceptance().nonsecretInputs],
    ['provider', foundationAcceptance().provider],
    ['smoke', foundationAcceptance().smoke],
    ['foundationContract', foundationAcceptance().foundationContract],
    ['networking', foundationAcceptance().networking],
    ['imageAuthority', foundationAcceptance().imageAuthority],
  ] as const)('admits a descriptor-stable proxied %s without property reads', (field, value) => {
    let propertyReads = 0;
    const proxied = new Proxy(value, {
      get(targetValue, key, receiver) {
        void targetValue;
        void key;
        void receiver;
        propertyReads += 1;
        throw new Error('proxied authority property must not be read');
      },
    });

    const admitted = admitTerraformAcceptanceRecord(
      FOUNDATION_ACCEPTANCE_KIND,
      new Proxy(
        { ...foundationAcceptance(), [field]: proxied },
        {
          get(targetValue, key, receiver) {
            void targetValue;
            void key;
            void receiver;
            propertyReads += 1;
            throw new Error('proxied acceptance property must not be read');
          },
        },
      ),
      target.targetKey,
    );

    expect(admitted).toEqual(foundationAcceptance());
    expect(propertyReads).toBe(0);
  });

  it('admits proxied nested smoke checks, authority arrays, and runtime data without property reads', () => {
    const base = foundationAcceptance();
    let propertyReads = 0;
    const proxied = <T extends object>(value: T): T =>
      new Proxy(value, {
        get(targetValue, key, receiver) {
          propertyReads += 1;
          return Reflect.get(targetValue, key, receiver);
        },
      });
    const smokeEvidence = base.smoke.evidence;
    const checks = proxied(smokeEvidence.checks.map((check) => proxied({ ...check })));
    const record = {
      ...base,
      provider: { ...base.provider, runtime: proxied(base.provider.runtime) },
      smoke: {
        ...base.smoke,
        evidence: {
          ...smokeEvidence,
          checks,
          stateOwnership: { ...smokeEvidence.stateOwnership, checks },
        },
      },
      networking: {
        ...base.networking,
        proverSubnetIds: proxied([...base.networking.proverSubnetIds]),
      },
      imageAuthority: {
        ...base.imageAuthority,
        signingRepositoryFilters: proxied(
          base.imageAuthority.signingRepositoryFilters.map((filter) => proxied({ ...filter })),
        ),
      },
    };

    expect(admitTerraformAcceptanceRecord(FOUNDATION_ACCEPTANCE_KIND, record, target.targetKey)).toEqual(base);
    expect(propertyReads).toBe(0);
  });

  it.each([
    ['contract', { foundationContract: { ...foundationContractAuthority(), foundationContractHash: '7'.repeat(64) } }],
    ['networking', { networkingSha256: '7'.repeat(64) }],
    ['image authority', { imageAuthoritySha256: '7'.repeat(64) }],
  ] as const)('rejects smoke evidence detached from its admitted %s', (_label, mismatch) => {
    const evidence = foundationSmokeEvidence();
    expect(() =>
      admitTerraformAcceptanceRecord(
        FOUNDATION_ACCEPTANCE_KIND,
        foundationAcceptance({ smoke: { result: 'passed', evidence: { ...evidence, ...mismatch } } }),
        target.targetKey,
      ),
    ).toThrow(/smoke.*detached/u);
  });

  it.each(['sparse', 'hidden', 'symbol'] as const)('rejects %s Foundation array authority', (shape) => {
    const subnetIds: unknown[] = [`subnet-${'1111aaaa'}`];
    if (shape === 'sparse') {
      subnetIds.length = 2;
    } else if (shape === 'hidden') {
      Object.defineProperty(subnetIds, 'hidden', { value: 'sentinel', enumerable: false });
    } else {
      Object.defineProperty(subnetIds, Symbol('sentinel'), { value: 'sentinel', enumerable: true });
    }

    expect(() =>
      admitTerraformAcceptanceRecord(
        FOUNDATION_ACCEPTANCE_KIND,
        foundationAcceptance({
          networking: { ...foundationAcceptance().networking, proverSubnetIds: subnetIds },
        }),
        target.targetKey,
      ),
    ).toThrow(/dense array/u);
  });

  it('admits only the exact Foundation content-addressed namespace', () => {
    const key = deriveTerraformAcceptanceRecordKey(
      FOUNDATION_ACCEPTANCE_KIND,
      foundationAcceptance(),
      target.targetKey,
    );

    expect(admitTerraformAcceptanceRecordKey(FOUNDATION_ACCEPTANCE_KIND, key, 'stark-dev/develop')).toBe(key);
    expect(() =>
      admitTerraformAcceptanceRecordKey(FOUNDATION_ACCEPTANCE_KIND, key.toUpperCase(), 'stark-dev/develop'),
    ).toThrow('namespace');
    expect(() =>
      admitTerraformAcceptanceRecordKey(
        FOUNDATION_ACCEPTANCE_KIND,
        key.replace('/foundation/acceptances/', '/bootstrap/acceptances/'),
        'stark-dev/develop',
      ),
    ).toThrow('namespace');
    expect(() => admitTerraformAcceptanceRecordKey(BOOTSTRAP_ACCEPTANCE_KIND, key, 'stark-dev/develop')).toThrow(
      'namespace',
    );
  });

  it('does not derive a key for an unregistered kind', () => {
    expect(() =>
      deriveTerraformAcceptanceRecordKey('unregistered-acceptance' as never, acceptance(), target.targetKey),
    ).toThrow('not registered');
  });
});

function foundationPointer(
  recordKey: string,
  previous: Readonly<{ etag: string; versionId: string }> | null = null,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    kind: FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND,
    targetKey: 'stark-dev/develop',
    recordKey,
    pipelineExecutionId,
    acceptanceAttemptId,
    previous,
    compareAndSwapEvidenceId: `cas/foundation-acceptance/${pipelineExecutionId}/${acceptanceAttemptId}`,
    ...overrides,
  } as const;
}

describe('Foundation Terraform current acceptance pointer', () => {
  it('admits one exact deeply frozen pointer', () => {
    const recordKey = deriveTerraformAcceptanceRecordKey(
      FOUNDATION_ACCEPTANCE_KIND,
      foundationAcceptance(),
      target.targetKey,
    );
    const admitted = admitTerraformAcceptancePointer(
      FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND,
      foundationPointer(recordKey, { etag: '"prior"', versionId: 'prior-version' }),
      target.targetKey,
    );

    expect(admitted).toEqual(foundationPointer(recordKey, { etag: '"prior"', versionId: 'prior-version' }));
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.previous)).toBe(true);
  });

  it.each([
    ['wrong kind', { kind: FOUNDATION_ACCEPTANCE_KIND }],
    ['wrong target', { targetKey: 'stark-prod/main' }],
    [
      'Bootstrap record key',
      { recordKey: deriveTerraformAcceptanceRecordKey(BOOTSTRAP_ACCEPTANCE_KIND, acceptance(), target.targetKey) },
    ],
    ['floating key', { recordKey: 'accepted-baselines/stark-dev/develop/foundation/acceptances/latest.json' }],
    ['wrong execution', { pipelineExecutionId: 'not-a-uuid' }],
    ['wrong attempt', { acceptanceAttemptId: 'not-a-uuid' }],
    ['detached CAS evidence', { compareAndSwapEvidenceId: 'cas/foundation-acceptance/detached' }],
    ['unknown field', { transcript: 'sentinel' }],
  ] as const)('rejects %s', (_label, overrides) => {
    const recordKey = deriveTerraformAcceptanceRecordKey(
      FOUNDATION_ACCEPTANCE_KIND,
      foundationAcceptance(),
      target.targetKey,
    );
    expect(() =>
      admitTerraformAcceptancePointer(
        FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND,
        foundationPointer(recordKey, null, overrides),
        target.targetKey,
      ),
    ).toThrow();
  });
});

it('requires an expected target for each acceptance key namespace', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const configuredTargets = await import('./index.js');
    const configuredAcceptance = await import('./terraform-acceptance.js');
    const production = configuredTargets.resolveAllowedDeploymentTarget('stark-prod/main');
    for (const [kind, lane] of [
      [BOOTSTRAP_ACCEPTANCE_KIND, 'bootstrap'],
      [FOUNDATION_ACCEPTANCE_KIND, 'foundation'],
    ] as const) {
      const authority = configuredTargets.resolveDeploymentLaneAuthority(production, lane);
      const key = `${authority.names.terraformBaselinePrefix}/${authority.stateIdentity}/acceptances/${'a'.repeat(64)}.json`;
      expect(configuredAcceptance.admitTerraformAcceptanceRecordKey(kind, key, production.targetKey)).toBe(key);
      expect(() => configuredAcceptance.admitTerraformAcceptanceRecordKey(kind, key, 'stark-dev/develop')).toThrow(
        'namespace',
      );
      expect(() => configuredAcceptance.admitTerraformAcceptanceRecordKey(kind, key, undefined)).toThrow(
        'expected target',
      );
      expect(() => configuredAcceptance.admitTerraformAcceptanceRecordKey(kind, key, 'unreviewed/main')).toThrow(
        'not authorized',
      );
      for (const invalidKey of [
        key.toUpperCase(),
        `${key}.json`,
        key.replace('stark-prod/main', 'stark-dev/develop'),
      ]) {
        expect(() =>
          configuredAcceptance.admitTerraformAcceptanceRecordKey(kind, invalidKey, production.targetKey),
        ).toThrow('namespace');
      }
      const otherKind = kind === BOOTSTRAP_ACCEPTANCE_KIND ? FOUNDATION_ACCEPTANCE_KIND : BOOTSTRAP_ACCEPTANCE_KIND;
      expect(() =>
        configuredAcceptance.admitTerraformAcceptanceRecordKey(otherKind, key, production.targetKey),
      ).toThrow('namespace');
    }
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});

it('binds Bootstrap and Foundation pointers to an independently selected configured target', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const configuredTargets = await import('./index.js');
    const configuredAcceptance = await import('./terraform-acceptance.js');
    for (const targetKey of ['stark-dev/develop', 'stark-prod/main'] as const) {
      const selectedTarget = configuredTargets.resolveAllowedDeploymentTarget(targetKey);
      const otherTarget = targetKey === 'stark-dev/develop' ? 'stark-prod/main' : 'stark-dev/develop';
      for (const [kind, lane, factory] of [
        [BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND, 'bootstrap', pointer],
        [FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND, 'foundation', foundationPointer],
      ] as const) {
        const authority = configuredTargets.resolveDeploymentLaneAuthority(selectedTarget, lane);
        const rootPrefix = `${authority.names.terraformBaselinePrefix}/${authority.stateIdentity}`;
        const recordKey = `${rootPrefix}/acceptances/${'a'.repeat(64)}.json`;
        const value = factory(recordKey, { etag: '"previous"', versionId: 'previous-version' }, { targetKey });
        const admitted = configuredAcceptance.admitTerraformAcceptancePointer(kind, value, targetKey);
        expect(canonicalRecordJson(admitted)).toBe(canonicalRecordJson(value));
        expect(Object.isFrozen(admitted)).toBe(true);
        expect(Object.isFrozen(admitted.previous)).toBe(true);
        expect(configuredAcceptance.deriveTerraformAcceptancePointerKey(kind, targetKey)).toBe(
          `${rootPrefix}/current.json`,
        );
        expect(() => configuredAcceptance.admitTerraformAcceptancePointer(kind, value, otherTarget)).toThrow('target');
        expect(() => configuredAcceptance.admitTerraformAcceptancePointer(kind, value, undefined)).toThrow(
          'expected target',
        );
        expect(() => configuredAcceptance.deriveTerraformAcceptancePointerKey(kind, undefined)).toThrow(
          'expected target',
        );
        expect(() => configuredAcceptance.deriveTerraformAcceptancePointerKey(kind, 'unreviewed/main')).toThrow(
          'not authorized',
        );
        for (const overrides of [
          { recordKey: recordKey.replace(targetKey, otherTarget) },
          { recordKey: recordKey.replace(`/${lane}/`, lane === 'bootstrap' ? '/foundation/' : '/bootstrap/') },
          { targetKey: otherTarget },
          { compareAndSwapEvidenceId: 'cas/detached' },
        ]) {
          expect(() =>
            configuredAcceptance.admitTerraformAcceptancePointer(kind, { ...value, ...overrides }, targetKey),
          ).toThrow();
        }
      }
    }
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});

it('binds complete Terraform acceptances to the independently selected production target', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const configured = await import('./index.js');
    const authority = await import('./terraform-acceptance.js');
    const logging = await import('./source-path-build-authority.js');
    const publication = await import('./terraform-acceptance-publication.js');
    const selection = await import('./terraform-acceptance-selection.js');
    const production = configured.resolveAllowedDeploymentTarget('stark-prod/main');
    function project(value: unknown): unknown {
      if (typeof value === 'string') {
        return value
          .replaceAll(target.accountId, production.accountId)
          .replaceAll('stark-dev', 'stark-prod')
          .replaceAll('stark_dev', 'stark_prod')
          .replaceAll('develop', 'main');
      }
      if (Array.isArray(value)) return value.map((entry: unknown) => project(entry));
      if (isRecord(value))
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, project(entry)]));
      return value;
    }
    for (const [kind, lane, base] of [
      [BOOTSTRAP_ACCEPTANCE_KIND, 'bootstrap', acceptance()],
      [FOUNDATION_ACCEPTANCE_KIND, 'foundation', foundationAcceptance()],
    ] as const) {
      const context = configured.renderDeploymentLaneContext({
        target: production,
        lane,
        accountId: production.accountId,
        requestedControlSourceSha: sourceSha,
        selectedApplicationSourceSha: sourceSha,
        frameworkSourceSha: sourceSha,
      });
      const body = project(base) as Record<string, unknown>;
      body['targetContext'] = context;
      const inputs = base.nonsecretInputs.files.map((file) => {
        const values: unknown = JSON.parse(Buffer.from(file.contentBase64, 'base64').toString('utf8'));
        const projected = project(values) as Record<string, unknown>;
        if (lane === 'bootstrap') {
          projected['development_app_public_hostname'] = 'production.example.invalid';
          projected['development_app_cloudfront_acm_certificate_arn'] =
            `arn:aws:acm:us-east-1:${production.accountId}:certificate/11111111-2222-3333-4444-555555555555`;
        }
        const content = canonicalRecordJson(projected);
        return {
          path: file.path,
          sha256: createHash('sha256').update(content).digest('hex'),
          contentBase64: Buffer.from(content).toString('base64'),
        };
      });
      body['nonsecretInputs'] = { ...base.nonsecretInputs, files: inputs };
      if (lane === 'bootstrap') {
        body['approval'] = {
          ...(body['approval'] as object),
          actionName: configured.resolveBootstrapSavedPlanApprovalAction(production),
        };
        const inventory = logging.resolveBootstrapLogGroupInventory(context);
        body['smoke'] = {
          result: 'passed',
          evidence: {
            evidenceType: 'bootstrap-codebuild-log-group-inventory',
            targetKey: production.targetKey,
            stateIdentity: context.root.stateIdentity,
            backendKey: context.root.backendKey,
            controlSourceSha: sourceSha,
            frameworkSourceSha: sourceSha,
            acceptedPlanChecksum: base.acceptedPlanChecksum,
            pipelineExecutionId,
            inventorySha256: canonicalSha256(inventory),
            stateJsonSha256: '6'.repeat(64),
            expectedProjectCount: inventory.length,
            verifiedProjectCount: inventory.length,
            unexpectedLogGroupCount: 0,
            remoteIdentityMismatchCount: 0,
            retentionMismatchCount: 0,
            projectLoggingMismatchCount: 0,
          },
        };
      } else {
        body['networking'] = {
          ...(body['networking'] as object),
          publicSubnetException: configured.resolveFoundationPublicSubnetException(production),
        };
        const smoke = body['smoke'] as Record<string, unknown>;
        smoke['evidence'] = {
          ...(smoke['evidence'] as object),
          networkingSha256: canonicalSha256(body['networking']),
          imageAuthoritySha256: canonicalSha256(body['imageAuthority']),
        };
      }
      const admit = (value: unknown, expectedTarget: unknown) =>
        kind === BOOTSTRAP_ACCEPTANCE_KIND
          ? authority.admitTerraformAcceptanceRecord(BOOTSTRAP_ACCEPTANCE_KIND, value, expectedTarget)
          : authority.admitTerraformAcceptanceRecord(FOUNDATION_ACCEPTANCE_KIND, value, expectedTarget);
      const admitted = admit(body, production.targetKey);
      expect(canonicalRecordJson(admitted)).toBe(canonicalRecordJson(body));
      expect(Object.isFrozen(admitted)).toBe(true);
      const key = authority.deriveTerraformAcceptanceRecordKey(kind, admitted, production.targetKey);
      expect(key).toBe(
        `${context.names.terraformBaselinePrefix}/${context.root.stateIdentity}/acceptances/${canonicalSha256(body)}.json`,
      );
      const objects = new Map<string, { body: string; etag: string; versionId: string }>();
      const events: string[] = [];
      let sequence = 0;
      const getObject = ({ key: objectKey }: { key: string }) => {
        events.push(`get:${objectKey}`);
        return objects.get(objectKey);
      };
      const putObject = (input: {
        key: string;
        body: string;
        condition: { type: 'if-none-match' } | { type: 'if-match'; etag: string; versionId: string };
      }) => {
        events.push(`put:${input.key}:${input.condition.type}`);
        const current = objects.get(input.key);
        if (
          input.condition.type === 'if-none-match'
            ? current !== undefined
            : current?.etag !== input.condition.etag || current.versionId !== input.condition.versionId
        )
          return { status: 'precondition-failed' } as const;
        sequence += 1;
        const coordinates = { etag: `"etag-${sequence}"`, versionId: `version-${sequence}` };
        objects.set(input.key, { body: input.body, ...coordinates });
        return { status: 'written', ...coordinates } as const;
      };
      const coordinateObject = ({ key: objectKey }: { key: string }) => {
        events.push(`coordinates:${objectKey}`);
        const current = objects.get(objectKey);
        return current === undefined ? undefined : { etag: current.etag, versionId: current.versionId };
      };
      const ledger = publication.createTerraformAcceptanceLedger(
        { getObject, putObject },
        coordinateObject,
        production.targetKey,
      );
      const pointerKind =
        lane === 'bootstrap' ? BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND : FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND;
      const pointerKey = authority.deriveTerraformAcceptancePointerKey(pointerKind, production.targetKey);
      const request = {
        expectedTargetKey: production.targetKey,
        kind,
        pointerKind,
        pointerKey,
        record: admitted,
        expected: null,
        ledger: { publishRecord: ledger.publishRecord, movePointer: ledger.movePointer },
      };
      const first = await publication.publishTerraformAcceptance(request);
      expect(first).toMatchObject({ recordStatus: 'created', pointerStatus: 'moved', recordKey: key, pointerKey });
      expect(events.filter((event) => event.startsWith(`put:${pointerKey}:`))).toEqual([
        `put:${pointerKey}:if-none-match`,
      ]);
      const firstPointer = objects.get(pointerKey);
      events.length = 0;
      const selected = await selection.resolveCurrentTerraformAcceptance({
        expectedTargetKey: production.targetKey,
        root: lane,
        transport: { getObject },
      });
      expect(selected.record).toEqual(admitted);
      expect(selected.recordKey).toBe(key);
      expect(events).toEqual([`get:${pointerKey}`, `get:${key}`]);
      await expect(publication.publishTerraformAcceptance(request)).resolves.toMatchObject({
        recordStatus: 'idempotent-retry',
        pointerStatus: 'idempotent-retry',
      });
      expect(objects.get(pointerKey)).toEqual(firstPointer);
      const next = await publication.publishTerraformAcceptance({
        ...request,
        expected: first.pointerObservation,
        record: { ...admitted, acceptanceAttemptId: '12345678-1234-4234-8234-123456789abc' },
      });
      expect(next.pointerStatus).toBe('moved');
      expect(events).toContain(`put:${pointerKey}:if-match`);
      await expect(
        publication.publishTerraformAcceptance({
          ...request,
          expected: first.pointerObservation,
          record: { ...admitted, acceptanceAttemptId: '87654321-1234-4234-8234-123456789abc' },
        }),
      ).rejects.toBeInstanceOf(publication.TerraformAcceptancePointerConflictError);
      events.length = 0;
      await expect(
        publication.publishTerraformAcceptance({ ...request, expectedTargetKey: target.targetKey }),
      ).rejects.toThrow('target');
      await expect(publication.publishTerraformAcceptance({ ...request, record: base })).rejects.toThrow('target');
      const developmentLedger = publication.createTerraformAcceptanceLedger(
        { getObject, putObject },
        coordinateObject,
        target.targetKey,
      );
      await expect(developmentLedger.publishRecord(kind, admitted)).rejects.toThrow('target');
      const developmentPointerKey = authority.deriveTerraformAcceptancePointerKey(pointerKind, target.targetKey);
      await expect(ledger.observePointer({ kind: pointerKind, pointerKey: developmentPointerKey })).rejects.toThrow(
        'pointer key',
      );
      await expect(
        ledger.movePointer({
          kind: pointerKind,
          pointerKey: developmentPointerKey,
          recordKey: key,
          pipelineExecutionId,
          acceptanceAttemptId: admitted.acceptanceAttemptId,
          expected: null,
        }),
      ).rejects.toThrow('detached');
      expect(() =>
        publication.createTerraformAcceptanceLedger({ getObject, putObject }, coordinateObject, undefined),
      ).toThrow('expected target');
      await expect(
        selection.resolveCurrentTerraformAcceptance({ root: lane, transport: { getObject } }),
      ).rejects.toThrow('exact current shape');
      expect(events).toEqual([]);
      const developmentRecordKey = authority.deriveTerraformAcceptanceRecordKey(kind, base, target.targetKey);
      const developmentPointer = authority.admitTerraformAcceptancePointer(
        pointerKind,
        {
          ...selected.pointer,
          targetKey: target.targetKey,
          recordKey: developmentRecordKey,
        },
        target.targetKey,
      );
      const crossPointerRead = vi.fn(() => ({
        body: canonicalRecordJson(developmentPointer),
        etag: '"mixed"',
        versionId: 'mixed-version',
      }));
      await expect(
        selection.resolveCurrentTerraformAcceptance({
          expectedTargetKey: production.targetKey,
          root: lane,
          transport: { getObject: crossPointerRead },
        }),
      ).rejects.toThrow();
      expect(crossPointerRead).toHaveBeenCalledTimes(1);
      const crossRecordRead = vi
        .fn()
        .mockReturnValueOnce(firstPointer)
        .mockReturnValueOnce({ body: canonicalRecordJson(base), etag: '"mixed"', versionId: 'mixed-version' });
      await expect(
        selection.resolveCurrentTerraformAcceptance({
          expectedTargetKey: production.targetKey,
          root: lane,
          transport: { getObject: crossRecordRead },
        }),
      ).rejects.toThrow('target');
      expect(crossRecordRead).toHaveBeenCalledTimes(2);
      objects.set(pointerKey, {
        body: canonicalRecordJson(developmentPointer),
        etag: '"mixed"',
        versionId: 'mixed-version',
      });
      await expect(publication.publishTerraformAcceptance(request)).rejects.toBeInstanceOf(
        publication.TerraformAcceptancePointerConflictError,
      );
      expect(() => admit(body, undefined)).toThrow('expected target');
      expect(() => admit(body, target.targetKey)).toThrow('target');
      expect(() => authority.deriveTerraformAcceptanceRecordKey(kind, body, target.targetKey)).toThrow('target');
      for (const overrides of [
        { targetKey: target.targetKey },
        { targetContext: base.targetContext },
        { backend: base.backend },
        { provider: base.provider },
        { approval: base.approval },
        { nonsecretInputs: base.nonsecretInputs },
        { smoke: base.smoke },
      ]) {
        expect(() => admit({ ...body, ...overrides }, production.targetKey)).toThrow();
      }
      if (lane === 'foundation') {
        expect(() =>
          admit(
            {
              ...body,
              networking: {
                ...(body['networking'] as object),
                publicSubnetException: 'accepted-for-develop-prover-egress',
              },
            },
            production.targetKey,
          ),
        ).toThrow('networking');
        expect(() =>
          admit({ ...body, imageAuthority: foundationAcceptance().imageAuthority }, production.targetKey),
        ).toThrow('image authority');
      }
    }
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
