import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { buildVerificationBundleArtifacts } from '@stark-ballot/verification/bundle';
import type { VerificationBundleArtifactContext } from '@stark-ballot/verification/bundle';
import { resolvePublicBundlePolicy } from '@stark-ballot/verification/public-bundle-manifest';
import {
  asUnixTimestampMillis,
  computeInputCommitment,
  computeSTHDigest,
  CURRENT_METHOD_VERSION,
  type ZkVMInput,
} from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ZkVMExecutionResult } from '@stark-ballot/zkvm-contract/zkvm/host-io';
import {
  getArrayProperty,
  getNumberProperty,
  getObjectProperty,
  getStringProperty,
  isNonNullObject,
} from '@stark-ballot/validation/unknown-value-guards';
import { extractZipFromFile } from './zip';
import { buildCloseStatement, buildElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import { parsePublicInputArtifact } from '@stark-ballot/verification/public-input';
import { admitReceiptPayload } from '@stark-ballot/verification/receipt-normalizer';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
  hashElectionConfig,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import {
  createVerificationBundleArchive as createNodeVerificationBundleArchive,
  persistVerificationBundleArtifacts,
} from './verification-bundle';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

const TEST_FINALIZATION_ID = 'test-finalization-id';

interface VerificationBundleContext extends Omit<VerificationBundleArtifactContext, 'createdAt'> {
  verifierWorkDir?: string;
}

async function persistVerificationBundle(context: VerificationBundleContext) {
  const { verifierWorkDir, ...artifactContext } = context;
  const { artifacts } = buildVerificationBundleArtifacts({
    ...artifactContext,
    createdAt: new Date().toISOString(),
  });
  const persisted = await persistVerificationBundleArtifacts({
    sessionId: context.sessionId,
    finalizationId: TEST_FINALIZATION_ID,
    ...omitUndefinedProperties({ verifierWorkDir: verifierWorkDir }),
    artifacts,
  });
  return {
    bundlePath: persisted.bundlePath,
    receiptPath: path.join(persisted.bundlePath, 'receipt.json'),
    inputPath: path.join(persisted.bundlePath, 'input.json'),
    journalPath: path.join(persisted.bundlePath, 'journal.json'),
    electionManifestPath: path.join(persisted.bundlePath, 'election-manifest.json'),
    closeStatementPath: path.join(persisted.bundlePath, 'close-statement.json'),
    metadataPath: path.join(persisted.bundlePath, 'metadata.json'),
    reportPath: path.join(persisted.bundlePath, 'verification.json'),
    sessionId: persisted.sessionId,
    finalizationId: persisted.finalizationId,
  };
}

function createVerificationBundleArchive(bundlePath: string): Promise<string> {
  return createNodeVerificationBundleArchive(bundlePath, {
    policy: resolvePublicBundlePolicy('sync'),
  });
}

const baseZkvmInput: ZkVMInput = {
  electionId: '550e8400-e29b-41d4-a716-446655440000',
  electionConfigHash: getDefaultElectionConfigHash(),
  logId: '0x' + '2'.repeat(64),
  timestamp: 1,
  bulletinRoot: '0x' + '3'.repeat(64),
  treeSize: 64,
  totalExpected: 64,
  votes: [],
};

const defaultElectionConfig = buildDefaultElectionConfig();

const baseIncludedBitmap = Array.from({ length: 64 }, (_, index) => index > 0);
const baseSeenBitmap = Array.from({ length: 64 }, () => true);

function parseJsonRecord(content: string, label: string): Record<string, unknown> {
  const payload: unknown = JSON.parse(content);
  if (!isNonNullObject(payload)) {
    throw new Error(`Expected ${label} to be a record`);
  }
  return payload;
}

function buildZkvmInput(overrides: Partial<ZkVMInput> = {}): ZkVMInput {
  return { ...baseZkvmInput, ...overrides };
}

const baseZkvmResult: ZkVMExecutionResult = {
  verifiedTally: [0, 0, 0, 0, 0],
  bulletinRoot: baseZkvmInput.bulletinRoot,
  treeSize: baseZkvmInput.treeSize,
  totalExpected: baseZkvmInput.totalExpected,
  totalVotes: 0,
  validVotes: 0,
  invalidVotes: 0,
  seenIndicesCount: 0,
  missingSlots: baseZkvmInput.totalExpected,
  invalidPresentedSlots: 0,
  rejectedRecords: 0,
  seenBitmapRoot: computeIncludedBitmapRoot(baseSeenBitmap),
  includedBitmapRoot: computeIncludedBitmapRoot(baseIncludedBitmap),
  excludedSlots: baseZkvmInput.totalExpected,
  inputCommitment: computeInputCommitment(baseZkvmInput),
  methodVersion: CURRENT_METHOD_VERSION,
  electionId: baseZkvmInput.electionId,
  electionConfigHash: baseZkvmInput.electionConfigHash,
  sthDigest: computeSTHDigest(
    baseZkvmInput.logId,
    baseZkvmInput.treeSize,
    asUnixTimestampMillis(baseZkvmInput.timestamp),
    baseZkvmInput.bulletinRoot,
  ),
  ...omitUndefinedProperties({ imageId: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d' }),
  seenBitmap: baseSeenBitmap,
  includedBitmap: baseIncludedBitmap,
};

function buildZkvmResult(
  overrides: Partial<ZkVMExecutionResult> = {},
  zkvmInput: ZkVMInput = baseZkvmInput,
): ZkVMExecutionResult {
  return {
    ...baseZkvmResult,
    inputCommitment: computeInputCommitment(zkvmInput),
    sthDigest: computeSTHDigest(
      zkvmInput.logId,
      zkvmInput.treeSize,
      asUnixTimestampMillis(zkvmInput.timestamp),
      zkvmInput.bulletinRoot,
    ),
    methodVersion: CURRENT_METHOD_VERSION,
    ...overrides,
  };
}

describe('verification-bundle', () => {
  let testWorkDir: string;

  beforeEach(async () => {
    // Create temporary work directory for tests
    const parentDir = path.join(process.cwd(), '.tmp');
    await fs.mkdir(parentDir, { recursive: true });
    testWorkDir = await fs.mkdtemp(path.join(parentDir, 'verification-bundle-'));
    process.env['VERIFIER_WORK_DIR'] = testWorkDir;
  });

  afterEach(async () => {
    // Cleanup test directory
    delete process.env['VERIFIER_WORK_DIR'];
    try {
      await fs.rm(testWorkDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('persistVerificationBundle', () => {
    it('should create bundle directory and save all required files', async () => {
      // Arrange
      const zkvmInput = buildZkvmInput({
        timestamp: Date.now(),
        votes: [
          {
            index: 0,
            choice: 0,
            random: '0x' + '4'.repeat(64),
            commitment: '0x' + '5'.repeat(64),
            merklePath: [],
          },
        ],
      });
      const context: VerificationBundleContext = {
        sessionId: 'test-session-123',
        ...omitUndefinedProperties({ verifierWorkDir: testWorkDir }),
        zkvmInput,
        electionConfig: defaultElectionConfig,
        zkvmResult: buildZkvmResult(
          {
            verifiedTally: [1, 0, 0, 0, 0],
            totalVotes: 1,
            validVotes: 1,
            seenIndicesCount: 1,
            missingSlots: 63,
            excludedSlots: 63,
          },
          zkvmInput,
        ),
        normalizedReceipt: {
          receipt: {
            seal: 'test-seal',
            journal: 'test-journal',
            ...omitUndefinedProperties({
              imageId: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d',
            }),
          },
          rawPayload: admitReceiptPayload({
            seal: 'test-seal-raw',
            journal: { bytes: [1, 2, 3] },
          }),
        },
      };

      // Act
      const result = await persistVerificationBundle(context);

      // Assert - verify bundle structure
      expect(result.bundlePath).toContain('test-session-123');
      expect(result.receiptPath).toContain('receipt.json');
      expect(result.inputPath).toContain('input.json');
      expect(result.journalPath).toContain('journal.json');
      expect(result.electionManifestPath).toContain('election-manifest.json');
      expect(result.closeStatementPath).toContain('close-statement.json');
      expect(result.metadataPath).toContain('metadata.json');
      expect(result.reportPath).toContain('verification.json');
      expect(result.sessionId).toBe('test-session-123');
      expect(result.finalizationId).toBeDefined();

      // Verify files exist
      await expect(fs.access(result.bundlePath)).resolves.toBeUndefined();
      await expect(fs.access(result.receiptPath)).resolves.toBeUndefined();
      await expect(fs.access(result.inputPath)).resolves.toBeUndefined();
      await expect(fs.access(result.journalPath)).resolves.toBeUndefined();
      await expect(fs.access(result.electionManifestPath)).resolves.toBeUndefined();
      await expect(fs.access(result.closeStatementPath)).resolves.toBeUndefined();
      await expect(fs.access(result.metadataPath)).resolves.toBeUndefined();

      // Verify file contents
      const inputContent = await fs.readFile(result.inputPath, 'utf-8');
      const inputData = parseJsonRecord(inputContent, 'input');
      // Input is serialized to Rust format (snake_case, byte arrays)
      const electionId = getObjectProperty(inputData, 'election_id') ?? inputData['election_id'];
      expect(electionId).toBeDefined();
      expect(Array.isArray(electionId)).toBe(true);

      const journalContent = await fs.readFile(result.journalPath, 'utf-8');
      const journalData = parseJsonRecord(journalContent, 'journal');
      expect(strictDefined(journalData['verifiedTally'])).toEqual([1, 0, 0, 0, 0]);
      expect(getArrayProperty(journalData, 'includedBitmap')).toBeUndefined();

      const receiptContent = await fs.readFile(result.receiptPath, 'utf-8');
      const receiptData = parseJsonRecord(receiptContent, 'receipt');
      expect(getStringProperty(receiptData, 'seal')).toBe('test-seal-raw');

      const metadataContent = await fs.readFile(result.metadataPath, 'utf-8');
      const metadataData = parseJsonRecord(metadataContent, 'metadata');
      expect(getStringProperty(metadataData, 'sessionId')).toBe('test-session-123');
      expect(getNumberProperty(metadataData, 'methodVersion')).toBe(CURRENT_METHOD_VERSION);

      const electionManifestContent = await fs.readFile(result.electionManifestPath, 'utf-8');
      const electionManifestData = parseJsonRecord(electionManifestContent, 'election manifest');
      const expectedElectionManifest = buildElectionManifest(
        '550e8400-e29b-41d4-a716-446655440000',
        defaultElectionConfig,
      );
      expect(getStringProperty(electionManifestData, 'electionId')).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(getNumberProperty(electionManifestData, 'totalExpected')).toBe(64);
      expect(getStringProperty(electionManifestData, 'electionConfigHash')).toBe(
        expectedElectionManifest.electionConfigHash,
      );

      const closeStatementContent = await fs.readFile(result.closeStatementPath, 'utf-8');
      const closeStatementData = parseJsonRecord(closeStatementContent, 'close statement');
      const expectedCloseStatement = buildCloseStatement({
        logId: '0x' + '2'.repeat(64),
        treeSize: 64,
        timestamp: context.zkvmInput.timestamp,
        bulletinRoot: '0x' + '3'.repeat(64),
      });
      expect(getStringProperty(closeStatementData, 'logId')).toBe('0x' + '2'.repeat(64));
      expect(getNumberProperty(closeStatementData, 'treeSize')).toBe(64);
      expect(getStringProperty(closeStatementData, 'bulletinRoot')).toBe('0x' + '3'.repeat(64));
      expect(getStringProperty(closeStatementData, 'sthDigest')).toBe(expectedCloseStatement.sthDigest);

      const publicInputPath = path.join(result.bundlePath, 'public-input.json');
      await expect(fs.access(publicInputPath)).resolves.toBeUndefined();
      const publicInputContent = await fs.readFile(publicInputPath, 'utf-8');
      const publicInputData = parseJsonRecord(publicInputContent, 'public input');
      expect(getStringProperty(publicInputData, 'schema')).toBe('stark-ballot.public_input');
      expect(getStringProperty(publicInputData, 'version')).toBe('1.1');
      expect(publicInputData).not.toHaveProperty('contractGeneration');
      expect(getNumberProperty(publicInputData, 'methodVersion')).toBe(CURRENT_METHOD_VERSION);
      const parsedPublicInput = parsePublicInputArtifact(publicInputData, {
        source: 'generated',
      });
      expect(parsedPublicInput.valid).toBe(true);
      expect(parsedPublicInput.typedAuthority).toEqual(
        expect.objectContaining({
          electionId: context.zkvmInput.electionId,
          electionConfigHash: context.zkvmInput.electionConfigHash,
          methodVersion: CURRENT_METHOD_VERSION,
          bulletinRoot: context.zkvmInput.bulletinRoot,
          treeSize: context.zkvmInput.treeSize,
          totalExpected: context.zkvmInput.totalExpected,
          votesCount: 1,
        }),
      );
      const publicVotes = getArrayProperty(publicInputData, 'votes');
      expect(Array.isArray(publicVotes)).toBe(true);
      const firstVote = Array.isArray(publicVotes) ? publicVotes[0] : null;
      if (!isNonNullObject(firstVote)) {
        throw new Error('Expected public input vote to be a record');
      }
      expect(getStringProperty(firstVote, 'commitment')).toBe('0x' + '5'.repeat(64));
      expect(getNumberProperty(firstVote, 'index')).toBe(0);
      expect(Array.isArray(strictDefined(firstVote['merklePath']))).toBe(true);
      expect(getNumberProperty(firstVote, 'choice')).toBeUndefined();
      expect(getStringProperty(firstVote, 'random')).toBeUndefined();

      const includedBitmapPath = path.join(result.bundlePath, 'included-bitmap.json');
      await expect(fs.access(includedBitmapPath)).resolves.toBeUndefined();
      const includedBitmapContent = await fs.readFile(includedBitmapPath, 'utf-8');
      const includedBitmapData = parseJsonRecord(includedBitmapContent, 'included bitmap');
      expect(getStringProperty(includedBitmapData, 'schema')).toBe('stark-ballot.included_bitmap');
      expect(getStringProperty(includedBitmapData, 'version')).toBe('1.0');
      expect(getNumberProperty(includedBitmapData, 'treeSize')).toBe(64);
      expect(getStringProperty(includedBitmapData, 'includedBitmapRoot')).toBe(
        computeIncludedBitmapRoot(baseIncludedBitmap),
      );
      expect(getArrayProperty(includedBitmapData, 'includedBitmap')).toHaveLength(64);

      const seenBitmapPath = path.join(result.bundlePath, 'seen-bitmap.json');
      await expect(fs.access(seenBitmapPath)).resolves.toBeUndefined();
      const seenBitmapContent = await fs.readFile(seenBitmapPath, 'utf-8');
      const seenBitmapData = parseJsonRecord(seenBitmapContent, 'seen bitmap');
      expect(getStringProperty(seenBitmapData, 'schema')).toBe('stark-ballot.seen_bitmap');
      expect(getStringProperty(seenBitmapData, 'version')).toBe('1.0');
      expect(getNumberProperty(seenBitmapData, 'treeSize')).toBe(64);
      expect(getStringProperty(seenBitmapData, 'seenBitmapRoot')).toBe(computeIncludedBitmapRoot(baseSeenBitmap));
      expect(getArrayProperty(seenBitmapData, 'seenBitmap')).toHaveLength(64);
    });

    it('should handle missing normalized receipt gracefully', async () => {
      // Arrange
      const zkvmInput = buildZkvmInput({ timestamp: Date.now() });
      const context: VerificationBundleContext = {
        sessionId: 'test-session-no-receipt',
        ...omitUndefinedProperties({ verifierWorkDir: testWorkDir }),
        zkvmInput,
        electionConfig: defaultElectionConfig,
        zkvmResult: buildZkvmResult(
          {
            receipt: {
              ...omitUndefinedProperties({
                imageId: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d',
              }),
              payload: {
                seal: 'fallback-seal',
                journal: { bytes: [4, 5, 6] },
              },
              raw: {
                seal: 'fallback-seal',
                journal: { bytes: [4, 5, 6] },
              },
            },
          },
          zkvmInput,
        ),
      };

      // Act & Assert - should not throw
      const result = await persistVerificationBundle(context);
      expect(result.bundlePath).toBeTruthy();
      expect(result.sessionId).toBe('test-session-no-receipt');

      // Verify receipt fallback to raw
      const receiptContent = await fs.readFile(result.receiptPath, 'utf-8');
      const receiptData = parseJsonRecord(receiptContent, 'receipt');
      expect(getStringProperty(receiptData, 'seal')).toBe('fallback-seal');
    });

    it('fails closed when public input context drifts from the canonical journal', async () => {
      const zkvmInput = buildZkvmInput({
        bulletinRoot: '0x' + '9'.repeat(64),
      });
      const context: VerificationBundleContext = {
        sessionId: 'test-session-drifted-input',
        ...omitUndefinedProperties({ verifierWorkDir: testWorkDir }),
        zkvmInput,
        electionConfig: defaultElectionConfig,
        zkvmResult: buildZkvmResult(),
        normalizedReceipt: {
          receipt: {
            seal: 'test-seal',
            journal: 'test-journal',
            ...omitUndefinedProperties({ imageId: baseZkvmResult.imageId }),
          },
          rawPayload: admitReceiptPayload({
            seal: 'test-seal-raw',
            journal: { bytes: [1, 2, 3] },
          }),
        },
      };

      await expect(persistVerificationBundle(context)).rejects.toThrow(
        'Public audit artifacts are inconsistent with canonical proof data',
      );
    });

    it('fails closed when a provided election manifest drifts from the authoritative context', async () => {
      const context: VerificationBundleContext = {
        sessionId: 'test-session-drifted-manifest',
        ...omitUndefinedProperties({ verifierWorkDir: testWorkDir }),
        zkvmInput: buildZkvmInput(),
        electionConfig: defaultElectionConfig,
        electionManifest: {
          ...buildElectionManifest(baseZkvmInput.electionId, defaultElectionConfig),
          totalExpected: baseZkvmInput.totalExpected + 1,
        },
        zkvmResult: buildZkvmResult(),
        normalizedReceipt: {
          receipt: {
            seal: 'test-seal',
            journal: 'test-journal',
            ...omitUndefinedProperties({ imageId: baseZkvmResult.imageId }),
          },
          rawPayload: admitReceiptPayload({
            seal: 'test-seal-raw',
            journal: { bytes: [1, 2, 3] },
          }),
        },
      };

      await expect(persistVerificationBundle(context)).rejects.toThrow(
        'Public audit artifacts are inconsistent with canonical proof data',
      );
    });

    it('builds election-manifest.json from the authoritative election config when provided', async () => {
      const customElectionConfig = {
        ...defaultElectionConfig,
        choices: ['A', 'B', 'C', 'D', 'Legacy'],
        version: 'legacy-v0',
      };
      const zkvmInput = buildZkvmInput({
        electionConfigHash: hashElectionConfig(customElectionConfig),
        timestamp: Date.now(),
      });
      const context: VerificationBundleContext = {
        sessionId: 'test-session-custom-config',
        ...omitUndefinedProperties({ verifierWorkDir: testWorkDir }),
        zkvmInput,
        electionConfig: customElectionConfig,
        zkvmResult: buildZkvmResult(
          {
            receipt: {
              ...omitUndefinedProperties({
                imageId: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d',
              }),
              payload: {
                seal: 'custom-config-seal',
                journal: { bytes: [1, 2, 3] },
              },
              raw: {
                seal: 'custom-config-seal',
                journal: { bytes: [1, 2, 3] },
              },
            },
            electionConfigHash: hashElectionConfig(customElectionConfig),
          },
          zkvmInput,
        ),
      };

      const result = await persistVerificationBundle(context);
      const electionManifestContent = await fs.readFile(result.electionManifestPath, 'utf-8');
      const electionManifestData = parseJsonRecord(electionManifestContent, 'election manifest');

      expect(getStringProperty(electionManifestData, 'version')).toBe('legacy-v0');
      expect(getArrayProperty(electionManifestData, 'choices')).toEqual(['A', 'B', 'C', 'D', 'Legacy']);
      expect(getStringProperty(electionManifestData, 'electionConfigHash')).toBe(
        hashElectionConfig(customElectionConfig),
      );

      const inputContent = await fs.readFile(result.inputPath, 'utf-8');
      const inputData = parseJsonRecord(inputContent, 'input');
      const electionConfigRecord = getObjectProperty(inputData, 'election_config');
      expect(electionConfigRecord).toEqual({
        totalExpected: 64,
        choices: ['A', 'B', 'C', 'D', 'Legacy'],
        version: 'legacy-v0',
        botCount: 63,
        merkleTreeDepth: 6,
      });
    });

    it('fails safe when the authoritative election config does not match zkVM input', async () => {
      const zkvmInput = buildZkvmInput({
        electionConfigHash: '0x' + '9'.repeat(64),
        timestamp: Date.now(),
      });
      const context: VerificationBundleContext = {
        sessionId: 'test-session-missing-config',
        ...omitUndefinedProperties({ verifierWorkDir: testWorkDir }),
        zkvmInput,
        electionConfig: defaultElectionConfig,
        zkvmResult: buildZkvmResult(
          {
            receipt: {
              ...omitUndefinedProperties({
                imageId: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d',
              }),
              payload: {
                seal: 'missing-config-seal',
                journal: { bytes: [7, 8, 9] },
              },
              raw: {
                seal: 'missing-config-seal',
                journal: { bytes: [7, 8, 9] },
              },
            },
            electionConfigHash: '0x' + '9'.repeat(64),
          },
          zkvmInput,
        ),
      };

      await expect(persistVerificationBundle(context)).rejects.toThrow(
        'Authoritative election config hash does not match zkVM input',
      );
    });

    it('should throw error when receipt payload is unavailable', async () => {
      // Arrange
      const zkvmInput = buildZkvmInput({ timestamp: Date.now() });
      const context: VerificationBundleContext = {
        sessionId: 'test-session-invalid',
        ...omitUndefinedProperties({ verifierWorkDir: testWorkDir }),
        zkvmInput,
        electionConfig: defaultElectionConfig,
        zkvmResult: buildZkvmResult(
          {
            ...omitUndefinedProperties({ receipt: undefined }),
          },
          zkvmInput,
        ),
      };

      // Act & Assert
      await expect(persistVerificationBundle(context)).rejects.toThrow(
        'zkVM receipt payload unavailable for verification bundle',
      );
    });
  });

  describe('createVerificationBundleArchive', () => {
    it('fails closed when sync metadata is missing', async () => {
      const bundleDir = path.join(testWorkDir, 'missing-sync-metadata');
      await fs.mkdir(bundleDir, { recursive: true });
      for (const fileName of [
        'public-input.json',
        'election-manifest.json',
        'close-statement.json',
        'receipt.json',
        'journal.json',
      ]) {
        await fs.writeFile(path.join(bundleDir, fileName), JSON.stringify({}), 'utf-8');
      }

      await expect(createVerificationBundleArchive(bundleDir)).rejects.toThrow(
        'Missing required public bundle member(s): metadata.json',
      );
    });

    it('fails closed when a required public artifact is missing', async () => {
      const bundleDir = path.join(testWorkDir, 'missing-required-artifact');
      await fs.mkdir(bundleDir, { recursive: true });
      await fs.writeFile(path.join(bundleDir, 'receipt.json'), JSON.stringify({ receipt: {} }), 'utf-8');
      await fs.writeFile(path.join(bundleDir, 'journal.json'), JSON.stringify({}), 'utf-8');

      await expect(createVerificationBundleArchive(bundleDir)).rejects.toThrow(
        'Missing required public bundle member(s)',
      );
    });

    it('creates a zip archive containing JSON artifacts', async () => {
      const zkvmInput = buildZkvmInput({ timestamp: Date.now() });
      const context: VerificationBundleContext = {
        sessionId: 'zip-session',
        ...omitUndefinedProperties({ verifierWorkDir: testWorkDir }),
        zkvmInput,
        electionConfig: defaultElectionConfig,
        zkvmResult: buildZkvmResult(
          {
            receipt: {
              ...omitUndefinedProperties({
                imageId: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d',
              }),
              payload: {
                seal: 'fallback-seal',
                journal: { bytes: [4, 5, 6] },
              },
              raw: {
                seal: 'fallback-seal',
                journal: { bytes: [4, 5, 6] },
              },
            },
          },
          zkvmInput,
        ),
      };

      const result = await persistVerificationBundle(context);
      const verificationPayload = {
        status: 'success',
        createdAt: '2025-01-01T00:00:00.000Z',
      };
      await fs.writeFile(
        path.join(result.bundlePath, 'verification.json'),
        JSON.stringify(verificationPayload, null, 2),
        'utf-8',
      );
      await fs.writeFile(
        path.join(result.bundlePath, 'failure-marker.json'),
        JSON.stringify({ category: 'artifact' }),
        'utf-8',
      );
      const expectedFiles = [
        'public-input.json',
        'election-manifest.json',
        'close-statement.json',
        'journal.json',
        'receipt.json',
        'metadata.json',
      ].sort();
      const expectedContents = new Map<string, string>();
      for (const fileName of expectedFiles) {
        const content = await fs.readFile(path.join(result.bundlePath, fileName), 'utf-8');
        expectedContents.set(fileName, content);
      }

      const archivePath = await createVerificationBundleArchive(result.bundlePath);

      expect(archivePath).toContain('bundle.zip');
      const stats = await fs.stat(archivePath);
      expect(stats.size).toBeGreaterThan(0);
      const extractionDir = path.join(result.bundlePath, 'extracted');
      await extractZipFromFile(archivePath, { destination: extractionDir });
      const extractedFiles = (await fs.readdir(extractionDir)).sort();
      expect(extractedFiles).toEqual(expectedFiles);
      for (const fileName of expectedFiles) {
        const extractedContent = await fs.readFile(path.join(extractionDir, fileName), 'utf-8');
        expect(extractedContent).toBe(expectedContents.get(fileName));
      }
      expect(extractedFiles).not.toContain('input.json');
      expect(extractedFiles).not.toContain('included-bitmap.json');
      expect(extractedFiles).not.toContain('seen-bitmap.json');
      expect(extractedFiles).not.toContain('verification.json');
      expect(extractedFiles).not.toContain('failure-marker.json');
    });
  });
});
