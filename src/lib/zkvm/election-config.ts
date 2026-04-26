import { createHash } from 'crypto';
import { BOT_COUNT, MERKLE_TREE_DEPTH, VOTE_CHOICES } from '@/shared/constants';
import { normalizeHexString } from '@/lib/utils/hex';

export interface ElectionConfig {
  totalExpected: number;
  choices: readonly string[];
  version: string;
  botCount: number;
  merkleTreeDepth: number;
}

export const ELECTION_VERSION = 'v1.0';

export function buildDefaultElectionConfig(): ElectionConfig {
  return {
    totalExpected: BOT_COUNT + 1,
    choices: VOTE_CHOICES,
    version: ELECTION_VERSION,
    botCount: BOT_COUNT,
    merkleTreeDepth: MERKLE_TREE_DEPTH,
  };
}

export function cloneElectionConfig(config: ElectionConfig): ElectionConfig {
  return {
    totalExpected: config.totalExpected,
    choices: [...config.choices],
    version: config.version,
    botCount: config.botCount,
    merkleTreeDepth: config.merkleTreeDepth,
  };
}

export function isElectionConfig(value: unknown): value is ElectionConfig {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const config = value as Partial<ElectionConfig>;
  return Boolean(
    Number.isInteger(config.totalExpected) &&
    typeof config.version === 'string' &&
    config.version.length > 0 &&
    Number.isInteger(config.botCount) &&
    typeof config.botCount === 'number' &&
    config.botCount >= 0 &&
    Number.isInteger(config.merkleTreeDepth) &&
    typeof config.merkleTreeDepth === 'number' &&
    config.merkleTreeDepth > 0 &&
    Array.isArray(config.choices) &&
    config.choices.length > 0 &&
    config.choices.every((choice) => typeof choice === 'string' && choice.length > 0),
  );
}

export function hashElectionConfig(config: ElectionConfig): string {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      totalExpected: config.totalExpected,
      choices: [...config.choices],
      version: config.version,
      botCount: config.botCount,
      merkleTreeDepth: config.merkleTreeDepth,
    }),
  );
  return '0x' + hash.digest('hex');
}

export function getDefaultElectionConfigHash(): string {
  return hashElectionConfig(buildDefaultElectionConfig());
}

export function hasMatchingElectionConfigHash(config: ElectionConfig, electionConfigHash: string): boolean {
  return normalizeHexString(hashElectionConfig(config)) === normalizeHexString(electionConfigHash);
}
