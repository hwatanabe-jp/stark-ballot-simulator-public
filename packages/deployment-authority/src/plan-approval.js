import {
  isPlainRecord,
  parseFullSourceSha,
  parseSha256,
  requireExactKeys,
  requireGroupedLowercaseUuid,
  requireString,
} from './internal.js';
import { resolveAllowedDeploymentTarget } from './index.js';

const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/u;
const DEPLOYMENT_TARGET = resolveAllowedDeploymentTarget('stark-dev/develop');
const EXPLICIT_ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const SUMMARY_PATTERN = /^\{[\s\S]*\}$/u;

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

function requiredRecord(value, label) {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  try {
    return requireExactKeys(value, keys, label);
  } catch {
    requiredRecord(value, label);
    throw new Error(`${label} must use the exact current shape.`);
  }
}

function requiredString(value, label, pattern) {
  try {
    return requireString(value, label, pattern);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
}

function requiredUuid(value, label) {
  try {
    return requireGroupedLowercaseUuid(value, label);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
}

export function parseSavedPlanChecksum(value) {
  try {
    return parseSha256(value, 'Reviewed plan checksum');
  } catch {
    throw new Error('Reviewed plan checksum is invalid.');
  }
}

export function parseSavedPlanChecksumSidecar(value) {
  const checksum = typeof value === 'string' ? value.trim().split(/\s+/u)[0] : undefined;
  return parseSavedPlanChecksum(checksum);
}

function expectedSummaryExtensions(value) {
  const extensions = requiredRecord(value ?? {}, 'Saved-plan approval summary extensions');
  for (const [name, expected] of Object.entries(extensions)) {
    if (SAVED_PLAN_APPROVAL_OUTPUT_KEYS.includes(name) || typeof expected !== 'string') {
      throw new Error('Saved-plan approval summary extensions are invalid.');
    }
  }
  return extensions;
}

export function validateSavedPlanApprovalPublication({
  actionExecutions,
  pipelineExecutionId,
  sourceSha,
  accountId,
  deploymentEnvironment,
  reviewedPlanChecksum,
  expectedSummaryExtensions: rawExpectedSummaryExtensions,
  policy,
}) {
  requiredUuid(pipelineExecutionId, 'Pipeline execution ID');
  try {
    parseFullSourceSha(sourceSha, 'Source SHA');
  } catch {
    throw new Error('Source SHA is invalid.');
  }
  requiredString(accountId, 'AWS account ID', ACCOUNT_ID_PATTERN);
  if (accountId !== DEPLOYMENT_TARGET.accountId) {
    throw new Error('AWS account does not match the reviewed target.');
  }
  if (deploymentEnvironment !== DEPLOYMENT_TARGET.environmentId) {
    throw new Error(`Deployment environment must be ${DEPLOYMENT_TARGET.environmentId}.`);
  }
  parseSavedPlanChecksum(reviewedPlanChecksum);

  const exactPolicy = exactKeys(
    policy,
    ['actionName', 'approvalSubject', 'exactlyOneError', 'stageName', 'summaryLabel'],
    'Saved-plan approval policy',
  );
  const actionName = requiredString(exactPolicy.actionName, 'Saved-plan approval action name', /^\S+$/u);
  const approvalSubject = requiredString(exactPolicy.approvalSubject, 'Saved-plan approval subject', /^\S[\s\S]*\S$/u);
  const exactlyOneError = requiredString(
    exactPolicy.exactlyOneError,
    'Saved-plan approval count error',
    /^\S[\s\S]*\S$/u,
  );
  const stageName = requiredString(exactPolicy.stageName, 'Saved-plan approval stage name', /^\S+$/u);
  const summaryLabel = requiredString(exactPolicy.summaryLabel, 'Saved-plan approval summary label', /^\S[\s\S]*\S$/u);
  const extensions = expectedSummaryExtensions(rawExpectedSummaryExtensions);

  const details = requiredRecord(actionExecutions, 'CodePipeline action executions').actionExecutionDetails;
  if (!Array.isArray(details)) {
    throw new Error('CodePipeline action execution details are missing.');
  }
  const approvals = details.filter(
    (detail) =>
      detail?.pipelineExecutionId === pipelineExecutionId &&
      detail?.stageName === stageName &&
      detail?.actionName === actionName &&
      detail?.status === 'Succeeded',
  );
  if (approvals.length !== 1) {
    throw new Error(exactlyOneError);
  }

  const approval = approvals[0];
  const result = requiredRecord(requiredRecord(approval.output, 'Approval output').executionResult, 'Approval result');
  const summaryText = requiredString(result.externalExecutionSummary, summaryLabel, SUMMARY_PATTERN);
  let summary;
  try {
    summary = JSON.parse(summaryText);
  } catch {
    throw new Error(`${summaryLabel} must be valid JSON.`);
  }
  exactKeys(summary, [...SAVED_PLAN_BINDING_KEYS, ...Object.keys(extensions)], summaryLabel);

  const expectedSummary = {
    sourceSha,
    accountId,
    deploymentEnvironment,
    reviewedPlanChecksum,
    ...extensions,
  };
  for (const [name, expected] of Object.entries(expectedSummary)) {
    if (summary[name] !== expected) {
      throw new Error(`${summaryLabel} ${name} does not match the saved plan.`);
    }
  }

  const actionExecutionId = requiredUuid(approval.actionExecutionId, `${approvalSubject} approval action execution ID`);
  const approver = requiredString(
    approval.updatedBy,
    `${approvalSubject} approver`,
    new RegExp(`^arn:aws:(?:iam|sts)::${accountId}:(?:user|role|assumed-role)/[^\\s]+$`, 'u'),
  );
  const timestamp = requiredString(
    approval.lastUpdateTime,
    `${approvalSubject} approval timestamp`,
    EXPLICIT_ISO_TIMESTAMP_PATTERN,
  );
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`${approvalSubject} approval timestamp is invalid.`);
  }

  return {
    pipelineExecutionId,
    stageName,
    actionName,
    actionExecutionId,
    sourceSha,
    accountId,
    deploymentEnvironment,
    reviewedPlanChecksum,
    ...extensions,
    approver,
    approvalTimestamp: new Date(timestamp).toISOString(),
  };
}
