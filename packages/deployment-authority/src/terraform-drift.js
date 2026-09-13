/** @typedef {import("./index.js").ImmutableObjectReference} ImmutableObjectReference */

/** @typedef {import("./terraform-authority.js").TerraformBackendAuthority} TerraformBackendAuthority */

/**
 * @typedef {'create' | 'update' | 'replace' | 'delete' | 'read-only'} TerraformDriftActionClass
 */

/**
 * @typedef {'no-drift' | 'drift-detected' | 'check-failed'} TerraformDriftResult
 */

/**
 * @typedef {'app' | 'bootstrap' | 'foundation'} TerraformDriftRoot
 */

/**
 * @typedef {'authority-selection' | 'authority-admission' | 'source-checkout' | 'identity-admission' | 'provider-initialization' | 'runner-runtime' | 'plan-input-preparation' | 'terraform-plan' | 'plan-summary'} TerraformDriftFailureStage
 */

/**
 * @typedef {{
    readonly configuredManagedImage: string;
    readonly runningManagedImage: string;
}} TerraformDriftBuildRuntime
 */

/**
 * @typedef {{
    readonly create: number;
    readonly update: number;
    readonly replace: number;
    readonly delete: number;
    readonly readOnly: number;
}} TerraformDriftActionCounts
 */

/**
 * @typedef {{
    readonly address: string;
    readonly actionClasses: readonly TerraformDriftActionClass[];
}} TerraformDriftAddress
 */

/**
 * @typedef {{
    readonly actionCounts: TerraformDriftActionCounts;
    readonly addresses: readonly TerraformDriftAddress[];
    readonly omittedAddressCount: number;
}} TerraformDriftSummary
 */

/**
 * @typedef {{
    readonly accountId: string;
    readonly region: string;
    readonly root: TerraformDriftRoot;
    readonly stateIdentity: string;
    readonly backend: TerraformBackendAuthority;
    readonly controlSourceSha: string;
    readonly frameworkSourceSha: string;
    readonly targetConfigurationSha256: string;
}} TerraformDriftIdentity
 */

/**
 * @typedef {{
    readonly runnerSourceSha: string;
    readonly terraformVersion: string;
    readonly terraformPlanFormatVersion: string;
}} TerraformDriftToolRuntime
 */

/**
 * @typedef {{
    readonly evidenceType: 'terraform-drift-report';
    readonly executionId: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly reportOnly: true;
}} TerraformDriftEvidenceBase
 */

/**
 * @typedef {TerraformDriftEvidenceBase & {
    readonly acceptedAuthority: ImmutableObjectReference;
    readonly buildRuntime: TerraformDriftBuildRuntime;
    readonly observed: TerraformDriftIdentity;
    readonly result: 'no-drift' | 'drift-detected';
    readonly terraformDetailedExitCode: 0 | 2;
    readonly failureStage: null;
    readonly summary: TerraformDriftSummary;
    readonly toolRuntime: TerraformDriftToolRuntime;
}} TerraformDriftSuccessfulEvidence
 */

/**
 * @typedef {TerraformDriftEvidenceBase & {
    readonly acceptedAuthority: ImmutableObjectReference | null;
    readonly buildRuntime: TerraformDriftBuildRuntime | null;
    readonly observed: TerraformDriftIdentity | null;
    readonly result: 'check-failed';
    readonly terraformDetailedExitCode: number | null;
    readonly failureStage: TerraformDriftFailureStage;
    readonly summary: null;
    readonly toolRuntime: TerraformDriftToolRuntime | null;
}} TerraformDriftFailedEvidence
 */

/**
 * @typedef {TerraformDriftSuccessfulEvidence | TerraformDriftFailedEvidence} TerraformDriftEvidence
 */

/**
 * @typedef {{
    readonly acceptedAuthority: ImmutableObjectReference | null;
    readonly buildRuntime: TerraformDriftBuildRuntime | null;
    readonly expectedIdentity: TerraformDriftIdentity | null;
    readonly observed: TerraformDriftIdentity | null;
    readonly executionId: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly terraformDetailedExitCode: number | null;
    readonly failureStage: TerraformDriftFailureStage | null;
    readonly summary: TerraformDriftSummary | null;
    readonly toolRuntime: TerraformDriftToolRuntime | null;
}} TerraformDriftEvidenceInput
 */

import { isDeepStrictEqual } from 'node:util';
import {
  deepFreeze,
  hasControlCharacter,
  isPlainRecord,
  parseFullSourceSha,
  parseImmutableObjectReference,
  parseSha256,
  requireExactKeys,
  requireString,
} from './internal.js';
import { isManagedCodeBuildImageIdentifier } from './source-path-build-authority.js';
import { validateTerraformBackendAuthority } from './terraform-authority.js';

export const MAX_REDACTED_TERRAFORM_ADDRESSES = 100;
export const MAX_SAVED_PLAN_REVIEW_ADDRESSES = 1_000;

const REPORTED_ACTION_ORDER = ['create', 'update', 'replace', 'delete', 'read-only'];
const MAX_TERRAFORM_ADDRESS_BYTES = 4_096;
const MAX_REDACTED_ADDRESS_BYTES = 1_024;
/** @type {readonly ['create', 'update', 'replace', 'delete', 'read-only']} */
const ACTION_CLASSES = ['create', 'update', 'replace', 'delete', 'read-only'];
const DRIFT_IDENTITY_KEYS = [
  'accountId',
  'backend',
  'controlSourceSha',
  'frameworkSourceSha',
  'region',
  'root',
  'stateIdentity',
  'targetConfigurationSha256',
];
const DRIFT_SUMMARY_KEYS = ['actionCounts', 'addresses', 'omittedAddressCount'];
const ACTION_COUNTS_KEYS = ['create', 'delete', 'readOnly', 'replace', 'update'];
const BUILD_RUNTIME_KEYS = ['configuredManagedImage', 'runningManagedImage'];
const TOOL_RUNTIME_KEYS = ['runnerSourceSha', 'terraformPlanFormatVersion', 'terraformVersion'];
const DRIFT_EVIDENCE_KEYS = [
  'acceptedAuthority',
  'buildRuntime',
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
  'acceptedAuthority',
  'buildRuntime',
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

/** @param {unknown} value @returns {value is TerraformDriftActionClass} */
function isTerraformDriftActionClass(value) {
  return typeof value === 'string' && ACTION_CLASSES.some((actionClass) => actionClass === value);
}

/** @param {unknown} value @returns {TerraformDriftActionClass} */
function parseTerraformDriftActionClass(value) {
  if (!isTerraformDriftActionClass(value)) {
    throw new Error('Terraform drift action class is invalid.');
  }
  return value;
}

/** @param {unknown} value @param {string} label @returns {TerraformDriftRoot} */
function parseTerraformDriftRoot(value, label) {
  switch (value) {
    case 'app':
    case 'bootstrap':
    case 'foundation':
      return value;
    default:
      throw new Error(`${label} root is invalid.`);
  }
}

/** @param {unknown} value @returns {TerraformDriftFailureStage} */
function parseTerraformDriftFailureStage(value) {
  switch (value) {
    case 'authority-selection':
    case 'authority-admission':
    case 'source-checkout':
    case 'identity-admission':
    case 'provider-initialization':
    case 'runner-runtime':
    case 'plan-input-preparation':
    case 'terraform-plan':
    case 'plan-summary':
      return value;
    default:
      throw new Error('Terraform drift failureStage is invalid.');
  }
}

/** @param {unknown} value @returns {TerraformDriftResult} */
function parseTerraformDriftResult(value) {
  switch (value) {
    case 'no-drift':
    case 'drift-detected':
    case 'check-failed':
      return value;
    default:
      throw new Error('Terraform drift result is invalid.');
  }
}

/** @param {unknown} value @returns {number | null} */
function parseTerraformDetailedExitCode(value) {
  classifyTerraformDetailedExitCode(value);
  if (value === null || typeof value === 'number') {
    return value;
  }
  throw new Error('Terraform detailed exit code is invalid.');
}

/**
 * @param {unknown} value
 * @returns {TerraformDriftResult}
 */
export function classifyTerraformDetailedExitCode(value) {
  if (value === null) {
    return 'check-failed';
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 255) {
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

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function requireRecord(value, label) {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} record
 * @param {PropertyKey} key
 * @param {string} label
 * @returns {unknown}
 */
function requireDataProperty(record, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(`${label} must be an enumerable data property.`);
  }
  return descriptor.value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {unknown[]}
 */
function denseDataArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a dense data-property array.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value')) {
    throw new Error(`${label} must be a dense data-property array.`);
  }
  /** @type {unknown[]} */
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

/**
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function exactKeys(value, keys, label) {
  try {
    return requireExactKeys(value, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function nonNegativeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
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

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {TerraformDriftIdentity}
 */
function parseDriftIdentity(value, label) {
  const identity = exactKeys(value, DRIFT_IDENTITY_KEYS, label);
  const root = parseTerraformDriftRoot(identity['root'], label);
  const accountId = requireString(identity['accountId'], `${label} accountId`, /^[0-9]{12}$/u);
  const region = requireString(identity['region'], `${label} region`, /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/u);
  const stateIdentity = requireString(
    identity['stateIdentity'],
    `${label} stateIdentity`,
    /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/(?:app|bootstrap|foundation)$/u,
  );
  if (!stateIdentity.endsWith(`/${root}`)) {
    throw new Error(`${label} stateIdentity does not match root.`);
  }
  let backend;
  try {
    backend = validateTerraformBackendAuthority(identity['backend'], root, stateIdentity.slice(0, -root.length - 1));
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
    controlSourceSha: parseFullSourceSha(identity['controlSourceSha'], `${label} controlSourceSha`),
    frameworkSourceSha: parseFullSourceSha(identity['frameworkSourceSha'], `${label} frameworkSourceSha`),
    targetConfigurationSha256: parseSha256(identity['targetConfigurationSha256'], `${label} targetConfigurationSha256`),
  });
}

/**
 * @param {unknown} value
 * @returns {TerraformDriftSummary}
 */
function parseDriftSummary(value) {
  const summary = exactKeys(value, DRIFT_SUMMARY_KEYS, 'Terraform drift summary');
  const rawCounts = exactKeys(summary['actionCounts'], ACTION_COUNTS_KEYS, 'Terraform drift action counts');
  const actionCounts = {
    create: nonNegativeInteger(rawCounts['create'], 'Terraform drift create count'),
    update: nonNegativeInteger(rawCounts['update'], 'Terraform drift update count'),
    replace: nonNegativeInteger(rawCounts['replace'], 'Terraform drift replace count'),
    delete: nonNegativeInteger(rawCounts['delete'], 'Terraform drift delete count'),
    readOnly: nonNegativeInteger(rawCounts['readOnly'], 'Terraform drift readOnly count'),
  };
  const rawAddresses = denseDataArray(summary['addresses'], 'Terraform drift addresses');
  if (rawAddresses.length > MAX_REDACTED_TERRAFORM_ADDRESSES) {
    throw new Error('Terraform drift addresses are invalid.');
  }
  const addresses = rawAddresses.map((entry, index) => {
    const addressEntry = exactKeys(entry, ['actionClasses', 'address'], `Terraform drift address ${index}`);
    const address = redactTerraformResourceAddressWithPolicy(addressEntry['address'], true);
    if (address !== addressEntry['address']) {
      throw new Error(`Terraform drift address ${index} is not redacted.`);
    }
    const rawActionClasses = denseDataArray(
      addressEntry['actionClasses'],
      `Terraform drift address ${index} action classes`,
    );
    if (rawActionClasses.length === 0 || rawActionClasses.some((action) => !isTerraformDriftActionClass(action))) {
      throw new Error(`Terraform drift address ${index} action classes are invalid.`);
    }
    const actionClasses = rawActionClasses
      .map(parseTerraformDriftActionClass)
      .sort((left, right) => REPORTED_ACTION_ORDER.indexOf(left) - REPORTED_ACTION_ORDER.indexOf(right));
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
  const omittedAddressCount = nonNegativeInteger(summary['omittedAddressCount'], 'Terraform drift omittedAddressCount');
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

/**
 * @param {unknown} value
 * @returns {TerraformDriftSummary}
 */
export function validateTerraformDriftSummary(value) {
  return parseDriftSummary(value);
}

/**
 * @param {unknown} value
 * @returns {TerraformDriftToolRuntime}
 */
function parseToolRuntime(value) {
  const runtime = exactKeys(value, TOOL_RUNTIME_KEYS, 'Terraform drift tool runtime');
  return deepFreeze({
    runnerSourceSha: parseFullSourceSha(runtime['runnerSourceSha'], 'Terraform drift runner source SHA'),
    terraformVersion: requireString(
      runtime['terraformVersion'],
      'Terraform drift Terraform version',
      TERRAFORM_VERSION_PATTERN,
    ),
    terraformPlanFormatVersion: requireString(
      runtime['terraformPlanFormatVersion'],
      'Terraform drift plan format version',
      TERRAFORM_PLAN_FORMAT_PATTERN,
    ),
  });
}

/**
 * @param {unknown} value
 * @returns {TerraformDriftBuildRuntime}
 */
function parseBuildRuntime(value) {
  const runtime = exactKeys(value, BUILD_RUNTIME_KEYS, 'Terraform drift build runtime');
  const configuredManagedImage = runtime['configuredManagedImage'];
  if (!isManagedCodeBuildImageIdentifier(configuredManagedImage)) {
    throw new Error('Terraform drift configured build image is not an admitted AWS-managed image.');
  }
  const runningManagedImage = runtime['runningManagedImage'];
  if (!isManagedCodeBuildImageIdentifier(runningManagedImage)) {
    throw new Error('Terraform drift running build image is not an admitted AWS-managed image.');
  }
  return deepFreeze({ configuredManagedImage, runningManagedImage });
}

/**
 * @param {unknown} value
 * @returns {TerraformDriftFailureStage | null}
 */
function parseFailureStage(value) {
  if (value === null) {
    return null;
  }
  return parseTerraformDriftFailureStage(value);
}

/**
 * @param {unknown} value
 * @returns {ImmutableObjectReference | null}
 */
function parseNullableReference(value) {
  return value === null ? null : parseImmutableObjectReference(value);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {TerraformDriftIdentity | null}
 */
function parseNullableIdentity(value, label) {
  return value === null ? null : parseDriftIdentity(value, label);
}

/**
 * @param {unknown} value
 * @returns {TerraformDriftSummary | null}
 */
function parseNullableSummary(value) {
  return value === null ? null : parseDriftSummary(value);
}

/**
 * @param {unknown} value
 * @returns {TerraformDriftToolRuntime | null}
 */
function parseNullableToolRuntime(value) {
  return value === null ? null : parseToolRuntime(value);
}

/**
 * @param {unknown} value
 * @returns {TerraformDriftBuildRuntime | null}
 */
function parseNullableBuildRuntime(value) {
  return value === null ? null : parseBuildRuntime(value);
}

/**
 * @param {ImmutableObjectReference | null} acceptedAuthority
 * @param {TerraformDriftIdentity | null} observed
 * @param {TerraformDriftSummary | null} summary
 * @param {TerraformDriftToolRuntime | null} toolRuntime
 * @param {TerraformDriftBuildRuntime | null} buildRuntime
 * @returns {{ acceptedAuthority: ImmutableObjectReference, buildRuntime: TerraformDriftBuildRuntime, observed: TerraformDriftIdentity, summary: TerraformDriftSummary, toolRuntime: TerraformDriftToolRuntime }}
 */
function requireSuccessfulEvidenceCoordinates(acceptedAuthority, observed, summary, toolRuntime, buildRuntime) {
  if (
    acceptedAuthority === null ||
    observed === null ||
    summary === null ||
    toolRuntime === null ||
    buildRuntime === null
  ) {
    throw new Error('Successful Terraform drift evidence requires complete admitted coordinates.');
  }
  return { acceptedAuthority, buildRuntime, observed, summary, toolRuntime };
}

/**
 * @param {ImmutableObjectReference | null} acceptedAuthority
 * @param {TerraformDriftIdentity | null} observed
 * @param {TerraformDriftSummary | null} summary
 * @returns {void}
 */
function assertFailedEvidenceCoordinates(acceptedAuthority, observed, summary) {
  if (summary !== null) {
    throw new Error('Failed Terraform drift evidence must not claim a plan summary.');
  }
  if (acceptedAuthority === null && observed !== null) {
    throw new Error('Terraform drift observed coordinates require an admitted accepted authority reference.');
  }
}

/**
 * @param {unknown} value
 * @returns {TerraformDriftActionClass | null}
 */
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

/**
 * @param {unknown} value
 * @param {boolean} allowRedactedWildcard
 * @returns {string}
 */
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

/**
 * @param {unknown} value
 * @returns {string}
 */
export function redactTerraformResourceAddress(value) {
  return redactTerraformResourceAddressWithPolicy(value, false);
}

/**
 * @param {unknown} value
 * @param {'drift-report' | 'saved-plan-review'} [purpose]
 * @returns {TerraformDriftSummary}
 */
export function summarizeTerraformPlan(value, purpose = 'drift-report') {
  if (purpose !== 'drift-report' && purpose !== 'saved-plan-review') {
    throw new Error('Terraform plan summary purpose is invalid.');
  }
  const addressLimit =
    purpose === 'saved-plan-review' ? MAX_SAVED_PLAN_REVIEW_ADDRESSES : MAX_REDACTED_TERRAFORM_ADDRESSES;
  const plan = requireRecord(value, 'Terraform plan JSON');
  const resourceChangesDescriptor = Object.getOwnPropertyDescriptor(plan, 'resource_changes');
  const resourceChanges = denseDataArray(
    resourceChangesDescriptor === undefined ? [] : resourceChangesDescriptor.value,
    'Terraform plan JSON resource_changes',
  );

  const actionCounts = { create: 0, update: 0, replace: 0, delete: 0, readOnly: 0 };
  /** @type {Map<string, Set<TerraformDriftActionClass>>} */
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
    .slice(0, addressLimit)
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

/**
 * @param {unknown} value
 * @returns {TerraformDriftEvidence}
 */
export function validateTerraformDriftEvidence(value) {
  const evidence = exactKeys(value, DRIFT_EVIDENCE_KEYS, 'Terraform drift evidence');
  if (evidence['evidenceType'] !== 'terraform-drift-report') {
    throw new Error('Terraform drift evidenceType is invalid.');
  }
  if (evidence['reportOnly'] !== true) {
    throw new Error('Terraform drift evidence must be report-only.');
  }
  const executionId = requireString(
    evidence['executionId'],
    'Terraform drift executionId',
    OPERATIONAL_IDENTIFIER_PATTERN,
  );
  const startedAt = canonicalTimestamp(evidence['startedAt'], 'Terraform drift startedAt');
  const finishedAt = canonicalTimestamp(evidence['finishedAt'], 'Terraform drift finishedAt');
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error('Terraform drift finishedAt must not precede startedAt.');
  }
  const terraformDetailedExitCode = parseTerraformDetailedExitCode(evidence['terraformDetailedExitCode']);
  const mappedResult = classifyTerraformDetailedExitCode(terraformDetailedExitCode);
  const failureStage = parseFailureStage(evidence['failureStage']);
  const acceptedAuthority = parseNullableReference(evidence['acceptedAuthority']);
  const buildRuntime = parseNullableBuildRuntime(evidence['buildRuntime']);
  const observed = parseNullableIdentity(evidence['observed'], 'Terraform drift observed identity');
  const summary = parseNullableSummary(evidence['summary']);
  const toolRuntime = parseNullableToolRuntime(evidence['toolRuntime']);
  const result = parseTerraformDriftResult(evidence['result']);

  if (failureStage === null) {
    if (mappedResult === 'check-failed' || result !== mappedResult) {
      throw new Error('Terraform drift result does not match its detailed exit code.');
    }
    const coordinates = requireSuccessfulEvidenceCoordinates(
      acceptedAuthority,
      observed,
      summary,
      toolRuntime,
      buildRuntime,
    );
    if (
      result === 'no-drift' &&
      (coordinates.summary.actionCounts['create'] !== 0 ||
        coordinates.summary.actionCounts['update'] !== 0 ||
        coordinates.summary.actionCounts['replace'] !== 0 ||
        coordinates.summary.actionCounts['delete'] !== 0)
    ) {
      throw new Error('Terraform no-drift evidence cannot contain mutating resource actions.');
    }
    if (terraformDetailedExitCode !== 0 && terraformDetailedExitCode !== 2) {
      throw new Error('Successful Terraform drift evidence requires a successful detailed exit code.');
    }
    return deepFreeze({
      evidenceType: 'terraform-drift-report',
      executionId,
      acceptedAuthority: coordinates.acceptedAuthority,
      buildRuntime: coordinates.buildRuntime,
      observed: coordinates.observed,
      startedAt,
      finishedAt,
      result,
      terraformDetailedExitCode,
      failureStage: null,
      summary: coordinates.summary,
      reportOnly: true,
      toolRuntime: coordinates.toolRuntime,
    });
  }

  if (result !== 'check-failed') {
    throw new Error('Terraform drift failureStage requires check-failed result.');
  }
  assertFailedEvidenceCoordinates(acceptedAuthority, observed, summary);
  return deepFreeze({
    evidenceType: 'terraform-drift-report',
    executionId,
    acceptedAuthority,
    buildRuntime,
    observed,
    startedAt,
    finishedAt,
    result: 'check-failed',
    terraformDetailedExitCode,
    failureStage,
    summary: null,
    reportOnly: true,
    toolRuntime,
  });
}

/**
 * @param {unknown} value
 * @returns {TerraformDriftEvidence}
 */
export function buildTerraformDriftEvidence(value) {
  const input = exactKeys(value, DRIFT_EVIDENCE_INPUT_KEYS, 'Terraform drift evidence input');
  const acceptedAuthority = parseNullableReference(input['acceptedAuthority']);
  const buildRuntime = parseNullableBuildRuntime(input['buildRuntime']);
  const expectedIdentity = parseNullableIdentity(input['expectedIdentity'], 'Terraform drift expected identity');
  const observed = parseNullableIdentity(input['observed'], 'Terraform drift observed identity');
  const summary = parseNullableSummary(input['summary']);
  const toolRuntime = parseNullableToolRuntime(input['toolRuntime']);
  const terraformDetailedExitCode = input['terraformDetailedExitCode'];
  const mappedResult = classifyTerraformDetailedExitCode(terraformDetailedExitCode);
  let failureStage = parseFailureStage(input['failureStage']);
  if (mappedResult === 'check-failed' && failureStage === null) {
    if (terraformDetailedExitCode === null) {
      throw new Error('A pre-Terraform check failure requires an explicit failureStage.');
    }
    failureStage = 'terraform-plan';
  }
  const result = failureStage === null ? mappedResult : 'check-failed';

  if (result === 'check-failed') {
    if (acceptedAuthority === null && expectedIdentity !== null) {
      throw new Error('Terraform drift expected identity requires an admitted accepted authority reference.');
    }
    if (observed !== null && expectedIdentity === null) {
      throw new Error('Terraform drift observed identity requires an expected identity.');
    }
    assertFailedEvidenceCoordinates(acceptedAuthority, observed, summary);
  } else {
    if (expectedIdentity === null || !isDeepStrictEqual(expectedIdentity, observed)) {
      throw new Error('Terraform drift observed identity does not match the accepted authority identity.');
    }
    requireSuccessfulEvidenceCoordinates(acceptedAuthority, observed, summary, toolRuntime, buildRuntime);
  }

  return validateTerraformDriftEvidence({
    evidenceType: 'terraform-drift-report',
    executionId: input['executionId'],
    acceptedAuthority,
    buildRuntime,
    observed,
    startedAt: input['startedAt'],
    finishedAt: input['finishedAt'],
    result,
    terraformDetailedExitCode,
    failureStage,
    summary,
    reportOnly: true,
    toolRuntime,
  });
}
