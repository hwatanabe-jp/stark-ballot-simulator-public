#!/usr/bin/env tsx
/**
 * CLI E2E Voting Flow Test
 * Tests the complete voting flow without a browser
 */

// Load .env.local before anything else
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import path from 'path';

// Try to load .env.local from project root
const projectRoot = path.resolve(__dirname, '../..');
config({ path: path.join(projectRoot, '.env.local'), quiet: true });
config({ path: path.join(projectRoot, 'scripts/tests/.env.test.defaults'), quiet: true });

console.log('[CLI] Amplify auth mode: SigV4 (IAM) with default credential chain');

import {
  CLITestHelpers,
  resolveFinalizationCountDiagnostics,
  type TestResult,
} from '../../src/lib/testing/cli-test-helpers';
import type { VoteChoice } from '../../src/shared/constants';
import { parseArgs } from 'util';
import net from 'net';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import { detectTampering } from '../../src/lib/verification/tamperDetection';
import type { ImageIdMapping } from '../../src/lib/verification/image-id-types';
import {
  resolveConfiguredImageIdVariant,
  resolveExpectedImageIdFromMapping,
  type ImageIdVariant,
} from '../../src/lib/verification/image-id-policy.js';
import imageIdMappingJson from '../../public/imageId-mapping.json';
import { persistCliReport, extractBundleArchive } from '../../src/lib/testing/cli-artifacts';
import { buildVerifierUrl, isSafeVerifierSegment } from '../../src/lib/finalize/finalize-urls';
import {
  collectCliVerificationContractErrors,
  isCtProofMissing,
  mergeFetchedVoteProof,
  resolveReceiptPayload,
  resolveTallyResult,
  resolveUserVoteProof,
  shouldFetchVoteProof,
} from '../../src/lib/testing/cli-voting-flow-helpers';
import { isRecord } from '../../src/lib/utils/guards';

const imageIdMapping = imageIdMappingJson as ImageIdMapping;
const currentMethodVersion = imageIdMapping.current;
const AUTHENTICATED_ENDPOINT_DELIVERY = 'authenticated-endpoint' as const;

type AuthenticatedArtifactKind = 'bundle' | 'report';

interface AuthenticatedArtifactCandidate {
  kind: AuthenticatedArtifactKind;
  url: string;
}

interface AuthenticatedArtifactDownload {
  path: string;
  hash: string;
}

export function resolveDefaultCliExpectedImageId(
  mapping: ImageIdMapping,
  variant: ImageIdVariant = resolveConfiguredImageIdVariant(process.env.EXPECTED_IMAGE_ID_VARIANT),
): { imageId: string; variant: ImageIdVariant } {
  return {
    imageId: resolveExpectedImageIdFromMapping(mapping, Number(mapping.current), variant),
    variant,
  };
}

const defaultCliExpectedImageId = resolveDefaultCliExpectedImageId(imageIdMapping);

if (!process.env.EXPECTED_IMAGE_ID) {
  const sourceLabel = `imageId-mapping.json (methodVersion ${currentMethodVersion}, variant ${defaultCliExpectedImageId.variant})`;
  console.warn(`[CLI] EXPECTED_IMAGE_ID not set. Resolving from ${sourceLabel}.`);
  process.env.EXPECTED_IMAGE_ID = defaultCliExpectedImageId.imageId;
}

// Test configuration
export interface CLITestConfig {
  scenarios: string[];
  useRealZkVM: boolean;
  realMode: 'dev' | 'prod';
  verbose: boolean;
  outputFormat: 'json' | 'table' | 'markdown';
  allScenarios: boolean;
  scenario?: string;
  userChoice: VoteChoice;
  skipBuild: boolean;
}

// Test cases for different tamper scenarios
const testCases = [
  {
    name: 'S0: Normal case (no tampering)',
    scenario: [] as string[],
    expectedTamper: false,
  },
  {
    name: 'S1: Ignore user vote',
    scenario: ['S1'],
    expectedTamper: true,
  },
  {
    name: 'S2: Tamper claimed tally for your vote',
    scenario: ['S2'],
    expectedTamper: true,
  },
  {
    name: 'S3: Ignore bot votes',
    scenario: ['S3'],
    expectedTamper: true,
  },
  {
    name: 'S4: Tamper claimed tally for bot votes',
    scenario: ['S4'],
    expectedTamper: true,
  },
  {
    name: 'S5: Random errors',
    scenario: ['S5'],
    expectedTamper: true,
  },
];

function isVoteChoice(value: unknown): value is VoteChoice {
  return value === 'A' || value === 'B' || value === 'C' || value === 'D' || value === 'E';
}

function isBotTamperInfo(
  value: unknown,
): value is { originalChoice: VoteChoice; recountedTo: VoteChoice; count: number } {
  if (!isRecord(value)) {
    return false;
  }
  const originalChoice = value.originalChoice;
  const recountedTo = value.recountedTo;
  const count = value.count;
  return isVoteChoice(originalChoice) && isVoteChoice(recountedTo) && typeof count === 'number';
}

function printHelp(): void {
  console.log(`STARK Ballot Simulator CLI E2E Test

Usage:
  pnpm test:cli -- --user-choice <A|B|C|D|E> [options]

Options:
  --user-choice, -u   Voter choice for the scenario (required)
  --real-zkvm         Use the real Rust zkVM instead of the mock executor
  --zkvm-mode <mode>  When --real-zkvm is set, choose 'dev' (default) or 'prod'
  --scenario, -s      Run a single tamper scenario (S0-S5)
  --all-scenarios     Run the full S0-S5 scenario matrix
  --output, -o        Report format (table | json | markdown). Default: table
  --verbose, -v       Enable verbose logging
  --skip-build        Reuse existing Next.js build output (skips \`next build\`)
  --help, -h          Show this help message

Examples:
  pnpm test:cli -- --user-choice A
  pnpm test:cli:mock -- --user-choice B --all-scenarios
  pnpm test:cli -- --user-choice C --real-zkvm --scenario S0
`);
}

export class CLIVotingTest {
  private helpers: CLITestHelpers | null;
  private config: CLITestConfig;
  private baseUrl: string | null;
  private nextProcess: ReturnType<typeof spawn> | null = null;

  constructor(config: CLITestConfig, helpers?: CLITestHelpers) {
    this.config = config;
    this.baseUrl = process.env.STARK_BALLOT_CLI_BASE_URL ?? null;
    this.helpers = helpers ?? null;
  }

  async setup(): Promise<void> {
    if (this.helpers) {
      return;
    }

    if (this.baseUrl) {
      this.helpers = new CLITestHelpers(this.baseUrl);
      return;
    }

    await this.startNextServer();
  }

  async teardown(): Promise<void> {
    if (this.nextProcess) {
      this.nextProcess.kill();
      await new Promise<void>((resolve) => this.nextProcess?.once('exit', () => resolve()));
      this.nextProcess = null;
    }
  }

  private async startNextServer(): Promise<void> {
    const projectDir = path.resolve(__dirname, '../..');

    if (!process.env.USE_MOCK_STORE) {
      process.env.USE_MOCK_STORE = 'true';
    }
    if (!process.env.USE_MOCK_ZKVM) {
      process.env.USE_MOCK_ZKVM = this.config.useRealZkVM ? 'false' : 'true';
    }

    if (this.config.useRealZkVM) {
      if (this.config.realMode === 'dev') {
        process.env.RISC0_DEV_MODE = '1';
      } else {
        delete process.env.RISC0_DEV_MODE;
      }
    } else {
      process.env.RISC0_DEV_MODE = '1';
    }

    const insecureZkvmRequested =
      process.env.USE_MOCK_ZKVM === 'true' ||
      process.env.RISC0_DEV_MODE === '1' ||
      process.env.FORCE_DEV_MODE === 'true';
    if (insecureZkvmRequested && typeof process.env.ALLOW_INSECURE_ZKVM === 'undefined') {
      process.env.ALLOW_INSECURE_ZKVM = 'true';
    }

    if (!this.config.skipBuild) {
      console.log('[CLI] Running next build (pass --skip-build to reuse the previous output)');
      await runCommand(getNextBinary(), ['build'], projectDir);
    } else {
      console.log('[CLI] Skipping next build (reusing existing output)');
    }

    const port = await reservePort();
    const host = '127.0.0.1';
    const nextBinary = getNextBinary();

    if (!process.env.TURNSTILE_BYPASS) {
      process.env.TURNSTILE_BYPASS = '1';
    }
    if (process.env.TURNSTILE_BYPASS === '1') {
      // Fail-closed bypass validation requires an explicit non-production runtime marker.
      const hasRuntimeMarker =
        Boolean(process.env.AWS_BRANCH?.trim()) ||
        Boolean(process.env.AMPLIFY_BRANCH?.trim()) ||
        Boolean(process.env.RUNTIME_DEPLOYMENT_ENV?.trim()) ||
        Boolean(process.env.ENV_NAME?.trim()) ||
        Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME?.trim());
      if (!hasRuntimeMarker) {
        process.env.RUNTIME_DEPLOYMENT_ENV = 'develop';
      }
    }
    if (process.env.USE_S3 !== 'false') {
      process.env.USE_S3 = 'false';
    }
    process.env.VERIFIER_PUBLIC_BASE_URL = `http://${host}:${port}`;

    this.nextProcess = spawn(nextBinary, ['start', '-p', String(port), '-H', host], {
      cwd: projectDir,
      env: {
        ...process.env,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    process.once('exit', () => this.nextProcess?.kill());

    process.env.STARK_BALLOT_WASM_MODULE_PATH =
      process.env.STARK_BALLOT_WASM_MODULE_PATH ?? path.join(projectDir, 'public/wasm/risc0_wasm_wrapper.js');
    process.env.STARK_BALLOT_WASM_BASE_URL = `http://${host}:${port}`;

    this.baseUrl = `http://${host}:${port}`;
    await waitForService(this.baseUrl);
    console.log(`[CLI] Started Next.js production server on ${this.baseUrl}`);

    this.helpers = new CLITestHelpers(this.baseUrl);
  }

  private log(message: string, level: 'info' | 'success' | 'error' | 'warning' = 'info') {
    if (!this.config.verbose && level === 'info') return;

    const timestamp = new Date().toISOString();
    const prefix = {
      info: '  ',
      success: '✅',
      error: '❌',
      warning: '⚠️',
    }[level];

    console.log(`[${timestamp}] ${prefix} ${message}`);
  }

  async runTestCase(testCase: (typeof testCases)[0]): Promise<TestResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    if (!this.helpers) {
      throw new Error('CLI helpers not initialized');
    }
    const helpers = this.helpers;

    console.log(`\nTest Case: ${testCase.name}`);
    console.log('─────────────────────────────────');

    try {
      // Step 1: Create session
      this.log('Creating session...');
      const sessionId = await helpers.createSession();
      this.log(`Session created: ${sessionId}`, 'success');

      // Step 2: Submit user vote
      const userChoice = this.config.userChoice;
      this.log(`Submitting user vote: ${userChoice}`);
      const voteResult = await helpers.submitVote(sessionId, userChoice);
      this.log(`User vote submitted: ${userChoice} (commitment: ${voteResult.commitment.slice(0, 8)}...)`, 'success');
      if (this.config.verbose && voteResult.voteId) {
        this.log(`Vote ID: ${voteResult.voteId}`, 'info');
      }

      // Step 3: Generate bot votes
      this.log('Generating bot votes...');
      await helpers.generateBotVotes(sessionId);
      this.log('Bot votes generated: 63 votes', 'success');

      // Step 4: Apply tamper scenarios and finalize
      if (testCase.scenario.length > 0) {
        this.log(`Applying tamper scenario: ${testCase.scenario.join(', ')}`);
      }

      // Set zkVM mode based on config
      if (!this.config.useRealZkVM) {
        // Use Mock zkVM (JavaScript implementation)
        process.env.USE_MOCK_ZKVM = 'true';
        process.env.RISC0_DEV_MODE = '1';
        this.log('Using Mock zkVM (JavaScript, no STARK proofs)');
      } else {
        // Use Real zkVM (Rust binary)
        process.env.USE_MOCK_ZKVM = 'false';

        if (this.config.realMode === 'dev') {
          process.env.RISC0_DEV_MODE = '1';
          this.log('Using Real zkVM dev mode (Rust binary, Fake receipts, ~0.04s)');
        } else {
          delete process.env.RISC0_DEV_MODE;
          this.log('⚠️ Using Real zkVM production mode (Rust binary, STARK proofs)');
          this.log('⏱️ This will take approximately 6 minutes (366 seconds) per test case');
          console.log('─────────────────────────────────────────');
        }

        console.log(
          `[CLI] Real zkVM mode: ${this.config.realMode.toUpperCase()} (RISC0_DEV_MODE=${process.env.RISC0_DEV_MODE ?? 'unset'}), EXPECTED_IMAGE_ID=${process.env.EXPECTED_IMAGE_ID}`,
        );
      }

      const zkStartTime = Date.now();
      const scenarioId = testCase.scenario.length > 0 ? testCase.scenario[0] : 'S0';
      const finalizeResult = await helpers.finalizeWithScenarios(sessionId, scenarioId);
      const zkDuration = Date.now() - zkStartTime;
      this.log(`zkVM executed in ${(zkDuration / 1000).toFixed(1)}s`, 'success');

      // Extract results
      const tallyResult = resolveTallyResult(finalizeResult.data);
      if (!tallyResult) {
        throw new Error('Finalization response missing tally data');
      }
      const proofPayload = resolveReceiptPayload(finalizeResult.data);
      if (!proofPayload) {
        throw new Error('Finalization response missing receipt payload');
      }
      const debug = finalizeResult.data.debug;
      const { missingSlots, invalidPresentedSlots, validVotes, excludedSlots } = resolveFinalizationCountDiagnostics(
        finalizeResult.data,
      );
      let userVoteProof = resolveUserVoteProof(finalizeResult.data);
      const voteId = voteResult.voteId;
      if (shouldFetchVoteProof(userVoteProof, voteId)) {
        try {
          const fetchedProof = await helpers.fetchVoteProof(voteId, sessionId);
          userVoteProof = mergeFetchedVoteProof(userVoteProof, fetchedProof, voteResult.commitment);
          if (this.config.verbose) {
            this.log(`Fetched finalized vote proof (path length ${fetchedProof.merklePath.length})`, 'info');
          }
        } catch (proofError) {
          const message = proofError instanceof Error ? proofError.message : String(proofError);
          if (this.config.verbose) {
            console.warn(`[CLI] Failed to fetch finalized vote proof: ${message}`);
          }
        }
      }
      const finalMerklePath = userVoteProof?.merklePath; // Get the final Merkle path

      const finalizationMode: 'sync' | 'async' = finalizeResult.meta?.mode === 'async' ? 'async' : 'sync';
      const finalizationExecutionId = finalizeResult.meta?.executionId;
      const finalizationHistory = finalizeResult.meta?.finalizationHistory;
      const finalizationStepFunctions = finalizeResult.meta?.stepFunctions;
      const verificationContractErrors = collectCliVerificationContractErrors(finalizeResult.data);

      if (finalizationMode === 'async' && finalizationExecutionId) {
        this.log(`Finalization executionId: ${finalizationExecutionId}`, 'info');
      }

      for (const contractError of verificationContractErrors) {
        errors.push(contractError);
        this.log(contractError, 'error');
      }

      let verificationBundlePath: string | undefined;
      let verificationHash: string | undefined;
      let verificationBundleDelivery: typeof AUTHENTICATED_ENDPOINT_DELIVERY | undefined;
      let verificationReportHash: string | undefined;
      let verificationReportPath: string | undefined;
      let bundleExtractionDir: string | undefined;
      const verificationExecutionId =
        typeof finalizeResult.data.verificationExecutionId === 'string' &&
        isSafeVerifierSegment(finalizeResult.data.verificationExecutionId)
          ? finalizeResult.data.verificationExecutionId
          : undefined;
      if (!verificationExecutionId) {
        const selectorError = 'Finalized response missing top-level verificationExecutionId';
        errors.push(selectorError);
        this.log(selectorError, 'error');
      }
      const authenticatedBundleUrl =
        this.baseUrl && verificationExecutionId && isSafeVerifierSegment(sessionId)
          ? buildVerifierUrl(this.baseUrl, sessionId, verificationExecutionId)
          : undefined;
      const authenticatedReportUrl =
        this.baseUrl && verificationExecutionId && isSafeVerifierSegment(sessionId)
          ? buildVerifierUrl(this.baseUrl, sessionId, verificationExecutionId, 'report')
          : undefined;

      if (authenticatedBundleUrl) {
        try {
          const download = await this.downloadAuthenticatedArtifact(sessionId, {
            kind: 'bundle',
            url: authenticatedBundleUrl,
          });
          verificationBundlePath = download.path;
          verificationHash = download.hash;
          verificationBundleDelivery = AUTHENTICATED_ENDPOINT_DELIVERY;
          this.log(`Authenticated bundle downloaded (sha256=${verificationHash.slice(0, 8)}...)`);
        } catch (bundleError) {
          const message = bundleError instanceof Error ? bundleError.message : String(bundleError);
          errors.push(`Failed to download verification bundle: ${message}`);
          this.log(`Failed to download verification bundle: ${message}`, 'error');
        }
      }

      if (authenticatedReportUrl) {
        try {
          const download = await this.downloadAuthenticatedArtifact(sessionId, {
            kind: 'report',
            url: authenticatedReportUrl,
          });
          verificationReportPath = download.path;
          verificationReportHash = download.hash;
          this.log(`Authenticated verification report downloaded (sha256=${verificationReportHash.slice(0, 8)}...)`);
        } catch (reportError) {
          const message = reportError instanceof Error ? reportError.message : String(reportError);
          errors.push(`Failed to download verification report: ${message}`);
          this.log(`Failed to download verification report: ${message}`, 'error');
        }
      }

      // Step 5: Verify STARK proof
      this.log('Verifying STARK proof...');
      const starkOptions: NonNullable<Parameters<typeof helpers.verifySTARK>[1]> = {
        useRealZkVM: this.config.useRealZkVM,
        imageId: proofPayload.imageId ?? finalizeResult.data.imageId,
        verificationStatus: finalizeResult.data.verificationStatus,
        verificationReport: finalizeResult.data.verificationReport,
        allowDevMode:
          this.config.useRealZkVM &&
          (this.config.realMode === 'dev' || finalizeResult.data.verificationStatus === 'dev_mode'),
      };

      if (this.config.useRealZkVM && verificationBundlePath) {
        starkOptions.verificationBundlePath = verificationBundlePath;
      }

      const starkValid = await helpers.verifySTARK(proofPayload.receipt, starkOptions);

      // Check receipt type
      const receiptInfo = helpers.describeReceipt(proofPayload.receipt);

      switch (receiptInfo.kind) {
        case 'mock':
          this.log('Using Mock zkVM - STARK proof is simulated');
          break;
        case 'modern':
          this.log(`Using Real zkVM receipt (Modern format) - seal bytes ~${receiptInfo.sealLength ?? 'unknown'}`);
          break;
        case 'unknown':
          this.log('Receipt format could not be classified', 'warning');
          break;
      }

      if (starkValid) {
        const suffix =
          receiptInfo.kind === 'mock' ? ' (mock)' : receiptInfo.kind === 'modern' ? ' (modern receipt)' : '';
        const statusSuffix =
          finalizeResult.data.verificationStatus && finalizeResult.data.verificationStatus !== 'success'
            ? ` [status=${finalizeResult.data.verificationStatus}]`
            : '';
        this.log('STARK proof verified' + suffix + statusSuffix, 'success');
      } else {
        errors.push('STARK proof verification failed');
        this.log('STARK proof verification failed', 'error');
      }

      if (verificationBundlePath) {
        try {
          bundleExtractionDir = await extractBundleArchive({
            sessionId,
            bundlePath: verificationBundlePath,
            delivery: verificationBundleDelivery ?? AUTHENTICATED_ENDPOINT_DELIVERY,
            executionId: verificationExecutionId,
          });
          this.log(`Verification bundle extracted to ${bundleExtractionDir}`);
        } catch (extractError) {
          const message = extractError instanceof Error ? extractError.message : String(extractError);
          errors.push(`Failed to extract verification bundle: ${message}`);
          this.log(`Failed to extract verification bundle: ${message}`, 'error');
        }
      }

      // Step 6: Verify Merkle inclusion
      this.log('Verifying Merkle inclusion...');

      // Debug: Log Merkle verification data
      // Always log in verbose mode or when running specific scenarios
      const shouldLog = this.config.verbose || this.config.scenario;

      // Use the final Merkle path from finalize response if available
      const merklePathToUse = finalMerklePath && finalMerklePath.length > 0 ? finalMerklePath : voteResult.merklePath;
      const leafIndexFromFinalize = userVoteProof?.leafIndex;
      const leafIndexToUse = typeof leafIndexFromFinalize === 'number' ? leafIndexFromFinalize : voteResult.leafIndex;

      if (shouldLog) {
        console.log('[DEBUG] Merkle verification data:');
        console.log('  Commitment:', voteResult.commitment);
        console.log('  Leaf Index:', leafIndexToUse);
        console.log('  Path Length:', merklePathToUse.length);
        console.log(
          '  Path (first 3):',
          merklePathToUse.slice(0, 3).map((p: string) => p.slice(0, 10) + '...'),
        );
        console.log('  Merkle Root:', tallyResult.merkleRoot);
        console.log('  Using final path:', finalMerklePath && finalMerklePath.length > 0 ? 'YES' : 'NO');
      }

      let merkleValid = false;
      const treeSizeForProof =
        typeof userVoteProof?.treeSize === 'number' && userVoteProof.treeSize > 0
          ? userVoteProof.treeSize
          : typeof finalizeResult.data.treeSize === 'number' && finalizeResult.data.treeSize > 0
            ? finalizeResult.data.treeSize
            : tallyResult.totalVotes;
      const proofRoot = userVoteProof?.bulletinRootAtCast ?? tallyResult.merkleRoot;

      if (
        userVoteProof &&
        typeof userVoteProof.leafIndex === 'number' &&
        Array.isArray(userVoteProof.merklePath) &&
        treeSizeForProof > 0
      ) {
        const commitmentForProof = userVoteProof.commitment ?? voteResult.commitment;
        merkleValid = helpers.verifyMerkle(
          commitmentForProof,
          userVoteProof.merklePath,
          userVoteProof.leafIndex,
          proofRoot,
          {
            treeSize: treeSizeForProof,
          },
        );
      } else {
        const effectivePath =
          Array.isArray(merklePathToUse) && merklePathToUse.length > 0 ? merklePathToUse : voteResult.merklePath;
        if (Array.isArray(effectivePath) && effectivePath.length > 0) {
          merkleValid = helpers.verifyMerkle(
            voteResult.commitment,
            effectivePath,
            leafIndexToUse,
            tallyResult.merkleRoot,
            {
              treeSize: tallyResult.totalVotes,
            },
          );
        } else if (this.config.verbose) {
          console.warn('[CLI] No Merkle path available for verification');
        }
      }

      if (merkleValid) {
        this.log('Merkle inclusion verified', 'success');
      } else {
        const merkleError = 'Merkle inclusion verification failed';
        errors.push(merkleError);
        this.log(merkleError, 'error');
      }

      // Step 7: Check tamper detection
      if (isCtProofMissing(userVoteProof)) {
        errors.push('Missing CT inclusion proof for user vote');
      }

      const detectionPath = Array.isArray(userVoteProof?.merklePath) ? userVoteProof.merklePath : [];
      const verifiedTallyFromResponse = (() => {
        const apiTally = finalizeResult.data.verifiedTally;
        if (Array.isArray(apiTally)) {
          return apiTally;
        }
        const journalTally = finalizeResult.data.journal?.verifiedTally;
        if (Array.isArray(journalTally)) {
          return journalTally;
        }
        const debugTally = debug?.verifiedTally;
        if (Array.isArray(debugTally)) {
          return debugTally;
        }
        return undefined;
      })();

      const tamperAnalysis = await detectTampering(
        {
          tally: tallyResult.counts,
          bulletinRoot: userVoteProof?.bulletinRootAtCast ?? tallyResult.merkleRoot,
          totalVotes: tallyResult.totalVotes,
          tamperedCount: tallyResult.tamperedCount,
          missingSlots: missingSlots ?? 0,
          invalidPresentedSlots: invalidPresentedSlots ?? 0,
          validVotes: validVotes ?? 0,
          excludedSlots: excludedSlots ?? 0,
          verifiedTally: verifiedTallyFromResponse,
          botTamperInfo: (() => {
            const proof = finalizeResult.data.proof;
            if (!proof || !isBotTamperInfo(proof.recountedBotInfo)) {
              return undefined;
            }
            return proof.recountedBotInfo;
          })(),
          randomError:
            typeof finalizeResult.data.proof?.randomError === 'boolean'
              ? finalizeResult.data.proof.randomError
              : undefined,
        },
        {
          commitment: voteResult.commitment,
          path: Array.isArray(detectionPath) ? detectionPath : [],
          leafIndex: leafIndexToUse,
          choice: userChoice,
          random: voteResult.random,
          treeSize: treeSizeForProof,
        },
        {
          expectedTotalVotes: finalizeResult.data.totalExpected,
          scenarios: testCase.scenario,
        },
      );

      const tamperDetected = tamperAnalysis.isTampered;
      if (this.config.verbose) {
        console.log('  Detected scenarios:', tamperAnalysis.detectedScenarios.join(', ') || 'none');
      }
      this.log(
        `Tamper detected: ${tamperDetected ? 'YES' : 'NO'} (${tamperAnalysis.detectedScenarios.join(', ') || 'none'})`,
        tamperDetected === testCase.expectedTamper ? 'success' : 'error',
      );

      if (tamperDetected !== testCase.expectedTamper) {
        errors.push(
          `Expected tamper detection: ${testCase.expectedTamper}, got: ${tamperDetected} (${tamperAnalysis.detectedScenarios.join(', ') || 'none'})`,
        );
      }

      // Display results
      console.log('\nResults:');
      const verifiedTallyRaw = verifiedTallyFromResponse ?? debug?.verifiedTally ?? tallyResult.counts;
      const verifiedTallyForLog: number[] | undefined = Array.isArray(verifiedTallyRaw) ? verifiedTallyRaw : undefined;

      if (verifiedTallyForLog) {
        const verifiedTotal = verifiedTallyForLog.reduce((a: number, b: number) => a + b, 0);
        console.log(`- Verified tally:  [${verifiedTallyForLog.join(', ')}] (total: ${verifiedTotal})`);
      }
      if (
        typeof missingSlots === 'number' ||
        typeof invalidPresentedSlots === 'number' ||
        typeof validVotes === 'number' ||
        typeof excludedSlots === 'number'
      ) {
        console.log(
          `- Counts: missingSlots=${missingSlots ?? 'n/a'}, invalidPresentedSlots=${
            invalidPresentedSlots ?? 'n/a'
          }, validVotes=${validVotes ?? 'n/a'}, excludedSlots=${excludedSlots ?? 'n/a'}`,
        );
      }
      console.log(`- Tamper detected: ${tamperDetected ? '✅ YES' : '❌ NO'}`);

      // Check if user vote was affected
      if (tamperDetected && verifiedTallyForLog) {
        const actualUserChoice = this.config.userChoice;
        const userChoiceIndex = actualUserChoice.charCodeAt(0) - 'A'.charCodeAt(0);
        const verifiedCount = verifiedTallyForLog[userChoiceIndex];
        console.log(`- User vote (verified tally): ${actualUserChoice}=${verifiedCount}`);
      }

      return {
        name: testCase.name,
        passed: errors.length === 0,
        duration: Date.now() - startTime,
        details: {
          verifiedTally: verifiedTallyForLog,
          missingSlots,
          invalidPresentedSlots,
          validVotes,
          excludedSlots,
          tamperDetected,
          verificationStatus: finalizeResult.data.verificationStatus,
          verificationExecutionId,
          verificationBundleDelivery,
          verificationHash,
          verificationReportHash,
          verificationReportPath,
          bundleExtractionDir,
          errors: errors.length > 0 ? errors : undefined,
          finalizationMode,
          finalizationExecutionId,
          finalizationHistory: finalizationHistory && finalizationHistory.length > 0 ? finalizationHistory : undefined,
          finalizationStepFunctions: finalizationStepFunctions ?? undefined,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(errorMessage);
      this.log(`Test failed: ${errorMessage}`, 'error');

      return {
        name: testCase.name,
        passed: false,
        duration: Date.now() - startTime,
        details: {
          errors: [errorMessage],
        },
      };
    }
  }

  private async downloadAuthenticatedArtifact(
    sessionId: string,
    candidate: AuthenticatedArtifactCandidate,
  ): Promise<AuthenticatedArtifactDownload> {
    if (!this.helpers) {
      throw new Error('CLI helpers not initialized');
    }

    const response = await fetch(candidate.url, {
      method: 'GET',
      headers: this.helpers.getSensitiveAuthHeaders(sessionId),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (candidate.kind === 'report') {
      try {
        JSON.parse(buffer.toString('utf-8'));
      } catch {
        throw new Error('report endpoint returned invalid JSON');
      }
    }

    const hash = createHash('sha256').update(buffer).digest('hex');
    const downloadDir = path.join(projectRoot, '.tmp', 'cli-bundles', sessionId);
    await fs.mkdir(downloadDir, { recursive: true });

    const extension = candidate.kind === 'bundle' ? 'zip' : 'json';
    const prefix = candidate.kind === 'bundle' ? 'bundle' : 'verification-report';
    const filename = `${prefix}-${AUTHENTICATED_ENDPOINT_DELIVERY}-${Date.now()}-${randomUUID()}.${extension}`;
    const filePath = path.join(downloadDir, filename);
    await fs.writeFile(filePath, buffer);

    return { path: filePath, hash };
  }

  async run(): Promise<{ results: TestResult[]; passed: boolean }> {
    console.log('=== STARK Ballot Simulator CLI E2E Test ===');
    const runStartedAtIso = new Date().toISOString();
    console.log(`[${runStartedAtIso}] Starting test run...`);

    const results: TestResult[] = [];

    // Determine which test cases to run
    let casesToRun = testCases;

    if (this.config.scenario) {
      const scenario = this.config.scenario;
      casesToRun = testCases.filter(
        (tc) => tc.scenario.includes(scenario) || (scenario === 'S0' && tc.scenario.length === 0),
      );
    } else if (!this.config.allScenarios) {
      // Run only S0 and S1 by default for quick testing
      casesToRun = testCases.slice(0, 2);
    }

    // Debug: Show what will be run
    if (this.config.verbose || this.config.allScenarios) {
      console.log(`Running ${casesToRun.length} test cases (allScenarios: ${this.config.allScenarios})`);
    }

    // Run test cases
    for (const testCase of casesToRun) {
      const result = await this.runTestCase(testCase);
      results.push(result);
    }

    // Generate and display report
    console.log('\n' + '='.repeat(50));
    if (!this.helpers) {
      throw new Error('CLI helpers not initialized');
    }
    const report = await this.helpers.generateReport(results, this.config.outputFormat);
    console.log(report);

    const runFinishedAtIso = new Date().toISOString();
    try {
      const artifactSessionId = `run-${runStartedAtIso.replace(/[.:]/g, '-')}`;
      const artifacts = await persistCliReport({
        sessionId: artifactSessionId,
        outputFormat: this.config.outputFormat,
        reportContent: report,
        results,
        startedAt: runStartedAtIso,
        finishedAt: runFinishedAtIso,
      });
      this.log(`CLI report saved to ${artifacts.jsonPath}`, 'success');
      if (artifacts.formattedPath && artifacts.formattedPath !== artifacts.jsonPath) {
        this.log(`Formatted report saved to ${artifacts.formattedPath}`, 'success');
      }
    } catch (artifactError) {
      const message = artifactError instanceof Error ? artifactError.message : String(artifactError);
      this.log(`Failed to persist CLI report: ${message}`, 'warning');
    }

    const allPassed = results.every((r) => r.passed);
    return { results, passed: allPassed };
  }
}

function getNextBinary(): string {
  const projectDir = path.resolve(__dirname, '../..');
  const binName = process.platform === 'win32' ? 'next.cmd' : 'next';
  return path.join(projectDir, 'node_modules', '.bin', binName);
}

async function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env } });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error('Failed to reserve port'));
      }
    });
  });
}

async function waitForService(baseUrl: string, retries = 60): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(baseUrl, { method: 'GET' });
      if (response.status < 500) {
        return;
      }
    } catch {
      // ignore
    }
    await delay(1000);
  }
  throw new Error(`Next.js server did not become ready at ${baseUrl}`);
}

// Parse command line arguments
function parseConfig(): CLITestConfig {
  const rawArgs = process.argv.slice(2);
  const normalizedArgs = rawArgs.filter((arg) => arg !== '--');

  const { values, positionals } = parseArgs({
    args: normalizedArgs,
    options: {
      scenario: { type: 'string', short: 's' },
      'all-scenarios': { type: 'boolean' },
      'real-zkvm': { type: 'boolean' },
      'zkvm-mode': { type: 'string' },
      verbose: { type: 'boolean', short: 'v' },
      output: { type: 'string', short: 'o' },
      'user-choice': { type: 'string', short: 'u' },
      'skip-build': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true, // Allow positionals to handle pnpm's -- separator
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  // Validate user choice (required)
  const rawUserChoice = values['user-choice'];
  if (!rawUserChoice) {
    console.error('Error: --user-choice option is required.');
    console.error('Usage: pnpm test:cli -- --user-choice <A|B|C|D|E>');
    console.error('Example: pnpm test:cli:mock -- --user-choice A');
    process.exit(1);
  }

  const choice = rawUserChoice.toUpperCase();
  if (!isVoteChoice(choice)) {
    console.error(`Invalid user choice: ${values['user-choice']}. Must be A, B, C, D, or E.`);
    process.exit(1);
  }
  const userChoice = choice;

  const skipBuildFromPositionals = Array.isArray(positionals) ? positionals.includes('--skip-build') : false;

  const useRealZkVM = values['real-zkvm'] || false;
  let realMode: 'dev' | 'prod' = 'dev';
  if (useRealZkVM) {
    const rawMode = values['zkvm-mode'] ? String(values['zkvm-mode']).toLowerCase() : undefined;
    if (rawMode === 'prod' || rawMode === 'production') {
      realMode = 'prod';
    } else if (rawMode === 'dev' || rawMode === 'development' || rawMode === undefined) {
      realMode = 'dev';
    } else {
      console.error(`Invalid --zkvm-mode value: ${values['zkvm-mode']}. Use 'dev' or 'prod'.`);
      process.exit(1);
    }
  } else if (values['zkvm-mode']) {
    console.warn('[CLI] Ignoring --zkvm-mode because --real-zkvm was not provided.');
  }

  return {
    scenarios: [],
    scenario: values.scenario,
    allScenarios: values['all-scenarios'] || false,
    useRealZkVM,
    realMode,
    verbose: values.verbose || false,
    outputFormat: typeof values.output === 'string' ? (values.output as 'json' | 'table' | 'markdown') : 'table',
    userChoice,
    skipBuild: Boolean(
      values['skip-build'] ||
      skipBuildFromPositionals ||
      process.env.STARK_BALLOT_CLI_SKIP_BUILD === 'true' ||
      process.env.CLI_SKIP_BUILD === 'true',
    ),
  };
}

// Main entry point
async function main() {
  try {
    const config = parseConfig();
    const test = new CLIVotingTest(config);
    await test.setup();
    try {
      const { passed } = await test.run();
      await test.teardown();
      process.exit(passed ? 0 : 1);
    } catch (error) {
      await test.teardown();
      throw error;
    }
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  void main();
}
