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
      resources.length > 0 &&
      new Set(resources).size === resources.length &&
      resources.every((resource) => specification.deletionProtectedObjectArns.includes(resource))
    );
  });
  const coveredResources = uniqueSorted(proofStatements.flatMap((statement) => stringValues(statement['Resource'])));
  if (hasExactStringValues(coveredResources, specification.deletionProtectedObjectArns)) {
    return;
  }
  if (wildcardDenies.length === 0 && overlappingDeleteDenies.length > 0) {
    throw new Error(`${label} must apply to exact Principal *`);
  }
  if (unconditionalWildcardDenies.length === 0 && wildcardDenies.length > 0) {
    throw new Error(`${label} must be unconditional`);
  }
  if (exactActionDenies.length === 0 && unconditionalWildcardDenies.length > 0) {
    throw new Error(`${label} must cover exactly s3:DeleteObject and s3:DeleteObjectVersion`);
  }
  for (const candidate of exactActionDenies) {
    const resources = stringValues(candidate['Resource']);
    if (
      resources.length > 0 &&
      new Set(resources).size === resources.length &&
      resources.every((resource) => specification.deletionProtectedObjectArns.includes(resource))
    ) {
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
    if (!hasExactStringValues(principalCondition['aws:PrincipalArn'], restriction.publisherPrincipalArns)) {
      throw new Error(`${label} must admit only the configured publisher principals`);
    }
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
      throw new Error(`${label} must be unconditional`);
    }
    requireExactKeys(candidate, ['Sid', 'Effect', 'Principal', 'Action', 'Resource'], label);
    if (!isExactWildcardPrincipal(candidate['Principal'])) {
      throw new Error(`${label} must apply to exact Principal *`);
    }
    const resources = stringValues(candidate['Resource']);
    if (
      resources.length === 0 ||
      new Set(resources).size !== resources.length ||
      resources.some((resource) => !specification.retiredWriteDeniedObjectArns.includes(resource))
    ) {
      throw new Error(`${label} must cover exactly the configured retired resources`);
    }
    coveredResources.push(...resources);
  }
  if (!hasExactStringValues(coveredResources, specification.retiredWriteDeniedObjectArns)) {
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
  const bootstrap = resolveDeploymentLaneAuthority(target, 'bootstrap');
  const foundation = resolveDeploymentLaneAuthority(target, 'foundation');
  const app = resolveDeploymentLaneAuthority(target, 'app');
  const staticFast = target.environmentId === 'develop' ? resolveDeploymentLaneAuthority(target, 'static-fast') : null;
  const names = foundation.names;
  /** @param {string} name */
  const arnForRole = (name) => roleArn(target.partition, target.accountId, name);
  const releaseBucketArn = `arn:${target.partition}:s3:::${names.releaseManifestBucket}`;
  const appRetainedBucketArn = `arn:${target.partition}:s3:::${names.appRetainedArtifactBucket}`;
  const terraformBucketArn = `arn:${target.partition}:s3:::${names.terraformAuthorityBucket}`;
  const releaseImmutableObjectArns = ['artifacts', 'candidates', 'promotions'].map(
    (prefix) => `${releaseBucketArn}/${prefix}/*`,
  );
  const retiredDeploymentObjectArns = [`${releaseBucketArn}/deployments/*`, `${releaseBucketArn}/rollbacks/*`];
  const releasePointerObjectArns = [names.toolchainAcceptedPointerKey, names.proverAcceptedPointerKey].map(
    (key) => `${releaseBucketArn}/${key}`,
  );
  const retiredFoundationSigningObjectArn = `${releaseBucketArn}/${names.foundationSigningAuthorityPrefix}/*`;
  const retiredFoundationNetworkingObjectArn = `${releaseBucketArn}/${names.foundationAppNetworkingKey}`;
  const appImmutableObjectArns = [
    `${appRetainedBucketArn}/${names.acceptedDeploymentPrefix}/*/*`,
    `${appRetainedBucketArn}/${names.lambdaArtifactPrefix}/*`,
    `${appRetainedBucketArn}/${names.staticFrontendArtifactPrefix}/*`,
    `${appRetainedBucketArn}/${names.approvalEvidencePrefix}/*`,
    `${appRetainedBucketArn}/${names.recoveryManifestPrefix}/*`,
    `${appRetainedBucketArn}/${names.signaturePreflightPrefix}/*`,
  ];
  const appStatusObjectArn = `${appRetainedBucketArn}/${names.appDeploymentStatusKey}`;
  const appPointerObjectArns = [`${appRetainedBucketArn}/${names.acceptedDeploymentPointerKey}`, appStatusObjectArn];
  const terraformBootstrapHistoryObjectArn = `${terraformBucketArn}/${names.terraformBaselinePrefix}/${bootstrap.stateIdentity}/executions/*`;
  const terraformBootstrapAcceptanceObjectArn = `${terraformBucketArn}/${names.terraformBaselinePrefix}/${bootstrap.stateIdentity}/acceptances/*`;
  const terraformFoundationHistoryObjectArn = `${terraformBucketArn}/${names.terraformBaselinePrefix}/${foundation.stateIdentity}/executions/*`;
  const terraformFoundationAcceptanceObjectArn = `${terraformBucketArn}/${names.terraformBaselinePrefix}/${foundation.stateIdentity}/acceptances/*`;
  const terraformAppBaselineHistoryObjectArn = `${terraformBucketArn}/${names.terraformBaselinePrefix}/${app.stateIdentity}/executions/*`;
  const terraformBootstrapPointerObjectArn = `${terraformBucketArn}/${names.terraformBaselinePrefix}/${bootstrap.stateIdentity}/current.json`;
  const terraformFoundationPointerObjectArn = `${terraformBucketArn}/${names.terraformBaselinePrefix}/${foundation.stateIdentity}/current.json`;
  const terraformImmutableObjectArns = [terraformBootstrapAcceptanceObjectArn, terraformFoundationAcceptanceObjectArn];
  const terraformPointerObjectArns = [terraformBootstrapPointerObjectArn, terraformFoundationPointerObjectArn];
  const operatorPrincipalArnPattern =
    `arn:${target.partition}:iam::${target.accountId}:role/aws-reserved/sso.amazonaws.com/${target.region}/` +
    `AWSReservedSSO_${target.operatorPermissionSetName}_*`;
  /**
   * @param {readonly string[]} objectArns
   * @param {readonly string[]} publisherRoleNames
   */
  const exactPublishers = (objectArns, publisherRoleNames) => ({
    objectArns,
    conditionOperator: /** @type {const} */ ('ArnNotEquals'),
    publisherPrincipalArns: uniqueSorted(publisherRoleNames.map(arnForRole)),
  });
  /** @param {readonly string[]} objectArns */
  const operatorPublisher = (objectArns) => ({
    objectArns,
    conditionOperator: /** @type {const} */ ('ArnNotLike'),
    publisherPrincipalArns: [operatorPrincipalArnPattern],
  });

  return deepFreeze([
    {
      kind: 'release',
      bucketName: names.releaseManifestBucket,
      immutableObjectArns: releaseImmutableObjectArns,
      pointerObjectArns: releasePointerObjectArns,
      deletionProtectedObjectArns: [
        ...releaseImmutableObjectArns,
        ...retiredDeploymentObjectArns,
        `${releaseBucketArn}/reissue/*`,
        retiredFoundationNetworkingObjectArn,
        ...releasePointerObjectArns,
      ],
      retiredWriteDeniedObjectArns: [
        `${releaseBucketArn}/${names.proverReleasePrefix}/*/manifest.json`,
        `${releaseBucketArn}/${names.toolchainArtifactPrefix}/*/manifest.json`,
        ...retiredDeploymentObjectArns,
        retiredFoundationSigningObjectArn,
        retiredFoundationNetworkingObjectArn,
      ],
      publisherRestrictions: [
        exactPublishers(
          [`${releaseBucketArn}/${names.toolchainArtifactPrefix}/candidates/*`],
          [names.toolchainCandidateRole],
        ),
        exactPublishers(
          [`${releaseBucketArn}/${names.toolchainArtifactPrefix}/releases/*`],
          [names.toolchainPointerRole],
        ),
        exactPublishers([`${releaseBucketArn}/${names.proverReleasePrefix}/candidates/*`], [names.proverCandidateRole]),
        exactPublishers([`${releaseBucketArn}/${names.proverReleasePrefix}/releases/*`], [names.proverPointerRole]),
        exactPublishers(
          [`${releaseBucketArn}/candidates/*`],
          [names.toolchainCandidateRole, names.proverCandidateRole],
        ),
        exactPublishers([`${releaseBucketArn}/promotions/*`], [names.toolchainPointerRole, names.proverPointerRole]),
        exactPublishers([`${releaseBucketArn}/${names.toolchainAcceptedPointerKey}`], [names.toolchainPointerRole]),
        exactPublishers([`${releaseBucketArn}/${names.proverAcceptedPointerKey}`], [names.proverPointerRole]),
      ],
    },
    {
      kind: 'app-retained',
      bucketName: names.appRetainedArtifactBucket,
      immutableObjectArns: appImmutableObjectArns,
      pointerObjectArns: appPointerObjectArns,
      deletionProtectedObjectArns: [
        `${appRetainedBucketArn}/${names.acceptedDeploymentPrefix}/*`,
        ...appImmutableObjectArns.slice(1),
        appStatusObjectArn,
      ],
      retiredWriteDeniedObjectArns: [],
      publisherRestrictions: [
        exactPublishers(
          [`${appRetainedBucketArn}/${names.acceptedDeploymentPrefix}/*`],
          [names.appAcceptancePublisherRole],
        ),
        exactPublishers(
          [`${appRetainedBucketArn}/${names.lambdaArtifactPrefix}/*`],
          [app.names.terraformPlanRole, names.appSignaturePreflightPlanRole],
        ),
        exactPublishers(
          [`${appRetainedBucketArn}/${names.staticFrontendArtifactPrefix}/*`],
          [names.appStaticDeployRole, ...(staticFast === null ? [] : [staticFast.names.appStaticFastDeployRole])],
        ),
        exactPublishers([`${appRetainedBucketArn}/${names.approvalEvidencePrefix}/*`], [app.names.terraformApplyRole]),
        operatorPublisher([`${appRetainedBucketArn}/${names.recoveryManifestPrefix}/*`]),
        exactPublishers(
          [`${appRetainedBucketArn}/${names.signaturePreflightPrefix}/*`],
          [names.appSignaturePreflightInvokerRole],
        ),
        exactPublishers([appStatusObjectArn], [names.appDeploymentStatusPublisherRole]),
      ],
    },
    {
      kind: 'terraform',
      bucketName: names.terraformAuthorityBucket,
      immutableObjectArns: terraformImmutableObjectArns,
      pointerObjectArns: terraformPointerObjectArns,
      deletionProtectedObjectArns: [
        ...terraformImmutableObjectArns,
        terraformBootstrapHistoryObjectArn,
        terraformFoundationHistoryObjectArn,
        terraformAppBaselineHistoryObjectArn,
        ...terraformPointerObjectArns,
      ],
      retiredWriteDeniedObjectArns: [
        terraformBootstrapHistoryObjectArn,
        terraformFoundationHistoryObjectArn,
        terraformAppBaselineHistoryObjectArn,
      ],
      publisherRestrictions: [
        exactPublishers(
          [terraformBootstrapAcceptanceObjectArn, terraformBootstrapPointerObjectArn],
          [names.bootstrapTerraformAcceptancePublisherRole],
        ),
        exactPublishers(
          [terraformFoundationAcceptanceObjectArn, terraformFoundationPointerObjectArn],
          [names.foundationTerraformAcceptancePublisherRole],
        ),
      ],
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
