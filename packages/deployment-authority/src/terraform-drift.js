import { isDeepStrictEqual } from 'node:util';
import {
  deepFreeze,
  hasControlCharacter,
  isPlainRecord,
  parseFullSourceSha,
  parseImmutableObjectReference,
  requireExactKeys,
  requireString,
} from './internal.js';
import { validateTerraformBackendAuthority } from './terraform-baseline.js';

export const MAX_REDACTED_TERRAFORM_ADDRESSES = 100;

const ACTION_COUNT_KEYS = ['create', 'update', 'replace', 'delete', 'readOnly'];
const REPORTED_ACTION_ORDER = ['create', 'update', 'replace', 'delete', 'read-only'];
const MAX_TERRAFORM_ADDRESS_BYTES = 4_096;
const MAX_REDACTED_ADDRESS_BYTES = 1_024;
const ROOTS = ['app', 'bootstrap', 'foundation'];
const ACTION_CLASSES = ['create', 'update', 'replace', 'delete', 'read-only'];
const FAILURE_STAGES = [
  'baseline-selection',
  'baseline-admission',
  'source-checkout',
  'identity-admission',
  'provider-initialization',
  'runner-runtime',
  'terraform-plan',
  'plan-summary',
];
const DRIFT_IDENTITY_KEYS = [
  'accountId',
  'backend',
  'context',
  'controlSourceSha',
  'frameworkSourceSha',
  'inputManifest',
  'providerEvidence',
  'region',
  'root',
  'stateIdentity',
];
const DRIFT_SUMMARY_KEYS = ['actionCounts', 'addresses', 'omittedAddressCount'];
const ACTION_COUNTS_KEYS = ['create', 'delete', 'readOnly', 'replace', 'update'];
const TOOL_RUNTIME_KEYS = ['runnerSourceSha', 'terraformPlanFormatVersion', 'terraformVersion'];
const DRIFT_EVIDENCE_KEYS = [
  'baseline',
  'evidenceType',
  'executionId',
  'failureStage',
  'finishedAt',
  'observed',
  'reportOnly',
  'result',
  'startedAt',
  'summary',
  'terraformDetailedExitCode',
  'toolRuntime',
];
const DRIFT_EVIDENCE_INPUT_KEYS = [
  'baseline',
  'executionId',
  'expectedIdentity',
  'failureStage',
  'finishedAt',
  'observed',
  'startedAt',
  'summary',
  'terraformDetailedExitCode',
  'toolRuntime',
];
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const OPERATIONAL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,255}$/u;
const TERRAFORM_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const TERRAFORM_PLAN_FORMAT_PATTERN = /^[0-9]+\.[0-9]+$/u;

export function classifyTerraformDetailedExitCode(value) {
  if (value === null) {
    return 'check-failed';
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new Error('Terraform detailed exit code is invalid.');
  }
  if (value === 0) {
    return 'no-drift';
  }
  if (value === 2) {
    return 'drift-detected';
  }
  return 'check-failed';
}

function requireRecord(value, label) {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireDataProperty(record, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(`${label} must be an enumerable data property.`);
  }
  return descriptor.value;
}

function denseDataArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a dense data-property array.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value')) {
    throw new Error(`${label} must be a dense data-property array.`);
  }
  const entries = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must be a dense data-property array.`);
    }
    entries.push(descriptor.value);
  }
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        typeof key !== 'string' ||
        (key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)),
    )
  ) {
    throw new Error(`${label} must be a dense data-property array.`);
  }
  return entries;
}

function exactKeys(value, keys, label) {
  try {
    return requireExactKeys(value, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (
    typeof value !== 'string' ||
    !CANONICAL_TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical UTC timestamp.`);
  }
  return value;
}

function parseDriftIdentity(value, label) {
  const identity = exactKeys(value, DRIFT_IDENTITY_KEYS, label);
  const root = identity.root;
  if (!ROOTS.includes(root)) {
    throw new Error(`${label} root is invalid.`);
  }
  const accountId = requireString(identity.accountId, `${label} accountId`, /^[0-9]{12}$/u);
  const region = requireString(identity.region, `${label} region`, /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/u);
  const stateIdentity = requireString(
    identity.stateIdentity,
    `${label} stateIdentity`,
    /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/(?:app|bootstrap|foundation)$/u,
  );
  if (!stateIdentity.endsWith(`/${root}`)) {
    throw new Error(`${label} stateIdentity does not match root.`);
  }
  let backend;
  try {
    backend = validateTerraformBackendAuthority(identity.backend, root);
    if (backend.region !== region || !backend.kmsKeyArn.startsWith(`arn:aws:kms:${region}:${accountId}:key/`)) {
      throw new Error('Terraform drift target coordinates do not match its backend.');
    }
  } catch (error) {
    throw new Error(`${label} backend authority is invalid.`, { cause: error });
  }
  return deepFreeze({
    accountId,
    region,
    root,
    stateIdentity,
    backend,
    controlSourceSha: parseFullSourceSha(identity.controlSourceSha, `${label} controlSourceSha`),
    frameworkSourceSha: parseFullSourceSha(identity.frameworkSourceSha, `${label} frameworkSourceSha`),
    context: parseImmutableObjectReference(identity.context),
    inputManifest: parseImmutableObjectReference(identity.inputManifest),
    providerEvidence: parseImmutableObjectReference(identity.providerEvidence),
  });
}

function parseDriftSummary(value) {
  const summary = exactKeys(value, DRIFT_SUMMARY_KEYS, 'Terraform drift summary');
  const rawCounts = exactKeys(summary.actionCounts, ACTION_COUNTS_KEYS, 'Terraform drift action counts');
  const actionCounts = Object.fromEntries(
    ACTION_COUNTS_KEYS.map((key) => [key, nonNegativeInteger(rawCounts[key], `Terraform drift ${key} count`)]),
  );
  const rawAddresses = denseDataArray(summary.addresses, 'Terraform drift addresses');
  if (rawAddresses.length > MAX_REDACTED_TERRAFORM_ADDRESSES) {
    throw new Error('Terraform drift addresses are invalid.');
  }
  const addresses = rawAddresses.map((entry, index) => {
    const addressEntry = exactKeys(entry, ['actionClasses', 'address'], `Terraform drift address ${index}`);
    const address = redactTerraformResourceAddressWithPolicy(addressEntry.address, true);
    if (address !== addressEntry.address) {
      throw new Error(`Terraform drift address ${index} is not redacted.`);
    }
    const rawActionClasses = denseDataArray(
      addressEntry.actionClasses,
      `Terraform drift address ${index} action classes`,
    );
    if (rawActionClasses.length === 0 || rawActionClasses.some((action) => !ACTION_CLASSES.includes(action))) {
      throw new Error(`Terraform drift address ${index} action classes are invalid.`);
    }
    const actionClasses = [...rawActionClasses].sort(
      (left, right) => REPORTED_ACTION_ORDER.indexOf(left) - REPORTED_ACTION_ORDER.indexOf(right),
    );
    if (new Set(actionClasses).size !== actionClasses.length || !isDeepStrictEqual(actionClasses, rawActionClasses)) {
      throw new Error(`Terraform drift address ${index} action classes are not canonical.`);
    }
    return deepFreeze({ address, actionClasses });
  });
  const sortedAddresses = [...addresses].sort((left, right) =>
    left.address < right.address ? -1 : left.address > right.address ? 1 : 0,
  );
  if (
    new Set(addresses.map((entry) => entry.address)).size !== addresses.length ||
    !isDeepStrictEqual(addresses, sortedAddresses)
  ) {
    throw new Error('Terraform drift addresses must be unique and sorted.');
  }
  const omittedAddressCount = nonNegativeInteger(summary.omittedAddressCount, 'Terraform drift omittedAddressCount');
  const totalActionCount = Object.values(actionCounts).reduce((total, count) => total + count, 0);
  for (const [addressIndex, addressEntry] of addresses.entries()) {
    for (const actionClass of addressEntry.actionClasses) {
      const countKey = actionClass === 'read-only' ? 'readOnly' : actionClass;
      if (actionCounts[countKey] === 0) {
        throw new Error(
          `Terraform drift address ${addressIndex} action class is absent from the classified action counts.`,
        );
      }
    }
  }
  if (addresses.length + omittedAddressCount > totalActionCount) {
    throw new Error('Terraform drift address counts exceed the classified actions.');
  }
  if (totalActionCount > 0 && addresses.length + omittedAddressCount === 0) {
    throw new Error('Terraform drift classified actions require represented or omitted addresses.');
  }
  if (totalActionCount === 0 && (addresses.length !== 0 || omittedAddressCount !== 0)) {
    throw new Error('Terraform drift empty action counts must have an empty address set.');
  }
  return deepFreeze({ actionCounts, addresses, omittedAddressCount });
}

export function validateTerraformDriftSummary(value) {
  return parseDriftSummary(value);
}

function parseToolRuntime(value) {
  const runtime = exactKeys(value, TOOL_RUNTIME_KEYS, 'Terraform drift tool runtime');
  return deepFreeze({
    runnerSourceSha: parseFullSourceSha(runtime.runnerSourceSha, 'Terraform drift runner source SHA'),
    terraformVersion: requireString(
      runtime.terraformVersion,
      'Terraform drift Terraform version',
      TERRAFORM_VERSION_PATTERN,
    ),
    terraformPlanFormatVersion: requireString(
      runtime.terraformPlanFormatVersion,
      'Terraform drift plan format version',
      TERRAFORM_PLAN_FORMAT_PATTERN,
    ),
  });
}

function parseFailureStage(value) {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !FAILURE_STAGES.includes(value)) {
    throw new Error('Terraform drift failureStage is invalid.');
  }
  return value;
}

function parseNullableReference(value) {
  return value === null ? null : parseImmutableObjectReference(value);
}

function parseNullableIdentity(value, label) {
  return value === null ? null : parseDriftIdentity(value, label);
}

function parseNullableSummary(value) {
  return value === null ? null : parseDriftSummary(value);
}

function parseNullableToolRuntime(value) {
  return value === null ? null : parseToolRuntime(value);
}

function assertSuccessfulEvidenceCoordinates(baseline, observed, summary, toolRuntime) {
  if (baseline === null || observed === null || summary === null || toolRuntime === null) {
    throw new Error('Successful Terraform drift evidence requires complete admitted coordinates.');
  }
}

function assertFailedEvidenceCoordinates(baseline, observed, summary) {
  if (summary !== null) {
    throw new Error('Failed Terraform drift evidence must not claim a plan summary.');
  }
  if (baseline === null && observed !== null) {
    throw new Error('Terraform drift observed coordinates require an admitted baseline reference.');
  }
}

export function classifyTerraformActionSequence(value, label = 'Terraform action sequence') {
  const actions = denseDataArray(value, label);
  if (!actions.every((action) => typeof action === 'string')) {
    throw new Error(`${label} is not a supported Terraform action sequence.`);
  }
  const sequence = actions.join('\0');
  switch (sequence) {
    case 'no-op':
      return null;
    case 'create':
      return 'create';
    case 'update':
      return 'update';
    case 'delete\0create':
    case 'create\0delete':
      return 'replace';
    case 'delete':
      return 'delete';
    case 'read':
      return 'read-only';
    default:
      throw new Error(`${label} is not a supported Terraform action sequence.`);
  }
}

function redactTerraformResourceAddressWithPolicy(value, allowRedactedWildcard) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_TERRAFORM_ADDRESS_BYTES ||
    hasControlCharacter(value)
  ) {
    throw new Error('Terraform resource address is invalid.');
  }

  let redacted = '';
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (character !== '[') {
      if (character === undefined || !/[A-Za-z0-9_.-]/u.test(character)) {
        throw new Error('Terraform resource address is invalid.');
      }
      redacted += character;
      index += 1;
      continue;
    }

    const contentStart = index + 1;
    let closingIndex = contentStart;
    let insideQuotedString = false;
    let escaped = false;
    for (; closingIndex < value.length; closingIndex += 1) {
      const indexedCharacter = value[closingIndex];
      if (insideQuotedString) {
        if (escaped) {
          escaped = false;
        } else if (indexedCharacter === '\\') {
          escaped = true;
        } else if (indexedCharacter === '"') {
          insideQuotedString = false;
        }
      } else if (indexedCharacter === '"') {
        insideQuotedString = true;
      } else if (indexedCharacter === ']') {
        break;
      } else if (indexedCharacter === '[') {
        throw new Error('Terraform resource address is invalid.');
      }
    }
    if (closingIndex >= value.length || insideQuotedString || escaped) {
      throw new Error('Terraform resource address is invalid.');
    }
    const indexContent = value.slice(contentStart, closingIndex);
    let validIndex = (allowRedactedWildcard && indexContent === '*') || /^(?:0|[1-9][0-9]*)$/u.test(indexContent);
    if (!validIndex && indexContent.startsWith('"') && indexContent.endsWith('"')) {
      try {
        validIndex = typeof JSON.parse(indexContent) === 'string';
      } catch {
        validIndex = false;
      }
    }
    if (!validIndex) {
      throw new Error('Terraform resource address is invalid.');
    }
    redacted += '[*]';
    index = closingIndex + 1;
  }

  if (
    Buffer.byteLength(redacted, 'utf8') > MAX_REDACTED_ADDRESS_BYTES ||
    redacted.startsWith('.') ||
    redacted.endsWith('.') ||
    redacted.includes('..')
  ) {
    throw new Error('Terraform resource address is invalid.');
  }
  const segments = redacted.split('.');
  if (segments.length < 2 || segments.some((segment) => !/^[A-Za-z0-9_-]+(?:\[\*\])*$/u.test(segment))) {
    throw new Error('Terraform resource address is invalid.');
  }
  return redacted;
}

export function redactTerraformResourceAddress(value) {
  return redactTerraformResourceAddressWithPolicy(value, false);
}

export function summarizeTerraformPlan(value) {
  const plan = requireRecord(value, 'Terraform plan JSON');
  const resourceChangesDescriptor = Object.getOwnPropertyDescriptor(plan, 'resource_changes');
  const resourceChanges = denseDataArray(
    resourceChangesDescriptor === undefined ? [] : resourceChangesDescriptor.value,
    'Terraform plan JSON resource_changes',
  );

  const actionCounts = Object.fromEntries(ACTION_COUNT_KEYS.map((key) => [key, 0]));
  const addressActions = new Map();
  for (const [index, valueAtIndex] of resourceChanges.entries()) {
    const resourceChange = requireRecord(valueAtIndex, `resource_changes[${index}]`);
    const change = requireRecord(
      requireDataProperty(resourceChange, 'change', `resource_changes[${index}].change`),
      `resource_changes[${index}].change`,
    );
    const address = redactTerraformResourceAddress(
      requireDataProperty(resourceChange, 'address', `resource_changes[${index}].address`),
    );
    const actionClass = classifyTerraformActionSequence(
      requireDataProperty(change, 'actions', `resource_changes[${index}].change.actions`),
      `resource_changes[${index}].change.actions`,
    );
    if (actionClass === null) {
      continue;
    }
    const countKey = actionClass === 'read-only' ? 'readOnly' : actionClass;
    actionCounts[countKey] += 1;
    const actions = addressActions.get(address) ?? new Set();
    actions.add(actionClass);
    addressActions.set(address, actions);
  }

  const addresses = [...addressActions]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, MAX_REDACTED_TERRAFORM_ADDRESSES)
    .map(([address, actions]) => ({
      address,
      actionClasses: [...actions].sort(
        (left, right) => REPORTED_ACTION_ORDER.indexOf(left) - REPORTED_ACTION_ORDER.indexOf(right),
      ),
    }));

  return deepFreeze({
    actionCounts,
    addresses,
    omittedAddressCount: addressActions.size - addresses.length,
  });
}

export function validateTerraformDriftEvidence(value) {
  const evidence = exactKeys(value, DRIFT_EVIDENCE_KEYS, 'Terraform drift evidence');
  if (evidence.evidenceType !== 'terraform-drift-report') {
    throw new Error('Terraform drift evidenceType is invalid.');
  }
  if (evidence.reportOnly !== true) {
    throw new Error('Terraform drift evidence must be report-only.');
  }
  const executionId = requireString(
    evidence.executionId,
    'Terraform drift executionId',
    OPERATIONAL_IDENTIFIER_PATTERN,
  );
  const startedAt = canonicalTimestamp(evidence.startedAt, 'Terraform drift startedAt');
  const finishedAt = canonicalTimestamp(evidence.finishedAt, 'Terraform drift finishedAt');
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error('Terraform drift finishedAt must not precede startedAt.');
  }
  const terraformDetailedExitCode = evidence.terraformDetailedExitCode;
  const mappedResult = classifyTerraformDetailedExitCode(terraformDetailedExitCode);
  const failureStage = parseFailureStage(evidence.failureStage);
  const baseline = parseNullableReference(evidence.baseline);
  const observed = parseNullableIdentity(evidence.observed, 'Terraform drift observed identity');
  const summary = parseNullableSummary(evidence.summary);
  const toolRuntime = parseNullableToolRuntime(evidence.toolRuntime);
  const result = evidence.result;
  if (!['no-drift', 'drift-detected', 'check-failed'].includes(result)) {
    throw new Error('Terraform drift result is invalid.');
  }

  if (failureStage === null) {
    if (mappedResult === 'check-failed' || result !== mappedResult) {
      throw new Error('Terraform drift result does not match its detailed exit code.');
    }
    assertSuccessfulEvidenceCoordinates(baseline, observed, summary, toolRuntime);
    if (
      result === 'no-drift' &&
      (summary.actionCounts.create !== 0 ||
        summary.actionCounts.update !== 0 ||
        summary.actionCounts.replace !== 0 ||
        summary.actionCounts.delete !== 0)
    ) {
      throw new Error('Terraform no-drift evidence cannot contain mutating resource actions.');
    }
  } else {
    if (result !== 'check-failed') {
      throw new Error('Terraform drift failureStage requires check-failed result.');
    }
    assertFailedEvidenceCoordinates(baseline, observed, summary);
  }

  return deepFreeze({
    evidenceType: 'terraform-drift-report',
    executionId,
    baseline,
    observed,
    startedAt,
    finishedAt,
    result,
    terraformDetailedExitCode,
    failureStage,
    summary,
    reportOnly: true,
    toolRuntime,
  });
}

export function buildTerraformDriftEvidence(value) {
  const input = exactKeys(value, DRIFT_EVIDENCE_INPUT_KEYS, 'Terraform drift evidence input');
  const baseline = parseNullableReference(input.baseline);
  const expectedIdentity = parseNullableIdentity(input.expectedIdentity, 'Terraform drift expected identity');
  const observed = parseNullableIdentity(input.observed, 'Terraform drift observed identity');
  const summary = parseNullableSummary(input.summary);
  const toolRuntime = parseNullableToolRuntime(input.toolRuntime);
  const terraformDetailedExitCode = input.terraformDetailedExitCode;
  const mappedResult = classifyTerraformDetailedExitCode(terraformDetailedExitCode);
  let failureStage = parseFailureStage(input.failureStage);
  if (mappedResult === 'check-failed' && failureStage === null) {
    if (terraformDetailedExitCode === null) {
      throw new Error('A pre-Terraform check failure requires an explicit failureStage.');
    }
    failureStage = 'terraform-plan';
  }
  const result = failureStage === null ? mappedResult : 'check-failed';

  if (result === 'check-failed') {
    if (baseline === null && expectedIdentity !== null) {
      throw new Error('Terraform drift expected identity requires an admitted baseline reference.');
    }
    if (observed !== null && expectedIdentity === null) {
      throw new Error('Terraform drift observed identity requires an expected identity.');
    }
    assertFailedEvidenceCoordinates(baseline, observed, summary);
  } else {
    if (expectedIdentity === null || !isDeepStrictEqual(expectedIdentity, observed)) {
      throw new Error('Terraform drift observed identity does not match the accepted baseline identity.');
    }
    assertSuccessfulEvidenceCoordinates(baseline, observed, summary, toolRuntime);
  }

  return validateTerraformDriftEvidence({
    evidenceType: 'terraform-drift-report',
    executionId: input.executionId,
    baseline,
    observed,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    result,
    terraformDetailedExitCode,
    failureStage,
    summary,
    reportOnly: true,
    toolRuntime,
  });
}
