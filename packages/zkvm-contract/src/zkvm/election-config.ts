import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { BOT_COUNT, MERKLE_TREE_DEPTH, VOTE_CHOICES } from './contract-constants';
import { normalizeHexString } from './hex';

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

export function hashElectionConfig(config: ElectionConfig): string {
  const canonicalConfig = JSON.stringify({
    totalExpected: config.totalExpected,
    choices: [...config.choices],
    version: config.version,
    botCount: config.botCount,
    merkleTreeDepth: config.merkleTreeDepth,
  });
  return `0x${bytesToHex(sha256(utf8ToBytes(canonicalConfig)))}`;
}

export function getDefaultElectionConfigHash(): string {
  return hashElectionConfig(buildDefaultElectionConfig());
}

export function hasMatchingElectionConfigHash(config: ElectionConfig, electionConfigHash: string): boolean {
  return normalizeHexString(hashElectionConfig(config)) === normalizeHexString(electionConfigHash);
}
