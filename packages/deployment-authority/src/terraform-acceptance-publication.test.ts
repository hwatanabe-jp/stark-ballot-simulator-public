import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
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
  deriveTerraformAcceptanceRecordKey,
} from './terraform-acceptance.js';
import { createTerraformAcceptanceLedger, publishTerraformAcceptance } from './terraform-acceptance-publication.js';

const sourceSha = 'a'.repeat(40);
const pipelineExecutionId = '11111111-2222-3333-4444-555555555555';
const acceptanceAttemptId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const actionExecutionId = '44444444-5555-6666-7777-888888888888';
const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const imageSigningIdentity = resolveImageSigningIdentity(target);
const stateKmsKeyArn =
  `arn:${target.partition}:kms:${target.region}:${target.accountId}:key/` + '22222222-3333-4444-5555-666666666666';

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalRecordJson(value)).digest('hex');
}

const contexts = {
  bootstrap: renderDeploymentLaneContext({
    target,
    lane: 'bootstrap',
    accountId: target.accountId,
    requestedControlSourceSha: sourceSha,
    selectedApplicationSourceSha: sourceSha,
    frameworkSourceSha: sourceSha,
  }),
  foundation: renderDeploymentLaneContext({
    target,
    lane: 'foundation',
    accountId: target.accountId,
    requestedControlSourceSha: sourceSha,
    selectedApplicationSourceSha: sourceSha,
    frameworkSourceSha: sourceSha,
  }),
} as const;

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

function maximumProviderLock(): string {
  const marker = `    "zh:${'1'.repeat(64)}",\n`;
  const template = providerLock();
  const fixedBytes = Buffer.byteLength(template, 'utf8') - Buffer.byteLength(marker, 'utf8');
  const hashCount = Math.floor((1024 * 1024 - fixedBytes) / Buffer.byteLength(marker, 'utf8'));
  return template.replace(marker, marker.repeat(hashCount));
}

function nonsecretInputs(root: 'bootstrap' | 'foundation') {
  const context = contexts[root];
  const values: Record<string, unknown> =
    root === 'bootstrap'
      ? {
          account_alias: context.target.accountLabel,
          aws_account_id: context.target.accountId,
          aws_region: context.target.region,
          backend_principal_arns: [`arn:aws:iam::${context.target.accountId}:role/operator`],
          control_source_sha: context.source.requestedControlSourceSha,
          deployment_environment: context.target.environmentId,
          development_app_cloudfront_acm_certificate_arn: null,
          development_app_public_hostname: 'develop.example.invalid',
          enable_development_app_pipeline: true,
          enable_development_foundation_pipeline: true,
          enable_development_pipeline: true,
          github_full_repository_id: context.source.repository,
          project_name: context.project.projectId,
          protected_production_aws_account_id: null,
          source_branch: context.source.branch,
          state_backend_key: context.root.backendKey,
          state_bucket_name: context.names.terraformStateBucket,
          state_kms_alias: context.names.terraformStateKmsAlias,
          state_kms_key_id: '22222222-3333-4444-5555-666666666666',
          state_scope: context.root.scope,
          terraform_version: '1.15.8',
        }
      : {
          account_alias: context.target.accountLabel,
          aws_account_id: context.target.accountId,
          aws_region: context.target.region,
          deployment_environment: context.target.environmentId,
          project_name: context.project.projectId,
          public_hostname_disposition: 'external-dns-acm',
          state_backend_key: context.root.backendKey,
          state_scope: context.root.scope,
        };
  const body = canonicalRecordJson(values);
  return {
    evidenceType: 'terraform-baseline-nonsecret-inputs',
    root,
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

function runtimeEvidence(root: 'bootstrap' | 'foundation') {
  const context = contexts[root];
  const projectName = context.names.terraformPlanProject;
  return {
    evidenceType: 'codebuild-runtime',
    targetKey: 'stark-dev/develop',
    lane: root,
    stateIdentity: context.root.stateIdentity,
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

function bootstrapSmoke() {
  const context = contexts.bootstrap;
  return {
    result: 'passed',
    evidence: {
      evidenceType: 'bootstrap-codebuild-log-group-state',
      targetKey: 'stark-dev/develop',
      stateIdentity: context.root.stateIdentity,
      backendKey: context.root.backendKey,
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
  } as const;
}

const foundationCheckIds = [
  'foundation_state_nonempty',
  'source_module_declarations_absent',
  'module_state_resources_absent',
  'malformed_state_resources_absent',
  'undeclared_state_resources_absent',
  'missing_declared_state_resources_absent',
  'disallowed_foundation_resource_types_absent',
  'app_runtime_state_resources_absent',
] as const;

function foundationContractAuthority() {
  return {
    closureIdentity: FOUNDATION_CONTRACT_CLOSURE_IDENTITY,
    foundationContractHash: '8'.repeat(64),
  } as const;
}

function foundationNetworkingAuthority() {
  return {
    vpcId: `vpc-${'1234abcd'}`,
    proverSubnetIds: [`subnet-${'1111aaaa'}`],
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

function foundationSmoke() {
  const context = contexts.foundation;
  const checks = foundationCheckIds.map((id) => ({ id, count: 0 }));
  const resources = ['aws_ecr_repository.prover'];
  const foundationContract = foundationContractAuthority();
  const networking = foundationNetworkingAuthority();
  const imageAuthority = foundationImageAuthority();
  return {
    result: 'passed',
    evidence: {
      evidenceType: 'foundation-saved-plan',
      manifestType: 'foundation-smoke',
      stateIdentity: context.root.stateIdentity,
      backendKey: context.root.backendKey,
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
      acceptedMarkerPath: `accepted-deployments/${context.root.stateIdentity}`,
      stateOwnership: {
        ownershipType: 'foundation-state',
        stateIdentity: context.root.stateIdentity,
        sourceSha,
        stateResourcesSha256: '5'.repeat(64),
        foundationStateResourceCount: resources.length,
        foundationStateResources: resources,
        declaredFoundationResources: resources,
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
        checks,
      },
      checks,
    },
  } as const;
}

function commonRecord(root: 'bootstrap' | 'foundation') {
  const context = contexts[root];
  return {
    targetKey: 'stark-dev/develop',
    targetContext: context,
    backend: {
      bucketName: context.names.terraformStateBucket,
      backendKey: context.root.backendKey,
      kmsKeyArn: stateKmsKeyArn,
      region: context.target.region,
    },
    nonsecretInputs: nonsecretInputs(root),
    secretReferences: [],
    provider: {
      lock: providerLock(),
      selections: { 'registry.terraform.io/hashicorp/aws': '6.58.0' },
      terraformVersion: '1.15.8',
      platform: 'linux_amd64',
      runtime: runtimeEvidence(root),
    },
    acceptedPlanChecksum: '4'.repeat(64),
    pipelineExecutionId,
    acceptanceAttemptId,
    acceptedAt: '2026-08-14T01:04:05.000Z',
  } as const;
}

function bootstrapAcceptance() {
  return admitTerraformAcceptanceRecord(
    BOOTSTRAP_ACCEPTANCE_KIND,
    {
      kind: BOOTSTRAP_ACCEPTANCE_KIND,
      ...commonRecord('bootstrap'),
      approval: {
        approvalType: 'bootstrap-saved-plan-approval',
        stageName: 'ManualApproval',
        actionName: 'ApproveInitialDevelopmentApply',
        actionExecutionId,
        reviewedPlanChecksum: '4'.repeat(64),
        approver: `arn:${target.partition}:sts::${target.accountId}:assumed-role/operator/session`,
        approvalTimestamp: '2026-08-14T01:02:03.000Z',
      },
      smoke: bootstrapSmoke(),
    },
    target.targetKey,
  );
}

function foundationAcceptance() {
  return admitTerraformAcceptanceRecord(
    FOUNDATION_ACCEPTANCE_KIND,
    {
      kind: FOUNDATION_ACCEPTANCE_KIND,
      ...commonRecord('foundation'),
      approval: {
        approvalType: 'foundation-saved-plan-approval',
        stageName: 'ManualApproval',
        actionName: 'ApproveFoundationApply',
        actionExecutionId,
        reviewedPlanChecksum: '4'.repeat(64),
        approver: `arn:${target.partition}:sts::${target.accountId}:assumed-role/operator/session`,
        approvalTimestamp: '2026-08-14T01:02:03.000Z',
      },
      smoke: foundationSmoke(),
      foundationContract: foundationContractAuthority(),
      networking: foundationNetworkingAuthority(),
      imageAuthority: foundationImageAuthority(),
    },
    target.targetKey,
  );
}

const cases = [
  {
    kind: BOOTSTRAP_ACCEPTANCE_KIND,
    pointerKind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
    record: bootstrapAcceptance(),
  },
  {
    kind: FOUNDATION_ACCEPTANCE_KIND,
    pointerKind: FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND,
    record: foundationAcceptance(),
  },
] as const;

function successfulLedger(
  testCase: (typeof cases)[number],
  expected: Readonly<{ etag: string; versionId: string }> | null,
) {
  const { kind, pointerKind, record } = testCase;
  const recordKey = deriveTerraformAcceptanceRecordKey(kind, record, target.targetKey);
  const pointerKey = `${record.targetContext.names.terraformBaselinePrefix}/${record.targetContext.root.stateIdentity}/current.json`;
  const pointer = admitTerraformAcceptancePointer(
    pointerKind,
    {
      kind: pointerKind,
      targetKey: 'stark-dev/develop',
      recordKey,
      pipelineExecutionId,
      acceptanceAttemptId,
      previous: expected,
      compareAndSwapEvidenceId: `cas/${record.targetContext.root.lane}-acceptance/${pipelineExecutionId}/${acceptanceAttemptId}`,
    },
    target.targetKey,
  );
  const recordPublication = {
    status: 'created',
    kind,
    key: recordKey,
    record,
    recordObservation: { etag: '"record"', versionId: 'record-version' },
  } as const;
  const movement = {
    status: 'moved',
    pointerKey,
    pointer,
    pointerObservation: { etag: '"pointer"', versionId: 'pointer-version' },
    recordKey,
    record,
  } as const;
  return {
    pointerKey,
    recordKey,
    recordPublication,
    movement,
    publishRecord: vi.fn(() => Promise.resolve<unknown>(recordPublication)),
    movePointer: vi.fn(() => Promise.resolve<unknown>(movement)),
  };
}

function publicationRequest(
  testCase: (typeof cases)[number],
  fixture: ReturnType<typeof successfulLedger>,
  expected: Readonly<{ etag: string; versionId: string }> | null,
) {
  return {
    expectedTargetKey: target.targetKey,
    kind: testCase.kind,
    pointerKind: testCase.pointerKind,
    pointerKey: fixture.pointerKey,
    record: testCase.record,
    expected,
    ledger: { publishRecord: fixture.publishRecord, movePointer: fixture.movePointer },
  } as const;
}

function detachedAcceptance(testCase: (typeof cases)[number]) {
  const record = { ...testCase.record, acceptedAt: '2026-08-14T01:04:06.000Z' };
  return testCase.kind === FOUNDATION_ACCEPTANCE_KIND
    ? admitTerraformAcceptanceRecord(FOUNDATION_ACCEPTANCE_KIND, record, target.targetKey)
    : admitTerraformAcceptanceRecord(BOOTSTRAP_ACCEPTANCE_KIND, record, target.targetKey);
}

class ConditionalMemoryTransport {
  readonly objects = new Map<string, Readonly<{ body: string; etag: string; versionId: string }>>();
  readonly puts: Readonly<Record<string, unknown>>[] = [];
  readonly events: string[] = [];
  private writeCount = 0;

  getObject({ key }: { readonly key: string }) {
    this.events.push(`get:${key}`);
    return this.objects.get(key);
  }

  putObject(input: Readonly<Record<string, unknown>>) {
    this.puts.push(input);
    const key = input['key'] as string;
    this.events.push(`put:${key}`);
    const body = input['body'] as string;
    const condition = input['condition'] as Readonly<Record<string, unknown>>;
    const current = this.objects.get(key);
    const admitted =
      (condition['type'] === 'if-none-match' && current === undefined) ||
      (condition['type'] === 'if-match' &&
        current !== undefined &&
        current.etag === condition['etag'] &&
        current.versionId === condition['versionId']);
    if (!admitted) {
      return { status: 'precondition-failed' } as const;
    }
    return { status: 'written' as const, ...this.forceWrite(key, body) };
  }

  forceWrite(key: string, body: string) {
    this.writeCount += 1;
    const written = {
      body,
      etag: `"etag-${this.writeCount}"`,
      versionId: `object-${this.writeCount}`,
    } as const;
    this.objects.set(key, written);
    return { etag: written.etag, versionId: written.versionId } as const;
  }
}

function createMemoryAcceptanceLedger(transport: ConditionalMemoryTransport) {
  return createTerraformAcceptanceLedger(
    {
      getObject: transport.getObject.bind(transport),
      putObject: transport.putObject.bind(transport),
    },
    ({ key }: { readonly key: string }) => {
      const current = transport.objects.get(key);
      return current === undefined ? undefined : { etag: current.etag, versionId: current.versionId };
    },
    target.targetKey,
  );
}

describe('Terraform acceptance publication boundary', () => {
  it('creates one immutable acceptance record through the conditional object transport', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createMemoryAcceptanceLedger(transport);

    await expect(ledger.publishRecord(BOOTSTRAP_ACCEPTANCE_KIND, bootstrapAcceptance())).resolves.toMatchObject({
      status: 'created',
      kind: BOOTSTRAP_ACCEPTANCE_KIND,
    });
    expect(transport.puts).toContainEqual({
      key: deriveTerraformAcceptanceRecordKey(BOOTSTRAP_ACCEPTANCE_KIND, bootstrapAcceptance(), target.targetKey),
      body: canonicalRecordJson(bootstrapAcceptance()),
      condition: { type: 'if-none-match' },
    });
  });

  it('admits a valid Terraform acceptance larger than the release record ceiling', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createMemoryAcceptanceLedger(transport);
    const standard = bootstrapAcceptance();
    const record = admitTerraformAcceptanceRecord(
      BOOTSTRAP_ACCEPTANCE_KIND,
      {
        ...standard,
        provider: { ...standard.provider, lock: maximumProviderLock() },
      },
      target.targetKey,
    );

    expect(Buffer.byteLength(canonicalRecordJson(record), 'utf8')).toBeGreaterThan(1024 * 1024);
    await expect(ledger.publishRecord(BOOTSTRAP_ACCEPTANCE_KIND, record)).resolves.toMatchObject({
      status: 'created',
      kind: BOOTSTRAP_ACCEPTANCE_KIND,
    });
  });

  it('moves from an opaque predecessor by CAS over both its ETag and VersionId without parsing its body', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createMemoryAcceptanceLedger(transport);
    const record = bootstrapAcceptance();
    const publication = await ledger.publishRecord(BOOTSTRAP_ACCEPTANCE_KIND, record);
    const pointerKey = `${record.targetContext.names.terraformBaselinePrefix}/${record.targetContext.root.stateIdentity}/current.json`;
    const predecessor = transport.forceWrite(pointerKey, 'opaque predecessor bytes');

    await expect(
      ledger.movePointer({
        kind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointerKey,
        recordKey: publication.key,
        pipelineExecutionId,
        acceptanceAttemptId,
        expected: predecessor,
      }),
    ).resolves.toMatchObject({
      status: 'moved',
      pointerKey,
      recordKey: publication.key,
    });
    expect(transport.puts.at(-1)).toMatchObject({
      key: pointerKey,
      condition: { type: 'if-match', etag: predecessor.etag, versionId: predecessor.versionId },
    });
  });

  it('observes an opaque predecessor only as exact pointer metadata', async () => {
    const getObject = vi.fn(() => {
      throw new Error('predecessor body must not be read');
    });
    const putObject = vi.fn(() => {
      throw new Error('pointer must not be written');
    });
    const coordinateObject = vi.fn(() => ({ etag: '"legacy"', versionId: 'legacy-object' }));
    const ledger = createTerraformAcceptanceLedger({ getObject, putObject }, coordinateObject, target.targetKey);
    const record = bootstrapAcceptance();
    const pointerKey = `${record.targetContext.names.terraformBaselinePrefix}/${record.targetContext.root.stateIdentity}/current.json`;

    await expect(
      ledger.observePointer({ kind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND, pointerKey }),
    ).resolves.toEqual({ etag: '"legacy"', versionId: 'legacy-object' });
    expect(coordinateObject).toHaveBeenCalledTimes(1);
    expect(getObject).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
  });

  it.each([
    [BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND, BOOTSTRAP_ACCEPTANCE_KIND, 'bootstrap'],
    [FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND, FOUNDATION_ACCEPTANCE_KIND, 'foundation'],
  ] as const)('rejects detached %s keys before any transport call', async (kind, recordKind, root) => {
    const getObject = vi.fn();
    const putObject = vi.fn();
    const coordinateObject = vi.fn();
    const ledger = createTerraformAcceptanceLedger({ getObject, putObject }, coordinateObject, target.targetKey);
    const context = contexts[root];
    const pointerKey = `${context.names.terraformBaselinePrefix}/${context.root.stateIdentity}/current.json`;
    const record = root === 'bootstrap' ? bootstrapAcceptance() : foundationAcceptance();
    const recordKey = deriveTerraformAcceptanceRecordKey(recordKind, record, target.targetKey);
    for (const invalidKey of [
      pointerKey.replace('stark-dev/develop', 'stark-prod/main'),
      pointerKey.replace(`/${root}/`, root === 'bootstrap' ? '/foundation/' : '/bootstrap/'),
      `unrelated/${pointerKey}`,
      `${pointerKey}/current.json`,
      `${pointerKey}.json`,
      'current.json',
    ]) {
      await expect(ledger.observePointer({ kind, pointerKey: invalidKey })).rejects.toThrow('pointer key');
      await expect(
        ledger.movePointer({
          kind,
          pointerKey: invalidKey,
          recordKey,
          pipelineExecutionId,
          acceptanceAttemptId,
          expected: null,
        }),
      ).rejects.toThrow('detached');
    }
    expect(coordinateObject).not.toHaveBeenCalled();
    expect(getObject).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
    await expect(ledger.observePointer({ kind, pointerKey })).resolves.toBeNull();
    expect(coordinateObject).toHaveBeenCalledExactlyOnceWith({ key: pointerKey });
  });

  it('returns a stale-writer conflict when first-create observes a different opaque pointer', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createMemoryAcceptanceLedger(transport);
    const record = bootstrapAcceptance();
    const publication = await ledger.publishRecord(BOOTSTRAP_ACCEPTANCE_KIND, record);
    const pointerKey = `${record.targetContext.names.terraformBaselinePrefix}/${record.targetContext.root.stateIdentity}/current.json`;
    const predecessor = transport.forceWrite(pointerKey, 'opaque predecessor bytes');
    transport.events.length = 0;

    const movement = await ledger.movePointer({
      kind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
      pointerKey,
      recordKey: publication.key,
      pipelineExecutionId,
      acceptanceAttemptId,
      expected: null,
    });

    expect(movement).toEqual({ status: 'conflict', pointerKey, expected: null, observed: null });
    expect(transport.events).toEqual([`get:${publication.key}`, `put:${pointerKey}`, `get:${pointerKey}`]);
    expect(transport.puts.at(-1)?.['condition']).toEqual({ type: 'if-none-match' });
    expect(transport.objects.get(pointerKey)).toEqual({ body: 'opaque predecessor bytes', ...predecessor });
  });

  it('rejects null contention with the same acceptance bound to a different predecessor', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createMemoryAcceptanceLedger(transport);
    const record = bootstrapAcceptance();
    const publication = await ledger.publishRecord(BOOTSTRAP_ACCEPTANCE_KIND, record);
    const pointerKey = `${record.targetContext.names.terraformBaselinePrefix}/${record.targetContext.root.stateIdentity}/current.json`;
    const currentPointer = admitTerraformAcceptancePointer(
      BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
      {
        kind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
        targetKey: record.targetKey,
        recordKey: publication.key,
        pipelineExecutionId,
        acceptanceAttemptId,
        previous: { etag: '"different"', versionId: 'different-object' },
        compareAndSwapEvidenceId: `cas/bootstrap-acceptance/${pipelineExecutionId}/${acceptanceAttemptId}`,
      },
      target.targetKey,
    );
    const currentObservation = transport.forceWrite(pointerKey, canonicalRecordJson(currentPointer));

    await expect(
      ledger.movePointer({
        kind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointerKey,
        recordKey: publication.key,
        pipelineExecutionId,
        acceptanceAttemptId,
        expected: null,
      }),
    ).resolves.toEqual({ status: 'conflict', pointerKey, expected: null, observed: null });
    expect(transport.objects.get(pointerKey)).toEqual({
      body: canonicalRecordJson(currentPointer),
      ...currentObservation,
    });
  });

  it('admits only an exact target record and pointer retry without rewriting either object', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createMemoryAcceptanceLedger(transport);
    const record = bootstrapAcceptance();
    const firstRecord = await ledger.publishRecord(BOOTSTRAP_ACCEPTANCE_KIND, record);
    const retryRecord = await ledger.publishRecord(BOOTSTRAP_ACCEPTANCE_KIND, record);
    expect(retryRecord).toMatchObject({ status: 'idempotent-retry', key: firstRecord.key, record });
    const pointerKey = `${record.targetContext.names.terraformBaselinePrefix}/${record.targetContext.root.stateIdentity}/current.json`;
    const firstMove = await ledger.movePointer({
      kind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
      pointerKey,
      recordKey: firstRecord.key,
      pipelineExecutionId,
      acceptanceAttemptId,
      expected: null,
    });
    if (firstMove.status !== 'moved') throw new Error('test invariant failed');
    const pointerBeforeNullContention = transport.objects.get(pointerKey);
    const attemptsBeforeNullContention = transport.puts.length;
    await expect(
      ledger.movePointer({
        kind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointerKey,
        recordKey: firstRecord.key,
        pipelineExecutionId,
        acceptanceAttemptId,
        expected: null,
      }),
    ).resolves.toMatchObject({
      status: 'idempotent-retry',
      pointerKey,
      recordKey: firstRecord.key,
      record,
    });
    expect(transport.puts).toHaveLength(attemptsBeforeNullContention + 1);
    expect(transport.objects.get(pointerKey)).toEqual(pointerBeforeNullContention);
    const writesBeforeRetry = transport.puts.length;

    await expect(
      ledger.movePointer({
        kind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointerKey,
        recordKey: firstRecord.key,
        pipelineExecutionId,
        acceptanceAttemptId,
        expected: null,
      }),
    ).resolves.toMatchObject({
      status: 'idempotent-retry',
      pointerKey,
      recordKey: firstRecord.key,
      record,
    });
    expect(transport.puts).toHaveLength(writesBeforeRetry + 1);
    expect(transport.objects.get(pointerKey)).toEqual(pointerBeforeNullContention);
  });

  it('returns a bound conflict while treating a changed opaque predecessor as non-authoritative bytes', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createMemoryAcceptanceLedger(transport);
    const record = bootstrapAcceptance();
    const publication = await ledger.publishRecord(BOOTSTRAP_ACCEPTANCE_KIND, record);
    const pointerKey = `${record.targetContext.names.terraformBaselinePrefix}/${record.targetContext.root.stateIdentity}/current.json`;
    const reviewed = transport.forceWrite(pointerKey, '{"retiredAuthority":true}\n');
    transport.forceWrite(pointerKey, 'changed opaque predecessor bytes');

    await expect(
      ledger.movePointer({
        kind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointerKey,
        recordKey: publication.key,
        pipelineExecutionId,
        acceptanceAttemptId,
        expected: reviewed,
      }),
    ).resolves.toEqual({ status: 'conflict', pointerKey, expected: reviewed, observed: null });
  });

  it('rejects a concurrent pointer with the reviewed ETag but a different VersionId without overwriting it', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createMemoryAcceptanceLedger(transport);
    const record = bootstrapAcceptance();
    const publication = await ledger.publishRecord(BOOTSTRAP_ACCEPTANCE_KIND, record);
    const pointerKey = `${record.targetContext.names.terraformBaselinePrefix}/${record.targetContext.root.stateIdentity}/current.json`;
    const reviewed = transport.forceWrite(pointerKey, 'opaque predecessor bytes');
    transport.objects.set(pointerKey, {
      body: 'concurrent opaque bytes',
      etag: reviewed.etag,
      versionId: 'concurrent-object',
    });
    const writesBeforeMove = transport.puts.length;

    await expect(
      ledger.movePointer({
        kind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointerKey,
        recordKey: publication.key,
        pipelineExecutionId,
        acceptanceAttemptId,
        expected: reviewed,
      }),
    ).resolves.toEqual({ status: 'conflict', pointerKey, expected: reviewed, observed: null });
    expect(transport.puts).toHaveLength(writesBeforeMove + 1);
    expect(transport.objects.get(pointerKey)).toEqual({
      body: 'concurrent opaque bytes',
      etag: reviewed.etag,
      versionId: 'concurrent-object',
    });
  });

  it('admits an exact target retry after an ambiguous CAS response without rewriting the pointer', async () => {
    const transport = new ConditionalMemoryTransport();
    const basePutObject = transport.putObject.bind(transport);
    let returnAmbiguousFailure = true;
    const ledger = createTerraformAcceptanceLedger(
      {
        getObject: transport.getObject.bind(transport),
        putObject(input: Readonly<Record<string, unknown>>) {
          const result = basePutObject(input);
          if (
            returnAmbiguousFailure &&
            String(input['key']).endsWith('/current.json') &&
            result['status'] === 'written'
          ) {
            returnAmbiguousFailure = false;
            throw new Error('ambiguous conditional write response');
          }
          return result;
        },
      },
      ({ key }: { readonly key: string }) => {
        const current = transport.objects.get(key);
        return current === undefined ? undefined : { etag: current.etag, versionId: current.versionId };
      },
      target.targetKey,
    );
    const record = bootstrapAcceptance();
    const publication = await ledger.publishRecord(BOOTSTRAP_ACCEPTANCE_KIND, record);
    const pointerKey = `${record.targetContext.names.terraformBaselinePrefix}/${record.targetContext.root.stateIdentity}/current.json`;
    const predecessor = transport.forceWrite(pointerKey, 'opaque predecessor bytes');

    await expect(
      ledger.movePointer({
        kind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointerKey,
        recordKey: publication.key,
        pipelineExecutionId,
        acceptanceAttemptId,
        expected: predecessor,
      }),
    ).rejects.toThrow('ambiguous conditional write response');
    const writtenPointer = transport.objects.get(pointerKey);
    if (writtenPointer === undefined) throw new Error('test target pointer was not written');
    const writesBeforeRetry = transport.puts.length;

    await expect(
      ledger.movePointer({
        kind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointerKey,
        recordKey: publication.key,
        pipelineExecutionId,
        acceptanceAttemptId,
        expected: predecessor,
      }),
    ).resolves.toMatchObject({ status: 'idempotent-retry', pointerKey, recordKey: publication.key });
    expect(transport.puts).toHaveLength(writesBeforeRetry + 1);
    expect(transport.objects.get(pointerKey)).toEqual(writtenPointer);
  });

  it('carries a target retry through the public publication boundary without changing the pointer', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createMemoryAcceptanceLedger(transport);
    const publicationLedger = { publishRecord: ledger.publishRecord, movePointer: ledger.movePointer };
    const record = bootstrapAcceptance();
    const pointerKey = `${record.targetContext.names.terraformBaselinePrefix}/${record.targetContext.root.stateIdentity}/current.json`;
    await publishTerraformAcceptance({
      expectedTargetKey: target.targetKey,
      kind: BOOTSTRAP_ACCEPTANCE_KIND,
      pointerKind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
      pointerKey,
      record,
      expected: null,
      ledger: publicationLedger,
    });
    const writesBeforeRetry = transport.puts.length;
    const pointerBeforeRetry = transport.objects.get(pointerKey);

    await expect(
      publishTerraformAcceptance({
        expectedTargetKey: target.targetKey,
        kind: BOOTSTRAP_ACCEPTANCE_KIND,
        pointerKind: BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointerKey,
        record,
        expected: null,
        ledger: publicationLedger,
      }),
    ).resolves.toMatchObject({ recordStatus: 'idempotent-retry', pointerStatus: 'idempotent-retry' });
    expect(transport.puts).toHaveLength(writesBeforeRetry + 2);
    expect(transport.objects.get(pointerKey)).toEqual(pointerBeforeRetry);
  });

  it.each(cases)('publishes and moves the $kind pointer through one exact injected ledger', async (testCase) => {
    const expected = { etag: '"prior"', versionId: 'prior-version' } as const;
    const fixture = successfulLedger(testCase, expected);
    const ledger = { publishRecord: fixture.publishRecord, movePointer: fixture.movePointer };

    await expect(
      publishTerraformAcceptance({ ...publicationRequest(testCase, fixture, expected), ledger }),
    ).resolves.toEqual({
      recordStatus: 'created',
      recordKey: fixture.recordKey,
      pointerStatus: 'moved',
      pointerKey: fixture.pointerKey,
      pointerObservation: { etag: '"pointer"', versionId: 'pointer-version' },
    });
    expect(fixture.publishRecord).toHaveBeenCalledWith(testCase.kind, testCase.record);
    expect(fixture.movePointer).toHaveBeenCalledWith({
      kind: testCase.pointerKind,
      pointerKey: fixture.pointerKey,
      recordKey: fixture.recordKey,
      pipelineExecutionId,
      acceptanceAttemptId,
      expected,
    });
  });

  it('invokes exact ledger methods with one inert receiver and rejects a proxied ledger without traps', async () => {
    const testCase = cases[0];
    const fixture = successfulLedger(testCase, null);
    const receivers: object[] = [];
    const publishRecord = vi.fn(function (this: object, _kind: unknown, _record: unknown) {
      void _kind;
      void _record;
      receivers.push(this);
      return Promise.resolve(fixture.recordPublication);
    });
    const movePointer = vi.fn(function (this: object, _input: unknown) {
      void _input;
      receivers.push(this);
      return Promise.resolve(fixture.movement);
    });
    const ledger = { publishRecord, movePointer };

    await expect(
      publishTerraformAcceptance({ ...publicationRequest(testCase, fixture, null), ledger }),
    ).resolves.toMatchObject({ recordKey: fixture.recordKey, pointerKey: fixture.pointerKey });
    expect(receivers).toHaveLength(2);
    expect(receivers[0]).toBe(receivers[1]);
    expect(Object.getPrototypeOf(receivers[0])).toBeNull();
    expect(Object.isFrozen(receivers[0])).toBe(true);

    let proxyTraps = 0;
    const proxiedLedger = new Proxy(ledger, {
      get() {
        proxyTraps += 1;
        return undefined;
      },
      getOwnPropertyDescriptor() {
        proxyTraps += 1;
        return undefined;
      },
      getPrototypeOf() {
        proxyTraps += 1;
        return null;
      },
      ownKeys() {
        proxyTraps += 1;
        return [];
      },
    });
    await expect(
      publishTerraformAcceptance({ ...publicationRequest(testCase, fixture, null), ledger: proxiedLedger }),
    ).rejects.toThrow();
    expect(proxyTraps).toBe(0);
  });

  it.each(['record publication', 'pointer success', 'pointer conflict'] as const)(
    'rejects a proxied %s response without invoking traps',
    async (boundary) => {
      const testCase = cases[0];
      const fixture = successfulLedger(testCase, null);
      let proxyTraps = 0;
      const proxied = <T extends object>(value: T): T =>
        new Proxy(value, {
          get() {
            proxyTraps += 1;
            return undefined;
          },
          getOwnPropertyDescriptor() {
            proxyTraps += 1;
            return undefined;
          },
          getPrototypeOf() {
            proxyTraps += 1;
            return null;
          },
          ownKeys() {
            proxyTraps += 1;
            return [];
          },
        });
      const ledger = {
        publishRecord: () =>
          boundary === 'record publication' ? proxied(fixture.recordPublication) : fixture.recordPublication,
        movePointer: () =>
          boundary === 'pointer success'
            ? proxied(fixture.movement)
            : boundary === 'pointer conflict'
              ? proxied({ status: 'conflict', pointerKey: fixture.pointerKey, expected: null, observed: null } as const)
              : fixture.movement,
      };

      await expect(
        publishTerraformAcceptance({ ...publicationRequest(testCase, fixture, null), ledger }),
      ).rejects.toThrow();
      expect(proxyTraps).toBe(0);
    },
  );

  it('rejects a pointer movement value with a proxied prototype ancestor without invoking traps', async () => {
    const testCase = cases[0];
    const fixture = successfulLedger(testCase, null);
    let proxyTraps = 0;
    const ancestor = new Proxy(Object.create(null) as object, {
      get() {
        proxyTraps += 1;
        return undefined;
      },
      getOwnPropertyDescriptor() {
        proxyTraps += 1;
        return undefined;
      },
      getPrototypeOf() {
        proxyTraps += 1;
        return null;
      },
      ownKeys() {
        proxyTraps += 1;
        return [];
      },
    });
    const intermediate = Object.create(ancestor) as object;
    const pointerObservation = Object.create(intermediate) as object;
    Object.defineProperties(
      pointerObservation,
      Object.getOwnPropertyDescriptors({ etag: '"pointer"', versionId: 'pointer-version' }),
    );
    const ledger = {
      publishRecord: () => fixture.recordPublication,
      movePointer: () => ({ ...fixture.movement, pointerObservation }),
    };

    await expect(
      publishTerraformAcceptance({ ...publicationRequest(testCase, fixture, null), ledger }),
    ).rejects.toThrow();
    expect(proxyTraps).toBe(0);
  });

  it.each(['request', 'record context', 'expected pointer', 'record observation', 'pointer observation'] as const)(
    'rejects a proxied %s data boundary without invoking traps',
    async (boundary) => {
      const testCase = cases[0];
      const fixture = successfulLedger(testCase, null);
      let proxyTraps = 0;
      const proxied = <T extends object>(value: T): T =>
        new Proxy(value, {
          get() {
            proxyTraps += 1;
            return undefined;
          },
          getOwnPropertyDescriptor() {
            proxyTraps += 1;
            return undefined;
          },
          getPrototypeOf() {
            proxyTraps += 1;
            return null;
          },
          ownKeys() {
            proxyTraps += 1;
            return [];
          },
        });
      const base = publicationRequest(testCase, fixture, null);
      const request =
        boundary === 'request'
          ? proxied(base)
          : boundary === 'record context'
            ? { ...base, record: { ...base.record, targetContext: proxied(base.record.targetContext) } }
            : boundary === 'expected pointer'
              ? { ...base, expected: proxied({ etag: '"prior"', versionId: 'prior-object' }) }
              : {
                  ...base,
                  ledger: {
                    publishRecord: () =>
                      boundary === 'record observation'
                        ? {
                            ...fixture.recordPublication,
                            recordObservation: proxied({ etag: '"record"', versionId: 'record-version' }),
                          }
                        : fixture.recordPublication,
                    movePointer: () =>
                      boundary === 'pointer observation'
                        ? {
                            ...fixture.movement,
                            pointerObservation: proxied({ etag: '"pointer"', versionId: 'pointer-version' }),
                          }
                        : fixture.movement,
                  },
                };

      await expect(publishTerraformAcceptance(request)).rejects.toThrow();
      expect(proxyTraps).toBe(0);
    },
  );

  it('rejects thenables and Promise subclasses from ledger ports without assimilating them', async () => {
    const testCase = cases[0];
    const thenableFixture = successfulLedger(testCase, null);
    let thenCalls = 0;
    const thenable = { ...thenableFixture.recordPublication };
    Object.defineProperty(thenable, 'then', {
      enumerable: true,
      get() {
        thenCalls += 1;
        return undefined;
      },
    });
    const thenableLedger = { publishRecord: () => thenable, movePointer: thenableFixture.movePointer };

    await expect(
      publishTerraformAcceptance({ ...publicationRequest(testCase, thenableFixture, null), ledger: thenableLedger }),
    ).rejects.toThrow();
    expect(thenCalls).toBe(0);
    expect(thenableFixture.movePointer).not.toHaveBeenCalled();

    class AlteredPromise<T> extends Promise<T> {}
    const promiseFixture = successfulLedger(testCase, null);
    const promiseLedger = {
      publishRecord: () => new AlteredPromise((resolve) => resolve(promiseFixture.recordPublication)),
      movePointer: promiseFixture.movePointer,
    };
    await expect(
      publishTerraformAcceptance({ ...publicationRequest(testCase, promiseFixture, null), ledger: promiseLedger }),
    ).rejects.toThrow(/promise shell/u);
    expect(promiseFixture.movePointer).not.toHaveBeenCalled();
  });

  it('maps an exact stale-writer result to the stable review-conflict error', async () => {
    const testCase = cases[1];
    const expected = { etag: '"prior"', versionId: 'prior-version' } as const;
    const fixture = successfulLedger(testCase, expected);
    fixture.movePointer.mockResolvedValueOnce({
      status: 'conflict',
      pointerKey: fixture.pointerKey,
      expected,
      observed: null,
    });

    await expect(publishTerraformAcceptance(publicationRequest(testCase, fixture, expected))).rejects.toThrow(
      'Terraform acceptance pointer changed after review.',
    );
  });

  it('rejects hidden request and ledger authority before invoking either ledger method', async () => {
    const testCase = cases[0];
    const fixture = successfulLedger(testCase, null);
    const hiddenRequest = { ...publicationRequest(testCase, fixture, null) };
    Object.defineProperty(hiddenRequest, 'rawPlan', { value: 'sentinel', enumerable: false });

    await expect(publishTerraformAcceptance(hiddenRequest)).rejects.toThrow(/exact current shape/u);
    expect(fixture.publishRecord).not.toHaveBeenCalled();
    expect(fixture.movePointer).not.toHaveBeenCalled();

    const hiddenLedger = { publishRecord: fixture.publishRecord, movePointer: fixture.movePointer };
    Object.defineProperty(hiddenLedger, 'readPointer', { value: vi.fn(), enumerable: false });
    await expect(
      publishTerraformAcceptance({ ...publicationRequest(testCase, fixture, null), ledger: hiddenLedger }),
    ).rejects.toThrow(/ledger.*exact current shape/u);
    expect(fixture.publishRecord).not.toHaveBeenCalled();
    expect(fixture.movePointer).not.toHaveBeenCalled();
  });

  it('rejects accessor ledger methods without invoking the accessor or either operation', async () => {
    const testCase = cases[0];
    const fixture = successfulLedger(testCase, null);
    let accessorInvoked = false;
    const ledger = {
      get publishRecord() {
        accessorInvoked = true;
        return fixture.publishRecord;
      },
      movePointer: fixture.movePointer,
    };

    await expect(
      publishTerraformAcceptance({ ...publicationRequest(testCase, fixture, null), ledger }),
    ).rejects.toThrow(/ledger.*exact current shape/u);
    expect(accessorInvoked).toBe(false);
    expect(fixture.publishRecord).not.toHaveBeenCalled();
    expect(fixture.movePointer).not.toHaveBeenCalled();
  });

  it.each([
    ['an extra field', { etag: '"prior"', versionId: 'prior-version', body: 'sentinel' }],
    ['an invalid ETag', { etag: ' ', versionId: 'prior-version' }],
    ['an invalid VersionId', { etag: '"prior"', versionId: '' }],
  ] as const)('rejects expected-pointer authority with %s before publishing', async (_label, expected) => {
    const testCase = cases[1];
    const fixture = successfulLedger(testCase, null);

    await expect(
      publishTerraformAcceptance({ ...publicationRequest(testCase, fixture, null), expected }),
    ).rejects.toThrow();
    expect(fixture.publishRecord).not.toHaveBeenCalled();
    expect(fixture.movePointer).not.toHaveBeenCalled();
  });

  it('rejects a mismatched kind pair and pointer namespace before publishing', async () => {
    const testCase = cases[0];
    const fixture = successfulLedger(testCase, null);

    await expect(
      publishTerraformAcceptance({
        ...publicationRequest(testCase, fixture, null),
        pointerKind: FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND,
      }),
    ).rejects.toThrow(/not a registered pair/u);
    await expect(
      publishTerraformAcceptance({
        ...publicationRequest(testCase, fixture, null),
        pointerKey: `${fixture.pointerKey}.detached`,
      }),
    ).rejects.toThrow(/does not match its admitted root/u);
    expect(fixture.publishRecord).not.toHaveBeenCalled();
    expect(fixture.movePointer).not.toHaveBeenCalled();
  });

  it('rejects malformed or detached record-publication evidence before moving a pointer', async () => {
    const testCase = cases[1];
    const malformedFixture = successfulLedger(testCase, null);
    malformedFixture.publishRecord.mockResolvedValueOnce({
      ...malformedFixture.recordPublication,
      transcript: 'sentinel',
    });
    await expect(publishTerraformAcceptance(publicationRequest(testCase, malformedFixture, null))).rejects.toThrow(
      /exact current shape/u,
    );
    expect(malformedFixture.movePointer).not.toHaveBeenCalled();

    const detachedRecord = detachedAcceptance(testCase);
    const detachedBodyFixture = successfulLedger(testCase, null);
    detachedBodyFixture.publishRecord.mockResolvedValueOnce({
      ...detachedBodyFixture.recordPublication,
      record: detachedRecord,
    });
    await expect(publishTerraformAcceptance(publicationRequest(testCase, detachedBodyFixture, null))).rejects.toThrow(
      /record publication is invalid/u,
    );
    expect(detachedBodyFixture.movePointer).not.toHaveBeenCalled();

    const detachedKeyFixture = successfulLedger(testCase, null);
    detachedKeyFixture.publishRecord.mockResolvedValueOnce({
      ...detachedKeyFixture.recordPublication,
      key: deriveTerraformAcceptanceRecordKey(testCase.kind, detachedRecord, target.targetKey),
    });
    await expect(publishTerraformAcceptance(publicationRequest(testCase, detachedKeyFixture, null))).rejects.toThrow(
      /record publication is invalid/u,
    );
    expect(detachedKeyFixture.movePointer).not.toHaveBeenCalled();
  });

  it.each(['success', 'conflict'] as const)(
    'rejects hidden or accessor status fields in a %s movement result without invoking accessors',
    async (resultKind) => {
      const testCase = cases[0];
      const hiddenFixture = successfulLedger(testCase, null);
      const hiddenResult: Record<string, unknown> =
        resultKind === 'success'
          ? { ...hiddenFixture.movement }
          : { status: 'conflict', pointerKey: hiddenFixture.pointerKey, expected: null, observed: null };
      Object.defineProperty(hiddenResult, 'hidden', { value: 'sentinel', enumerable: false });
      hiddenFixture.movePointer.mockResolvedValueOnce(hiddenResult);
      await expect(publishTerraformAcceptance(publicationRequest(testCase, hiddenFixture, null))).rejects.toThrow(
        /pointer movement is invalid/u,
      );

      const accessorFixture = successfulLedger(testCase, null);
      const accessorResult: Record<string, unknown> =
        resultKind === 'success'
          ? {
              pointerKey: accessorFixture.pointerKey,
              pointer: accessorFixture.movement.pointer,
              pointerObservation: accessorFixture.movement.pointerObservation,
              record: accessorFixture.movement.record,
              recordKey: accessorFixture.recordKey,
            }
          : { pointerKey: accessorFixture.pointerKey, expected: null, observed: null };
      let accessorInvoked = false;
      Object.defineProperty(accessorResult, 'status', {
        enumerable: true,
        get() {
          accessorInvoked = true;
          return resultKind === 'success' ? 'moved' : 'conflict';
        },
      });
      accessorFixture.movePointer.mockResolvedValueOnce(accessorResult);
      await expect(publishTerraformAcceptance(publicationRequest(testCase, accessorFixture, null))).rejects.toThrow(
        /pointer movement is invalid/u,
      );
      expect(accessorInvoked).toBe(false);
    },
  );

  it('rejects successful movement evidence detached from its pointer, record, execution, or predecessor', async () => {
    const testCase = cases[1];
    const expected = { etag: '"prior"', versionId: 'prior-version' } as const;
    const alternateRecord = detachedAcceptance(testCase);
    const alternateRecordKey = deriveTerraformAcceptanceRecordKey(testCase.kind, alternateRecord, target.targetKey);
    const detachedPipelineExecutionId = '99999999-2222-3333-4444-555555555555';
    const expectDetached = async (
      mutate: (fixture: ReturnType<typeof successfulLedger>) => Readonly<Record<string, unknown>>,
    ) => {
      const fixture = successfulLedger(testCase, expected);
      fixture.movePointer.mockResolvedValueOnce(mutate(fixture));
      await expect(publishTerraformAcceptance(publicationRequest(testCase, fixture, expected))).rejects.toThrow(
        /pointer movement is invalid/u,
      );
    };

    await expectDetached((fixture) => ({ ...fixture.movement, pointerKey: `${fixture.pointerKey}.detached` }));
    await expectDetached((fixture) => ({
      ...fixture.movement,
      pointer: { ...fixture.movement.pointer, recordKey: alternateRecordKey },
    }));
    await expectDetached((fixture) => ({ ...fixture.movement, record: alternateRecord }));
    await expectDetached((fixture) => ({
      ...fixture.movement,
      pointer: {
        ...fixture.movement.pointer,
        pipelineExecutionId: detachedPipelineExecutionId,
        compareAndSwapEvidenceId: `cas/foundation-acceptance/${detachedPipelineExecutionId}/${acceptanceAttemptId}`,
      },
    }));
    await expectDetached((fixture) => ({
      ...fixture.movement,
      pointer: { ...fixture.movement.pointer, previous: null },
    }));
  });

  it.each([
    ['record', 'etag', ' '],
    ['record', 'versionId', ''],
    ['pointer', 'etag', 'bad\0etag'],
    ['pointer', 'versionId', 'null'],
  ] as const)('rejects an invalid %s observation %s', async (boundary, field, invalidValue) => {
    const testCase = cases[0];
    const fixture = successfulLedger(testCase, null);
    if (boundary === 'record') {
      fixture.publishRecord.mockResolvedValueOnce({
        ...fixture.recordPublication,
        recordObservation: { ...fixture.recordPublication.recordObservation, [field]: invalidValue },
      });
    } else {
      fixture.movePointer.mockResolvedValueOnce({
        ...fixture.movement,
        pointerObservation: { ...fixture.movement.pointerObservation, [field]: invalidValue },
      });
    }

    await expect(publishTerraformAcceptance(publicationRequest(testCase, fixture, null))).rejects.toThrow();
    if (boundary === 'record') {
      expect(fixture.movePointer).not.toHaveBeenCalled();
    }
  });

  it('admits exact idempotent retries and deeply freezes the exact public result', async () => {
    const testCase = cases[1];
    const expected = { etag: '"prior"', versionId: 'prior-version' } as const;
    const fixture = successfulLedger(testCase, expected);
    fixture.publishRecord.mockResolvedValueOnce({
      ...fixture.recordPublication,
      status: 'idempotent-retry',
    });
    fixture.movePointer.mockResolvedValueOnce({ ...fixture.movement, status: 'idempotent-retry' });

    const result = await publishTerraformAcceptance(publicationRequest(testCase, fixture, expected));

    expect(result).toEqual({
      recordStatus: 'idempotent-retry',
      recordKey: fixture.recordKey,
      pointerStatus: 'idempotent-retry',
      pointerKey: fixture.pointerKey,
      pointerObservation: fixture.movement.pointerObservation,
    });
    expect(Reflect.ownKeys(result).sort()).toEqual(
      ['pointerKey', 'pointerObservation', 'pointerStatus', 'recordKey', 'recordStatus'].sort(),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.pointerObservation)).toBe(true);
  });

  it('rejects an idempotent result bound to a different predecessor', async () => {
    const testCase = cases[0];
    const fixture = successfulLedger(testCase, null);
    fixture.movePointer.mockResolvedValueOnce({
      ...fixture.movement,
      status: 'idempotent-retry',
      pointer: {
        ...fixture.movement.pointer,
        previous: { etag: '"different"', versionId: 'different-object' },
      },
    });

    await expect(publishTerraformAcceptance(publicationRequest(testCase, fixture, null))).rejects.toThrow(
      'Terraform acceptance pointer movement is invalid.',
    );
  });

  it('validates conflict bindings before returning the stable review-conflict error', async () => {
    const testCase = cases[1];
    const expected = { etag: '"prior"', versionId: 'prior-version' } as const;
    const detachedFixture = successfulLedger(testCase, expected);
    detachedFixture.movePointer.mockResolvedValueOnce({
      status: 'conflict',
      pointerKey: detachedFixture.pointerKey,
      expected: null,
      observed: null,
    });
    await expect(publishTerraformAcceptance(publicationRequest(testCase, detachedFixture, expected))).rejects.toThrow(
      'Terraform acceptance pointer movement is invalid.',
    );

    const observedFixture = successfulLedger(testCase, expected);
    observedFixture.movePointer.mockResolvedValueOnce({
      status: 'conflict',
      pointerKey: observedFixture.pointerKey,
      expected,
      observed: {
        pointer: observedFixture.movement.pointer,
        pointerObservation: observedFixture.movement.pointerObservation,
      },
    });
    await expect(publishTerraformAcceptance(publicationRequest(testCase, observedFixture, expected))).rejects.toThrow(
      'Terraform acceptance pointer changed after review.',
    );
  });
});
