import {
  cloneElectionConfig,
  hashElectionConfig,
  hasMatchingElectionConfigHash,
  type ElectionConfig,
} from '@/lib/zkvm/election-config';
import { computeSTHDigest } from '@/lib/zkvm/types';
import { getNumberProperty, getStringProperty, isRecord } from '@/lib/utils/guards';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@/lib/utils/hex';

export interface ElectionManifest {
  electionId: string;
  totalExpected: number;
  choices: readonly string[];
  version: string;
  botCount: number;
  merkleTreeDepth: number;
  electionConfigHash: string;
}

export interface CloseStatement {
  logId: string;
  treeSize: number;
  timestamp: number;
  bulletinRoot: string;
  sthDigest: string;
}

function normalizeHex32(value: string, label: string): string {
  if (!isValidHexString(value, 32)) {
    throw new Error(`Invalid ${label}: expected 32-byte hex string`);
  }
  return addHexPrefix(normalizeHexString(value));
}

export function recomputeElectionManifestHash(manifest: ElectionManifest): string {
  return hashElectionConfig({
    totalExpected: manifest.totalExpected,
    choices: manifest.choices,
    version: manifest.version,
    botCount: manifest.botCount,
    merkleTreeDepth: manifest.merkleTreeDepth,
  });
}

export function resolveElectionConfigForManifest(input: {
  electionConfig?: ElectionConfig;
  electionConfigHash: string;
  totalExpected: number;
}): ElectionConfig {
  const candidate = input.electionConfig ? cloneElectionConfig(input.electionConfig) : undefined;

  if (!candidate) {
    throw new Error('Authoritative election config unavailable for manifest generation');
  }

  if (candidate.totalExpected !== input.totalExpected) {
    throw new Error('Authoritative election config totalExpected does not match zkVM input');
  }

  if (!hasMatchingElectionConfigHash(candidate, input.electionConfigHash)) {
    throw new Error('Authoritative election config hash does not match zkVM input');
  }

  return candidate;
}

export function buildElectionManifest(electionId: string, electionConfig: ElectionConfig): ElectionManifest {
  const config = cloneElectionConfig(electionConfig);
  const manifest: ElectionManifest = {
    electionId,
    totalExpected: config.totalExpected,
    choices: [...config.choices],
    version: config.version,
    botCount: config.botCount,
    merkleTreeDepth: config.merkleTreeDepth,
    electionConfigHash: '',
  };

  return {
    ...manifest,
    electionConfigHash: recomputeElectionManifestHash(manifest),
  };
}

export function buildCloseStatement(input: {
  logId: string;
  treeSize: number;
  timestamp: number;
  bulletinRoot: string;
}): CloseStatement {
  const logId = normalizeHex32(input.logId, 'logId');
  const bulletinRoot = normalizeHex32(input.bulletinRoot, 'bulletinRoot');

  return {
    logId,
    treeSize: input.treeSize,
    timestamp: input.timestamp,
    bulletinRoot,
    sthDigest: computeSTHDigest(logId, input.treeSize, input.timestamp, bulletinRoot),
  };
}

export function isElectionManifest(value: unknown): value is ElectionManifest {
  if (!isRecord(value)) {
    return false;
  }

  const electionId = getStringProperty(value, 'electionId');
  const totalExpected = getNumberProperty(value, 'totalExpected');
  const choices = value.choices;
  const version = getStringProperty(value, 'version');
  const botCount = getNumberProperty(value, 'botCount');
  const merkleTreeDepth = getNumberProperty(value, 'merkleTreeDepth');
  const electionConfigHash = getStringProperty(value, 'electionConfigHash');

  return Boolean(
    electionId &&
    Number.isInteger(totalExpected) &&
    Array.isArray(choices) &&
    choices.every((choice) => typeof choice === 'string') &&
    version &&
    Number.isInteger(botCount) &&
    Number.isInteger(merkleTreeDepth) &&
    electionConfigHash &&
    isValidHexString(electionConfigHash, 32),
  );
}

export function isCloseStatement(value: unknown): value is CloseStatement {
  if (!isRecord(value)) {
    return false;
  }

  const logId = getStringProperty(value, 'logId');
  const treeSize = getNumberProperty(value, 'treeSize');
  const timestamp = getNumberProperty(value, 'timestamp');
  const bulletinRoot = getStringProperty(value, 'bulletinRoot');
  const sthDigest = getStringProperty(value, 'sthDigest');

  return Boolean(
    logId &&
    isValidHexString(logId, 32) &&
    Number.isInteger(treeSize) &&
    Number.isInteger(timestamp) &&
    bulletinRoot &&
    isValidHexString(bulletinRoot, 32) &&
    sthDigest &&
    isValidHexString(sthDigest, 32),
  );
}
