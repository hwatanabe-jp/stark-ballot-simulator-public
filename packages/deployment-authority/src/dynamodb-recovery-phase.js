import { isDeepStrictEqual } from 'node:util';
import { deepFreeze, parseImmutableObjectReference, requireExactKeys } from './internal.js';

export const DYNAMODB_RECOVERY_PHASES = Object.freeze([
  'primary_active',
  'primary_quiesced',
  'replacement_quiesced',
  'replacement_active',
]);

function exactRecord(value, keys, label) {
  try {
    return requireExactKeys(value, keys, label);
  } catch {
    throw new Error(`${label} must use the exact current shape.`);
  }
}

export function parseDynamoDbRecoveryPhase(value) {
  if (!DYNAMODB_RECOVERY_PHASES.includes(value)) {
    throw new Error('DynamoDB recovery phase is invalid.');
  }
  return value;
}

export function validateDynamoDbRecoverySelection(value) {
  const record = exactRecord(value, ['manifest', 'phase'], 'DynamoDB recovery selection');
  const phase = parseDynamoDbRecoveryPhase(record.phase);
  if (phase === 'primary_active') {
    if (record.manifest !== null) {
      throw new Error('primary_active must not select a DynamoDB recovery manifest.');
    }
    return deepFreeze({ phase, manifest: null });
  }
  if (record.manifest === null) {
    throw new Error('DynamoDB recovery transition phases require an exact recovery manifest.');
  }
  return deepFreeze({
    phase,
    manifest: parseImmutableObjectReference(record.manifest),
  });
}

function allowedNextPhases(current) {
  if (current === null) {
    return Object.freeze(['primary_active']);
  }
  const currentIndex = DYNAMODB_RECOVERY_PHASES.indexOf(current.phase);
  return Object.freeze(DYNAMODB_RECOVERY_PHASES.filter((_phase, index) => Math.abs(index - currentIndex) <= 1));
}

export function evaluateDynamoDbRecoveryPhaseTransition(value) {
  const record = exactRecord(value, ['current', 'requested'], 'DynamoDB recovery phase transition');
  const current = record.current === null ? null : validateDynamoDbRecoverySelection(record.current);
  const requested = validateDynamoDbRecoverySelection(record.requested);
  const allowedNext = allowedNextPhases(current);

  if (current === null) {
    if (requested.phase !== 'primary_active') {
      throw new Error('Initial DynamoDB recovery authority must use primary_active.');
    }
    return deepFreeze({
      current,
      requested,
      disposition: 'initial',
      allowedNextPhases: allowedNext,
    });
  }

  const currentIndex = DYNAMODB_RECOVERY_PHASES.indexOf(current.phase);
  const requestedIndex = DYNAMODB_RECOVERY_PHASES.indexOf(requested.phase);
  const phaseDelta = requestedIndex - currentIndex;
  if (Math.abs(phaseDelta) > 1) {
    throw new Error('DynamoDB recovery phases may change by only one adjacent phase.');
  }
  if (
    current.manifest !== null &&
    requested.manifest !== null &&
    !isDeepStrictEqual(current.manifest, requested.manifest)
  ) {
    throw new Error('DynamoDB recovery manifest must remain exact across selected recovery phases.');
  }

  return deepFreeze({
    current,
    requested,
    disposition: phaseDelta === 0 ? 'idempotent' : phaseDelta === 1 ? 'forward' : 'reverse',
    allowedNextPhases: allowedNext,
  });
}
