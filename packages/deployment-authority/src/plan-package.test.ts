import { describe, it, expect } from 'vitest';
import {
  canonicalRecordJson,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  resolveImageSigningIdentity,
} from './index.js';
import {
  admitPlanPackage,
  parsePlanPackage,
  derivePlanPackageKey,
  renderPlanPackageApprovalSummary,
  storedBytesSha256,
  admitObjectReference,
  PLAN_TERRAFORM_RUNTIME,
} from './plan-package.js';
import { buildTerraformBaselineNonsecretInputs } from './terraform-authority.js';
import { summarizePlanPackageReview } from './saved-plan-semantic-review.js';
import { buildRootCheckpoint, parseRootCheckpoint, deriveRootCheckpointKey } from './root-checkpoint.js';
import {
  prepareMutationOwner,
  assertMutationContinuation,
  deriveMutationOwnerKey,
  deriveMutationActionKey,
} from './mutation-owner.js';
import { FOUNDATION_CONSUMER_REQUIREMENTS, computeFoundationSourceContract } from './foundation-contract.js';
const targetKey = 'stark-dev/develop';
const target = resolveAllowedDeploymentTarget(targetKey);
const lane = resolveDeploymentLaneAuthority(target, 'foundation');
const executionId = '11111111-1111-1111-1111-111111111111';
const sourceSha = 'a'.repeat(40);
const sha = 'b'.repeat(64);
const inputs = {
  account_alias: target.accountLabel,
  aws_account_id: target.accountId,
  aws_region: target.region,
  deployment_environment: target.environmentId,
  project_name: target.projectId,
  public_hostname_disposition: 'external-dns-acm',
  state_backend_key: lane.backendKey,
  state_scope: 'foundation',
};
function fixture() {
  const backend = {
    bucketName: lane.names.terraformStateBucket,
    backendKey: lane.backendKey,
    kmsKeyArn: `arn:aws:kms:${target.region}:${target.accountId}:key/11111111-1111-1111-1111-111111111111`,
    region: target.region,
  };
  const tfplanJson = JSON.stringify({
    format_version: '1.2',
    terraform_version: '1.17.0',
    complete: true,
    errored: false,
    applyable: false,
    resource_changes: [],
    resource_drift: [],
    output_changes: {},
    checks: [],
    variables: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, { value }])),
  });
  return {
    targetKey,
    root: 'foundation' as const,
    accountId: target.accountId,
    region: target.region,
    backend,
    sourceSha,
    execution: {
      kind: 'pipeline',
      executionId,
      pipelineName: lane.names.pipeline,
      planActionExecutionId: executionId,
      buildId: `${lane.names.terraformPlanProject}:${executionId}`,
    },
    recipe: {
      runtime: PLAN_TERRAFORM_RUNTIME,
      providerLock:
        '# This file is maintained automatically by "terraform init".\n# Manual edits may be lost in future updates.\n\nprovider "registry.terraform.io/hashicorp/aws" {\n  version = "6.70.0"\n  hashes = [\n    "h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",\n  ]\n}\n',
      nonsecretInputs: buildTerraformBaselineNonsecretInputs('foundation', JSON.parse(tfplanJson)),
      artifacts: [],
    },
    files: {
      backend: `bucket = "${backend.bucketName}"\nkey = "${backend.backendKey}"\nregion = "${backend.region}"\nencrypt = true\nkms_key_id = "${backend.kmsKeyArn}"\nuse_lockfile = true\n`,
      tfplan: Buffer.from('exact binary plan').toString('base64'),
      tfplanJson,
    },
    references: { foundation: null, prover: null, toolchain: null },
    publication: { checkpoint: null, mutationOwner: null, initialPublication: true },
  };
}
function sealed() {
  const plan = admitPlanPackage(fixture(), targetKey, 'foundation');
  const body = canonicalRecordJson(plan);
  const reference = {
    key: derivePlanPackageKey(targetKey, 'foundation', executionId),
    versionId: 'opaque-version',
    sha256: storedBytesSha256(body),
  };
  return { plan, body, reference };
}
function foundationOutputs() {
  const signingProfileName = resolveImageSigningIdentity(target).signingProfileName;
  return {
    consumerContract: computeFoundationSourceContract({
      nonsecretInputs: {
        accountAlias: target.accountLabel,
        awsAccountId: target.accountId,
        awsRegion: target.region,
        deploymentEnvironment: target.environmentId,
        deploymentTargetKey: targetKey,
        projectName: target.projectId,
        publicHostnameDisposition: inputs.public_hostname_disposition,
        stateBackendKey: lane.backendKey,
        stateScope: 'foundation',
      },
      requirements: FOUNDATION_CONSUMER_REQUIREMENTS,
    }),
    networking: {
      vpcId: `vpc-${'1'.repeat(8)}`,
      proverSubnetIds: [`subnet-${'1'.repeat(8)}`, `subnet-${'2'.repeat(8)}`],
      proverSecurityGroupIds: [`sg-${'1'.repeat(8)}`],
      networkAuthority: 'foundation-owned',
      publicSubnetException: 'accepted-for-develop-prover-egress',
    },
    imageAuthority: {
      repositories: {
        prover: {
          name: lane.names.proverRepository,
          url: `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${lane.names.proverRepository}`,
        },
        toolchain: {
          name: lane.names.toolchainRepository,
          url: `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${lane.names.toolchainRepository}`,
        },
      },
      signingProfileName,
      signingProfileArn: `arn:aws:signer:${target.region}:${target.accountId}:/signing-profiles/${signingProfileName}`,
      signingRepositoryFilters: [{ filter: lane.names.proverRepository, filterType: 'WILDCARD_MATCH' }],
      tagMutability: 'IMMUTABLE',
      scanOnPush: true,
      proverSigningStatusRequired: 'COMPLETE',
      retentionPolicy: 'newest-five-images',
    },
  };
}
describe('immutable plan package', () => {
  it('binds exact binary and JSON bytes and renders a bounded complete no-op review', () => {
    const { plan, body, reference } = sealed();
    expect(parsePlanPackage(body, reference, targetKey, 'foundation')).toEqual(plan);
    expect(summarizePlanPackageReview(plan)).toMatchObject({
      applyable: false,
      complete: true,
      omittedChangedAddressCount: 0,
    });
    expect(renderPlanPackageApprovalSummary(plan, reference, executionId).length).toBeLessThanOrEqual(512);
  });
  it.each(['tfplan', 'tfplanJson'] as const)(
    'rejects changed %s bytes even under the same native artifact name',
    (name) => {
      const { plan, reference } = sealed();
      const changed = { ...plan, files: { ...plan.files, [name]: `${plan.files[name]} ` } };
      expect(() => parsePlanPackage(canonicalRecordJson(changed), reference, targetKey, 'foundation')).toThrow('bytes');
    },
  );
  it.each(['move', 'import'] as const)('rejects %s metadata in the current package review', (kind) => {
    const input = fixture();
    const planJson = JSON.parse(input.files.tfplanJson);
    planJson.resource_changes = [
      {
        address: 'aws_s3_bucket.fixture',
        ...(kind === 'move' ? { previous_address: 'aws_s3_bucket.previous' } : {}),
        change: { actions: ['no-op'], ...(kind === 'import' ? { importing: { id: 'existing' } } : {}) },
      },
    ];
    input.files.tfplanJson = JSON.stringify(planJson);
    const plan = admitPlanPackage(input, targetKey, 'foundation');
    expect(() => summarizePlanPackageReview(plan)).toThrow('unsupported move or import metadata');
  });
  it('rejects missing/legacy/foreign target records and null VersionIds', () => {
    expect(() => admitObjectReference({ key: 'a', versionId: 'null', sha256: sha })).toThrow();
    expect(() => admitPlanPackage({ ...fixture(), oldAcceptance: {} }, targetKey, 'foundation')).toThrow();
    expect(() => admitPlanPackage({ ...fixture(), targetKey: 'stark-prod/main' }, targetKey, 'foundation')).toThrow();
  });
  it('requires explicit first-publication authority', () => {
    const input = fixture();
    input.publication.initialPublication = false;
    expect(() => admitPlanPackage(input, targetKey, 'foundation')).toThrow('explicit');
  });
  it('rejects incomplete/action-invoking plans and omitted changes', () => {
    const input = fixture();
    const document = JSON.parse(input.files.tfplanJson);
    document.complete = false;
    input.files.tfplanJson = JSON.stringify(document);
    expect(() => admitPlanPackage(input, targetKey, 'foundation')).toThrow('incomplete');
  });
  it('redacts sensitive attribute values while retaining changed/unknown inventory', () => {
    const input = fixture();
    const document = JSON.parse(input.files.tfplanJson);
    document.applyable = true;
    document.resource_changes = [
      {
        address: 'aws_secretsmanager_secret.example',
        mode: 'managed',
        type: 'aws_secretsmanager_secret',
        name: 'example',
        change: {
          actions: ['update'],
          before: { name: 'private-before' },
          after: { name: 'private-after' },
          before_sensitive: { name: true },
          after_sensitive: { name: true },
          after_unknown: {},
        },
      },
    ];
    input.files.tfplanJson = JSON.stringify(document);
    const review = summarizePlanPackageReview(admitPlanPackage(input, targetKey, 'foundation'));
    expect(review.changedAddresses[0]?.sensitiveAttributes).toContain('name');
    expect(JSON.stringify(review)).not.toContain('private-before');
    expect(JSON.stringify(review)).not.toContain('private-after');
  });
});
describe('root checkpoint and mutation owner', () => {
  it.each([
    { vpcId: 'vpc-invalid' },
    { proverSubnetIds: [`subnet-${'1'.repeat(8)}`, `subnet-${'1'.repeat(8)}`] },
    { proverSubnetIds: [`subnet-${'1'.repeat(8)}`] },
    { proverSecurityGroupIds: ['sg-invalid'] },
    { networkAuthority: 'app-owned' },
    { publicSubnetException: 'accepted-for-production-prover-egress' },
    { unexpected: true },
  ])('rejects malformed or foreign Foundation networking %j', (networking) => {
    const { plan, reference } = sealed();
    const outputs = foundationOutputs();
    expect(() =>
      buildRootCheckpoint({
        plan,
        reference,
        acceptedAt: '2026-10-11T00:00:00.000Z',
        outputs: { ...outputs, networking: { ...outputs.networking, ...networking } },
        smoke: { status: 'Succeeded', executionId, packageSha256: reference.sha256 },
      }),
    ).toThrow();
  });
  it('rejects checkpoint source/target/output byte changes and foreign immutable keys', () => {
    const { plan, reference } = sealed();
    const checkpoint = buildRootCheckpoint({
      plan,
      reference,
      acceptedAt: '2026-10-11T00:00:00.000Z',
      outputs: foundationOutputs(),
      smoke: { status: 'Succeeded', executionId, packageSha256: reference.sha256 },
    });
    const body = canonicalRecordJson(checkpoint);
    const stored = {
      key: deriveRootCheckpointKey(targetKey, 'foundation'),
      versionId: '.exact-version',
      sha256: storedBytesSha256(body),
    };
    for (const patch of [{ sourceSha: 'f'.repeat(40) }, { targetKey: 'stark-prod/main' }, { outputs: {} }])
      expect(() =>
        parseRootCheckpoint(canonicalRecordJson({ ...checkpoint, ...patch }), stored, targetKey, 'foundation'),
      ).toThrow();
    expect(() =>
      parseRootCheckpoint(body, { ...stored, key: deriveRootCheckpointKey(targetKey, 'app') }, targetKey, 'foundation'),
    ).toThrow();
  });
  it('publishes one root body only after owning smoke and binds its stored bytes', () => {
    const { plan, reference } = sealed();
    const checkpoint = buildRootCheckpoint({
      plan,
      reference,
      acceptedAt: '2026-10-11T00:00:00.000Z',
      outputs: foundationOutputs(),
      smoke: { status: 'Succeeded', executionId, packageSha256: reference.sha256 },
    });
    const body = canonicalRecordJson(checkpoint);
    expect(
      parseRootCheckpoint(
        body,
        {
          key: deriveRootCheckpointKey(targetKey, 'foundation'),
          versionId: 'checkpoint-version',
          sha256: storedBytesSha256(body),
        },
        targetKey,
        'foundation',
      ),
    ).toEqual(checkpoint);
    expect(() =>
      buildRootCheckpoint({
        plan,
        reference,
        acceptedAt: '2026-10-11T00:00:00.000Z',
        outputs: foundationOutputs(),
        smoke: { status: 'Failed', executionId, packageSha256: reference.sha256 },
      }),
    ).toThrow('smoke');
  });
  it('never takes a newer owner as the CAS precondition for an old plan', () => {
    const { plan, reference } = sealed();
    const owner = prepareMutationOwner(plan, reference, null);
    expect(() =>
      prepareMutationOwner(plan, reference, {
        key: deriveMutationOwnerKey(targetKey, 'foundation'),
        etag: '"newer"',
        versionId: 'newer',
        sha256: sha,
      }),
    ).toThrow('changed');
    expect(() =>
      assertMutationContinuation(
        plan,
        reference,
        { ...owner, executionId: '22222222-2222-2222-2222-222222222222' },
        null,
      ),
    ).toThrow('owner');
    expect(() =>
      assertMutationContinuation(plan, reference, owner, {
        executionId,
        stage: 'DeployFoundation',
        action: 'Apply',
        status: 'Failed',
      }),
    ).toThrow('predecessor');
  });
  it('uses logical action identity without a retry build identifier', () => {
    expect(deriveMutationActionKey(targetKey, 'foundation', executionId, 'DeployFoundation', 'Apply')).toBe(
      `deployment/${targetKey}/foundation/actions/${executionId}/DeployFoundation/Apply.json`,
    );
  });
});
