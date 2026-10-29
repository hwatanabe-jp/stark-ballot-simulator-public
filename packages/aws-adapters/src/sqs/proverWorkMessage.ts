import { isNonArrayObject as isRecord } from '@stark-ballot/validation/unknown-value-guards';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type {
  FinalizationId,
  FinalizationScenarioContext,
} from '@stark-ballot/application/finalize/finalization-types';
import { asSessionId, type SessionId } from '@stark-ballot/domain/types/identifiers';
import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import type { ZkVMInput, VoteWithProof } from '@stark-ballot/zkvm-contract/zkvm/types';
import { assertZkvmWireNumericPreflight } from '@stark-ballot/zkvm-contract/zkvm/wire-numeric-preflight';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@stark-ballot/crypto-primitives';
import { SAFE_VERIFIER_SEGMENT_PATTERN } from '@stark-ballot/validation/safe-verifier-segment';

export const PROVER_WORK_RECORD_TYPE = 'prover-work' as const;
type ScenarioCode = `S${0 | 1 | 2 | 3 | 4 | 5}`;

type ProverWorkMessageCommon = {
  recordType: typeof PROVER_WORK_RECORD_TYPE;
  sessionId: SessionId;
  finalizationId: FinalizationId;
  queuedAtMs: number;
  expectedImageId: string;
  scenarios: ScenarioCode[];
  simulateTampering: boolean;
  scenarioContext: FinalizationScenarioContext;
};

export type ProverWorkMessage =
  | (ProverWorkMessageCommon & {
      inputSource: 'inline';
      zkvmInput: ZkVMInput;
      zkvmInputCommitment?: string;
      electionConfig: ElectionConfig;
    })
  | (ProverWorkMessageCommon & {
      inputSource: 's3';
      inputS3Key: string;
      outputS3Prefix: string;
      bundleS3Key: string;
    });

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMON_MESSAGE_KEYS = [
  'recordType',
  'inputSource',
  'sessionId',
  'finalizationId',
  'queuedAtMs',
  'expectedImageId',
  'scenarios',
  'simulateTampering',
  'scenarioContext',
] as const;
const INLINE_MESSAGE_KEYS = new Set([...COMMON_MESSAGE_KEYS, 'zkvmInput', 'zkvmInputCommitment', 'electionConfig']);
const S3_MESSAGE_KEYS = new Set([...COMMON_MESSAGE_KEYS, 'inputS3Key', 'outputS3Prefix', 'bundleS3Key']);
const ZKVM_INPUT_KEYS = new Set([
  'electionId',
  'bulletinRoot',
  'treeSize',
  'logId',
  'timestamp',
  'totalExpected',
  'electionConfigHash',
  'votes',
]);
const VOTE_KEYS = new Set(['commitment', 'choice', 'random', 'index', 'merklePath']);
const ELECTION_CONFIG_KEYS = new Set(['totalExpected', 'choices', 'version', 'botCount', 'merkleTreeDepth']);
const SCENARIO_CONTEXT_KEYS = new Set(['scenarios', 'tamperMode', 'claimedCounts', 'claimedTotalVotes', 'summary']);
const CLAIMED_COUNTS_KEYS = new Set(['A', 'B', 'C', 'D', 'E']);
const SCENARIO_SUMMARY_KEYS = new Set(['ignoredCount', 'recountedCount', 'userRecountChoice', 'affectedBotIds']);

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unsupported field ${key}`);
    }
  }
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function parseInteger(value: unknown, label: string, options: { min?: number; positive?: boolean } = {}): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  const min = options.positive ? 1 : (options.min ?? Number.NEGATIVE_INFINITY);
  if (value < min) {
    throw new Error(`${label} must be ${options.positive ? 'positive' : `at least ${min}`}`);
  }
  return value;
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function parseHexString(value: unknown, bytes: number, label: string): string {
  const raw = parseNonEmptyString(value, label);
  const normalized = addHexPrefix(normalizeHexString(raw));
  if (!isValidHexString(normalized, bytes)) {
    throw new Error(`${label} must be a ${bytes * 2}-character hex string`);
  }
  return normalized;
}

function parseOptionalHexString(value: unknown, bytes: number, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseHexString(value, bytes, label);
}

function parseSafeSegment(value: unknown, label: string, options: { uuid?: boolean; minLength?: number } = {}): string {
  const parsed = parseNonEmptyString(value, label);
  if (options.uuid && !UUID_PATTERN.test(parsed)) {
    throw new Error(`${label} must be a UUID`);
  }
  if (options.minLength !== undefined && parsed.length < options.minLength) {
    throw new Error(`${label} must be at least ${options.minLength} characters`);
  }
  if (!SAFE_VERIFIER_SEGMENT_PATTERN.test(parsed)) {
    throw new Error(`${label} must be a safe single path segment`);
  }
  return parsed;
}

function parseScenarioCode(value: unknown, label: string): ScenarioCode {
  if (value !== 'S0' && value !== 'S1' && value !== 'S2' && value !== 'S3' && value !== 'S4' && value !== 'S5') {
    throw new Error(`${label} must be S0-S5`);
  }
  return value;
}

function parseScenarioCodes(value: unknown): ScenarioCode[] {
  if (!Array.isArray(value)) {
    throw new Error('scenarios must be an array');
  }
  return value.map((entry, index) => parseScenarioCode(entry, `scenarios.${index}`));
}

function parseVoteWithProof(value: unknown): VoteWithProof {
  const record = assertRecord(value, 'vote');
  assertOnlyKeys(record, VOTE_KEYS, 'vote');
  const merklePath = record['merklePath'];
  if (!Array.isArray(merklePath)) {
    throw new Error('merklePath must be an array');
  }
  return {
    commitment: parseHexString(record['commitment'], 32, 'commitment'),
    choice: parseInteger(record['choice'], 'choice', { min: 0 }),
    random: parseHexString(record['random'], 32, 'random'),
    index: parseInteger(record['index'], 'index', { min: 0 }),
    merklePath: merklePath.map((entry, index) => parseHexString(entry, 32, `merklePath.${index}`)),
  };
}

function parseZkvmInput(value: unknown): ZkVMInput | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = assertRecord(value, 'zkvmInput');
  assertOnlyKeys(record, ZKVM_INPUT_KEYS, 'zkvmInput');
  const votes = record['votes'];
  if (!Array.isArray(votes) || votes.length === 0) {
    throw new Error('votes must contain at least one entry');
  }
  const parsedInput = {
    electionId: parseSafeSegment(record['electionId'], 'electionId', { uuid: true }),
    bulletinRoot: parseHexString(record['bulletinRoot'], 32, 'bulletinRoot'),
    treeSize: parseInteger(record['treeSize'], 'treeSize', { positive: true }),
    logId: parseHexString(record['logId'], 32, 'logId'),
    timestamp: parseInteger(record['timestamp'], 'timestamp', { min: 0 }),
    totalExpected: parseInteger(record['totalExpected'], 'totalExpected', { positive: true }),
    electionConfigHash: parseHexString(record['electionConfigHash'], 32, 'electionConfigHash'),
    votes: votes.map(parseVoteWithProof),
  };
  assertZkvmWireNumericPreflight(parsedInput);
  return parsedInput;
}

function parseElectionConfig(value: unknown): ElectionConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = assertRecord(value, 'electionConfig');
  assertOnlyKeys(record, ELECTION_CONFIG_KEYS, 'electionConfig');
  const choices = record['choices'];
  if (!Array.isArray(choices) || choices.length === 0 || !choices.every((choice) => typeof choice === 'string')) {
    throw new Error('choices must not be empty');
  }
  return {
    totalExpected: parseInteger(record['totalExpected'], 'totalExpected', { positive: true }),
    choices,
    version: parseNonEmptyString(record['version'], 'version'),
    botCount: parseInteger(record['botCount'], 'botCount', { min: 0 }),
    merkleTreeDepth: parseInteger(record['merkleTreeDepth'], 'merkleTreeDepth', { positive: true }),
  };
}

function parseClaimedCounts(value: unknown): FinalizationScenarioContext['claimedCounts'] {
  const record = assertRecord(value, 'claimedCounts');
  assertOnlyKeys(record, CLAIMED_COUNTS_KEYS, 'claimedCounts');
  return {
    A: parseInteger(record['A'], 'claimedCounts.A', { min: 0 }),
    B: parseInteger(record['B'], 'claimedCounts.B', { min: 0 }),
    C: parseInteger(record['C'], 'claimedCounts.C', { min: 0 }),
    D: parseInteger(record['D'], 'claimedCounts.D', { min: 0 }),
    E: parseInteger(record['E'], 'claimedCounts.E', { min: 0 }),
  };
}

function parseTamperMode(value: unknown): FinalizationScenarioContext['tamperMode'] {
  if (value === 'none' || value === 'input' || value === 'claim') return value;
  throw new Error('tamperMode must be none, input, or claim');
}

function parseUserRecountChoice(value: unknown): FinalizationScenarioContext['summary']['userRecountChoice'] {
  if (value === null || value === 'A' || value === 'B' || value === 'C' || value === 'D' || value === 'E') return value;
  throw new Error('userRecountChoice must be a vote choice or null');
}

function parseScenarioContext(value: unknown): FinalizationScenarioContext | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = assertRecord(value, 'scenarioContext');
  assertOnlyKeys(record, SCENARIO_CONTEXT_KEYS, 'scenarioContext');
  const summary = assertRecord(record['summary'], 'summary');
  assertOnlyKeys(summary, SCENARIO_SUMMARY_KEYS, 'summary');
  const affectedBotIds = summary['affectedBotIds'];
  if (affectedBotIds !== undefined && !Array.isArray(affectedBotIds)) {
    throw new Error('affectedBotIds must be an array');
  }
  return {
    scenarios: parseScenarioCodes(record['scenarios']),
    tamperMode: parseTamperMode(record['tamperMode']),
    claimedCounts: parseClaimedCounts(record['claimedCounts']),
    claimedTotalVotes: parseInteger(record['claimedTotalVotes'], 'claimedTotalVotes', { min: 0 }),
    summary: {
      ignoredCount: parseInteger(summary['ignoredCount'], 'ignoredCount', { min: 0 }),
      recountedCount: parseInteger(summary['recountedCount'], 'recountedCount', { min: 0 }),
      userRecountChoice: parseUserRecountChoice(summary['userRecountChoice']),
      ...(affectedBotIds
        ? {
            affectedBotIds: affectedBotIds.map((entry, index) =>
              parseInteger(entry, `affectedBotIds.${index}`, { min: 0 }),
            ),
          }
        : {}),
    },
  };
}

export const ProverWorkMessageSchema = {
  parse: parseProverWorkMessage,
};

export function parseProverWorkMessage(input: unknown): ProverWorkMessage {
  const record = assertRecord(input, 'Prover work message');
  if (record['recordType'] !== PROVER_WORK_RECORD_TYPE) {
    throw new Error(`recordType must be ${PROVER_WORK_RECORD_TYPE}`);
  }
  const inputSource = record['inputSource'];
  if (inputSource !== 'inline' && inputSource !== 's3') {
    throw new Error('inputSource must be inline or s3');
  }
  assertOnlyKeys(record, inputSource === 'inline' ? INLINE_MESSAGE_KEYS : S3_MESSAGE_KEYS, 'Prover work message');

  const scenarioContext = parseScenarioContext(record['scenarioContext']);
  if (!scenarioContext) {
    throw new Error('scenarioContext is required');
  }
  const common = {
    recordType: PROVER_WORK_RECORD_TYPE,
    inputSource,
    sessionId: asSessionId(parseSafeSegment(record['sessionId'], 'sessionId', { uuid: true })),
    finalizationId: asFinalizationId(parseSafeSegment(record['finalizationId'], 'finalizationId', { minLength: 10 })),
    queuedAtMs: parseInteger(record['queuedAtMs'], 'queuedAtMs', { min: 0 }),
    expectedImageId: parseHexString(record['expectedImageId'], 32, 'expectedImageId'),
    scenarios: parseScenarioCodes(record['scenarios']),
    simulateTampering: parseBoolean(record['simulateTampering'], 'simulateTampering'),
    scenarioContext,
  };

  if (inputSource === 'inline') {
    const zkvmInput = parseZkvmInput(record['zkvmInput']);
    const electionConfig = parseElectionConfig(record['electionConfig']);
    if (!zkvmInput || !electionConfig) {
      throw new Error('Inline prover input requires zkvmInput and electionConfig');
    }
    const zkvmInputCommitment = parseOptionalHexString(record['zkvmInputCommitment'], 32, 'zkvmInputCommitment');
    return {
      ...common,
      inputSource,
      zkvmInput,
      ...(zkvmInputCommitment ? { zkvmInputCommitment } : {}),
      electionConfig,
    };
  }

  return {
    ...common,
    inputSource,
    inputS3Key: parseNonEmptyString(record['inputS3Key'], 'inputS3Key'),
    outputS3Prefix: parseNonEmptyString(record['outputS3Prefix'], 'outputS3Prefix'),
    bundleS3Key: parseNonEmptyString(record['bundleS3Key'], 'bundleS3Key'),
  };
}
