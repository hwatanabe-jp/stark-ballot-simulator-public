import {
  isPlainRecord,
  parseFullSourceSha,
  parseSha256,
  requireExactKeys,
  requireGroupedLowercaseUuid,
  requireString,
} from './internal.js';
import { assertProxyFreePortData } from './conditional-object-ledger.js';
import { snapshotDataTree, snapshotExactRecord } from './descriptor-snapshot.js';
import { admitFoundationSourceContract } from './foundation-contract.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import { FOUNDATION_ACCEPTANCE_KIND, admitTerraformAcceptanceRecordKey } from './terraform-acceptance.js';

/**
 * Environment/mode eligibility only; the owning saved-plan boundary must also
 * prove a complete semantic no-op and an unchanged accepted release chain.
 * This predicate grants no deployment target or execution authority.
 *
 * @param {unknown} deploymentEnvironment
 * @param {unknown} deploymentMode
 */
export function allowsAppEmptyPlanSkip(deploymentEnvironment, deploymentMode) {
  return deploymentEnvironment === 'develop' && deploymentMode === 'normal';
}

const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/u;
const EXPLICIT_ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const SUMMARY_PATTERN = /^\{[\s\S]*\}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const FOUNDATION_ACCEPTANCE_BINDING_KEYS = [
  'closureIdentity',
  'foundationAcceptanceKey',
  'foundationAcceptedSourceSha',
  'foundationContractHash',
];
const FOUNDATION_BOUND_INPUT_KEYS = [
  'accountId',
  'deploymentEnvironment',
  'foundationAcceptance',
  'reviewedPlanChecksum',
  'sourceSha',
  'summaryType',
];
const FOUNDATION_BOUND_PUBLICATION_INPUT_KEYS = [
  'accountId',
  'actionExecutions',
  'deploymentEnvironment',
  'foundationAcceptance',
  'pipelineExecutionId',
  'policy',
  'reviewedPlanChecksum',
  'sourceSha',
  'summaryType',
];
const FOUNDATION_BOUND_SUMMARY_KEYS = [
  'accountId',
  'closureIdentityB64u',
  'deploymentEnvironment',
  'foundationAcceptanceDigestB64u',
  'foundationAcceptedSourceShaB64u',
  'foundationContractHashB64u',
  'reviewedPlanChecksumB64u',
  'sourceShaB64u',
];

const SAVED_PLAN_BINDING_KEYS = ['accountId', 'deploymentEnvironment', 'reviewedPlanChecksum', 'sourceSha'];
const SAVED_PLAN_APPROVAL_OUTPUT_KEYS = [
  ...SAVED_PLAN_BINDING_KEYS,
  'actionExecutionId',
  'actionName',
  'approvalTimestamp',
  'approver',
  'pipelineExecutionId',
  'stageName',
];
const APPROVAL_ACTION_PROJECTION_KEYS = ['actionExecutionDetails'];
const APPROVAL_ACTION_DETAIL_KEYS = [
  'actionExecutionId',
  'actionName',
  'lastUpdateTime',
  'output',
  'pipelineExecutionId',
  'stageName',
  'status',
  'updatedBy',
];

/**
 * @typedef {ReturnType<typeof resolveAllowedDeploymentTarget>} AllowedDeploymentTarget
 * @typedef {{
 *   readonly actionName: string,
 *   readonly approvalSubject: string,
 *   readonly exactlyOneError: string,
 *   readonly stageName: string,
 *   readonly summaryLabel: string,
 * }} SavedPlanApprovalPolicy
 * @typedef {{
 *   readonly actionExecutions: unknown,
 *   readonly pipelineExecutionId: unknown,
 *   readonly sourceSha: unknown,
 *   readonly accountId: unknown,
 *   readonly deploymentEnvironment: unknown,
 *   readonly reviewedPlanChecksum: unknown,
 *   readonly expectedSummaryExtensions?: Readonly<Record<string, string>>,
 *   readonly policy: SavedPlanApprovalPolicy,
 * }} SavedPlanApprovalPublicationInput
 * @typedef {Readonly<Record<string, unknown>> & {
 *   readonly pipelineExecutionId: string,
 *   readonly stageName: string,
 *   readonly actionName: string,
 *   readonly actionExecutionId: string,
 *   readonly sourceSha: string,
 *   readonly accountId: string,
 *   readonly deploymentEnvironment: string,
 *   readonly reviewedPlanChecksum: string,
 *   readonly approver: string,
 *   readonly approvalTimestamp: string,
 * }} SavedPlanApprovalPublication
 * @typedef {'verifier-preflight'} FoundationBoundApprovalSummaryType
 * @typedef {{
 *   readonly foundationAcceptanceKey: string,
 *   readonly foundationAcceptedSourceSha: string,
 *   readonly closureIdentity: string,
 *   readonly foundationContractHash: string,
 * }} FoundationAcceptanceApprovalBinding
 * @typedef {{
 *   readonly sourceSha: unknown,
 *   readonly accountId: unknown,
 *   readonly deploymentEnvironment: unknown,
 *   readonly reviewedPlanChecksum: unknown,
 *   readonly foundationAcceptance: unknown,
 *   readonly summaryType: unknown,
 * }} FoundationBoundApprovalSummaryInput
 */

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
function requiredRecord(value, label) {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

/** @param {unknown} value @param {readonly string[]} keys @param {string} label @returns {Record<string, unknown>} */
function exactKeys(value, keys, label) {
  try {
    return requireExactKeys(value, keys, label);
  } catch {
    requiredRecord(value, label);
    throw new Error(`${label} must use the exact current shape.`);
  }
}

/** @param {unknown} value @param {string} label @param {RegExp | undefined} [pattern] @returns {string} */
function requiredString(value, label, pattern) {
  try {
    return requireString(value, label, pattern);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
}

/** @param {unknown} value @param {string} label @returns {string} */
function requiredUuid(value, label) {
  try {
    return requireGroupedLowercaseUuid(value, label);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
}

/**
 * Admits the single exact succeeded approval-action projection carried from an
 * Apply agreement to the current acceptance publisher. Only the agreement
 * producer constructs this shape; acceptance consumers exact-admit it.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function admitSavedPlanApprovalActionProjection(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan approval expected target'),
  );
  assertProxyFreePortData(value, 'Saved-plan approval action projection');
  let projection;
  try {
    projection = snapshotExactRecord(
      snapshotDataTree(value, 'Saved-plan approval action projection'),
      APPROVAL_ACTION_PROJECTION_KEYS,
      'Saved-plan approval action projection',
    );
  } catch (error) {
    throw new Error('Saved-plan approval action projection must use the exact current shape.', { cause: error });
  }
  const details = projection['actionExecutionDetails'];
  if (!Array.isArray(details) || details.length !== 1) {
    throw new Error('Saved-plan approval action projection must contain exactly one succeeded action.');
  }
  let detail;
  let output;
  let result;
  try {
    detail = snapshotExactRecord(details[0], APPROVAL_ACTION_DETAIL_KEYS, 'Saved-plan approval action detail');
    output = snapshotExactRecord(detail['output'], ['executionResult'], 'Saved-plan approval action output');
    result = snapshotExactRecord(
      output['executionResult'],
      ['externalExecutionId', 'externalExecutionSummary'],
      'Saved-plan approval action result',
    );
  } catch (error) {
    throw new Error('Saved-plan approval action projection must use the exact current shape.', { cause: error });
  }
  const actionExecutionId = requiredUuid(detail['actionExecutionId'], 'Saved-plan approval action execution ID');
  if (result['externalExecutionId'] !== actionExecutionId || detail['status'] !== 'Succeeded') {
    throw new Error('Saved-plan approval action projection is detached from its succeeded action.');
  }
  const externalExecutionSummary = requiredString(
    result['externalExecutionSummary'],
    'Saved-plan approval external execution summary',
    SUMMARY_PATTERN,
  );
  if (Buffer.byteLength(externalExecutionSummary, 'utf8') > 512) {
    throw new Error('Saved-plan approval external execution summary is oversized.');
  }
  try {
    if (!isPlainRecord(JSON.parse(externalExecutionSummary))) throw new Error('summary is not an object');
  } catch (error) {
    throw new Error('Saved-plan approval external execution summary must be valid object JSON.', { cause: error });
  }
  const approver = requiredString(
    detail['updatedBy'],
    'Saved-plan approval action approver',
    new RegExp(
      `^arn:${target.partition}:(?:iam|sts)::${target.accountId}:` + '(?:user|role|assumed-role)/[^\\s]+$',
      'u',
    ),
  );
  const approvalTimestamp = requiredString(
    detail['lastUpdateTime'],
    'Saved-plan approval action timestamp',
    EXPLICIT_ISO_TIMESTAMP_PATTERN,
  );
  if (Number.isNaN(Date.parse(approvalTimestamp))) {
    throw new Error('Saved-plan approval action timestamp is invalid.');
  }
  return Object.freeze({
    actionExecutionDetails: Object.freeze([
      Object.freeze({
        actionExecutionId,
        actionName: requiredString(detail['actionName'], 'Saved-plan approval action name', /^\S+$/u),
        lastUpdateTime: new Date(approvalTimestamp).toISOString(),
        output: Object.freeze({
          executionResult: Object.freeze({
            externalExecutionId: actionExecutionId,
            externalExecutionSummary,
          }),
        }),
        pipelineExecutionId: requiredUuid(detail['pipelineExecutionId'], 'Saved-plan approval pipeline execution ID'),
        stageName: requiredString(detail['stageName'], 'Saved-plan approval stage name', /^\S+$/u),
        status: /** @type {const} */ ('Succeeded'),
        updatedBy: approver,
      }),
    ]),
  });
}

/**
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {FoundationAcceptanceApprovalBinding}
 */
export function admitFoundationAcceptanceApprovalBinding(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan approval expected target'),
  );
  assertProxyFreePortData(value, 'Foundation acceptance approval binding');
  let binding;
  try {
    binding = snapshotExactRecord(value, FOUNDATION_ACCEPTANCE_BINDING_KEYS, 'Foundation acceptance approval binding');
  } catch (error) {
    throw new Error('Foundation acceptance approval binding must use the exact current shape.', { cause: error });
  }
  const foundationAcceptanceKey = admitTerraformAcceptanceRecordKey(
    FOUNDATION_ACCEPTANCE_KIND,
    binding['foundationAcceptanceKey'],
    target.targetKey,
  );
  let foundationAcceptedSourceSha;
  try {
    foundationAcceptedSourceSha = parseFullSourceSha(
      binding['foundationAcceptedSourceSha'],
      'Foundation accepted source SHA',
    );
  } catch (error) {
    throw new Error('Foundation acceptance approval binding accepted source SHA is invalid.', { cause: error });
  }
  const contract = admitFoundationSourceContract({
    closureIdentity: binding['closureIdentity'],
    foundationContractHash: binding['foundationContractHash'],
  });
  return Object.freeze({
    foundationAcceptanceKey,
    foundationAcceptedSourceSha,
    closureIdentity: contract.closureIdentity,
    foundationContractHash: contract.foundationContractHash,
  });
}

/** @param {AllowedDeploymentTarget} target */
function foundationAcceptancePrefix(target) {
  const authority = resolveDeploymentLaneAuthority(target, 'foundation');
  return `${authority.names.terraformBaselinePrefix}/${authority.stateIdentity}/acceptances/`;
}

/** @param {unknown} value @returns {FoundationBoundApprovalSummaryType} */
function foundationBoundSummaryType(value) {
  if (value !== 'verifier-preflight') {
    throw new Error('Foundation-bound approval summary type is invalid.');
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {AllowedDeploymentTarget} target
 * @returns {Readonly<{
 *   sourceSha: string,
 *   accountId: string,
 *   deploymentEnvironment: string,
 *   reviewedPlanChecksum: string,
 *   foundationAcceptance: FoundationAcceptanceApprovalBinding,
 *   summaryType: FoundationBoundApprovalSummaryType,
 * }>}
 */
function admitFoundationBoundInput(value, target) {
  assertProxyFreePortData(value, 'Foundation-bound approval input');
  let input;
  try {
    input = snapshotExactRecord(value, FOUNDATION_BOUND_INPUT_KEYS, 'Foundation-bound approval input');
  } catch (error) {
    throw new Error('Foundation-bound approval input must use the exact current shape.', { cause: error });
  }
  let sourceSha;
  try {
    sourceSha = parseFullSourceSha(input['sourceSha'], 'Foundation-bound approval source SHA');
  } catch (error) {
    throw new Error('Foundation-bound approval source SHA is invalid.', { cause: error });
  }
  const accountId = requiredString(input['accountId'], 'AWS account ID', ACCOUNT_ID_PATTERN);
  if (accountId !== target.accountId) {
    throw new Error('AWS account does not match the reviewed target.');
  }
  const deploymentEnvironment = requiredString(input['deploymentEnvironment'], 'Deployment environment');
  if (deploymentEnvironment !== target.environmentId) {
    throw new Error(`Deployment environment must be ${target.environmentId}.`);
  }
  return Object.freeze({
    sourceSha,
    accountId,
    deploymentEnvironment,
    reviewedPlanChecksum: parseSavedPlanChecksum(input['reviewedPlanChecksum']),
    foundationAcceptance: admitFoundationAcceptanceApprovalBinding(input['foundationAcceptance'], target.targetKey),
    summaryType: foundationBoundSummaryType(input['summaryType']),
  });
}

/** @param {string} value @returns {string} */
function encodeHexBase64Url(value) {
  return Buffer.from(value, 'hex').toString('base64url');
}

/**
 * @param {unknown} value
 * @param {readonly number[]} byteWidths
 * @param {string} label
 * @returns {string}
 */
function decodeCanonicalHexBase64Url(value, byteWidths, label) {
  const encodedWidths = byteWidths.map((byteWidth) => Math.ceil((byteWidth * 4) / 3));
  if (typeof value !== 'string' || !encodedWidths.includes(value.length) || !BASE64URL_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (!byteWidths.includes(decoded.byteLength) || decoded.toString('base64url') !== value) {
    throw new Error(`${label} is invalid.`);
  }
  return decoded.toString('hex');
}

/**
 * Bound every primitive before JSON serialization or base64 decoding. Exact
 * field widths make the object-level CodePipeline limit independently
 * enforceable even when the caller supplies an already-parsed object.
 *
 * @param {Readonly<Record<string, unknown>>} summary
 * @param {AllowedDeploymentTarget} target
 */
function assertFoundationBoundSummaryTransportBound(summary, target) {
  const boundedStrings = [
    ['sourceShaB64u', [27, 43], 'source SHA'],
    ['reviewedPlanChecksumB64u', [43], 'reviewed plan checksum'],
    ['foundationAcceptanceDigestB64u', [43], 'Foundation acceptance digest'],
    ['foundationAcceptedSourceShaB64u', [27, 43], 'Foundation accepted source SHA'],
    ['closureIdentityB64u', [43], 'closure identity'],
    ['foundationContractHashB64u', [43], 'Foundation contract hash'],
    ['accountId', [12], 'AWS account ID'],
    ['deploymentEnvironment', [target.environmentId.length], 'deployment environment'],
  ];
  for (const [name, lengths, label] of boundedStrings) {
    const value = summary[/** @type {string} */ (name)];
    if (typeof value !== 'string' || !(/** @type {number[]} */ (lengths).includes(value.length))) {
      throw new Error(`Foundation-bound approval summary ${String(label)} is invalid.`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > 512) {
    throw new Error('Foundation-bound approval summary exceeds the CodePipeline limit.');
  }
}

/**
 * Render the one bounded CodePipeline summary projection used by App's
 * Foundation-bound approvals. Raw reviewed authority remains in artifacts and
 * review display; only this reversible transport projection is compacted.
 *
 * @param {FoundationBoundApprovalSummaryInput} value
 * @param {unknown} expectedTargetKey
 */
export function renderFoundationBoundApprovalSummary(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan approval expected target'),
  );
  const input = admitFoundationBoundInput(value, target);
  const acceptanceDigest = input.foundationAcceptance.foundationAcceptanceKey.slice(
    foundationAcceptancePrefix(target).length,
    -'.json'.length,
  );
  const summary = {
    sourceShaB64u: encodeHexBase64Url(input.sourceSha),
    accountId: input.accountId,
    deploymentEnvironment: input.deploymentEnvironment,
    reviewedPlanChecksumB64u: encodeHexBase64Url(input.reviewedPlanChecksum),
    foundationAcceptanceDigestB64u: encodeHexBase64Url(acceptanceDigest),
    foundationAcceptedSourceShaB64u: encodeHexBase64Url(input.foundationAcceptance.foundationAcceptedSourceSha),
    closureIdentityB64u: encodeHexBase64Url(input.foundationAcceptance.closureIdentity),
    foundationContractHashB64u: encodeHexBase64Url(input.foundationAcceptance.foundationContractHash),
  };
  if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > 512) {
    throw new Error('Foundation-bound approval summary exceeds the CodePipeline limit.');
  }
  return Object.freeze(summary);
}

/**
 * Strictly decode and byte-compare a compact CodePipeline summary against the
 * raw carried Foundation authority and reviewed saved-plan coordinates.
 *
 * @param {unknown} value
 * @param {FoundationBoundApprovalSummaryInput} expectedValue
 * @param {unknown} expectedTargetKey
 */
export function admitFoundationBoundApprovalSummary(value, expectedValue, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan approval expected target'),
  );
  const expected = admitFoundationBoundInput(expectedValue, target);
  assertProxyFreePortData(value, 'Foundation-bound approval summary');
  let summary;
  try {
    summary = snapshotExactRecord(value, FOUNDATION_BOUND_SUMMARY_KEYS, 'Foundation-bound approval summary');
  } catch (error) {
    throw new Error(`Foundation-bound approval summary must use the exact ${expected.summaryType} shape.`, {
      cause: error,
    });
  }
  assertFoundationBoundSummaryTransportBound(summary, target);
  const sourceSha = decodeCanonicalHexBase64Url(
    summary['sourceShaB64u'],
    [20, 32],
    'Foundation-bound approval summary source SHA',
  );
  const reviewedPlanChecksum = decodeCanonicalHexBase64Url(
    summary['reviewedPlanChecksumB64u'],
    [32],
    'Foundation-bound approval summary reviewed plan checksum',
  );
  const acceptanceDigest = decodeCanonicalHexBase64Url(
    summary['foundationAcceptanceDigestB64u'],
    [32],
    'Foundation-bound approval summary Foundation acceptance digest',
  );
  const foundationAcceptedSourceSha = decodeCanonicalHexBase64Url(
    summary['foundationAcceptedSourceShaB64u'],
    [20, 32],
    'Foundation-bound approval summary Foundation accepted source SHA',
  );
  const closureIdentity = decodeCanonicalHexBase64Url(
    summary['closureIdentityB64u'],
    [32],
    'Foundation-bound approval summary closure identity',
  );
  const foundationContractHash = decodeCanonicalHexBase64Url(
    summary['foundationContractHashB64u'],
    [32],
    'Foundation-bound approval summary Foundation contract hash',
  );
  const foundationAcceptanceKey = `${foundationAcceptancePrefix(target)}${acceptanceDigest}.json`;
  if (foundationAcceptanceKey !== expected.foundationAcceptance.foundationAcceptanceKey) {
    throw new Error(
      'Foundation-bound approval summary Foundation acceptance key does not match the carried authority.',
    );
  }
  const comparisons = [
    ['source SHA', sourceSha, expected.sourceSha],
    ['AWS account ID', summary['accountId'], expected.accountId],
    ['deployment environment', summary['deploymentEnvironment'], expected.deploymentEnvironment],
    ['reviewed plan checksum', reviewedPlanChecksum, expected.reviewedPlanChecksum],
    [
      'Foundation accepted source SHA',
      foundationAcceptedSourceSha,
      expected.foundationAcceptance.foundationAcceptedSourceSha,
    ],
    ['closure identity', closureIdentity, expected.foundationAcceptance.closureIdentity],
    ['Foundation contract hash', foundationContractHash, expected.foundationAcceptance.foundationContractHash],
  ];
  for (const [label, actual, expectedValue] of comparisons) {
    if (actual !== expectedValue) {
      throw new Error(`Foundation-bound approval summary ${label} does not match the carried authority.`);
    }
  }
  return Object.freeze({
    sourceSha,
    accountId: expected.accountId,
    deploymentEnvironment: expected.deploymentEnvironment,
    reviewedPlanChecksum,
    foundationAcceptance: expected.foundationAcceptance,
  });
}

/** @param {unknown} value @returns {string} */
export function parseSavedPlanChecksum(value) {
  try {
    return parseSha256(value, 'Reviewed plan checksum');
  } catch {
    throw new Error('Reviewed plan checksum is invalid.');
  }
}

/** @param {unknown} value @returns {string} */
export function parseSavedPlanChecksumSidecar(value) {
  const checksum = typeof value === 'string' ? value.trim().split(/\s+/u)[0] : undefined;
  return parseSavedPlanChecksum(checksum);
}

/** @param {Readonly<Record<string, string>> | undefined} value @returns {Readonly<Record<string, string>>} */
function expectedSummaryExtensions(value) {
  const extensions = requiredRecord(value ?? {}, 'Saved-plan approval summary extensions');
  /** @type {Record<string, string>} */
  const parsed = {};
  for (const [name, expected] of Object.entries(extensions)) {
    if (SAVED_PLAN_APPROVAL_OUTPUT_KEYS.includes(name) || typeof expected !== 'string') {
      throw new Error('Saved-plan approval summary extensions are invalid.');
    }
    parsed[name] = expected;
  }
  return parsed;
}

/**
 * @param {SavedPlanApprovalPublicationInput & { readonly foundationBound?: Readonly<{
 *   foundationAcceptance: unknown,
 *   summaryType: FoundationBoundApprovalSummaryType,
 * }> }} input
 * @param {AllowedDeploymentTarget} target
 * @returns {SavedPlanApprovalPublication}
 */
function validateSavedPlanApprovalPublicationInternal(
  {
    actionExecutions,
    pipelineExecutionId,
    sourceSha,
    accountId,
    deploymentEnvironment,
    reviewedPlanChecksum,
    expectedSummaryExtensions: rawExpectedSummaryExtensions,
    policy,
    foundationBound,
  },
  target,
) {
  const exactPipelineExecutionId = requiredUuid(pipelineExecutionId, 'Pipeline execution ID');
  let exactSourceSha;
  try {
    exactSourceSha = parseFullSourceSha(sourceSha, 'Source SHA');
  } catch {
    throw new Error('Source SHA is invalid.');
  }
  const exactAccountId = requiredString(accountId, 'AWS account ID', ACCOUNT_ID_PATTERN);
  if (exactAccountId !== target.accountId) {
    throw new Error('AWS account does not match the reviewed target.');
  }
  const exactDeploymentEnvironment = requiredString(deploymentEnvironment, 'Deployment environment');
  if (exactDeploymentEnvironment !== target.environmentId) {
    throw new Error(`Deployment environment must be ${target.environmentId}.`);
  }
  const exactReviewedPlanChecksum = parseSavedPlanChecksum(reviewedPlanChecksum);

  const exactPolicy = exactKeys(
    policy,
    ['actionName', 'approvalSubject', 'exactlyOneError', 'stageName', 'summaryLabel'],
    'Saved-plan approval policy',
  );
  const actionName = requiredString(exactPolicy['actionName'], 'Saved-plan approval action name', /^\S+$/u);
  const approvalSubject = requiredString(
    exactPolicy['approvalSubject'],
    'Saved-plan approval subject',
    /^\S[\s\S]*\S$/u,
  );
  const exactlyOneError = requiredString(
    exactPolicy['exactlyOneError'],
    'Saved-plan approval count error',
    /^\S[\s\S]*\S$/u,
  );
  const stageName = requiredString(exactPolicy['stageName'], 'Saved-plan approval stage name', /^\S+$/u);
  const summaryLabel = requiredString(
    exactPolicy['summaryLabel'],
    'Saved-plan approval summary label',
    /^\S[\s\S]*\S$/u,
  );
  const extensions = expectedSummaryExtensions(rawExpectedSummaryExtensions);

  const details = requiredRecord(actionExecutions, 'CodePipeline action executions')['actionExecutionDetails'];
  if (!Array.isArray(details)) {
    throw new Error('CodePipeline action execution details are missing.');
  }
  const approvals = details.filter((detail) => {
    if (!isPlainRecord(detail)) return false;
    return (
      detail['pipelineExecutionId'] === exactPipelineExecutionId &&
      detail['stageName'] === stageName &&
      detail['actionName'] === actionName &&
      detail['status'] === 'Succeeded'
    );
  });
  if (approvals.length !== 1) {
    throw new Error(exactlyOneError);
  }

  const approval = approvals[0];
  if (approval === undefined || !isPlainRecord(approval)) {
    throw new Error(exactlyOneError);
  }
  const result = requiredRecord(
    requiredRecord(approval['output'], 'Approval output')['executionResult'],
    'Approval result',
  );
  const rawSummaryText = result['externalExecutionSummary'];
  if (
    typeof rawSummaryText !== 'string' ||
    rawSummaryText.length < 2 ||
    rawSummaryText.length > 512 ||
    Buffer.byteLength(rawSummaryText, 'utf8') > 512
  ) {
    throw new Error(`${summaryLabel} is empty or oversized.`);
  }
  const summaryText = requiredString(rawSummaryText, summaryLabel, SUMMARY_PATTERN);
  /** @type {unknown} */
  let summary;
  try {
    summary = JSON.parse(summaryText);
  } catch {
    throw new Error(`${summaryLabel} must be valid JSON.`);
  }
  let summaryOutput;
  if (foundationBound === undefined) {
    const exactSummary = exactKeys(summary, [...SAVED_PLAN_BINDING_KEYS, ...Object.keys(extensions)], summaryLabel);
    const expectedSummary = {
      sourceSha: exactSourceSha,
      accountId: exactAccountId,
      deploymentEnvironment: exactDeploymentEnvironment,
      reviewedPlanChecksum: exactReviewedPlanChecksum,
      ...extensions,
    };
    for (const [name, expected] of Object.entries(expectedSummary)) {
      if (exactSummary[name] !== expected) {
        throw new Error(`${summaryLabel} ${name} does not match the saved plan.`);
      }
    }
    summaryOutput = extensions;
  } else {
    if (Object.keys(extensions).length !== 0) {
      throw new Error('Foundation-bound saved-plan approval cannot use generic summary extensions.');
    }
    let admittedSummary;
    try {
      admittedSummary = admitFoundationBoundApprovalSummary(
        summary,
        {
          sourceSha: exactSourceSha,
          accountId: exactAccountId,
          deploymentEnvironment: exactDeploymentEnvironment,
          reviewedPlanChecksum: exactReviewedPlanChecksum,
          foundationAcceptance: foundationBound.foundationAcceptance,
          summaryType: foundationBound.summaryType,
        },
        target.targetKey,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('must use the exact')) {
        throw new Error(`${summaryLabel} must use the exact current shape.`, { cause: error });
      }
      throw error;
    }
    summaryOutput = {
      foundationAcceptanceKey: admittedSummary.foundationAcceptance.foundationAcceptanceKey,
      foundationAcceptedSourceSha: admittedSummary.foundationAcceptance.foundationAcceptedSourceSha,
      closureIdentity: admittedSummary.foundationAcceptance.closureIdentity,
      foundationContractHash: admittedSummary.foundationAcceptance.foundationContractHash,
    };
  }

  const actionExecutionId = requiredUuid(
    approval['actionExecutionId'],
    `${approvalSubject} approval action execution ID`,
  );
  const approver = requiredString(
    approval['updatedBy'],
    `${approvalSubject} approver`,
    new RegExp(`^arn:${target.partition}:(?:iam|sts)::${exactAccountId}:(?:user|role|assumed-role)/[^\\s]+$`, 'u'),
  );
  const timestamp = requiredString(
    approval['lastUpdateTime'],
    `${approvalSubject} approval timestamp`,
    EXPLICIT_ISO_TIMESTAMP_PATTERN,
  );
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`${approvalSubject} approval timestamp is invalid.`);
  }

  return {
    pipelineExecutionId: exactPipelineExecutionId,
    stageName,
    actionName,
    actionExecutionId,
    sourceSha: exactSourceSha,
    accountId: exactAccountId,
    deploymentEnvironment: exactDeploymentEnvironment,
    reviewedPlanChecksum: exactReviewedPlanChecksum,
    ...summaryOutput,
    approver,
    approvalTimestamp: new Date(timestamp).toISOString(),
  };
}

/** @param {SavedPlanApprovalPublicationInput} input @param {unknown} expectedTargetKey @returns {SavedPlanApprovalPublication} */
export function validateSavedPlanApprovalPublication(input, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan approval expected target'),
  );
  return validateSavedPlanApprovalPublicationInternal(input, target);
}

/**
 * Dedicated App preflight approval admission. The compact
 * transport is reversible and byte-compared to this raw carried authority;
 * generic saved-plan summaries remain unchanged.
 *
 * @param {SavedPlanApprovalPublicationInput & {
 *   readonly foundationAcceptance: unknown,
 *   readonly summaryType: FoundationBoundApprovalSummaryType,
 * }} value
 * @param {unknown} expectedTargetKey
 */
export function validateFoundationBoundSavedPlanApprovalPublication(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan approval expected target'),
  );
  assertProxyFreePortData(value, 'Foundation-bound saved-plan approval publication');
  let input;
  try {
    input = snapshotExactRecord(
      snapshotDataTree(value, 'Foundation-bound saved-plan approval publication'),
      FOUNDATION_BOUND_PUBLICATION_INPUT_KEYS,
      'Foundation-bound saved-plan approval publication',
    );
  } catch (error) {
    throw new Error('Foundation-bound saved-plan approval publication must use the exact current shape.', {
      cause: error,
    });
  }
  return validateSavedPlanApprovalPublicationInternal(
    {
      actionExecutions: input['actionExecutions'],
      pipelineExecutionId: input['pipelineExecutionId'],
      sourceSha: input['sourceSha'],
      accountId: input['accountId'],
      deploymentEnvironment: input['deploymentEnvironment'],
      reviewedPlanChecksum: input['reviewedPlanChecksum'],
      policy: /** @type {SavedPlanApprovalPolicy} */ (input['policy']),
      foundationBound: {
        foundationAcceptance: input['foundationAcceptance'],
        summaryType: foundationBoundSummaryType(input['summaryType']),
      },
    },
    target,
  );
}
