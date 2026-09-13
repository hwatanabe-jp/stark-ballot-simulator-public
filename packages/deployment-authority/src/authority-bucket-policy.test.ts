import { productionConfigurationFixture } from './test-support/deployment-target-fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import {
  auditAuthorityBucketPolicies,
  auditAuthorityBucketPolicyObservation,
  buildAuthorityBucketPolicyAuditSpecifications,
} from './authority-bucket-policy.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';

type AuditSpecification = ReturnType<typeof buildAuthorityBucketPolicyAuditSpecifications>[number];

function policyFor(specification: AuditSpecification) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: `${specification.kind}-authority-deletion`,
        Effect: 'Deny',
        Principal: '*',
        Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
        Resource: [...specification.deletionProtectedObjectArns],
      },
      {
        Sid: `${specification.kind}-authority-create-only`,
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:PutObject',
        Resource: [...specification.immutableObjectArns],
        Condition: {
          StringNotEquals: {
            's3:if-none-match': '*',
          },
        },
      },
      {
        Sid: `${specification.kind}-authority-pointer-conditional`,
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:PutObject',
        Resource: [...specification.pointerObjectArns],
        Condition: {
          StringNotEquals: {
            's3:if-none-match': '*',
          },
          Null: {
            's3:if-match': 'true',
          },
        },
      },
      {
        Sid: `${specification.kind}-authority-pointer-ambiguous`,
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:PutObject',
        Resource: [...specification.pointerObjectArns],
        Condition: {
          Null: {
            's3:if-none-match': 'false',
            's3:if-match': 'false',
          },
        },
      },
      ...specification.publisherRestrictions.map((restriction, index) => ({
        Sid: `${specification.kind}-authority-publisher-${index}`,
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:PutObject',
        Resource: [...restriction.objectArns],
        Condition: {
          [restriction.conditionOperator]: {
            'aws:PrincipalArn':
              restriction.publisherPrincipalArns.length === 1
                ? restriction.publisherPrincipalArns[0]
                : [...restriction.publisherPrincipalArns],
          },
        },
      })),
      ...specification.retiredWriteDeniedObjectArns.map((resource, index) => ({
        Sid: `${specification.kind}-retired-write-${index}`,
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:PutObject',
        Resource: resource,
      })),
    ],
  };
}

function observationFor(specification: AuditSpecification) {
  return {
    kind: specification.kind,
    bucketName: specification.bucketName,
    versioningStatus: 'Enabled',
    policy: policyFor(specification),
  };
}

function singleObservationFor(specification: AuditSpecification) {
  return {
    bucketName: specification.bucketName,
    versioningStatus: 'Enabled',
    policy: policyFor(specification),
  };
}

function completeAuditInput() {
  return {
    observations: buildAuthorityBucketPolicyAuditSpecifications('stark-dev/develop').map(observationFor),
  };
}

type MutableAuditInput = ReturnType<typeof completeAuditInput>;

function mutableObservation(input: MutableAuditInput, index: number) {
  const observation = input.observations[index];
  if (observation === undefined) {
    throw new Error(`missing fixture observation ${index}`);
  }
  return observation;
}

function mutableStatement(input: MutableAuditInput, observationIndex: number, statementIndex: number) {
  const statement = mutableObservation(input, observationIndex).policy.Statement[statementIndex];
  if (statement === undefined) {
    throw new Error(`missing fixture statement ${statementIndex}`);
  }
  return statement as Record<string, unknown>;
}

describe('authority bucket policy audit', () => {
  it('admits the exact three configured authority buckets and freezes its summary', () => {
    const specifications = buildAuthorityBucketPolicyAuditSpecifications('stark-dev/develop');

    expect(specifications.map(({ kind }) => kind)).toEqual(['release', 'app-retained', 'terraform']);

    const result = auditAuthorityBucketPolicies(completeAuditInput(), 'stark-dev/develop');

    expect(result).toEqual({
      auditType: 'authority-bucket-policy',
      buckets: specifications.map(({ bucketName, kind, publisherRestrictions }) => ({
        kind,
        bucketName,
        publisherRestrictionCount: publisherRestrictions.length,
        versioningStatus: 'Enabled',
      })),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.buckets)).toBe(true);
    expect(Object.isFrozen(specifications)).toBe(true);
    expect(specifications.every((specification) => Object.isFrozen(specification.publisherRestrictions))).toBe(true);
    expect(specifications[0]?.pointerObjectArns).toHaveLength(2);
    expect(specifications[2]?.pointerObjectArns).toHaveLength(2);
    expect(specifications.every((specification) => specification.publisherRestrictions.length > 0)).toBe(true);
  });

  it('audits current App status as a deletion-protected conditional pointer with one publisher', () => {
    const target = resolveAllowedDeploymentTarget('stark-dev/develop');
    const names = resolveDeploymentLaneAuthority(target, 'foundation').names;
    const specification = buildAuthorityBucketPolicyAuditSpecifications('stark-dev/develop').find(
      ({ kind }) => kind === 'app-retained',
    );
    if (specification === undefined) throw new Error('missing App-retained audit specification');
    const bucketArn = `arn:${target.partition}:s3:::${names.appRetainedArtifactBucket}`;
    const acceptancePointerArn = `${bucketArn}/${names.acceptedDeploymentPointerKey}`;
    const statusObjectArn = `${bucketArn}/${names.appDeploymentStatusKey}`;

    expect(specification.pointerObjectArns).toEqual([acceptancePointerArn, statusObjectArn]);
    expect(specification.deletionProtectedObjectArns).toContain(statusObjectArn);
    expect(specification.immutableObjectArns).not.toContain(statusObjectArn);
    expect(specification.publisherRestrictions).toContainEqual({
      objectArns: [statusObjectArn],
      conditionOperator: 'ArnNotEquals',
      publisherPrincipalArns: [
        `arn:${target.partition}:iam::${target.accountId}:role/${names.appDeploymentStatusPublisherRole}`,
      ],
    });
  });

  it('seals predecessor App history while Bootstrap and Foundation own current Terraform authority', () => {
    const target = resolveAllowedDeploymentTarget('stark-dev/develop');
    const bootstrap = resolveDeploymentLaneAuthority(target, 'bootstrap');
    const foundation = resolveDeploymentLaneAuthority(target, 'foundation');
    const app = resolveDeploymentLaneAuthority(target, 'app');
    const terraform = buildAuthorityBucketPolicyAuditSpecifications('stark-dev/develop').find(
      ({ kind }) => kind === 'terraform',
    );
    if (terraform === undefined) throw new Error('missing Terraform audit specification');
    const bucketArn = `arn:${target.partition}:s3:::${foundation.names.terraformAuthorityBucket}`;
    const prefix = foundation.names.terraformBaselinePrefix;
    const bootstrapHistory = `${bucketArn}/${prefix}/${bootstrap.stateIdentity}/executions/*`;
    const bootstrapAcceptances = `${bucketArn}/${prefix}/${bootstrap.stateIdentity}/acceptances/*`;
    const foundationHistory = `${bucketArn}/${prefix}/${foundation.stateIdentity}/executions/*`;
    const foundationAcceptances = `${bucketArn}/${prefix}/${foundation.stateIdentity}/acceptances/*`;
    const appHistory = `${bucketArn}/${prefix}/${app.stateIdentity}/executions/*`;
    const bootstrapPointer = `${bucketArn}/${prefix}/${bootstrap.stateIdentity}/current.json`;
    const foundationPointer = `${bucketArn}/${prefix}/${foundation.stateIdentity}/current.json`;

    expect(terraform.immutableObjectArns).toEqual([bootstrapAcceptances, foundationAcceptances]);
    expect(terraform.pointerObjectArns).toEqual([bootstrapPointer, foundationPointer]);
    expect(terraform.deletionProtectedObjectArns).toEqual([
      bootstrapAcceptances,
      foundationAcceptances,
      bootstrapHistory,
      foundationHistory,
      appHistory,
      bootstrapPointer,
      foundationPointer,
    ]);
    expect(terraform.retiredWriteDeniedObjectArns).toEqual([bootstrapHistory, foundationHistory, appHistory]);
    expect(terraform.publisherRestrictions).toEqual([
      {
        objectArns: [bootstrapAcceptances, bootstrapPointer],
        conditionOperator: 'ArnNotEquals',
        publisherPrincipalArns: [
          `arn:${target.partition}:iam::${target.accountId}:role/${bootstrap.names.bootstrapTerraformAcceptancePublisherRole}`,
        ],
      },
      {
        objectArns: [foundationAcceptances, foundationPointer],
        conditionOperator: 'ArnNotEquals',
        publisherPrincipalArns: [
          `arn:${target.partition}:iam::${target.accountId}:role/${foundation.names.foundationTerraformAcceptancePublisherRole}`,
        ],
      },
    ]);
  });

  it('separates Toolchain candidate and release publishers at their target ledger namespaces', () => {
    const target = resolveAllowedDeploymentTarget('stark-dev/develop');
    const names = resolveDeploymentLaneAuthority(target, 'foundation').names;
    const specification = buildAuthorityBucketPolicyAuditSpecifications('stark-dev/develop').find(
      ({ kind }) => kind === 'release',
    );
    if (specification === undefined) throw new Error('missing release audit specification');
    const candidateResource = specification.publisherRestrictions.find((restriction) =>
      restriction.objectArns.some((arn) => arn.endsWith('/artifacts/toolchain/candidates/*')),
    );
    const releaseResource = specification.publisherRestrictions.find((restriction) =>
      restriction.objectArns.some((arn) => arn.endsWith('/artifacts/toolchain/releases/*')),
    );

    expect(candidateResource).toEqual({
      objectArns: [expect.stringMatching(/\/artifacts\/toolchain\/candidates\/\*$/u)],
      conditionOperator: 'ArnNotEquals',
      publisherPrincipalArns: [`arn:${target.partition}:iam::${target.accountId}:role/${names.toolchainCandidateRole}`],
    });
    expect(releaseResource).toEqual({
      objectArns: [expect.stringMatching(/\/artifacts\/toolchain\/releases\/\*$/u)],
      conditionOperator: 'ArnNotEquals',
      publisherPrincipalArns: [`arn:${target.partition}:iam::${target.accountId}:role/${names.toolchainPointerRole}`],
    });
    expect(
      specification.publisherRestrictions.some((restriction) =>
        restriction.objectArns.some((arn) => arn.endsWith('/artifacts/toolchain/*')),
      ),
    ).toBe(false);
  });

  it('separates Prover candidate and release publishers and closes the predecessor record namespace', () => {
    const target = resolveAllowedDeploymentTarget('stark-dev/develop');
    const names = resolveDeploymentLaneAuthority(target, 'foundation').names;
    const specification = buildAuthorityBucketPolicyAuditSpecifications('stark-dev/develop').find(
      ({ kind }) => kind === 'release',
    );
    if (specification === undefined) throw new Error('missing release audit specification');
    const candidateResource = specification.publisherRestrictions.find((restriction) =>
      restriction.objectArns.some((arn) => arn.endsWith('/artifacts/prover/candidates/*')),
    );
    const releaseResource = specification.publisherRestrictions.find((restriction) =>
      restriction.objectArns.some((arn) => arn.endsWith('/artifacts/prover/releases/*')),
    );

    expect(candidateResource).toEqual({
      objectArns: [expect.stringMatching(/\/artifacts\/prover\/candidates\/\*$/u)],
      conditionOperator: 'ArnNotEquals',
      publisherPrincipalArns: [`arn:${target.partition}:iam::${target.accountId}:role/${names.proverCandidateRole}`],
    });
    expect(releaseResource).toEqual({
      objectArns: [expect.stringMatching(/\/artifacts\/prover\/releases\/\*$/u)],
      conditionOperator: 'ArnNotEquals',
      publisherPrincipalArns: [`arn:${target.partition}:iam::${target.accountId}:role/${names.proverPointerRole}`],
    });
    expect(
      specification.publisherRestrictions.some((restriction) =>
        restriction.objectArns.some((arn) => arn.endsWith('/artifacts/prover/*')),
      ),
    ).toBe(false);
    expect(specification.retiredWriteDeniedObjectArns).toEqual([
      expect.stringMatching(/\/artifacts\/prover\/\*\/manifest\.json$/u),
      expect.stringMatching(/\/artifacts\/toolchain\/\*\/manifest\.json$/u),
      expect.stringMatching(/\/deployments\/\*$/u),
      expect.stringMatching(/\/rollbacks\/\*$/u),
      expect.stringMatching(/\/artifacts\/foundation\/image-signing\/\*$/u),
      expect.stringMatching(/\/channels\/develop\/foundation\/app-networking\.json$/u),
    ]);
    expect(JSON.stringify(specification)).not.toContain('appDeploymentRecordRole');
    expect(
      specification.publisherRestrictions.some((restriction) =>
        restriction.objectArns.some(
          (arn) => arn.includes('/artifacts/foundation/image-signing/') || arn.endsWith('/app-networking.json'),
        ),
      ),
    ).toBe(false);
  });

  it('audits one owning-smoke observation without requiring IAM simulation results', () => {
    const specification = buildAuthorityBucketPolicyAuditSpecifications('stark-dev/develop')[0];
    if (specification === undefined) {
      throw new Error('missing release audit fixture');
    }
    const observation = singleObservationFor(specification);

    expect(auditAuthorityBucketPolicyObservation('release', observation, 'stark-dev/develop')).toEqual({
      kind: 'release',
      bucketName: specification.bucketName,
      publisherRestrictionCount: specification.publisherRestrictions.length,
      versioningStatus: 'Enabled',
    });
  });

  it('rejects an authority bucket whose versioning is not enabled', () => {
    const input = completeAuditInput();
    mutableObservation(input, 1).versioningStatus = 'Suspended';

    expect(() => auditAuthorityBucketPolicies(input, 'stark-dev/develop')).toThrow(
      'app-retained authority bucket versioning must be Enabled',
    );
  });

  it('rejects missing, duplicate, and misidentified configured bucket observations', () => {
    const missing = completeAuditInput();
    missing.observations.pop();
    expect(() => auditAuthorityBucketPolicies(missing, 'stark-dev/develop')).toThrow(
      'authority bucket policy audit must contain exactly the configured buckets',
    );

    const duplicate = completeAuditInput();
    duplicate.observations[2] = structuredClone(mutableObservation(duplicate, 1));
    expect(() => auditAuthorityBucketPolicies(duplicate, 'stark-dev/develop')).toThrow(
      'terraform authority bucket observation does not match its configured bucket',
    );

    const wrongName = completeAuditInput();
    mutableObservation(wrongName, 0).bucketName = 'different-authority-bucket';
    expect(() => auditAuthorityBucketPolicies(wrongName, 'stark-dev/develop')).toThrow(
      'release authority bucket observation does not match its configured bucket',
    );
  });

  it('rejects unknown audit, observation, policy, and governed statement fields', () => {
    const unknownInput = { ...completeAuditInput(), fallback: true };
    expect(() => auditAuthorityBucketPolicies(unknownInput, 'stark-dev/develop')).toThrow(
      'authority bucket policy audit input must contain exactly observations',
    );

    const unknownObservation = completeAuditInput();
    Object.assign(mutableObservation(unknownObservation, 0), { fallbackBucketName: 'legacy' });
    expect(() => auditAuthorityBucketPolicies(unknownObservation, 'stark-dev/develop')).toThrow(
      'release authority bucket observation must contain exactly bucketName, kind, policy, versioningStatus',
    );

    const unknownPolicy = completeAuditInput();
    Object.assign(mutableObservation(unknownPolicy, 0).policy, { Id: 'unreviewed-policy' });
    expect(() => auditAuthorityBucketPolicies(unknownPolicy, 'stark-dev/develop')).toThrow(
      'release authority bucket policy must contain exactly Statement, Version',
    );

    const unknownStatement = completeAuditInput();
    Object.assign(mutableStatement(unknownStatement, 0, 1), { NotResource: 'arn:aws:s3:::other/*' });
    expect(() => auditAuthorityBucketPolicies(unknownStatement, 'stark-dev/develop')).toThrow(
      'release immutable create-only deny must contain exactly Action, Condition, Effect, Principal, Resource, Sid',
    );
  });

  it('requires the exact IAM policy language version', () => {
    const input = completeAuditInput();
    mutableObservation(input, 0).policy.Version = '2008-10-17';

    expect(() => auditAuthorityBucketPolicies(input, 'stark-dev/develop')).toThrow(
      'release authority bucket policy Version must be 2012-10-17',
    );
  });

  it('requires an unconditional wildcard-principal delete deny for every protected object and version', () => {
    const conditional = completeAuditInput();
    Object.assign(mutableStatement(conditional, 0, 0), {
      Condition: { StringEquals: { 'aws:PrincipalArn': 'arn:aws:iam::000000000000:root' } },
    });
    expect(() => auditAuthorityBucketPolicies(conditional, 'stark-dev/develop')).toThrow(
      'release deletion deny must be unconditional',
    );

    const missingAction = completeAuditInput();
    mutableStatement(missingAction, 1, 0)['Action'] = 's3:DeleteObject';
    expect(() => auditAuthorityBucketPolicies(missingAction, 'stark-dev/develop')).toThrow(
      'app-retained deletion deny must cover exactly s3:DeleteObject and s3:DeleteObjectVersion',
    );

    const wrongPrincipal = completeAuditInput();
    mutableStatement(wrongPrincipal, 2, 0)['Principal'] = { AWS: 'arn:aws:iam::000000000000:root' };
    expect(() => auditAuthorityBucketPolicies(wrongPrincipal, 'stark-dev/develop')).toThrow(
      'terraform deletion deny must apply to exact Principal *',
    );

    const missingResource = completeAuditInput();
    const resources = mutableStatement(missingResource, 0, 0)['Resource'];
    if (!Array.isArray(resources)) {
      throw new Error('expected resource fixture array');
    }
    resources.pop();
    expect(() => auditAuthorityBucketPolicies(missingResource, 'stark-dev/develop')).toThrow(
      'release deletion deny must cover exactly the configured protected resources',
    );
  });

  it('permits narrower deletion denies alongside exact universal deletion protection', () => {
    const input = completeAuditInput();
    const terraformSpecification = buildAuthorityBucketPolicyAuditSpecifications('stark-dev/develop').find(
      ({ kind }) => kind === 'terraform',
    );
    if (terraformSpecification === undefined) {
      throw new Error('missing Terraform audit specification');
    }
    const terraformStatements = mutableObservation(input, 2).policy.Statement as unknown as Record<string, unknown>[];
    terraformStatements.push({
      Sid: 'DenyTerraformApplyRoleObjectAccess',
      Effect: 'Deny',
      Principal: {
        AWS: 'arn:aws:iam::000000000000:role/exact-terraform-apply-role',
      },
      Action: ['s3:DeleteObject', 's3:GetObject', 's3:GetObjectVersion', 's3:PutObject'],
      Resource: [
        ...terraformSpecification.deletionProtectedObjectArns,
        'arn:aws:s3:::example-terraform-authority/terraform-drift-reports/*',
      ],
    });
    terraformStatements.push(
      {
        Sid: 'DenyOneDeletionActionForAllPrincipals',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:DeleteObject',
        Resource: [...terraformSpecification.deletionProtectedObjectArns],
      },
      {
        Sid: 'DenyConditionedDeletionForAllPrincipals',
        Effect: 'Deny',
        Principal: '*',
        Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
        Resource: [...terraformSpecification.deletionProtectedObjectArns],
        Condition: {
          StringEquals: { 'aws:PrincipalArn': 'arn:aws:iam::000000000000:role/exact-role' },
        },
      },
    );

    expect(() => auditAuthorityBucketPolicies(input, 'stark-dev/develop')).not.toThrow();
  });

  it('permits exact-resource pointer guards alongside the publisher restriction for that pointer', () => {
    const input = completeAuditInput();
    const releaseSpecification = buildAuthorityBucketPolicyAuditSpecifications('stark-dev/develop').find(
      ({ kind }) => kind === 'release',
    );
    if (releaseSpecification === undefined) {
      throw new Error('missing release audit specification');
    }
    const appNetworkingPointer = releaseSpecification.pointerObjectArns.at(-1);
    if (appNetworkingPointer === undefined) {
      throw new Error('missing Foundation app-networking pointer');
    }
    mutableStatement(input, 0, 2)['Resource'] = releaseSpecification.pointerObjectArns.slice(0, -1);
    mutableStatement(input, 0, 3)['Resource'] = releaseSpecification.pointerObjectArns.slice(0, -1);
    mutableObservation(input, 0).policy.Statement.push(
      {
        Sid: 'DenyUnconditionalFoundationAppNetworkingWrites',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:PutObject',
        Resource: appNetworkingPointer,
        Condition: {
          StringNotEquals: { 's3:if-none-match': '*' },
          Null: { 's3:if-match': 'true' },
        },
      },
      {
        Sid: 'DenyAmbiguousFoundationAppNetworkingWrites',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:PutObject',
        Resource: appNetworkingPointer,
        Condition: {
          Null: { 's3:if-none-match': 'false', 's3:if-match': 'false' },
        },
      },
    );

    expect(() => auditAuthorityBucketPolicies(input, 'stark-dev/develop')).not.toThrow();
  });

  it('requires create-only records to carry exact If-None-Match star', () => {
    const presenceOnly = completeAuditInput();
    mutableStatement(presenceOnly, 0, 1)['Condition'] = {
      Null: {
        's3:if-none-match': 'true',
      },
    };
    expect(() => auditAuthorityBucketPolicies(presenceOnly, 'stark-dev/develop')).toThrow(
      'release immutable create-only deny must require exact If-None-Match *',
    );

    const wrongValue = completeAuditInput();
    mutableStatement(wrongValue, 1, 1)['Condition'] = {
      StringNotEquals: {
        's3:if-none-match': 'different-etag',
      },
    };
    expect(() => auditAuthorityBucketPolicies(wrongValue, 'stark-dev/develop')).toThrow(
      'app-retained immutable create-only deny must require exact If-None-Match *',
    );

    const missingResource = completeAuditInput();
    const resources = mutableStatement(missingResource, 2, 1)['Resource'];
    if (!Array.isArray(resources)) {
      throw new Error('expected resource fixture array');
    }
    resources.pop();
    expect(() => auditAuthorityBucketPolicies(missingResource, 'stark-dev/develop')).toThrow(
      'terraform immutable create-only deny must cover exactly the configured immutable resources',
    );
  });

  it('requires pointer first-create XOR compare-and-swap conditions', () => {
    const presenceOnly = completeAuditInput();
    mutableStatement(presenceOnly, 0, 2)['Condition'] = {
      Null: {
        's3:if-none-match': 'true',
        's3:if-match': 'true',
      },
    };
    expect(() => auditAuthorityBucketPolicies(presenceOnly, 'stark-dev/develop')).toThrow(
      'release pointer conditional deny must require exact If-None-Match * or If-Match',
    );

    const missingIfMatch = completeAuditInput();
    mutableStatement(missingIfMatch, 1, 2)['Condition'] = {
      StringNotEquals: {
        's3:if-none-match': '*',
      },
    };
    expect(() => auditAuthorityBucketPolicies(missingIfMatch, 'stark-dev/develop')).toThrow(
      'app-retained pointer conditional deny must require exact If-None-Match * or If-Match',
    );

    const ambiguousAllowed = completeAuditInput();
    mutableStatement(ambiguousAllowed, 2, 3)['Condition'] = {
      Null: {
        's3:if-none-match': 'true',
        's3:if-match': 'false',
      },
    };
    expect(() => auditAuthorityBucketPolicies(ambiguousAllowed, 'stark-dev/develop')).toThrow(
      'terraform ambiguous pointer deny must reject both If-None-Match and If-Match',
    );

    const missingAmbiguityDeny = completeAuditInput();
    mutableObservation(missingAmbiguityDeny, 0).policy.Statement.splice(3, 1);
    expect(() => auditAuthorityBucketPolicies(missingAmbiguityDeny, 'stark-dev/develop')).toThrow(
      'release ambiguous pointer deny must cover exactly the configured pointer resources',
    );
  });

  it('requires exact resource-policy publisher restrictions for every governed write family', () => {
    const missingRestriction = completeAuditInput();
    mutableObservation(missingRestriction, 0).policy.Statement.splice(4, 1);
    expect(() => auditAuthorityBucketPolicies(missingRestriction, 'stark-dev/develop')).toThrow(
      'release publisher restriction must cover every configured write family',
    );

    const widenedPublisher = completeAuditInput();
    const releaseRestriction = mutableStatement(widenedPublisher, 0, 4);
    const condition = releaseRestriction['Condition'];
    if (typeof condition !== 'object' || condition === null) {
      throw new Error('expected publisher condition fixture');
    }
    Object.assign(condition, {
      ArnNotEquals: {
        'aws:PrincipalArn': 'arn:aws:iam::000000000000:role/unreviewed-publisher',
      },
    });
    expect(() => auditAuthorityBucketPolicies(widenedPublisher, 'stark-dev/develop')).toThrow(
      'release publisher restriction must admit only the configured publisher principals',
    );

    const wrongResource = completeAuditInput();
    mutableStatement(wrongResource, 1, 4)['Resource'] = 'arn:aws:s3:::unreviewed/*';
    expect(() => auditAuthorityBucketPolicies(wrongResource, 'stark-dev/develop')).toThrow(
      'app-retained publisher restriction must cover every configured write family',
    );

    const wrongOperator = completeAuditInput();
    const terraformRestriction = mutableStatement(wrongOperator, 2, 4);
    const terraformCondition = terraformRestriction['Condition'];
    if (typeof terraformCondition !== 'object' || terraformCondition === null) {
      throw new Error('expected publisher condition fixture');
    }
    const mutableCondition = terraformCondition as Record<string, unknown>;
    const arnNotEquals: unknown = mutableCondition['ArnNotEquals'];
    delete mutableCondition['ArnNotEquals'];
    Object.assign(terraformCondition, { StringNotEquals: arnNotEquals });
    expect(() => auditAuthorityBucketPolicies(wrongOperator, 'stark-dev/develop')).toThrow(
      'terraform publisher restriction must use the configured ARN condition operator',
    );
  });

  it('requires unconditional wildcard-principal denies for every retired release-record namespace', () => {
    const missing = completeAuditInput();
    const releaseSpecification = buildAuthorityBucketPolicyAuditSpecifications('stark-dev/develop')[0];
    if (releaseSpecification === undefined) throw new Error('missing release audit specification');
    mutableObservation(missing, 0).policy.Statement.splice(4 + releaseSpecification.publisherRestrictions.length, 1);
    expect(() => auditAuthorityBucketPolicies(missing, 'stark-dev/develop')).toThrow(
      'release retired authority write deny must cover exactly the configured retired resources',
    );

    const conditional = completeAuditInput();
    const statement = mutableStatement(conditional, 0, 4 + releaseSpecification.publisherRestrictions.length);
    statement['Condition'] = { ArnNotEquals: { 'aws:PrincipalArn': 'arn:aws:iam::000000000000:role/example' } };
    expect(() => auditAuthorityBucketPolicies(conditional, 'stark-dev/develop')).toThrow(
      'release retired authority write deny must be unconditional',
    );
  });

  it('rejects an unknown per-bucket audit kind', () => {
    const specification = buildAuthorityBucketPolicyAuditSpecifications('stark-dev/develop')[0];
    if (specification === undefined) {
      throw new Error('missing release audit fixture');
    }
    const observation = singleObservationFor(specification);

    expect(() => auditAuthorityBucketPolicyObservation('legacy-release', observation, 'stark-dev/develop')).toThrow(
      'authority bucket policy audit kind is invalid',
    );
  });
});

it('audits the production authority buckets without admitting a static-fast publisher', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const targets = await import('./index.js');
    const authority = await import('./authority-bucket-policy.js');
    const production = targets.resolveAllowedDeploymentTarget('stark-prod/main');
    const development = targets.resolveAllowedDeploymentTarget('stark-dev/develop');
    const app = targets.resolveDeploymentLaneAuthority(production, 'app');
    const staticFast = targets.resolveDeploymentLaneAuthority(development, 'static-fast');
    const specifications = authority.buildAuthorityBucketPolicyAuditSpecifications(production.targetKey);
    const observations = specifications.map(observationFor);
    expect(authority.auditAuthorityBucketPolicies({ observations }, production.targetKey).buckets).toHaveLength(3);
    for (const specification of specifications) {
      expect(
        authority.auditAuthorityBucketPolicyObservation(
          specification.kind,
          singleObservationFor(specification),
          production.targetKey,
        ).bucketName,
      ).toBe(specification.bucketName);
    }
    const retained = specifications.find((specification) => specification.kind === 'app-retained');
    if (retained === undefined) throw new Error('production retained authority fixture missing');
    const staticPublishers = retained.publisherRestrictions.find((restriction) =>
      restriction.objectArns.some((arn) => arn.endsWith(`/${app.names.staticFrontendArtifactPrefix}/*`)),
    );
    expect(staticPublishers?.publisherPrincipalArns).toEqual([
      `arn:${production.partition}:iam::${production.accountId}:role/${app.names.appStaticDeployRole}`,
    ]);
    for (const wrongTarget of [undefined, 'unreviewed/main', development.targetKey]) {
      expect(() => authority.auditAuthorityBucketPolicies({ observations }, wrongTarget)).toThrow();
      expect(() =>
        authority.auditAuthorityBucketPolicyObservation(retained.kind, singleObservationFor(retained), wrongTarget),
      ).toThrow();
    }
    expect(() => authority.buildAuthorityBucketPolicyAuditSpecifications(undefined)).toThrow();
    const widened = {
      ...retained,
      publisherRestrictions: retained.publisherRestrictions.map((restriction) =>
        restriction === staticPublishers
          ? {
              ...restriction,
              publisherPrincipalArns: [
                ...restriction.publisherPrincipalArns,
                `arn:${production.partition}:iam::${production.accountId}:role/${staticFast.names.appStaticFastDeployRole}`,
              ],
            }
          : restriction,
      ),
    };
    expect(() =>
      authority.auditAuthorityBucketPolicyObservation(
        retained.kind,
        singleObservationFor(widened),
        production.targetKey,
      ),
    ).toThrow();
    const devSpecifications = authority.buildAuthorityBucketPolicyAuditSpecifications(development.targetKey);
    for (let index = 0; index < observations.length; index += 1) {
      const other = devSpecifications[index];
      if (other === undefined) throw new Error('development authority fixture missing');
      const mixed = observations.map((observation, position) =>
        position === index ? observationFor(other) : observation,
      );
      expect(() => authority.auditAuthorityBucketPolicies({ observations: mixed }, production.targetKey)).toThrow();
    }
    const suspended = observations.map((observation) => ({ ...observation, versioningStatus: 'Suspended' }));
    expect(() => authority.auditAuthorityBucketPolicies({ observations: suspended }, production.targetKey)).toThrow();
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
