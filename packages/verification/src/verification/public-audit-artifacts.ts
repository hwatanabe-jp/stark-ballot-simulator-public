import {
  cloneElectionConfig,
  hashElectionConfig,
  hasMatchingElectionConfigHash,
  type ElectionConfig,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { asUnixTimestampMillis, computeSTHDigest, UINT32_MAX } from '@stark-ballot/zkvm-contract/zkvm/types';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@stark-ballot/crypto-primitives';
import { s, type Infer } from '@stark-ballot/validation/schema';
import { documentOpenApiRefinement } from '@stark-ballot/validation/schema-openapi';

const publicAuditHex32Schema = documentOpenApiRefinement(
  s.string().refine((value) => isValidHexString(value, 32), {
    message: 'Expected 32-byte hex string',
  }),
  'The value is exactly 32 bytes of hexadecimal, with an optional case-insensitive 0x prefix.',
  { pattern: '^(?:0[xX])?[0-9A-Fa-f]{64}$' },
);
const publicAuditUint32Schema = s.number().int().nonnegative().max(UINT32_MAX);
const publicAuditPositiveUint32Schema = publicAuditUint32Schema.min(1);

export const electionManifestArtifactSchema = s
  .object({
    electionId: s.string().uuid(),
    totalExpected: publicAuditUint32Schema,
    choices: s.array(s.string().min(1)).min(1),
    version: s.string().min(1),
    botCount: publicAuditUint32Schema,
    merkleTreeDepth: publicAuditPositiveUint32Schema,
    electionConfigHash: publicAuditHex32Schema,
  })
  .strict();

export const closeStatementArtifactSchema = s
  .object({
    logId: publicAuditHex32Schema,
    treeSize: publicAuditPositiveUint32Schema,
    timestamp: s.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    bulletinRoot: publicAuditHex32Schema,
    sthDigest: publicAuditHex32Schema,
  })
  .strict();

export type ElectionManifest = Omit<Readonly<Infer<typeof electionManifestArtifactSchema>>, 'choices'> & {
  readonly choices: Readonly<Infer<typeof electionManifestArtifactSchema>['choices']>;
};
export type CloseStatement = Readonly<Infer<typeof closeStatementArtifactSchema>>;

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
    sthDigest: computeSTHDigest(logId, input.treeSize, asUnixTimestampMillis(input.timestamp), bulletinRoot),
  };
}

export function isElectionManifest(value: unknown): value is ElectionManifest {
  return electionManifestArtifactSchema.safeParse(value).success;
}

export function isCloseStatement(value: unknown): value is CloseStatement {
  return closeStatementArtifactSchema.safeParse(value).success;
}
