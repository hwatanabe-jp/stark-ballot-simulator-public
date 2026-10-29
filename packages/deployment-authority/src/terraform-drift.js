import { hasDenseArrayOwnKeys, deepFreeze, hasControlCharacter, isPlainRecord, requireExactKeys } from './internal.js';
import { admitArrayOwnMetadata, copyArrayDataEntries, requireEnumerableDataProperty } from './descriptor-snapshot.js';
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

import { isDeepStrictEqual } from 'node:util';

export const MAX_REDACTED_TERRAFORM_ADDRESSES = 100;
const MAX_SAVED_PLAN_REVIEW_ADDRESSES = 1_000;

const REPORTED_ACTION_ORDER = ['create', 'update', 'replace', 'delete', 'read-only'];
const MAX_TERRAFORM_ADDRESS_BYTES = 4_096;
const MAX_REDACTED_ADDRESS_BYTES = 1_024;
/** @type {readonly ['create', 'update', 'replace', 'delete', 'read-only']} */
const ACTION_CLASSES = ['create', 'update', 'replace', 'delete', 'read-only'];

const DRIFT_SUMMARY_KEYS = ['actionCounts', 'addresses', 'omittedAddressCount'];
const ACTION_COUNTS_KEYS = ['create', 'delete', 'readOnly', 'replace', 'update'];
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
  return requireEnumerableDataProperty(record, key, `${label} must be an enumerable data property.`);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {unknown[]}
 */
function denseDataArray(value, label) {
  const { array, ownKeys } = admitArrayOwnMetadata(value, `${label} must be a dense data-property array.`);
  const entries = copyArrayDataEntries(array, array.length, `${label} must be a dense data-property array.`);
  if (!hasDenseArrayOwnKeys(ownKeys, array.length)) {
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
  const addresses = admitDriftAddresses(summary['addresses']);
  const omittedAddressCount = nonNegativeInteger(summary['omittedAddressCount'], 'Terraform drift omittedAddressCount');
  assertDriftAddressCounts(actionCounts, addresses, omittedAddressCount);
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
  const address = admitUnredactedAddress(value);

  let redacted = '';
  let index = 0;
  while (index < address.length) {
    const character = address[index];
    if (character !== '[') {
      if (character === undefined || !/[A-Za-z0-9_.-]/u.test(character)) {
        throw new Error('Terraform resource address is invalid.');
      }
      redacted += character;
      index += 1;
      continue;
    }

    const contentStart = index + 1;
    const closingIndex = findAddressIndexEnd(address, contentStart);
    if (!isValidAddressIndex(address.slice(contentStart, closingIndex), allowRedactedWildcard)) {
      throw new Error('Terraform resource address is invalid.');
    }
    redacted += '[*]';
    index = closingIndex + 1;
  }

  assertRedactedAddressShape(redacted);
  return redacted;
}

/** @param {string} value @param {number} start */
function findAddressQuotedStringEnd(value, start) {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === '\\') index += 1;
    else if (value[index] === '"') return index;
  }
  throw new Error('Terraform resource address is invalid.');
}

/** @param {string} value @param {number} start */
function findAddressIndexEnd(value, start) {
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') index = findAddressQuotedStringEnd(value, index + 1);
    else if (character === ']') return index;
    else if (character === '[') throw new Error('Terraform resource address is invalid.');
  }
  throw new Error('Terraform resource address is invalid.');
}

/** @param {string} value @param {boolean} allowRedactedWildcard */
function isValidAddressIndex(value, allowRedactedWildcard) {
  if ((allowRedactedWildcard && value === '*') || /^(?:0|[1-9][0-9]*)$/u.test(value)) return true;
  if (!value.startsWith('"') || !value.endsWith('"')) return false;
  try {
    return typeof JSON.parse(value) === 'string';
  } catch {
    return false;
  }
}

/** @param {string} redacted */
function assertRedactedAddressShape(redacted) {
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

/** @param {unknown} value */
function admitDriftAddresses(value) {
  const rawAddresses = denseDataArray(value, 'Terraform drift addresses');
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
  return addresses;
}
/** @param {TerraformDriftSummary['actionCounts']} actionCounts @param {TerraformDriftSummary['addresses']} addresses @param {number} omittedAddressCount */
function assertDriftAddressCounts(actionCounts, addresses, omittedAddressCount) {
  const totalActionCount = Object.values(actionCounts).reduce((total, count) => total + count, 0);
  assertDriftActionClassCounts(actionCounts, addresses);
  if (addresses.length + omittedAddressCount > totalActionCount) {
    throw new Error('Terraform drift address counts exceed the classified actions.');
  }
  if (totalActionCount > 0 && addresses.length + omittedAddressCount === 0) {
    throw new Error('Terraform drift classified actions require represented or omitted addresses.');
  }
  if (totalActionCount === 0 && (addresses.length !== 0 || omittedAddressCount !== 0)) {
    throw new Error('Terraform drift empty action counts must have an empty address set.');
  }
}

/** @param {TerraformDriftSummary['actionCounts']} actionCounts @param {TerraformDriftSummary['addresses']} addresses */
function assertDriftActionClassCounts(actionCounts, addresses) {
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
}

/** @param {unknown} value */
function admitUnredactedAddress(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_TERRAFORM_ADDRESS_BYTES ||
    hasControlCharacter(value)
  ) {
    throw new Error('Terraform resource address is invalid.');
  }

  return value;
}
