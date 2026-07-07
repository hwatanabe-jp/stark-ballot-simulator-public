import type { FinalizationScenarioContext } from '@stark-ballot/domain/types/server';
import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import type { ZkVMInput, VoteWithProof } from '@stark-ballot/zkvm-contract/zkvm/types';
import { assertZkvmWireNumericPreflight } from '@stark-ballot/zkvm-contract/zkvm/wire-numeric-preflight';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@stark-ballot/domain/utils/hex';
import { SAFE_VERIFIER_SEGMENT_PATTERN } from '@stark-ballot/validation/safe-verifier-segment';

export const PROVER_WORK_MESSAGE_VERSION = 'v1.1' as const;
type ScenarioCode = `S${0 | 1 | 2 | 3 | 4 | 5}`;

export type ProverWorkMessage = {
  messageVersion: typeof PROVER_WORK_MESSAGE_VERSION;
  sessionId: string;
  contractGeneration: string;
  executionId: string;
  queuedAt: number;
  zkvmInput?: ZkVMInput;
  expectedImageId: string;
  zkvmInputCommitment?: string;
  electionConfig?: ElectionConfig;
  inputS3Key?: string;
  outputS3Prefix?: string;
  bundleS3Key?: string;
  scenarios: ScenarioCode[];
  simulateTampering: boolean;
  scenarioContext?: FinalizationScenarioContext;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_KEYS = new Set([
  'messageVersion',
  'sessionId',
  'contractGeneration',
  'executionId',
  'queuedAt',
  'zkvmInput',
  'expectedImageId',
  'zkvmInputCommitment',
  'electionConfig',
  'inputS3Key',
  'outputS3Prefix',
  'bundleS3Key',
  'scenarios',
  'simulateTampering',
  'scenarioContext',
]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function parseOptionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseNonEmptyString(value, label);
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

function parseBooleanDefault(value: unknown, label: string, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
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
  if (value === undefined) {
    return [];
  }
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
    tamperMode:
      record['tamperMode'] === 'none' || record['tamperMode'] === 'input' || record['tamperMode'] === 'claim'
        ? record['tamperMode']
        : (() => {
            throw new Error('tamperMode must be none, input, or claim');
          })(),
    claimedCounts: parseClaimedCounts(record['claimedCounts']),
    claimedTotalVotes: parseInteger(record['claimedTotalVotes'], 'claimedTotalVotes', { min: 0 }),
    summary: {
      ignoredCount: parseInteger(summary['ignoredCount'], 'ignoredCount', { min: 0 }),
      recountedCount: parseInteger(summary['recountedCount'], 'recountedCount', { min: 0 }),
      userRecountChoice:
        summary['userRecountChoice'] === null ||
        summary['userRecountChoice'] === 'A' ||
        summary['userRecountChoice'] === 'B' ||
        summary['userRecountChoice'] === 'C' ||
        summary['userRecountChoice'] === 'D' ||
        summary['userRecountChoice'] === 'E'
          ? summary['userRecountChoice']
          : (() => {
              throw new Error('userRecountChoice must be a vote choice or null');
            })(),
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
  assertOnlyKeys(record, MESSAGE_KEYS, 'Prover work message');
  if (record['messageVersion'] !== PROVER_WORK_MESSAGE_VERSION) {
    throw new Error('messageVersion must be v1.1');
  }

  const zkvmInput = parseZkvmInput(record['zkvmInput']);
  const electionConfig = parseElectionConfig(record['electionConfig']);
  const inputS3Key = parseOptionalNonEmptyString(record['inputS3Key'], 'inputS3Key');
  const outputS3Prefix = parseOptionalNonEmptyString(record['outputS3Prefix'], 'outputS3Prefix');
  const bundleS3Key = parseOptionalNonEmptyString(record['bundleS3Key'], 'bundleS3Key');
  const hasArtifactKeys = Boolean(inputS3Key && outputS3Prefix && bundleS3Key);
  const hasInlineProverInput = Boolean(zkvmInput && electionConfig);

  if (!hasArtifactKeys && !hasInlineProverInput) {
    throw new Error('Prover work message must include either target S3 artifact keys or inline prover input.');
  }
  const zkvmInputCommitment =
    record['zkvmInputCommitment'] !== undefined
      ? parseOptionalHexString(record['zkvmInputCommitment'], 32, 'zkvmInputCommitment')
      : undefined;
  const scenarioContext =
    record['scenarioContext'] !== undefined ? parseScenarioContext(record['scenarioContext']) : undefined;

  return {
    messageVersion: PROVER_WORK_MESSAGE_VERSION,
    sessionId: parseSafeSegment(record['sessionId'], 'sessionId', { uuid: true }),
    contractGeneration: parseNonEmptyString(record['contractGeneration'], 'contractGeneration'),
    executionId: parseSafeSegment(record['executionId'], 'executionId', { minLength: 10 }),
    queuedAt: parseInteger(record['queuedAt'], 'queuedAt', { min: 0 }),
    ...(zkvmInput ? { zkvmInput } : {}),
    expectedImageId: parseHexString(record['expectedImageId'], 32, 'expectedImageId'),
    ...(zkvmInputCommitment ? { zkvmInputCommitment } : {}),
    ...(electionConfig ? { electionConfig } : {}),
    ...(inputS3Key ? { inputS3Key } : {}),
    ...(outputS3Prefix ? { outputS3Prefix } : {}),
    ...(bundleS3Key ? { bundleS3Key } : {}),
    scenarios: parseScenarioCodes(record['scenarios']),
    simulateTampering: parseBooleanDefault(record['simulateTampering'], 'simulateTampering', false),
    ...(scenarioContext ? { scenarioContext } : {}),
  };
}
