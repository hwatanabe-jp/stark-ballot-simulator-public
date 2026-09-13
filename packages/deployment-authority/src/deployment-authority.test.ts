import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  cloneDeploymentTargetConfiguration,
  mutableDeploymentTargetConfiguration,
  productionConfigurationFixture,
} from './test-support/deployment-target-fixtures';
import {
  assertFirstPublication,
  assertMatchingSourcePins,
  assertPointerCompareAndSwap,
  canonicalJson,
  canonicalJsonSha256,
  canonicalRecordJson,
  classifyImmutablePublication,
  deriveDeploymentIdentity,
  immutableObjectReferencesEqual,
  parseDigestPinnedImageReference,
  parseDeploymentLaneContext,
  parseFullSourceSha,
  parseGitCommitSha,
  parseImmutableObjectReference,
  parseImageDigest,
  parseS3VersionId,
  parseSha256,
  parseDeploymentTargetConfiguration,
  renderDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
  resolveBootstrapSavedPlanApprovalAction,
  resolveFoundationPublicSubnetException,
  resolveDeploymentLaneAuthority,
  resolveImageSigningIdentity,
  validateAwsSsoCallerIdentity,
  validateAwsSsoCallerIdentityForPermissionSet,
  validateCanonicalSha256Binding,
} from './index.js';

const SOURCE_SHA = 'a'.repeat(40);
const ACCOUNT_ID = resolveAllowedDeploymentTarget('stark-dev/develop').accountId;
const EXPECTED_TARGET_CONFIGURATION_SHA256 =
  ACCOUNT_ID === '000000000000'
    ? '90a00a0573e756db0be1b11ad4f2da14429ed9047fc3c599cb007e5bca0df74d'
    : 'ad07ec7087202fc474b162e928d914ee6c97af05bc49f7485982dcf7cff45724';

const RETIRED_READINESS_NAME_KEYS = [
  'recoveryReadinessProject',
  'recoveryReadinessReportPrefix',
  'recoveryReadinessRole',
  'rollbackReadinessProject',
  'rollbackReadinessReportPrefix',
  'rollbackReadinessRole',
] as const;

describe('deployment authority primitives', () => {
  it('resolves the exact target image-signing identity without consumer reconstruction', () => {
    expect(resolveImageSigningIdentity(resolveAllowedDeploymentTarget('stark-dev/develop'))).toEqual({
      namePrefix: 'stark-ballot-simulator-stark-dev-develop',
      signingProfileName: 'stark_ballot_simulator_stark_dev_develop_ecr',
      signingProfileArn: `arn:aws:signer:ap-northeast-1:${ACCOUNT_ID}:/signing-profiles/stark_ballot_simulator_stark_dev_develop_ecr`,
      repositories: {
        prover: 'stark-ballot-simulator-stark-dev-develop/prover',
        toolchain: 'stark-ballot-simulator-stark-dev-develop/risc0-toolchain',
      },
    });
  });

  it('admits only the reviewed IAM Identity Center operator caller', () => {
    const target = resolveAllowedDeploymentTarget('stark-dev/develop');
    const arn = `arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_stark-dev-operator_0123456789abcdef/operator-session`;

    expect(validateAwsSsoCallerIdentity({ Account: ACCOUNT_ID, Arn: arn }, target)).toEqual({
      accountId: ACCOUNT_ID,
      arn,
    });
    expect(() =>
      validateAwsSsoCallerIdentity(
        {
          Account: ACCOUNT_ID,
          Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_AdministratorAccess_0123456789abcdef/admin-session`,
        },
        target,
      ),
    ).toThrow('AWS caller role does not match the reviewed operator permission set.');
    expect(() => validateAwsSsoCallerIdentity({ Account: ACCOUNT_ID }, target)).toThrow(
      'AWS caller identity must use exact Account and Arn fields.',
    );
    expect(() => validateAwsSsoCallerIdentity({ Account: ACCOUNT_ID, Arn: arn, UserId: 'unexpected' }, target)).toThrow(
      'AWS caller identity must use exact Account and Arn fields.',
    );
  });

  it('binds an independently selected profile to its explicit permission-set role', () => {
    const target = resolveAllowedDeploymentTarget('stark-dev/develop');
    const permissionSetName = 'AdministratorAccess';
    const arn =
      `arn:aws:sts::${ACCOUNT_ID}:assumed-role/` + `AWSReservedSSO_${permissionSetName}_0123456789abcdef/admin-session`;

    expect(
      validateAwsSsoCallerIdentityForPermissionSet({ Account: ACCOUNT_ID, Arn: arn }, target, permissionSetName),
    ).toEqual({ accountId: ACCOUNT_ID, arn });
    expect(() =>
      validateAwsSsoCallerIdentityForPermissionSet(
        {
          Account: ACCOUNT_ID,
          Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_DifferentPermissionSet_0123456789abcdef/admin-session`,
        },
        target,
        permissionSetName,
      ),
    ).toThrow('AWS caller role does not match the reviewed permission set.');
  });

  it('renders structural JSON and its digest independently of insertion order', () => {
    const left = { z: [3, { b: true, a: null }], a: 'value' };
    const right = { a: 'value', z: [3, { a: null, b: true }] };
    const expected = '{"a":"value","z":[3,{"a":null,"b":true}]}';

    expect(canonicalJson(left)).toBe(expected);
    expect(canonicalJson(right)).toBe(expected);
    expect(canonicalJsonSha256(left)).toBe(createHash('sha256').update(expected).digest('hex'));
  });

  it('admits a self-hashed canonical record only when its body and expected digest agree', () => {
    const payload = {
      descriptorType: 'stark-ballot.zkvm-semantic-contract.current',
      method: { inputCommitmentFormatVersion: 10, methodVersion: 14 },
    };
    const expectedSha256 = canonicalJsonSha256(payload);
    const descriptor = { ...payload, semanticSha256: expectedSha256 };

    expect(validateCanonicalSha256Binding(descriptor, 'semanticSha256', expectedSha256, 'zkVM semantic contract')).toBe(
      expectedSha256,
    );

    expect(() =>
      validateCanonicalSha256Binding(
        { ...descriptor, unexpected: true },
        'semanticSha256',
        expectedSha256,
        'zkVM semantic contract',
      ),
    ).toThrow('zkVM semantic contract semanticSha256 does not match its canonical body');

    const extendedPayload = { ...payload, unexpected: true };
    expect(() =>
      validateCanonicalSha256Binding(
        { ...extendedPayload, semanticSha256: canonicalJsonSha256(extendedPayload) },
        'semanticSha256',
        expectedSha256,
        'zkVM semantic contract',
      ),
    ).toThrow('zkVM semantic contract semanticSha256 does not match the expected SHA-256');
  });

  it.each([
    { value: { optional: undefined }, message: 'canonical JSON does not admit undefined values' },
    { value: Array(1), message: 'canonical JSON does not admit sparse arrays' },
    { value: { count: Number.NaN }, message: 'canonical JSON numbers must be finite' },
    { value: { count: Number.MAX_SAFE_INTEGER + 1 }, message: 'canonical JSON integers must be safe' },
  ])('rejects noncanonical JSON input: $message', ({ value, message }) => {
    expect(() => canonicalJson(value)).toThrow(message);
  });

  it('rejects non-JSON array own structure without invoking accessors', () => {
    const withNamedProperty = [1];
    Object.defineProperty(withNamedProperty, 'label', { enumerable: true, value: 'metadata' });
    const withSymbolProperty = [1];
    Object.defineProperty(withSymbolProperty, Symbol('metadata'), { enumerable: true, value: 'metadata' });
    const withNonIndexProperty = [1];
    Object.defineProperty(withNonIndexProperty, '01', { enumerable: true, value: 'metadata' });
    let getterInvoked = false;
    const withAccessor = [1];
    Object.defineProperty(withAccessor, '0', {
      enumerable: true,
      get() {
        getterInvoked = true;
        return 1;
      },
    });

    for (const value of [withNamedProperty, withSymbolProperty, withNonIndexProperty, withAccessor]) {
      expect(() => canonicalJson(value)).toThrow(
        'canonical JSON arrays must contain only dense indexed data properties',
      );
    }
    expect(getterInvoked).toBe(false);
  });

  it('rejects non-JSON record own structure without invoking accessors', () => {
    const withSymbolProperty = { value: 1 };
    Object.defineProperty(withSymbolProperty, Symbol('metadata'), { enumerable: true, value: 'metadata' });
    const withNonEnumerableProperty = { value: 1 };
    Object.defineProperty(withNonEnumerableProperty, 'metadata', { enumerable: false, value: 'metadata' });
    let getterInvoked = false;
    const withAccessor = {};
    Object.defineProperty(withAccessor, 'value', {
      enumerable: true,
      get() {
        getterInvoked = true;
        return 1;
      },
    });

    for (const value of [withSymbolProperty, withNonEnumerableProperty, withAccessor]) {
      expect(() => canonicalJson(value)).toThrow(
        'canonical JSON records must contain only enumerable string-keyed data properties',
      );
    }
    expect(getterInvoked).toBe(false);
  });

  it('sorts record keys without coercing their values', () => {
    let coercionInvoked = false;
    const nonJsonValue = {
      toString() {
        coercionInvoked = true;
        return 'non-json';
      },
    };

    expect(() => canonicalJson({ z: nonJsonValue, a: 1 })).toThrow('canonical JSON does not admit function values');
    expect(coercionInvoked).toBe(false);
  });

  it('sorts prefix and comma-bearing keys by key code units alone', () => {
    expect(canonicalJson({ 'a,': 0, a: 'z' })).toBe('{"a":"z","a,":0}');
  });

  it('keeps exact-key admission closed to hidden, symbol, and accessor state without invoking getters', () => {
    const reference = {
      key: 'channels/develop/prover/accepted.json',
      versionId: 'version-id',
      sha256: 'b'.repeat(64),
    };
    const withHiddenState = { ...reference };
    Object.defineProperty(withHiddenState, 'hidden', { enumerable: false, value: true });
    const withSymbolState = { ...reference };
    Object.defineProperty(withSymbolState, Symbol('hidden'), { enumerable: true, value: true });
    let getterInvoked = false;
    const withAccessor = { ...reference };
    Object.defineProperty(withAccessor, 'key', {
      enumerable: true,
      get() {
        getterInvoked = true;
        return reference.key;
      },
    });

    for (const value of [withHiddenState, withSymbolState, withAccessor]) {
      expect(() => parseImmutableObjectReference(value)).toThrow(
        'immutable object reference must contain exactly key, sha256, versionId',
      );
    }
    expect(getterInvoked).toBe(false);
  });

  it('validates immutable references by exact keys and opaque S3 VersionId', () => {
    expect(
      parseImmutableObjectReference({
        key: 'channels/develop/prover/accepted.json',
        versionId: '.opaque-version+id',
        sha256: 'b'.repeat(64),
      }),
    ).toEqual({
      key: 'channels/develop/prover/accepted.json',
      versionId: '.opaque-version+id',
      sha256: 'b'.repeat(64),
    });

    expect(() =>
      parseImmutableObjectReference({
        key: 'channels/develop/prover/accepted.json',
        versionId: 'null',
        sha256: 'b'.repeat(64),
      }),
    ).toThrow('immutable object VersionId must not be the literal S3 VersionId "null"');
    expect(() =>
      parseImmutableObjectReference({
        key: 'channels/develop/prover/accepted.json',
        versionId: 'version-id',
        sha256: 'b'.repeat(64),
        schemaVersion: 2,
      }),
    ).toThrow('immutable object reference must contain exactly key, sha256, versionId');

    const validMultibyteKey = '界'.repeat(341);
    expect(Buffer.byteLength(validMultibyteKey, 'utf8')).toBe(1023);
    expect(
      parseImmutableObjectReference({
        key: validMultibyteKey,
        versionId: 'version-id',
        sha256: 'b'.repeat(64),
      }).key,
    ).toBe(validMultibyteKey);

    const oversizedMultibyteKey = '界'.repeat(342);
    expect(oversizedMultibyteKey.length).toBeLessThan(1024);
    expect(Buffer.byteLength(oversizedMultibyteKey, 'utf8')).toBeGreaterThan(1024);
    expect(() =>
      parseImmutableObjectReference({
        key: oversizedMultibyteKey,
        versionId: 'version-id',
        sha256: 'b'.repeat(64),
      }),
    ).toThrow('immutable object key is invalid');
  });

  it('compares validated immutable references centrally', () => {
    const reference = {
      key: 'artifacts/prover/release.json',
      versionId: '.opaque-version+id',
      sha256: 'b'.repeat(64),
    };

    expect(immutableObjectReferencesEqual(reference, { ...reference })).toBe(true);
    expect(immutableObjectReferencesEqual(reference, { ...reference, versionId: 'another-version' })).toBe(false);
    expect(() => immutableObjectReferencesEqual(reference, { ...reference, unknown: true })).toThrow(
      'immutable object reference must contain exactly key, sha256, versionId',
    );
  });

  it('keeps first publication and pointer compare-and-swap fail closed', () => {
    expect(() => assertFirstPublication(undefined)).not.toThrow();
    expect(() => assertFirstPublication('existing-version')).toThrow('immutable object already exists');
    expect(() =>
      assertPointerCompareAndSwap({ expectedVersionOrEtag: 'etag-a', observedVersionOrEtag: 'etag-a' }),
    ).not.toThrow();
    expect(() =>
      assertPointerCompareAndSwap({ expectedVersionOrEtag: 'etag-a', observedVersionOrEtag: 'etag-b' }),
    ).toThrow('mutable pointer changed after review');
  });

  it('renders stable newline-terminated record bytes with recursively sorted keys', () => {
    expect(canonicalRecordJson({ z: { b: 2, a: 1 }, a: true })).toBe(
      '{\n  "a": true,\n  "z": {\n    "a": 1,\n    "b": 2\n  }\n}\n',
    );
  });

  it('keeps top-level and nested integer-like keys in canonical code-unit order', () => {
    expect(
      canonicalRecordJson({
        2: 'top-two',
        10: 'top-ten',
        nested: { 2: 'nested-two', 10: 'nested-ten' },
      }),
    ).toBe(
      '{\n' +
        '  "10": "top-ten",\n' +
        '  "2": "top-two",\n' +
        '  "nested": {\n' +
        '    "10": "nested-ten",\n' +
        '    "2": "nested-two"\n' +
        '  }\n' +
        '}\n',
    );
  });

  it('keeps pretty record rendering closed to accessors without invoking them', () => {
    let getterInvoked = false;
    const value = {};
    Object.defineProperty(value, 'secret', {
      enumerable: true,
      get() {
        getterInvoked = true;
        return 'secret';
      },
    });

    expect(() => canonicalRecordJson(value)).toThrow(
      'canonical JSON records must contain only enumerable string-keyed data properties',
    );
    expect(getterInvoked).toBe(false);
  });

  it('validates source pins, checksums, and opaque object versions centrally', () => {
    expect(parseGitCommitSha(SOURCE_SHA, 'source SHA')).toBe(SOURCE_SHA);
    expect(parseFullSourceSha(SOURCE_SHA, 'source SHA')).toBe(SOURCE_SHA);
    expect(parseSha256('b'.repeat(64), 'plan checksum')).toBe('b'.repeat(64));
    expect(parseImageDigest(`sha256:${'b'.repeat(64)}`, 'image digest')).toBe(`sha256:${'b'.repeat(64)}`);
    expect(() => parseImageDigest(`sha512:${'b'.repeat(64)}`, 'image digest')).toThrow(
      'image digest must be a lowercase sha256 image digest',
    );
    expect(parseS3VersionId('.opaque+version', 'artifact VersionId')).toBe('.opaque+version');
    expect(() => parseFullSourceSha('abc', 'source SHA')).toThrow(
      'source SHA must be a full 40- or 64-character lowercase source SHA',
    );
    expect(() => parseGitCommitSha(`${SOURCE_SHA}abcd`, 'source SHA')).toThrow(
      'source SHA must be a full 40-character lowercase Git SHA.',
    );
    expect(() => parseS3VersionId('null', 'artifact VersionId')).toThrow(
      'artifact VersionId must not be the literal S3 VersionId "null"',
    );
    expect(() =>
      assertMatchingSourcePins({
        requestedSourceSha: SOURCE_SHA,
        sourceActionSourceSha: SOURCE_SHA,
        resolvedSourceSha: SOURCE_SHA,
      }),
    ).not.toThrow();
    expect(() =>
      assertMatchingSourcePins({
        requestedSourceSha: SOURCE_SHA,
        sourceActionSourceSha: 'b'.repeat(40),
        resolvedSourceSha: SOURCE_SHA,
      }),
    ).toThrow('requested, Source action, and resolved source SHAs must match exactly');
  });

  it('admits only the exact digest-pinned ECR repository selected by context', () => {
    const policy = {
      partition: 'aws' as const,
      accountId: ACCOUNT_ID,
      region: 'ap-northeast-1',
      repository: 'stark-ballot-simulator-stark-dev-develop/prover',
    };
    const image = `${ACCOUNT_ID}.dkr.ecr.ap-northeast-1.amazonaws.com/${policy.repository}@sha256:${'c'.repeat(64)}`;

    expect(parseDigestPinnedImageReference(image, policy)).toEqual({
      ...policy,
      digest: `sha256:${'c'.repeat(64)}`,
      imageUri: image,
    });
    for (const rejected of [
      `${ACCOUNT_ID}.dkr.ecr.ap-northeast-1.amazonaws.com/${policy.repository}:latest`,
      `${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/${policy.repository}@sha256:${'c'.repeat(64)}`,
      `${ACCOUNT_ID}.dkr.ecr.ap-northeast-1.amazonaws.com/other@sha256:${'c'.repeat(64)}`,
      `${'2'.repeat(12)}.dkr.ecr.ap-northeast-1.amazonaws.com/${policy.repository}@sha256:${'c'.repeat(64)}`,
    ]) {
      expect(() => parseDigestPinnedImageReference(rejected, policy)).toThrow(
        'image reference must be the exact authorized digest-pinned ECR repository',
      );
    }
  });

  it('classifies immutable first-write, identical retry, and conflict outcomes', () => {
    expect(classifyImmutablePublication({ observedSha256: undefined, proposedSha256: 'a'.repeat(64) })).toBe('create');
    expect(classifyImmutablePublication({ observedSha256: 'a'.repeat(64), proposedSha256: 'a'.repeat(64) })).toBe(
      'idempotent-retry',
    );
    expect(() =>
      classifyImmutablePublication({ observedSha256: 'b'.repeat(64), proposedSha256: 'a'.repeat(64) }),
    ).toThrow('immutable publication conflicts with existing bytes');
  });

  it('requires strict grouped lowercase UUIDs for deployment identities', () => {
    const input = {
      appExecutionAuthoritySha256: 'b'.repeat(64),
      appSourceSha: SOURCE_SHA,
      deployMode: 'normal' as const,
      pipelineExecutionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    };

    expect(() => deriveDeploymentIdentity(input)).not.toThrow();
    expect(() =>
      deriveDeploymentIdentity({ ...input, pipelineExecutionId: input.pipelineExecutionId.toUpperCase() }),
    ).toThrow('pipelineExecutionId is invalid');
    expect(() => deriveDeploymentIdentity({ ...input, pipelineExecutionId: 'a'.repeat(36) })).toThrow(
      'pipelineExecutionId is invalid',
    );
  });
});

describe('deployment lane context', () => {
  it('does not duplicate reviewed target values in static contract literals', () => {
    const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');

    for (const reviewedValue of [
      ACCOUNT_ID,
      'stark-ballot-simulator-stark-dev-develop',
      'ap-northeast-1',
      'hwatanabe-jp/stark-ballot-simulator',
      'https://github.com/hwatanabe-jp/stark-ballot-simulator',
    ]) {
      expect(source).not.toContain(`: '${reviewedValue}'`);
    }

    const planApprovalSource = readFileSync(new URL('./plan-approval.js', import.meta.url), 'utf8');
    expect(planApprovalSource).not.toContain("deploymentEnvironment: 'develop'");
    expect(planApprovalSource).not.toContain("deploymentEnvironment !== 'develop'");
  });

  it('admits one exact semantic target configuration and freezes it recursively', () => {
    const configuration = parseDeploymentTargetConfiguration(cloneDeploymentTargetConfiguration());

    expect(configuration.configurationType).toBe('deployment-target-configuration');
    expect(Object.keys(configuration.allowedTargets)).toEqual(['stark-dev/develop', 'stark-prod/main']);
    expect(Object.keys(configuration.allowedTargets['stark-dev/develop'].lanes).sort()).toEqual([
      'app',
      'bootstrap',
      'foundation',
      'prover',
      'static-fast',
      'toolchain',
    ]);
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.allowedTargets)).toBe(true);
    expect(Object.isFrozen(configuration.allowedTargets['stark-dev/develop'])).toBe(true);
    expect(Object.isFrozen(configuration.allowedTargets['stark-dev/develop'].lanes.app.names)).toBe(true);
  });

  it('separates retained App deployables from each lane execution artifact store', () => {
    const configuration = parseDeploymentTargetConfiguration(cloneDeploymentTargetConfiguration());
    const target = configuration.allowedTargets['stark-dev/develop'];

    expect(target.sharedNames).toMatchObject({
      appDeploymentStatusKey: 'status/current.json',
      appDeploymentStatusPublisherProject:
        'stark-ballot-simulator-pipeline-stark-dev-develop-app-publish-current-status',
      appDeploymentStatusPublisherRole: 'sbs-app-status-publisher-stark-dev-develop',
      appRetainedArtifactBucket: `sbs-app-pipeline-artifacts-stark-dev-develop-${ACCOUNT_ID}`,
      ecrRetentionFunction: 'stark-ballot-simulator-stark-dev-develop-ecr-retention',
      ecrRetentionLogGroup: '/aws/lambda/stark-ballot-simulator-stark-dev-develop-ecr-retention',
      ecrRetentionPermissionsBoundary: 'sbs-ecr-retention-boundary-stark-dev-develop',
      ecrRetentionRole: 'sbs-ecr-retention-stark-dev-develop',
      ecrRetentionSchedule: 'stark-ballot-simulator-stark-dev-develop-ecr-retention-daily',
      finalizationStateMachine: 'stark-ballot-simulator-stark-dev-develop-finalization',
      proverEcsCluster: 'stark-ballot-simulator-stark-dev-develop-prover',
      proverEcsTaskFamily: 'stark-ballot-simulator-stark-dev-develop-prover',
      terraformStateBucket: `stark-ballot-simulator-tfstate-stark-dev-develop-${ACCOUNT_ID}`,
      terraformStateKmsAlias: 'alias/stark-ballot-simulator-tfstate-stark-dev-develop',
      terraformDriftAppProviderCorePolicy: 'sbs-terraform-drift-app-provider-core-stark-dev-develop',
      terraformDriftAppProviderRuntimePolicy: 'sbs-terraform-drift-app-provider-runtime-stark-dev-develop',
      terraformDriftCoordinatorRequestShapePolicy: 'sbs-terraform-drift-coordinator-request-shape-stark-dev-develop',
      terraformDriftCoordinatorExecutionEnvironmentPolicy:
        'sbs-terraform-drift-coordinator-execution-environment-stark-dev-develop',
      terraformDriftCoordinatorAuthorityEnvironmentPolicy:
        'sbs-terraform-drift-coordinator-authority-environment-stark-dev-develop',
      bootstrapTerraformAcceptancePublisherRole: 'sbs-terraform-acceptance-publisher-stark-dev-develop-bootstrap',
      foundationTerraformAcceptancePublisherRole: 'sbs-terraform-acceptance-publisher-stark-dev-develop-foundation',
    });
    expect(Object.keys(target.sharedNames)).toHaveLength(94);
    expect(target.sharedNames).not.toHaveProperty('staticFrontendPublicationLeaseKey');
    for (const retiredName of RETIRED_READINESS_NAME_KEYS) {
      expect(target.sharedNames).not.toHaveProperty(retiredName);
    }
    expect(Object.keys(target.sharedNames.targetLambdaFunctions)).toHaveLength(6);
    expect(target.lanes.app.names.artifactBucket).toBe(`sbs-app-exec-artifacts-stark-dev-develop-${ACCOUNT_ID}`);
    const staticFast = target.lanes['static-fast'];
    if (staticFast === undefined) throw new Error('Development static-fast lane is missing.');
    expect(staticFast.names.artifactBucket).toBe(`sbs-static-fast-exec-artifacts-stark-dev-develop-${ACCOUNT_ID}`);
    expect(
      new Set([
        target.sharedNames.appRetainedArtifactBucket,
        target.lanes.app.names.artifactBucket,
        staticFast.names.artifactBucket,
      ]).size,
    ).toBe(3);
  });

  it('keeps Bootstrap acceptance publication separate from refresh-plan authority', () => {
    const configuration = parseDeploymentTargetConfiguration(cloneDeploymentTargetConfiguration());
    const target = configuration.allowedTargets['stark-dev/develop'];

    expect(target.sharedNames.bootstrapTerraformAcceptancePublisherRole).toBe(
      'sbs-terraform-acceptance-publisher-stark-dev-develop-bootstrap',
    );
    expect(target.sharedNames.bootstrapTerraformAcceptancePublisherRole).not.toBe(
      target.lanes.bootstrap.names.terraformSmokeRole,
    );

    const changed = mutableDeploymentTargetConfiguration();
    const changedTarget = changed.allowedTargets['stark-dev/develop'];
    if (changedTarget === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }
    changedTarget.sharedNames['bootstrapTerraformAcceptancePublisherRole'] =
      'sbs-terraform-acceptance-publisher-stark-dev-develop-other';
    expect(() => parseDeploymentTargetConfiguration(changed)).toThrow(
      'deployment target bootstrapTerraformAcceptancePublisherRole must match its target',
    );
  });

  it('keeps Foundation acceptance publication separate from refresh-plan authority', () => {
    const configuration = parseDeploymentTargetConfiguration(cloneDeploymentTargetConfiguration());
    const target = configuration.allowedTargets['stark-dev/develop'];

    expect(target.sharedNames.foundationTerraformAcceptancePublisherRole).toBe(
      'sbs-terraform-acceptance-publisher-stark-dev-develop-foundation',
    );
    expect(target.sharedNames.foundationTerraformAcceptancePublisherRole).not.toBe(
      target.lanes.foundation.names.terraformSmokeRole,
    );

    const changed = mutableDeploymentTargetConfiguration();
    const changedTarget = changed.allowedTargets['stark-dev/develop'];
    if (changedTarget === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }
    changedTarget.sharedNames['foundationTerraformAcceptancePublisherRole'] =
      'sbs-terraform-acceptance-publisher-stark-dev-develop-other';
    expect(() => parseDeploymentTargetConfiguration(changed)).toThrow(
      'deployment target foundationTerraformAcceptancePublisherRole must match its target',
    );
  });

  it('rejects collapsed drift-policy identities', () => {
    const configuration = mutableDeploymentTargetConfiguration();
    const target = configuration.allowedTargets['stark-dev/develop'];
    if (target === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }
    target.sharedNames['terraformDriftAppProviderRuntimePolicy'] =
      'sbs-terraform-drift-app-provider-core-stark-dev-develop';

    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(
      'deployment target Terraform drift managed policy names must be pairwise distinct',
    );
  });

  it.each([
    ['terraformStateBucket', 'not_a_bucket', 'generated S3 bucket name is invalid'],
    ['terraformStateKmsAlias', 'alias/aws/s3', 'generated KMS alias is invalid'],
  ] as const)('rejects invalid tracked state-backend authority in %s', (key, value, message) => {
    const configuration = mutableDeploymentTargetConfiguration();
    const target = configuration.allowedTargets['stark-dev/develop'];
    if (target === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }
    target.sharedNames[key] = value;

    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(message);
  });

  it('rejects unknown configuration fields and every unauthorized target entry', () => {
    expect(() =>
      parseDeploymentTargetConfiguration({
        ...(cloneDeploymentTargetConfiguration() as object),
        schemaVersion: 1,
      }),
    ).toThrow('deployment target configuration must contain exactly allowedTargets, configurationType');

    const withProductionTarget = cloneDeploymentTargetConfiguration() as {
      allowedTargets: Record<string, unknown>;
    };
    withProductionTarget.allowedTargets['stark-prod/main'] = {
      ...(structuredClone(withProductionTarget.allowedTargets['stark-dev/develop']) as object),
      productionPolicy: productionConfigurationFixture().production.productionPolicy,
    };
    expect(() => parseDeploymentTargetConfiguration(withProductionTarget)).toThrow(
      'deployment target key does not match its allowed-target entry',
    );

    const withUnknownTargetField = cloneDeploymentTargetConfiguration() as {
      allowedTargets: Record<string, Record<string, unknown>>;
    };
    const developmentTarget = withUnknownTargetField.allowedTargets['stark-dev/develop'];
    if (developmentTarget === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }
    developmentTarget['secretValue'] = 'not-admitted';
    expect(() => parseDeploymentTargetConfiguration(withUnknownTargetField)).toThrow(
      'deployment allowed target must contain exactly',
    );
  });

  it('enforces the S3 byte limit on configured context keys', () => {
    const configuration = cloneDeploymentTargetConfiguration() as {
      allowedTargets: Record<string, { sharedNames: Record<string, string> }>;
    };
    const target = configuration.allowedTargets['stark-dev/develop'];
    if (target === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }
    target.sharedNames['foundationAppNetworkingKey'] = '界'.repeat(342);

    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(
      'generated foundationAppNetworkingKey S3 key is invalid',
    );
  });

  it.each([
    ['sourceAction', 'bad/action', 'generated CodePipeline action name is invalid'],
    ['artifactKmsAlias', 'not-an-alias', 'generated KMS alias is invalid'],
    ['signatureVerifierFunction', 'bad/function', 'generated Lambda function name is invalid'],
    ['signerProfile', 'bad-profile', 'generated Signer profile name is invalid'],
    ['runtimeConfigReferencePrefix', 'relative/config', 'generated SSM parameter prefix is invalid'],
    ['runtimeSecretReferencePrefix', 'relative/secrets', 'generated Secrets Manager prefix is invalid'],
    ['runtimeNamePrefix', 'bad/name', 'generated runtime name prefix is invalid'],
    ['signatureRuntimeNamePrefix', 'bad/name', 'generated signature runtime name prefix is invalid'],
  ] as const)('service-validates the configured %s', (name, invalidValue, expectedError) => {
    const configuration = cloneDeploymentTargetConfiguration() as {
      allowedTargets: Record<
        string,
        {
          sourceAction: string;
          sharedNames: Record<string, string>;
          lanes: Record<string, { names: Record<string, string> }>;
        }
      >;
    };
    const target = configuration.allowedTargets['stark-dev/develop'];
    if (target === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }
    if (name === 'sourceAction') {
      target.sourceAction = invalidValue;
    } else if (name === 'artifactKmsAlias') {
      const bootstrapLane = target.lanes['bootstrap'];
      if (bootstrapLane === undefined) {
        throw new Error('Expected the reviewed Bootstrap lane fixture.');
      }
      bootstrapLane.names[name] = invalidValue;
    } else {
      target.sharedNames[name] = invalidValue;
    }

    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(expectedError);
  });

  it.each([
    ['runtimeNamePrefix', 'r'.repeat(41), 'generated EventBridge rule name is invalid'],
    ['signatureRuntimeNamePrefix', 's'.repeat(35), 'generated image signature verifier role IAM name is invalid'],
  ] as const)('reserves service suffix capacity for %s', (name, invalidValue, expectedError) => {
    const configuration = mutableDeploymentTargetConfiguration();
    const target = configuration.allowedTargets['stark-dev/develop'];
    if (target === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }
    target.sharedNames[name] = invalidValue;

    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(expectedError);
  });

  it.each([
    ['runtimeConfigReferencePrefix', `/${'c'.repeat(990)}`, 'generated SSM parameter prefix is invalid'],
    ['runtimeSecretReferencePrefix', `/${'s'.repeat(500)}`, 'generated Secrets Manager prefix is invalid'],
    ['signaturePreflightPrefix', 'p'.repeat(930), 'generated signaturePreflightPrefix derived S3 key is invalid'],
  ] as const)('reserves derived suffix capacity for %s', (name, invalidValue, expectedError) => {
    const configuration = mutableDeploymentTargetConfiguration();
    const target = configuration.allowedTargets['stark-dev/develop'];
    if (target === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }
    target.sharedNames[name] = invalidValue;

    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(expectedError);
  });

  it('applies the managed-policy limit to the signature verifier permissions boundary', () => {
    const configuration = mutableDeploymentTargetConfiguration();
    const target = configuration.allowedTargets['stark-dev/develop'];
    if (target === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }
    target.sharedNames['signatureVerifierPermissionsBoundary'] = 'p'.repeat(129);

    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(
      'generated signatureVerifierPermissionsBoundary IAM policy name is invalid',
    );
  });

  it('binds each lane to its frozen Terraform root scope, identity, and backend key', () => {
    for (const [lane, field, invalidValue, expectedError] of [
      ['toolchain', 'scope', 'app', 'deployment target lane toolchain scope must be foundation'],
      ['app', 'stateIdentity', 'stark-dev/develop/foundation', 'deployment target lane app state identity'],
      [
        'foundation',
        'backendKey',
        'stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate',
        'deployment target lane foundation backend key',
      ],
    ] as const) {
      const configuration = mutableDeploymentTargetConfiguration();
      const target = configuration.allowedTargets['stark-dev/develop'];
      const laneConfiguration = target?.lanes[lane];
      if (target === undefined || laneConfiguration === undefined) {
        throw new Error('Expected the reviewed deployment lane fixture.');
      }
      laneConfiguration[field] = invalidValue;

      expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(expectedError);
    }
  });

  it.each([
    ['region', 'not-a-region', 'deployment target region is invalid'],
    ['repository', 'owner-only', 'deployment target repository is invalid'],
    ['repositoryUrl', 'https://example.invalid/repository', 'deployment target repositoryUrl'],
    ['sourceBranch', 'bad branch', 'deployment target sourceBranch is invalid'],
    ['accountLabel', 'Stark Dev', 'deployment target accountLabel is invalid'],
    ['environmentId', 'develop/prod', 'deployment target environmentId is invalid'],
    ['operatorPermissionSetName', 'invalid/operator', 'deployment target operatorPermissionSetName is invalid'],
  ] as const)('syntax-validates deployment target %s', (field, invalidValue, expectedError) => {
    const configuration = mutableDeploymentTargetConfiguration();
    const target = configuration.allowedTargets['stark-dev/develop'];
    if (target === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }
    target[field] = invalidValue;

    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(expectedError);
  });

  it.each([
    ['targetKey', 'other/develop', 'deployment target key does not match accountLabel/environmentId'],
    ['resourcePrefix', 'valid-looking-other-prefix', 'deployment target resourcePrefix'],
    ['stateNamespace', 'valid/looking/namespace', 'deployment target stateNamespace'],
    ['artifactNamespace', 'valid/looking/namespace', 'deployment target artifactNamespace'],
  ] as const)('relationship-validates deployment target %s', (field, invalidValue, expectedError) => {
    const configuration = mutableDeploymentTargetConfiguration();
    const target = configuration.allowedTargets['stark-dev/develop'];
    if (target === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }
    target[field] = invalidValue;

    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(expectedError);
  });

  it.each([
    ['signature verifier', 'signatureVerifierFunction', 'different-verifier', 'target Lambda'],
    [
      'accepted deployment pointer',
      'acceptedDeploymentPointerKey',
      'accepted/other/current.json',
      'acceptedDeploymentPrefix',
    ],
    ['App deployment status key', 'appDeploymentStatusKey', 'status/other.json', 'exact current status key'],
  ] as const)('rejects inconsistent duplicated %s names', (_label, name, invalidValue, expectedError) => {
    const configuration = mutableDeploymentTargetConfiguration();
    const target = configuration.allowedTargets['stark-dev/develop'];
    if (target === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }
    target.sharedNames[name] = invalidValue;

    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(expectedError);
  });

  it.each(['accepted pointer', 'retained prefix'] as const)(
    'rejects a status key overlapping the governed App %s',
    (overlap) => {
      const configuration = mutableDeploymentTargetConfiguration();
      const target = configuration.allowedTargets['stark-dev/develop'];
      if (target === undefined) {
        throw new Error('Expected the reviewed development target fixture.');
      }
      if (overlap === 'accepted pointer') {
        target.sharedNames['acceptedDeploymentPrefix'] = 'status';
        target.sharedNames['acceptedDeploymentPointerKey'] = 'status/current.json';
      } else {
        target.sharedNames['approvalEvidencePrefix'] = 'status';
      }

      expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(
        'appDeploymentStatusKey must differ from every governed retained App key family',
      );
    },
  );

  it('rejects inconsistent lane aliases for shared runtime authority', () => {
    for (const [lane, name, invalidValue, expectedError] of [
      ['static-fast', 'pipelineRole', 'different-static-fast-role', 'appStaticFastPipelineRole'],
      [
        'bootstrap',
        'terraformSmokeRole',
        'stark-ballot-sim-tf-plan-stark-dev-develop-bootstrap',
        'must differ from terraformPlanRole',
      ],
    ] as const) {
      const configuration = mutableDeploymentTargetConfiguration();
      const target = configuration.allowedTargets['stark-dev/develop'];
      const laneConfiguration = target?.lanes[lane];
      if (target === undefined || laneConfiguration === undefined) {
        throw new Error('Expected the reviewed deployment lane fixture.');
      }
      laneConfiguration.names[name] = invalidValue;

      expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(expectedError);
    }
  });

  it.each([
    ['appStaticFastDeployProject', 'appStaticDeployProject', 'static-fast deploy project'],
    ['appStaticFastDeployProject', 'appStaticFastGateProject', 'static-fast deploy project'],
    ['appStaticFastDeployProject', 'appStaticFastSmokeProject', 'static-fast deploy project'],
    ['appStaticFastDeployRole', 'appStaticDeployRole', 'static-fast deploy role'],
    ['appStaticFastDeployRole', 'appStaticFastGateRole', 'static-fast deploy role'],
    ['appStaticFastDeployRole', 'appStaticFastSmokeRole', 'static-fast deploy role'],
    ['appStaticFastDeployRole', 'signatureVerifierRole', 'static-fast deploy role'],
    ['appDeploymentStatusPublisherProject', 'appStaticFastDeployProject', 'status publisher project'],
    ['appDeploymentStatusPublisherProject', 'terraformDriftAppProject', 'status publisher project'],
    ['appDeploymentStatusPublisherRole', 'appAcceptancePublisherRole', 'status publisher role'],
    ['appDeploymentStatusPublisherRole', 'appStaticFastDeployRole', 'status publisher role'],
    ['appDeploymentStatusPublisherRole', 'terraformDriftRunnerRole', 'status publisher role'],
  ] as const)('rejects a colliding App deploy authority in %s', (name, fullName, expectedError) => {
    const configuration = mutableDeploymentTargetConfiguration();
    const target = configuration.allowedTargets['stark-dev/develop'];
    if (target === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }
    const collidingValue = target.sharedNames[fullName];
    if (typeof collidingValue !== 'string') {
      throw new Error('Expected the colliding App authority fixture to be a name.');
    }
    target.sharedNames[name] = collidingValue;

    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(expectedError);
  });

  it.each([
    ['project', 'appDeploymentStatusPublisherProject', 'terraformPlanProject'],
    ['role', 'appDeploymentStatusPublisherRole', 'terraformPlanRole'],
  ] as const)('rejects a status publisher %s colliding with another lane', (kind, statusName, laneName) => {
    const configuration = mutableDeploymentTargetConfiguration();
    const target = configuration.allowedTargets['stark-dev/develop'];
    const foundation = target?.lanes['foundation'];
    if (target === undefined || foundation === undefined) {
      throw new Error('Expected the reviewed Foundation lane fixture.');
    }
    const collidingName = foundation.names[laneName];
    if (collidingName === undefined) {
      throw new Error('Expected the reviewed Foundation authority name fixture.');
    }
    target.sharedNames[statusName] = collidingName;

    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(`status publisher ${kind}`);
  });

  it('rejects target log groups that drift from their governed runtime resources', () => {
    const configuration = mutableDeploymentTargetConfiguration();
    const target = configuration.allowedTargets['stark-dev/develop'];
    if (target === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }

    target.sharedNames['targetLogGroups'] = {
      ...(target.sharedNames['targetLogGroups'] as Record<string, string>),
      publicApi: '/aws/lambda/different-public-api',
    };

    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(
      'deployment target log group publicApi must match its target Lambda function',
    );
  });

  it.each(['bad..bucket', 'bad.-bucket', '192.0.2.1', 'xn--reserved-bucket', 'reserved-s3alias'])(
    'rejects an invalid governed S3 bucket name: %s',
    (invalidBucket) => {
      const configuration = mutableDeploymentTargetConfiguration();
      const target = configuration.allowedTargets['stark-dev/develop'];
      const appLane = target?.lanes['app'];
      if (appLane === undefined) {
        throw new Error('Expected the reviewed App lane fixture.');
      }
      appLane.names['artifactBucket'] = invalidBucket;

      expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow('generated S3 bucket name is invalid');
    },
  );

  it.each(['/leading/slash', 'channels/../escape'])('rejects an invalid governed S3 key: %s', (invalidKey) => {
    const configuration = mutableDeploymentTargetConfiguration();
    const target = configuration.allowedTargets['stark-dev/develop'];
    if (target === undefined) {
      throw new Error('Expected the reviewed development target fixture.');
    }
    target.sharedNames['foundationAppNetworkingKey'] = invalidKey;

    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(
      'generated foundationAppNetworkingKey S3 key is invalid',
    );
  });

  it('binds the context hash to the full reviewed target entry without exposing internal configuration', () => {
    const configuration = parseDeploymentTargetConfiguration(cloneDeploymentTargetConfiguration());
    const fullTarget = configuration.allowedTargets['stark-dev/develop'];
    const target = resolveAllowedDeploymentTarget('stark-dev/develop');
    const context = renderDeploymentLaneContext({
      target,
      lane: 'app',
      accountId: ACCOUNT_ID,
      requestedControlSourceSha: SOURCE_SHA,
      selectedApplicationSourceSha: SOURCE_SHA,
      frameworkSourceSha: SOURCE_SHA,
    });

    expect(context.targetConfigurationSha256).toBe(canonicalJsonSha256(fullTarget));
    expect(context.targetConfigurationSha256).toBe(EXPECTED_TARGET_CONFIGURATION_SHA256);
    expect(context.targetConfigurationSha256).not.toBe(canonicalJsonSha256(target));
    expect(target).not.toHaveProperty('sharedNames');
    expect(target).not.toHaveProperty('lanes');
  });

  it('resolves bounded lane names without inventing account or source authority', () => {
    const target = resolveAllowedDeploymentTarget('stark-dev/develop');
    expect(target.operatorPermissionSetName).toBe('stark-dev-operator');
    expect(resolveDeploymentLaneAuthority(target, 'prover')).toMatchObject({
      lane: 'prover',
      scope: 'foundation',
      stateIdentity: 'stark-dev/develop/foundation',
      backendKey: 'stark-ballot-simulator/stark-dev/develop/foundation/terraform.tfstate',
      names: {
        pipeline: 'stark-ballot-simulator-pipeline-stark-dev-develop-prover-release',
        sourceAction: 'Source',
        githubTriggerRole: 'stark-ballot-simulator-github-trigger-stark-dev-develop',
        runtimeNamePrefix: 'stark-ballot-simulator-stark-dev-develop',
        runtimeSecretReferencePrefix: '/stark-ballot-simulator/stark-dev/develop/app/secrets',
        signatureRuntimeNamePrefix: 'stark-ballot-sim-stark-dev-develop',
        signatureVerifierPermissionsBoundary:
          'stark-ballot-simulator-image-signature-verifier-boundary-stark-dev-develop',
        signatureVerifierRole: 'stark-ballot-sim-stark-dev-develop-image-signature-verifier-role',
        releaseManifestBucket: 'stark-ballot-simulator-stark-dev-develop-release-manifests',
        proverRepository: 'stark-ballot-simulator-stark-dev-develop/prover',
        toolchainRepository: 'stark-ballot-simulator-stark-dev-develop/risc0-toolchain',
        foundationAppNetworkingKey: 'channels/develop/foundation/app-networking.json',
        acceptedDeploymentPointerKey: 'accepted-deployments/stark-dev/develop/app/current.json',
        targetLambdaFunctions: {
          finalizationWriter: 'stark-ballot-simulator-stark-dev-develop-finalization-writer',
          imageSignatureVerifier: 'stark-ballot-sim-stark-dev-develop-image-signature-verifier',
          proofDispatcher: 'stark-ballot-simulator-stark-dev-develop-proof-dispatcher',
          publicApi: 'stark-ballot-simulator-stark-dev-develop-public-api',
          semaphoreJanitor: 'stark-ballot-simulator-stark-dev-develop-semaphore-janitor',
          verificationWorker: 'stark-ballot-simulator-stark-dev-develop-verification-worker',
        },
        targetLogGroups: {
          finalizationWriter: '/aws/lambda/stark-ballot-simulator-stark-dev-develop-finalization-writer',
          imageSignatureVerifier: '/aws/lambda/stark-ballot-sim-stark-dev-develop-image-signature-verifier',
          opsLedger: '/aws/events/stark-ballot-simulator-stark-dev-develop-ops-ledger',
          proofDispatcher: '/aws/lambda/stark-ballot-simulator-stark-dev-develop-proof-dispatcher',
          prover: '/aws/ecs/stark-ballot-simulator-stark-dev-develop-prover',
          publicApi: '/aws/lambda/stark-ballot-simulator-stark-dev-develop-public-api',
          semaphoreJanitor: '/aws/lambda/stark-ballot-simulator-stark-dev-develop-semaphore-janitor',
          verificationWorker: '/aws/lambda/stark-ballot-simulator-stark-dev-develop-verification-worker',
        },
      },
      policy: { signatureVerificationRequired: true },
    });
  });

  it.each([
    ['bootstrap', 'stark-ballot-simulator-pipeline-stark-dev-develop', 'bootstrap'],
    ['foundation', 'stark-ballot-simulator-pipeline-stark-dev-develop-foundation', 'foundation'],
    ['toolchain', 'stark-ballot-simulator-pipeline-stark-dev-develop-toolchain-release', 'foundation'],
    ['prover', 'stark-ballot-simulator-pipeline-stark-dev-develop-prover-release', 'foundation'],
    ['app', 'stark-ballot-simulator-pipeline-stark-dev-develop-app', 'app'],
    ['static-fast', 'stark-ballot-simulator-pipeline-stark-dev-develop-app-static-fast', 'app'],
  ] as const)('renders exact %s lane ownership and pipeline names', (lane, pipeline, scope) => {
    const context = renderDeploymentLaneContext({
      target: resolveAllowedDeploymentTarget('stark-dev/develop'),
      lane,
      accountId: ACCOUNT_ID,
      requestedControlSourceSha: SOURCE_SHA,
      selectedApplicationSourceSha: SOURCE_SHA,
      frameworkSourceSha: SOURCE_SHA,
    });

    expect(context.root.scope).toBe(scope);
    expect(context.names.pipeline).toBe(pipeline);
    expect(context.names.pipeline).toMatch(/^[A-Za-z0-9.@_-]{1,100}$/);
    expect(context.names.proverRepository.length).toBeLessThanOrEqual(256);
    expect(context.names.toolchainRepository.length).toBeLessThanOrEqual(256);
    expect(context.names.foundationAppNetworkingKey.length).toBeLessThanOrEqual(1024);
  });

  it('renders one exact App context from the reviewed allowed target', () => {
    const target = resolveAllowedDeploymentTarget('stark-dev/develop');
    const context = renderDeploymentLaneContext({
      target,
      lane: 'app',
      accountId: ACCOUNT_ID,
      requestedControlSourceSha: SOURCE_SHA,
      selectedApplicationSourceSha: SOURCE_SHA,
      frameworkSourceSha: SOURCE_SHA,
    });

    expect(context).toMatchObject({
      contextType: 'deployment-lane-context',
      project: {
        projectId: 'stark-ballot-simulator',
        resourcePrefix: 'stark-ballot-simulator-stark-dev-develop',
        stateNamespace: 'stark-ballot-simulator/stark-dev/develop',
        artifactNamespace: 'stark-ballot-simulator/stark-dev/develop',
      },
      target: {
        partition: 'aws',
        accountId: ACCOUNT_ID,
        accountLabel: 'stark-dev',
        region: 'ap-northeast-1',
        environmentId: 'develop',
        environmentTier: 'development',
      },
      root: {
        lane: 'app',
        scope: 'app',
        stateIdentity: 'stark-dev/develop/app',
        backendKey: 'stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate',
      },
      source: {
        branch: 'develop',
        provider: 'github',
        repository: 'hwatanabe-jp/stark-ballot-simulator',
        repositoryUrl: 'https://github.com/hwatanabe-jp/stark-ballot-simulator',
        requestedControlSourceSha: SOURCE_SHA,
        selectedApplicationSourceSha: SOURCE_SHA,
        frameworkSourceSha: SOURCE_SHA,
      },
      names: {
        artifactBucket: `sbs-app-exec-artifacts-stark-dev-develop-${ACCOUNT_ID}`,
        appDeploymentStatusKey: 'status/current.json',
        appDeploymentStatusPublisherProject:
          'stark-ballot-simulator-pipeline-stark-dev-develop-app-publish-current-status',
        appDeploymentStatusPublisherRole: 'sbs-app-status-publisher-stark-dev-develop',
        appRetainedArtifactBucket: `sbs-app-pipeline-artifacts-stark-dev-develop-${ACCOUNT_ID}`,
        appSignaturePreflightPlanRole: 'stark-ballot-sim-sig-preflight-plan-stark-dev-develop-app',
        appStaticFastDeployProject: 'stark-ballot-simulator-pipeline-stark-dev-develop-app-static-fast-deploy',
        appStaticFastDeployRole: 'stark-ballot-sim-static-fast-deploy-stark-dev-develop-app',
        appStaticFastGateProject: 'stark-ballot-simulator-pipeline-stark-dev-develop-app-static-fast-gate-and-build',
        pipeline: 'stark-ballot-simulator-pipeline-stark-dev-develop-app',
        releaseManifestBucket: 'stark-ballot-simulator-stark-dev-develop-release-manifests',
        sourceAction: 'Source',
        proverRepository: 'stark-ballot-simulator-stark-dev-develop/prover',
        toolchainRepository: 'stark-ballot-simulator-stark-dev-develop/risc0-toolchain',
        foundationAppNetworkingKey: 'channels/develop/foundation/app-networking.json',
        acceptedDeploymentPointerKey: 'accepted-deployments/stark-dev/develop/app/current.json',
        targetLambdaFunctions: {
          finalizationWriter: 'stark-ballot-simulator-stark-dev-develop-finalization-writer',
          imageSignatureVerifier: 'stark-ballot-sim-stark-dev-develop-image-signature-verifier',
          proofDispatcher: 'stark-ballot-simulator-stark-dev-develop-proof-dispatcher',
          publicApi: 'stark-ballot-simulator-stark-dev-develop-public-api',
          semaphoreJanitor: 'stark-ballot-simulator-stark-dev-develop-semaphore-janitor',
          verificationWorker: 'stark-ballot-simulator-stark-dev-develop-verification-worker',
        },
      },
      policy: {
        signatureVerificationRequired: true,
      },
    });
    expect(context.targetConfigurationSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parseDeploymentLaneContext(context)).toEqual(context);
  });

  it('requires one control/framework source while allowing an independently selected App source', () => {
    const historicalAppSourceSha = 'b'.repeat(40);
    const context = renderDeploymentLaneContext({
      target: resolveAllowedDeploymentTarget('stark-dev/develop'),
      lane: 'app',
      accountId: ACCOUNT_ID,
      requestedControlSourceSha: SOURCE_SHA,
      selectedApplicationSourceSha: historicalAppSourceSha,
      frameworkSourceSha: SOURCE_SHA,
    });

    expect(context.source.selectedApplicationSourceSha).toBe(historicalAppSourceSha);
    expect(() =>
      renderDeploymentLaneContext({
        target: resolveAllowedDeploymentTarget('stark-dev/develop'),
        lane: 'app',
        accountId: ACCOUNT_ID,
        requestedControlSourceSha: SOURCE_SHA,
        selectedApplicationSourceSha: historicalAppSourceSha,
        frameworkSourceSha: 'c'.repeat(40),
      }),
    ).toThrow('requested control source SHA must match framework source SHA');
  });

  it('rejects unauthorized targets, target overrides, unknown context keys, and secrets', () => {
    expect(() => resolveAllowedDeploymentTarget('unreviewed/main')).toThrow(
      'deployment target "unreviewed/main" is not authorized',
    );

    const context = renderDeploymentLaneContext({
      target: resolveAllowedDeploymentTarget('stark-dev/develop'),
      lane: 'foundation',
      accountId: ACCOUNT_ID,
      requestedControlSourceSha: SOURCE_SHA,
      selectedApplicationSourceSha: SOURCE_SHA,
      frameworkSourceSha: SOURCE_SHA,
    });
    expect(() => parseDeploymentLaneContext({ ...context, schemaVersion: 2 })).toThrow(
      'deployment lane context must contain exactly contextType, names, policy, project, root, source, target, targetConfigurationSha256',
    );
    expect(() =>
      parseDeploymentLaneContext({
        ...context,
        policy: { ...context.policy, secretValue: 'do-not-admit' },
      }),
    ).toThrow('deployment context policy must contain exactly signatureVerificationRequired');
    expect(() =>
      renderDeploymentLaneContext({
        target: {
          ...resolveAllowedDeploymentTarget('stark-dev/develop'),
          region: 'us-east-1',
        } as unknown as ReturnType<typeof resolveAllowedDeploymentTarget>,
        lane: 'foundation',
        accountId: ACCOUNT_ID,
        requestedControlSourceSha: SOURCE_SHA,
        selectedApplicationSourceSha: SOURCE_SHA,
        frameworkSourceSha: SOURCE_SHA,
      }),
    ).toThrow('deployment target does not match the reviewed allowed-target configuration');
    expect(() =>
      renderDeploymentLaneContext({
        target: resolveAllowedDeploymentTarget('stark-dev/develop'),
        lane: 'foundation',
        accountId: '1'.repeat(12),
        requestedControlSourceSha: SOURCE_SHA,
        selectedApplicationSourceSha: SOURCE_SHA,
        frameworkSourceSha: SOURCE_SHA,
      }),
    ).toThrow('AWS account ID does not match the reviewed allowed target');
    expect(() =>
      renderDeploymentLaneContext({
        target: resolveAllowedDeploymentTarget('stark-dev/develop'),
        lane: 'foundation',
        accountId: ACCOUNT_ID,
        requestedControlSourceSha: SOURCE_SHA,
        selectedApplicationSourceSha: SOURCE_SHA,
        frameworkSourceSha: SOURCE_SHA,
        secretValue: 'do-not-admit',
      }),
    ).toThrow('deployment context input must contain exactly');
  });
});

describe('production target configuration admission', () => {
  it('keeps development policy and configuration bytes unchanged', () => {
    const target = resolveAllowedDeploymentTarget('stark-dev/develop');
    expect(resolveBootstrapSavedPlanApprovalAction(target)).toBe('ApproveInitialDevelopmentApply');
    expect(resolveFoundationPublicSubnetException(target)).toBe('accepted-for-develop-prover-egress');
    const admitted = parseDeploymentTargetConfiguration(cloneDeploymentTargetConfiguration());
    const development = admitted.allowedTargets['stark-dev/develop'];
    expect(Object.hasOwn(development, 'productionPolicy')).toBe(false);
    expect(canonicalJsonSha256(development)).toBe(EXPECTED_TARGET_CONFIGURATION_SHA256);
    expect(() => resolveBootstrapSavedPlanApprovalAction({ ...target, accountId: '999999999999' })).toThrow('reviewed');
    expect(() => resolveFoundationPublicSubnetException({ ...target, environmentId: 'main' })).toThrow('reviewed');
  });

  it('rejects missing, extra, or development policy values in the production configuration', () => {
    const { configuration, development, production } = productionConfigurationFixture();
    const policy = { ...production.productionPolicy };
    const invalidPolicies = [
      null,
      {},
      { bootstrapApprovalAction: 'ApproveBootstrapApply' },
      { foundationPublicSubnetException: 'accepted-for-production-prover-egress' },
      { ...policy, bootstrapApprovalAction: 'ApproveInitialDevelopmentApply' },
      { ...policy, foundationPublicSubnetException: 'accepted-for-develop-prover-egress' },
      { ...policy, extra: true },
    ];
    for (const invalid of invalidPolicies) {
      Object.assign(production, { productionPolicy: invalid });
      expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow();
    }
    delete production.productionPolicy;
    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow();
    const valid = productionConfigurationFixture();
    Object.assign(valid.development, { productionPolicy: valid.production.productionPolicy });
    expect(() => parseDeploymentTargetConfiguration(valid.configuration)).toThrow();
    expect(Object.hasOwn(development, 'productionPolicy')).toBe(false);
  });

  it('resolves reviewed production policy and binds it into the complete target hash', async () => {
    const { configuration, production } = productionConfigurationFixture();
    vi.resetModules();
    vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
    try {
      const configured = await import('./index.js');
      const target = configured.resolveAllowedDeploymentTarget('stark-prod/main');
      expect(configured.resolveBootstrapSavedPlanApprovalAction(target)).toBe(
        production.productionPolicy?.bootstrapApprovalAction,
      );
      expect(configured.resolveFoundationPublicSubnetException(target)).toBe(
        production.productionPolicy?.foundationPublicSubnetException,
      );
      const admitted = configured.parseDeploymentTargetConfiguration(configuration).allowedTargets['stark-prod/main'];
      expect(admitted).toBeDefined();
      const context = configured.renderDeploymentLaneContext({
        target,
        lane: 'bootstrap',
        accountId: target.accountId,
        requestedControlSourceSha: SOURCE_SHA,
        selectedApplicationSourceSha: SOURCE_SHA,
        frameworkSourceSha: SOURCE_SHA,
      });
      expect(context.targetConfigurationSha256).toBe(canonicalJsonSha256(admitted));
      const withoutPolicy = { ...admitted };
      Reflect.deleteProperty(withoutPolicy, 'productionPolicy');
      expect(context.targetConfigurationSha256).not.toBe(canonicalJsonSha256(withoutPolicy));
    } finally {
      vi.doUnmock('../deployment-targets.json');
      vi.resetModules();
    }
  });

  it('admits the closed production lane set without changing development authority', () => {
    const { configuration, development } = productionConfigurationFixture();
    const admitted = parseDeploymentTargetConfiguration(configuration);
    const production = admitted.allowedTargets['stark-prod/main'];
    expect(production?.targetKey).toBe('stark-prod/main');
    expect(Object.keys(production?.lanes ?? {}).sort()).toEqual([
      'app',
      'bootstrap',
      'foundation',
      'prover',
      'toolchain',
    ]);
    expect(Object.keys(production?.sharedNames ?? {}).some((key) => key.startsWith('appStaticFast'))).toBe(false);
    expect(canonicalJson(admitted.allowedTargets['stark-dev/develop'])).toBe(canonicalJson(development));
    expect(canonicalJsonSha256(admitted.allowedTargets['stark-dev/develop'])).toBe(
      EXPECTED_TARGET_CONFIGURATION_SHA256,
    );
    expect(Object.isFrozen(production)).toBe(true);
  });

  it('renders each configured production lane and rejects mixed target contexts', async () => {
    const { configuration } = productionConfigurationFixture();
    const previousDevelopmentContexts = ['bootstrap', 'foundation', 'toolchain', 'prover', 'app', 'static-fast'].map(
      (lane) =>
        renderDeploymentLaneContext({
          target: resolveAllowedDeploymentTarget('stark-dev/develop'),
          lane,
          accountId: ACCOUNT_ID,
          requestedControlSourceSha: SOURCE_SHA,
          selectedApplicationSourceSha: SOURCE_SHA,
          frameworkSourceSha: SOURCE_SHA,
        }),
    );
    vi.resetModules();
    vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
    try {
      const configured = await import('./index.js');
      const production = configured.resolveAllowedDeploymentTarget('stark-prod/main');
      const context = (lane: string) =>
        configured.renderDeploymentLaneContext({
          target: production,
          lane,
          accountId: production.accountId,
          requestedControlSourceSha: SOURCE_SHA,
          selectedApplicationSourceSha: SOURCE_SHA,
          frameworkSourceSha: SOURCE_SHA,
        });
      for (const lane of ['bootstrap', 'foundation', 'toolchain', 'prover', 'app']) {
        const rendered = context(lane);
        expect(configured.parseDeploymentLaneContext(rendered)).toEqual(rendered);
        expect(rendered.target.environmentId).toBe('main');
        expect(rendered.source.branch).toBe('main');
        expect(Object.keys(rendered.names).some((key) => key.startsWith('appStaticFast'))).toBe(false);
      }
      for (const previous of previousDevelopmentContexts) {
        expect(canonicalJson(configured.parseDeploymentLaneContext(previous))).toBe(canonicalJson(previous));
      }
      expect(() => context('static-fast')).toThrow('deployment lane is not authorized');
      const selected = context('app');
      for (const changed of [
        { ...selected, target: { ...selected.target, accountId: ACCOUNT_ID } },
        { ...selected, target: { ...selected.target, region: 'us-west-2' } },
        { ...selected, source: { ...selected.source, branch: 'develop' } },
        { ...selected, root: { ...selected.root, stateIdentity: 'stark-dev/develop/app' } },
        { ...selected, names: { ...selected.names, artifactBucket: 'unreviewed-artifact-bucket' } },
      ]) {
        expect(() => configured.parseDeploymentLaneContext(changed)).toThrow();
      }
    } finally {
      vi.doUnmock('../deployment-targets.json');
      vi.resetModules();
    }
  });

  it.each([
    ['sourceBranch', 'develop'],
    ['environmentTier', 'development'],
    ['accountLabel', 'stark-dev'],
    ['environmentId', 'develop'],
    ['targetKey', 'stark-dev/develop'],
  ] as const)('rejects development %s in the production entry', (field, value) => {
    const { configuration, production } = productionConfigurationFixture();
    production[field] = value;
    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(/deployment target/u);
  });

  it('rejects using the development account for production', () => {
    const { configuration, development, production } = productionConfigurationFixture();
    production.accountId = development.accountId;
    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(
      'distinct development and production accounts',
    );
  });

  it('rejects a production static-fast lane or a stray static-fast principal name', () => {
    const { configuration, development, production } = productionConfigurationFixture();
    const staticFast = development.lanes['static-fast'];
    if (staticFast === undefined) throw new Error('Missing static-fast fixture.');
    production.lanes['static-fast'] = staticFast;
    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(
      'deployment target lanes must contain exactly',
    );
    delete production.lanes['static-fast'];
    production.sharedNames['appStaticFastDeployRole'] = 'unexpected-static-publisher';
    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(
      'deployment target shared names must contain exactly',
    );
  });

  it('rejects any additional target even beside valid development and production entries', () => {
    const { configuration, production } = productionConfigurationFixture();
    configuration.allowedTargets['stark-prod/develop'] = production;
    expect(() => parseDeploymentTargetConfiguration(configuration)).toThrow(
      'deployment allowed targets must contain exactly',
    );
  });
});
