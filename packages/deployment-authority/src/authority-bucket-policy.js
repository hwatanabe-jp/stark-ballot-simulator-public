import { canonicalJson, deepFreeze, requireExactKeys, requireRecord, requireString } from './internal.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';

/**
 * @typedef {'release' | 'app-retained' | 'terraform'} AuthorityBucketKind
 */

/**
 * @typedef {{
 *   readonly kind: AuthorityBucketKind;
 *   readonly bucketName: string;
 *   readonly immutableObjectArns: readonly string[];
 *   readonly pointerObjectArns: readonly string[];
 *   readonly deletionProtectedObjectArns: readonly string[];
 *   readonly retiredWriteDeniedObjectArns: readonly string[];
 *   readonly publisherRestrictions: readonly {
 *     readonly objectArns: readonly string[];
 *     readonly conditionOperator: 'ArnNotEquals' | 'ArnNotLike';
 *     readonly publisherPrincipalArns: readonly string[];
 *   }[];
 * }} AuthorityBucketPolicyAuditSpecification
 */

/**
 * @param {string} partition
 * @param {string} accountId
 * @param {string} roleName
 * @returns {string}
 */
function roleArn(partition, accountId, roleName) {
  return `arn:${partition}:iam::${accountId}:role/${roleName}`;
}

/**
 * @param {readonly string[]} values
 * @returns {readonly string[]}
 */
function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

/**
 * @param {unknown} value
 * @returns {readonly string[]}
 */
function stringValues(value) {
  const values = Array.isArray(value) ? value : [value];
  if (values.some((entry) => typeof entry !== 'string')) {
    return [];
  }
  return /** @type {string[]} */ (values);
}

/**
 * @param {unknown} actual
 * @param {readonly string[]} expected
 * @returns {boolean}
 */
function hasExactStringValues(actual, expected) {
  const values = stringValues(actual);
  return (
    values.length === expected.length &&
    new Set(values).size === values.length &&
    expected.every((entry) => values.includes(entry))
  );
}

/**
 * @param {unknown} principal
 * @returns {boolean}
 */
function isExactWildcardPrincipal(principal) {
  if (principal === '*') {
    return true;
  }
  try {
    const record = requireExactKeys(principal, ['AWS'], 'authority bucket policy principal');
    return hasExactStringValues(record['AWS'], ['*']);
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @param {unknown} expected
 * @returns {boolean}
 */
function isExactCanonicalValue(value, expected) {
  try {
    return canonicalJson(value) === canonicalJson(expected);
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, unknown>} statement
 * @returns {boolean}
 */
function hasConditionalWriteHeader(statement) {
  try {
    const condition = canonicalJson(statement['Condition']);
    return condition.includes('"s3:if-none-match"') || condition.includes('"s3:if-match"');
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, unknown>} statement
 * @param {readonly string[]} expectedResources
 * @returns {boolean}
 */
function overlapsResources(statement, expectedResources) {
  return stringValues(statement['Resource']).some((resource) => expectedResources.includes(resource));
}

/**
 * @param {Record<string, unknown>} statement
 * @param {readonly string[]} expectedKeys
 * @returns {boolean}
 */
function hasExactStatementKeys(statement, expectedKeys) {
  try {
    requireExactKeys(statement, expectedKeys, 'authority bucket policy statement');
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, unknown>} statement
 * @returns {boolean}
 */
function hasPrincipalArnCondition(statement) {
  try {
    const condition = requireRecord(statement['Condition'], 'authority bucket policy condition');
    return Object.values(condition).some((value) =>
      Object.hasOwn(requireRecord(value, 'authority bucket policy condition operator'), 'aws:PrincipalArn'),
    );
  } catch {
    return false;
  }
}

/**
 * @param {readonly Record<string, unknown>[]} statements
 * @param {AuthorityBucketPolicyAuditSpecification} specification
 */
function requireDeletionDeny(statements, specification) {
  const label = `${specification.kind} deletion deny`;
  const overlappingDeleteDenies = statements.filter(
    (statement) =>
      statement['Effect'] === 'Deny' &&
      stringValues(statement['Action']).some(
        (action) => action === 's3:DeleteObject' || action === 's3:DeleteObjectVersion',
      ) &&
      overlapsResources(statement, specification.deletionProtectedObjectArns),
  );
  const wildcardDenies = overlappingDeleteDenies.filter((statement) =>
    isExactWildcardPrincipal(statement['Principal']),
  );
  const unconditionalWildcardDenies = wildcardDenies.filter((statement) => !Object.hasOwn(statement, 'Condition'));
  const exactActionDenies = unconditionalWildcardDenies.filter((statement) =>
    hasExactStringValues(statement['Action'], ['s3:DeleteObject', 's3:DeleteObjectVersion']),
  );
  const proofStatements = exactActionDenies.filter((statement) => {
    const resources = stringValues(statement['Resource']);
    return (
      hasExactStatementKeys(statement, ['Sid', 'Effect', 'Principal', 'Action', 'Resource']) &&
      isNonemptyResourceSubset(resources, specification.deletionProtectedObjectArns)
    );
  });
  const coveredResources = uniqueSorted(proofStatements.flatMap((statement) => stringValues(statement['Resource'])));
  if (hasExactStringValues(coveredResources, specification.deletionProtectedObjectArns)) {
    return;
  }
  assertDeletionDenyCoverageShape(
    { overlappingDeleteDenies, wildcardDenies, unconditionalWildcardDenies, exactActionDenies },
    label,
  );
  for (const candidate of exactActionDenies) {
    const resources = stringValues(candidate['Resource']);
    if (isNonemptyResourceSubset(resources, specification.deletionProtectedObjectArns)) {
      requireExactKeys(candidate, ['Sid', 'Effect', 'Principal', 'Action', 'Resource'], label);
    }
  }
  throw new Error(`${label} must cover exactly the configured protected resources`);
}

const IMMUTABLE_CREATE_ONLY_CONDITION = deepFreeze({
  StringNotEquals: { 's3:if-none-match': '*' },
});
const POINTER_CONDITIONAL_CONDITION = deepFreeze({
  StringNotEquals: { 's3:if-none-match': '*' },
  Null: { 's3:if-match': 'true' },
});
const POINTER_AMBIGUOUS_CONDITION = deepFreeze({
  Null: { 's3:if-none-match': 'false', 's3:if-match': 'false' },
});

/**
 * @param {Record<string, unknown>} statement
 * @param {string} label
 */
function requireConditionalPutDenyShape(statement, label) {
  requireExactKeys(statement, ['Sid', 'Effect', 'Principal', 'Action', 'Resource', 'Condition'], label);
  if (!isExactWildcardPrincipal(statement['Principal'])) {
    throw new Error(`${label} must apply to exact Principal *`);
  }
  if (!hasExactStringValues(statement['Action'], ['s3:PutObject'])) {
    throw new Error(`${label} must use exact s3:PutObject`);
  }
}

/**
 * @param {readonly Record<string, unknown>[]} statements
 * @param {AuthorityBucketPolicyAuditSpecification} specification
 */
function requireImmutableCreateOnlyDeny(statements, specification) {
  const label = `${specification.kind} immutable create-only deny`;
  const candidates = statements.filter(
    (statement) =>
      statement['Effect'] === 'Deny' &&
      hasExactStringValues(statement['Action'], ['s3:PutObject']) &&
      hasConditionalWriteHeader(statement) &&
      overlapsResources(statement, specification.immutableObjectArns),
  );
  for (const candidate of candidates) {
    requireConditionalPutDenyShape(candidate, label);
  }
  const matching = candidates.filter((candidate) =>
    isExactCanonicalValue(candidate['Condition'], IMMUTABLE_CREATE_ONLY_CONDITION),
  );
  if (matching.length === 0) {
    throw new Error(`${label} must require exact If-None-Match *`);
  }
  const coveredResources = matching.flatMap((statement) => stringValues(statement['Resource']));
  if (!hasExactStringValues(coveredResources, specification.immutableObjectArns)) {
    throw new Error(`${label} must cover exactly the configured immutable resources`);
  }
}

/**
 * @param {readonly Record<string, unknown>[]} statements
 * @param {AuthorityBucketPolicyAuditSpecification} specification
 */
function requirePointerDenies(statements, specification) {
  const candidates = statements.filter(
    (statement) =>
      statement['Effect'] === 'Deny' &&
      hasExactStringValues(statement['Action'], ['s3:PutObject']) &&
      hasConditionalWriteHeader(statement) &&
      overlapsResources(statement, specification.pointerObjectArns),
  );
  for (const candidate of candidates) {
    requireConditionalPutDenyShape(candidate, `${specification.kind} governed pointer deny`);
  }

  const conditional = candidates.filter((candidate) =>
    isExactCanonicalValue(candidate['Condition'], POINTER_CONDITIONAL_CONDITION),
  );
  const ambiguous = candidates.filter((candidate) =>
    isExactCanonicalValue(candidate['Condition'], POINTER_AMBIGUOUS_CONDITION),
  );
  const other = candidates.filter((candidate) => !conditional.includes(candidate) && !ambiguous.includes(candidate));
  if (conditional.length === 0) {
    throw new Error(`${specification.kind} pointer conditional deny must require exact If-None-Match * or If-Match`);
  }
  const conditionalResources = conditional.flatMap((statement) => stringValues(statement['Resource']));
  if (!hasExactStringValues(conditionalResources, specification.pointerObjectArns)) {
    throw new Error(
      `${specification.kind} pointer conditional deny must cover exactly the configured pointer resources`,
    );
  }
  if (ambiguous.length === 0) {
    throw new Error(
      other.length > 0
        ? `${specification.kind} ambiguous pointer deny must reject both If-None-Match and If-Match`
        : `${specification.kind} ambiguous pointer deny must cover exactly the configured pointer resources`,
    );
  }
  const ambiguousResources = ambiguous.flatMap((statement) => stringValues(statement['Resource']));
  if (!hasExactStringValues(ambiguousResources, specification.pointerObjectArns)) {
    throw new Error(`${specification.kind} ambiguous pointer deny must cover exactly the configured pointer resources`);
  }
}

/**
 * @param {readonly Record<string, unknown>[]} statements
 * @param {AuthorityBucketPolicyAuditSpecification} specification
 */
function requirePublisherRestrictions(statements, specification) {
  const label = `${specification.kind} publisher restriction`;
  for (const restriction of specification.publisherRestrictions) {
    const resourceMatches = statements.filter(
      (statement) =>
        statement['Effect'] === 'Deny' &&
        hasExactStringValues(statement['Action'], ['s3:PutObject']) &&
        hasExactStringValues(statement['Resource'], restriction.objectArns) &&
        hasPrincipalArnCondition(statement),
    );
    if (resourceMatches.length !== 1) {
      throw new Error(`${label} must cover every configured write family`);
    }
    const statement = resourceMatches[0];
    if (statement === undefined) {
      throw new Error(`${label} must cover every configured write family`);
    }
    requireExactKeys(statement, ['Sid', 'Effect', 'Principal', 'Action', 'Resource', 'Condition'], label);
    if (!isExactWildcardPrincipal(statement['Principal'])) {
      throw new Error(`${label} must apply to exact Principal *`);
    }
    assertPublisherPrincipals(statement, restriction, label);
  }
}

/**
 * @param {readonly Record<string, unknown>[]} statements
 * @param {AuthorityBucketPolicyAuditSpecification} specification
 */
function requireRetiredWriteDeny(statements, specification) {
  if (specification.retiredWriteDeniedObjectArns.length === 0) {
    return;
  }
  const label = `${specification.kind} retired authority write deny`;
  if (hasClosedWriteNamespace(statements, specification, label)) return;

  const candidates = statements.filter(
    (statement) =>
      statement['Effect'] === 'Deny' &&
      hasExactStringValues(statement['Action'], ['s3:PutObject']) &&
      overlapsResources(statement, specification.retiredWriteDeniedObjectArns),
  );
  /** @type {string[]} */
  const coveredResources = [];
  for (const candidate of candidates) {
    if (Object.hasOwn(candidate, 'Condition')) {
      // A retained create-only deny may overlap a retired namespace. Only
      // unconditional denies can establish that namespace's write prohibition.
      continue;
    }
    requireExactKeys(candidate, ['Sid', 'Effect', 'Principal', 'Action', 'Resource'], label);
    if (!isExactWildcardPrincipal(candidate['Principal'])) {
      throw new Error(`${label} must apply to exact Principal *`);
    }
    const resources = stringValues(candidate['Resource']);
    if (!isNonemptyResourceSubset(resources, specification.retiredWriteDeniedObjectArns)) {
      throw new Error(`${label} must cover exactly the configured retired resources`);
    }
    coveredResources.push(...resources);
  }
  if (!hasExactStringValues(coveredResources, specification.retiredWriteDeniedObjectArns)) {
    if (candidates.some((candidate) => Object.hasOwn(candidate, 'Condition'))) {
      throw new Error(`${label} must be unconditional`);
    }
    throw new Error(`${label} must cover exactly the configured retired resources`);
  }
}

/**
 * @param {unknown} policy
 * @param {AuthorityBucketPolicyAuditSpecification} specification
 */
function requireBucketPolicy(policy, specification) {
  const record = requireExactKeys(policy, ['Version', 'Statement'], `${specification.kind} authority bucket policy`);
  if (record['Version'] !== '2012-10-17') {
    throw new Error(`${specification.kind} authority bucket policy Version must be 2012-10-17`);
  }
  if (!Array.isArray(record['Statement'])) {
    throw new Error(`${specification.kind} authority bucket policy Statement must be an array`);
  }
  const statements = record['Statement'].map((statement, index) =>
    requireRecord(statement, `${specification.kind} authority bucket policy Statement ${index}`),
  );
  requireDeletionDeny(statements, specification);
  requireImmutableCreateOnlyDeny(statements, specification);
  requirePointerDenies(statements, specification);
  requirePublisherRestrictions(statements, specification);
  requireRetiredWriteDeny(statements, specification);
}

/**
 * Build the closed audit inventory for the independently selected deployment target.
 * AWS collection and IAM simulation remain the responsibility of a thin caller.
 *
 * @param {unknown} expectedTargetKey
 * @returns {readonly AuthorityBucketPolicyAuditSpecification[]}
 */
export function buildAuthorityBucketPolicyAuditSpecifications(expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Authority bucket policy expected target'),
  );
  const foundation = resolveDeploymentLaneAuthority(target, 'foundation');
  const app = resolveDeploymentLaneAuthority(target, 'app');
  const names = foundation.names;
  const releaseBucketArn = `arn:${target.partition}:s3:::${names.releaseManifestBucket}`;
  const appBucketArn = `arn:${target.partition}:s3:::${names.appRetainedArtifactBucket}`;
  const terraformBucketArn = `arn:${target.partition}:s3:::${names.terraformAuthorityBucket}`;
  /** @param {readonly string[]} objectArns @param {readonly string[]} roles */
  const publishers = (objectArns, roles) => ({
    objectArns,
    conditionOperator: /** @type {const} */ ('ArnNotEquals'),
    publisherPrincipalArns: uniqueSorted(roles.map((name) => roleArn(target.partition, target.accountId, name))),
  });
  const admin = `aws-reserved/sso.amazonaws.com/${target.region}/AWSReservedSSO_AdministratorAccess_????????????????`;
  /** @param {'bootstrap'|'foundation'|'app'} root */
  const prefix = (root) =>
    `${root === 'app' ? appBucketArn : terraformBucketArn}/deployment/${target.targetKey}/${root}`;
  /** @param {'bootstrap'|'foundation'|'app'} root */
  const immutable = (root) => ['plan-packages', 'actions', 'approvals'].map((name) => `${prefix(root)}/${name}/*`);
  /** @param {'bootstrap'|'foundation'|'app'} root */
  const rootPublishers = (root) => {
    const laneNames = root === 'app' ? app.names : foundation.names;
    const plan = root === 'bootstrap' ? admin : laneNames.terraformPlanRole;
    const apply = root === 'bootstrap' ? admin : laneNames.terraformApplyRole;
    const smoke = root === 'bootstrap' ? admin : laneNames.terraformSmokeRole;
    const actions =
      root === 'bootstrap'
        ? [['Local/Apply', admin]]
        : root === 'foundation'
          ? [
              ['DeployFoundation/ApplyReviewedFoundationPlan', apply],
              ['DeployFoundation/FoundationStateAbsenceOfAppRuntime', smoke],
            ]
          : [
              ['DeployApplication/ApplyReviewedAppPlan', apply],
              ['DeployApplication/DeployStaticFrontend', app.names.appStaticDeployRole],
              ['DeployApplication/TargetRuntimeSmoke', smoke],
              ['DeployApplication/PublishCurrentStatus', app.names.appDeploymentStatusPublisherRole],
            ];
    return [
      publishers([`${prefix(root)}/plan-packages/*`], [plan]),
      publishers([`${prefix(root)}/checkpoint.json`], [smoke]),
      publishers([`${prefix(root)}/mutation-owner.json`], [apply]),
      ...actions.map(([action, writer]) =>
        publishers([`${prefix(root)}/actions/*/${action}.json`], [requireString(writer, 'Action writer')]),
      ),
      ...(root === 'bootstrap' ? [publishers([`${prefix(root)}/approvals/*`], [admin])] : []),
    ];
  };
  const appArtifacts = [
    names.lambdaArtifactPrefix,
    names.staticFrontendArtifactPrefix,
    names.signaturePreflightPrefix,
  ].map((name) => `${appBucketArn}/${name}/*`);
  const oldApp = [names.acceptedDeploymentPrefix, names.approvalEvidencePrefix, names.recoveryManifestPrefix].map(
    (name) => `${appBucketArn}/${name}/*`,
  );
  const status = `${appBucketArn}/${names.appDeploymentStatusKey}`;
  const oldTerraform = [
    `${terraformBucketArn}/${names.terraformBaselinePrefix}/*`,
    `${terraformBucketArn}/${names.approvalEvidencePrefix}/*`,
  ];
  const oldRelease = [
    `${releaseBucketArn}/deployments/*`,
    `${releaseBucketArn}/rollbacks/*`,
    `${releaseBucketArn}/reissue/*`,
    `${releaseBucketArn}/candidates/*`,
    `${releaseBucketArn}/${names.toolchainAcceptedPointerKey}`,
    `${releaseBucketArn}/${names.proverAcceptedPointerKey}`,
    `${releaseBucketArn}/${names.foundationSigningAuthorityPrefix}/*`,
    `${releaseBucketArn}/${names.foundationAppNetworkingKey}`,
  ];
  return deepFreeze([
    {
      kind: 'release',
      bucketName: names.releaseManifestBucket,
      immutableObjectArns: ['toolchain', 'prover'].map((kind) => `${releaseBucketArn}/artifacts/${kind}/candidates/*`),
      pointerObjectArns: ['toolchain', 'prover'].map((kind) => `${releaseBucketArn}/promotions/${kind}/current.json`),
      deletionProtectedObjectArns: [`${releaseBucketArn}/*`],
      retiredWriteDeniedObjectArns: [
        ...oldRelease,
        `${releaseBucketArn}/artifacts/toolchain/releases/*`,
        `${releaseBucketArn}/artifacts/prover/releases/*`,
        `${releaseBucketArn}/artifacts/toolchain/*/manifest.json`,
        `${releaseBucketArn}/artifacts/prover/*/manifest.json`,
      ],
      publisherRestrictions: [
        publishers([`${releaseBucketArn}/artifacts/toolchain/candidates/*`], [names.toolchainCandidateRole]),
        publishers([`${releaseBucketArn}/artifacts/prover/candidates/*`], [names.proverCandidateRole]),
        publishers([`${releaseBucketArn}/promotions/toolchain/current.json`], [names.toolchainPointerRole]),
        publishers([`${releaseBucketArn}/promotions/prover/current.json`], [names.proverPointerRole]),
      ],
    },
    {
      kind: 'app-retained',
      bucketName: names.appRetainedArtifactBucket,
      immutableObjectArns: [...immutable('app'), ...appArtifacts],
      pointerObjectArns: [`${prefix('app')}/*`, status],
      deletionProtectedObjectArns: [`${prefix('app')}/*`, ...appArtifacts, ...oldApp, status],
      retiredWriteDeniedObjectArns: oldApp,
      publisherRestrictions: [
        ...rootPublishers('app'),
        publishers([appArtifacts[0] ?? ''], [app.names.terraformPlanRole]),
        publishers([appArtifacts[1] ?? ''], [app.names.terraformPlanRole]),
        publishers([appArtifacts[2] ?? ''], [app.names.terraformPlanRole]),
        publishers([status], [app.names.appDeploymentStatusPublisherRole]),
      ],
    },
    {
      kind: 'terraform',
      bucketName: names.terraformAuthorityBucket,
      immutableObjectArns: [...immutable('bootstrap'), ...immutable('foundation')],
      pointerObjectArns: [`${prefix('bootstrap')}/*`, `${prefix('foundation')}/*`],
      deletionProtectedObjectArns: [`${prefix('bootstrap')}/*`, `${prefix('foundation')}/*`, ...oldTerraform],
      retiredWriteDeniedObjectArns: oldTerraform,
      publisherRestrictions: [...rootPublishers('bootstrap'), ...rootPublishers('foundation')],
    },
  ]);
}

/**
 * Validate one authority bucket observation for its owning smoke path. The
 * unconditional wildcard-principal denies and exact publisher restrictions
 * prove protection without per-role IAM simulation.
 *
 * @param {unknown} kind
 * @param {unknown} input
 * @param {unknown} expectedTargetKey
 * @returns {{
 *   readonly kind: AuthorityBucketKind;
 *   readonly bucketName: string;
 *   readonly publisherRestrictionCount: number;
 *   readonly versioningStatus: 'Enabled';
 * }}
 */
export function auditAuthorityBucketPolicyObservation(kind, input, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Authority bucket policy expected target'),
  );
  if (typeof kind !== 'string' || !['release', 'app-retained', 'terraform'].includes(kind)) {
    throw new Error('authority bucket policy audit kind is invalid');
  }
  const specification = buildAuthorityBucketPolicyAuditSpecifications(target.targetKey).find(
    (candidate) => candidate.kind === kind,
  );
  if (specification === undefined) {
    throw new Error('authority bucket policy audit kind is invalid');
  }
  const observation = requireExactKeys(
    input,
    ['bucketName', 'versioningStatus', 'policy'],
    `${specification.kind} authority bucket observation`,
  );
  if (observation['bucketName'] !== specification.bucketName) {
    throw new Error(`${specification.kind} authority bucket observation does not match its configured bucket`);
  }
  const versioningStatus = requireString(
    observation['versioningStatus'],
    `${specification.kind} authority bucket versioning status`,
  );
  if (versioningStatus !== 'Enabled') {
    throw new Error(`${specification.kind} authority bucket versioning must be Enabled`);
  }
  requireBucketPolicy(observation['policy'], specification);
  return deepFreeze({
    kind: specification.kind,
    bucketName: specification.bucketName,
    publisherRestrictionCount: specification.publisherRestrictions.length,
    versioningStatus: /** @type {const} */ ('Enabled'),
  });
}

/**
 * Validate already-collected authority bucket policy observations.
 *
 * @param {unknown} input
 * @param {unknown} expectedTargetKey
 * @returns {{
 *   readonly auditType: 'authority-bucket-policy';
 *   readonly buckets: readonly {
 *     readonly kind: AuthorityBucketKind;
 *     readonly bucketName: string;
 *     readonly publisherRestrictionCount: number;
 *     readonly versioningStatus: 'Enabled';
 *   }[];
 * }}
 */
export function auditAuthorityBucketPolicies(input, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Authority bucket policy expected target'),
  );
  const record = requireExactKeys(input, ['observations'], 'authority bucket policy audit input');
  if (!Array.isArray(record['observations'])) {
    throw new Error('authority bucket policy audit observations must be an array');
  }
  const observations = record['observations'];
  const specifications = buildAuthorityBucketPolicyAuditSpecifications(target.targetKey);
  if (observations.length !== specifications.length) {
    throw new Error('authority bucket policy audit must contain exactly the configured buckets');
  }
  const summaries = specifications.map((specification, index) => {
    const observation = requireExactKeys(
      observations[index],
      ['kind', 'bucketName', 'versioningStatus', 'policy'],
      `${specification.kind} authority bucket observation`,
    );
    if (observation['kind'] !== specification.kind || observation['bucketName'] !== specification.bucketName) {
      throw new Error(`${specification.kind} authority bucket observation does not match its configured bucket`);
    }
    return auditAuthorityBucketPolicyObservation(
      specification.kind,
      {
        bucketName: observation['bucketName'],
        versioningStatus: observation['versioningStatus'],
        policy: observation['policy'],
      },
      target.targetKey,
    );
  });
  return deepFreeze({ auditType: /** @type {const} */ ('authority-bucket-policy'), buckets: summaries });
}

/** @param {Record<string, unknown>} statement @param {AuthorityBucketPolicyAuditSpecification['publisherRestrictions'][number]} restriction @param {string} label */
function assertPublisherPrincipals(statement, restriction, label) {
  let condition;
  try {
    condition = requireExactKeys(statement['Condition'], [restriction.conditionOperator], `${label} condition`);
  } catch {
    throw new Error(`${label} must use the configured ARN condition operator`);
  }
  const principalCondition = requireExactKeys(
    condition[restriction.conditionOperator],
    ['aws:PrincipalArn'],
    `${label} principal condition`,
  );
  const expected = restriction.publisherPrincipalArns;
  const exactAdministrator = isExactAdministratorPrincipal(principalCondition['aws:PrincipalArn'], expected);
  if (
    !exactAdministrator &&
    (expected.some((arn) => arn.includes('?')) ||
      !hasExactStringValues(principalCondition['aws:PrincipalArn'], expected))
  ) {
    throw new Error(`${label} must admit only the configured publisher principals`);
  }
}
/** @param {unknown} value @param {readonly string[]} expected */
function isExactAdministratorPrincipal(value, expected) {
  const actualPrincipals = stringValues(value);
  return (
    expected.length === 1 &&
    expected[0]?.endsWith('_????????????????') &&
    actualPrincipals.length === 1 &&
    actualPrincipals[0]?.startsWith(expected[0].slice(0, -16)) &&
    /^[0-9a-f]{16}$/u.test(actualPrincipals[0].slice(-16))
  );
}

/** @param {readonly Record<string, unknown>[]} statements @param {AuthorityBucketPolicyAuditSpecification} specification @param {string} label */
function hasClosedWriteNamespace(statements, specification, label) {
  const closedNamespace = statements.filter(
    (statement) =>
      statement['Effect'] === 'Deny' &&
      hasExactStringValues(statement['Action'], ['s3:PutObject']) &&
      Object.hasOwn(statement, 'NotResource'),
  );
  if (closedNamespace.length === 1) {
    const statement = closedNamespace[0];
    if (
      statement &&
      hasExactStatementKeys(statement, ['Sid', 'Effect', 'Principal', 'Action', 'NotResource']) &&
      isExactWildcardPrincipal(statement['Principal']) &&
      hasExactStringValues(statement['NotResource'], [
        ...specification.immutableObjectArns,
        ...specification.pointerObjectArns,
      ])
    )
      return true;
    throw new Error(`${label} must exclude exactly the current immutable/current namespaces.`);
  }

  return false;
}

/** @param {readonly string[]} resources @param {readonly string[]} allowed */
function isNonemptyResourceSubset(resources, allowed) {
  return (
    resources.length > 0 &&
    new Set(resources).size === resources.length &&
    resources.every((resource) => allowed.includes(resource))
  );
}

/** @param {{overlappingDeleteDenies: readonly unknown[],wildcardDenies: readonly unknown[],unconditionalWildcardDenies: readonly unknown[],exactActionDenies: readonly unknown[]}} candidates @param {string} label */
function assertDeletionDenyCoverageShape(candidates, label) {
  const { overlappingDeleteDenies, wildcardDenies, unconditionalWildcardDenies, exactActionDenies } = candidates;
  if (wildcardDenies.length === 0 && overlappingDeleteDenies.length > 0) {
    throw new Error(`${label} must apply to exact Principal *`);
  }
  if (unconditionalWildcardDenies.length === 0 && wildcardDenies.length > 0) {
    throw new Error(`${label} must be unconditional`);
  }
  if (exactActionDenies.length === 0 && unconditionalWildcardDenies.length > 0) {
    throw new Error(`${label} must cover exactly s3:DeleteObject and s3:DeleteObjectVersion`);
  }
}
