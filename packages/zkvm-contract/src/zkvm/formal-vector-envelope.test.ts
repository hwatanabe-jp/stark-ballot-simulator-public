import { describe, expect, it } from 'vitest';
import bitmapCasesJson from '../../../../docs/formal/generated-vectors/bitmap-cases.json';
import checkDefinitionsJson from '../../../../docs/formal/generated-vectors/check-definitions.json';
import guestModelCasesJson from '../../../../docs/formal/generated-vectors/guest-model-cases.json';
import inputCommitmentCasesJson from '../../../../docs/formal/generated-vectors/input-commitment-cases.json';
import verificationDisplayCasesJson from '../../../../docs/formal/generated-vectors/verification-display-cases.json';
import verificationSummaryCasesJson from '../../../../docs/formal/generated-vectors/verification-summary-cases.json';
import { parseCurrentFormalVectorEnvelope } from './formal-vectors';
import { CURRENT_METHOD_VERSION, INPUT_COMMITMENT_FORMAT_VERSION, UINT32_MAX, VERIFIED_TALLY_WIDTH } from './types';
import {
  MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD,
  MAX_GUEST_SERIALIZED_INPUT_BYTES,
  MAX_GUEST_TOTAL_EXPECTED,
  MAX_GUEST_TOTAL_PATH_NODES,
  MAX_GUEST_TREE_SIZE,
  MAX_GUEST_VOTE_COUNT,
} from './work-budget';

function cloneUnknown(value: unknown): unknown {
  return structuredClone(value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireArrayProperty(value: unknown, key: string): unknown[] {
  const property = requireObject(value, 'value')[key];
  if (!Array.isArray(property)) {
    throw new Error(`${key} must be an array`);
  }
  return property;
}

const EXPECTED_MODELED_BOUNDS = {
  inputCommitment: {
    formatVersion: INPUT_COMMITMENT_FORMAT_VERSION,
    u16Max: MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD,
    u32Max: UINT32_MAX,
  },
  guest: {
    methodVersion: CURRENT_METHOD_VERSION,
    treeSizeMax: MAX_GUEST_TREE_SIZE,
    totalExpectedMax: MAX_GUEST_TOTAL_EXPECTED,
    voteCountMax: MAX_GUEST_VOTE_COUNT,
    merklePathNodesPerRecordMax: MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD,
    totalMerklePathNodesMax: MAX_GUEST_TOTAL_PATH_NODES,
    serializedInputBytesMax: MAX_GUEST_SERIALIZED_INPUT_BYTES,
    tallyWidth: VERIFIED_TALLY_WIDTH,
    tallyBucketMax: MAX_GUEST_TREE_SIZE,
  },
};

describe('current formal vector envelope admission', () => {
  it('admits all six exact-current Lean-produced envelopes and their modeled bounds', () => {
    const summary = parseCurrentFormalVectorEnvelope(verificationSummaryCasesJson, 'verification-summary-cases');
    const display = parseCurrentFormalVectorEnvelope(verificationDisplayCasesJson, 'verification-display-cases');
    const definitions = parseCurrentFormalVectorEnvelope(checkDefinitionsJson, 'check-definitions');
    const inputCommitment = parseCurrentFormalVectorEnvelope(inputCommitmentCasesJson, 'input-commitment-cases');
    const bitmap = parseCurrentFormalVectorEnvelope(bitmapCasesJson, 'bitmap-cases');
    const guest = parseCurrentFormalVectorEnvelope(guestModelCasesJson, 'guest-model-cases');

    for (const envelope of [summary, display, definitions, inputCommitment, bitmap, guest]) {
      expect(envelope.envelopeType).toBe('stark-ballot.formal-vector.current');
      expect(envelope.modeledBounds).toEqual(EXPECTED_MODELED_BOUNDS);
      expect(envelope.canonicalSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(envelope.payload.length).toBeGreaterThan(0);
    }
  });

  it('rejects unknown envelope and payload keys', () => {
    const unknownEnvelopeKey = cloneUnknown(bitmapCasesJson);
    Reflect.set(requireObject(unknownEnvelopeKey, 'bitmap envelope'), 'schemaVersion', 1);

    expect(() => parseCurrentFormalVectorEnvelope(unknownEnvelopeKey, 'bitmap-cases')).toThrow(/exact keys/u);

    const unknownPayloadKey = cloneUnknown(bitmapCasesJson);
    const firstCase = requireArrayProperty(unknownPayloadKey, 'payload')[0];
    Reflect.set(requireObject(firstCase, 'bitmap case'), 'unexpected', true);

    expect(() => parseCurrentFormalVectorEnvelope(unknownPayloadKey, 'bitmap-cases')).toThrow(/exact keys/u);
  });

  it('rejects discriminator and canonical fingerprint drift', () => {
    expect(() => parseCurrentFormalVectorEnvelope(verificationSummaryCasesJson, 'verification-display-cases')).toThrow(
      /kind/u,
    );

    const driftedPayload = cloneUnknown(inputCommitmentCasesJson);
    const firstCase = requireArrayProperty(driftedPayload, 'payload')[0];
    Reflect.set(requireObject(firstCase, 'input commitment case'), 'name', 'drifted-case');

    expect(() => parseCurrentFormalVectorEnvelope(driftedPayload, 'input-commitment-cases')).toThrow(
      /canonicalSha256/u,
    );
  });

  it('uses no repository-owned numeric generation marker', () => {
    const envelopes = [
      verificationSummaryCasesJson,
      verificationDisplayCasesJson,
      checkDefinitionsJson,
      inputCommitmentCasesJson,
      bitmapCasesJson,
      guestModelCasesJson,
    ];

    for (const value of envelopes) {
      const envelope = requireObject(value, 'formal vector envelope');
      expect(Object.keys(envelope)).not.toContain('schemaVersion');
      expect(envelope['envelopeType']).toBe('stark-ballot.formal-vector.current');
      expect(envelope['kind']).not.toMatch(/-v\d+$/u);
    }
  });
});
