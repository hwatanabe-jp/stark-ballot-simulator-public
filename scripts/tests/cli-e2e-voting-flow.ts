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
import { fileURLToPath, pathToFileURL } from 'node:url';

// Try to load .env.local from project root
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
config({ path: path.join(projectRoot, '.env.local'), quiet: true });
config({ path: path.join(projectRoot, 'scripts/tests/.env.test.defaults'), quiet: true });

const isCliEntrypoint = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isCliEntrypoint) {
  console.log('[CLI] AWS auth mode: SigV4 (IAM) with default credential chain');
}

import {
  CLITestHelpers,
  getFinalizeTimeoutMs,
  resolveFinalizationCountDiagnostics,
  type TestResult,
  type VoteResult,
  type FinalizeScenarioData,
  type FinalizationCountDiagnostics,
} from '@stark-ballot/test-support/testing/cli-test-helpers';
import {
  admitInitialArtifactRange,
  admitNextArtifactRange,
  resolveArtifactChunkSize,
  readArtifactContentLength,
} from '@stark-ballot/api-contract/http/artifact-response';
import type { VoteChoice } from '@stark-ballot/domain/shared/constants';
import { parseArgs } from 'util';
import net from 'net';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import { detectTampering } from '@stark-ballot/verification/tamper-detection';
import { pollUntil } from '@stark-ballot/test-support/testing/poll';
import {
  resolveConfiguredImageIdVariant,
  resolveExpectedImageIdFromMapping,
  type ImageIdVariant,
} from '@stark-ballot/validation/image-id-policy';
import { parseImageIdMapping } from '@stark-ballot/validation/image-id-mapping';
import imageIdMappingJson from '../../public/imageId-mapping.json';
import {
  persistCliReport,
  extractBundleArchive,
  type CliRunEvidence,
  type CliRunFailure,
} from '@stark-ballot/test-support/testing/cli-artifacts';
import { collectCliRunEvidence, initialCliRunEvidence } from './lib/cli-run-evidence';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import {
  collectCliVerificationContractErrors,
  isCtProofMissing,
  mergeFetchedVoteProof,
  resolveReceiptPayload,
  resolveTallyResult,
  resolveUserVoteProof,
  type ResolvedTallyResult,
  type ReceiptPayload,
  type UserVoteProofSummary,
  shouldFetchVoteProof,
} from '@stark-ballot/test-support/testing/cli-voting-flow-helpers';
import { isNonNullObject } from '@stark-ballot/validation/unknown-value-guards';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { parseVerifierServiceWireReport } from '@stark-ballot/verification/verifier-service-report';
import {
  REPLACED_RUNTIME_SELECTOR_NAMES,
  TARGET_RUNTIME_EXTERNAL_INPUT_NAMES,
  resolveRuntimeProfile,
  type RuntimeProfileSelector,
} from '@stark-ballot/runtime-config/env/runtimeProfile';

const imageIdMapping = parseImageIdMapping(imageIdMappingJson);
const currentMethodVersion = imageIdMapping.current;
const AUTHENTICATED_ENDPOINT_DELIVERY = 'authenticated-endpoint' as const;
const DEFAULT_BUNDLE_RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_REPORT_DOWNLOAD_BYTES = 4 * 1024 * 1024;
const BUNDLE_RANGE_CHUNK_HEADER = 'x-stark-bundle-range-chunk-size';

function buildArtifactUrl(
  baseUrl: string | null,
  sessionId: string,
  finalizationId: string | undefined,
  artifact: 'bundle' | 'report',
): string | undefined {
  if (!baseUrl || !finalizationId || !isSafeVerifierSegment(sessionId)) return undefined;
  const relative = ['api', 'sessions', sessionId, 'finalizations', finalizationId, 'artifacts', artifact].join('/');
  return new URL(`/${relative}`, baseUrl).toString();
}

const CLI_BUILD_RUNTIME_ENV_KEYS = [
  'APPDATA',
  'CI',
  'ComSpec',
  'COREPACK_ENABLE_STRICT',
  'COREPACK_HOME',
  'FORCE_COLOR',
  'GITHUB_ACTIONS',
  'GITHUB_BASE_REF',
  'GITHUB_EVENT_NAME',
  'GITHUB_EVENT_PATH',
  'GITHUB_HEAD_REF',
  'GITHUB_REF',
  'GITHUB_REF_NAME',
  'GITHUB_REPOSITORY',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_NUMBER',
  'GITHUB_SHA',
  'GITHUB_WORKFLOW',
  'GITHUB_WORKSPACE',
  'HOME',
  'INIT_CWD',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'PNPM_HOME',
  'RUNNER_ARCH',
  'RUNNER_OS',
  'RUNNER_TEMP',
  'RUNNER_TOOL_CACHE',
  'SHELL',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'npm_command',
  'npm_config_cache',
  'npm_config_globalconfig',
  'npm_config_node_gyp',
  'npm_config_prefix',
  'npm_config_registry',
  'npm_config_store_dir',
  'npm_config_user_agent',
  'npm_config_userconfig',
  'npm_execpath',
  'npm_node_execpath',
  'npm_package_json',
] as const;
const CLI_SAFE_FRONTEND_BUILD_ENV_KEYS = [
  'VITE_API_BASE_URL',
  'VITE_APP_ENV',
  'VITE_RUNTIME_PROFILE',
  'VITE_STH_MIN_MATCHES',
  'VITE_STH_SOURCES',
  'VITE_TURNSTILE_SITE_KEY',
] as const;

type AuthenticatedArtifactKind = 'bundle' | 'report';

interface AuthenticatedArtifactCandidate {
  kind: AuthenticatedArtifactKind;
  url: string;
}

interface AuthenticatedArtifactDownload {
  path: string;
  hash: string;
}

export type CommandSpawner = typeof spawn;

export function resolveDefaultCliExpectedImageId(
  mapping: unknown,
  variant: ImageIdVariant = resolveConfiguredImageIdVariant(process.env['EXPECTED_IMAGE_ID_VARIANT']),
): { imageId: string; variant: ImageIdVariant } {
  const admittedMapping = parseImageIdMapping(mapping);
  return {
    imageId: resolveExpectedImageIdFromMapping(admittedMapping, Number(admittedMapping.current), variant),
    variant,
  };
}

if (!process.env['EXPECTED_IMAGE_ID']) {
  const defaultCliExpectedImageId = resolveDefaultCliExpectedImageId(imageIdMapping);
  const sourceLabel = `imageId-mapping.json (methodVersion ${currentMethodVersion}, variant ${defaultCliExpectedImageId.variant})`;
  if (isCliEntrypoint) {
    console.warn(`[CLI] EXPECTED_IMAGE_ID not set. Resolving from ${sourceLabel}.`);
  }
  process.env['EXPECTED_IMAGE_ID'] = defaultCliExpectedImageId.imageId;
}

function copyPresentEnvValue(target: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv, key: string): void {
  const value = source[key];
  if (typeof value === 'string') {
    target[key] = value;
  }
}

function createCliBuildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const key of CLI_BUILD_RUNTIME_ENV_KEYS) {
    copyPresentEnvValue(env, source, key);
  }
  for (const key of CLI_SAFE_FRONTEND_BUILD_ENV_KEYS) {
    copyPresentEnvValue(env, source, key);
  }
  return env;
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

function resolveCliRuntimeProfile(config: Pick<CLITestConfig, 'useRealZkVM' | 'realMode'>): RuntimeProfileSelector {
  if (!config.useRealZkVM) {
    return 'static-mock-e2e';
  }
  return config.realMode === 'prod' ? 'local-proof-production' : 'local-proof-development';
}

export function configureCliRuntimeProfile(
  config: Pick<CLITestConfig, 'useRealZkVM' | 'realMode'>,
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeProfileSelector {
  for (const selectorName of REPLACED_RUNTIME_SELECTOR_NAMES) {
    delete environment[selectorName];
  }
  for (const externalInputName of TARGET_RUNTIME_EXTERNAL_INPUT_NAMES) {
    delete environment[externalInputName];
  }
  const profile = resolveCliRuntimeProfile(config);
  environment['RUNTIME_PROFILE'] = profile;
  environment['VITE_RUNTIME_PROFILE'] = profile;
  return profile;
}

// Test cases for different tamper scenarios
const testCases = [
  {
    name: 'S0: Normal case (no tampering)',
    ...omitUndefinedProperties({ scenario: [] as string[] }),
    expectedTamper: false,
  },
  {
    name: 'S1: Ignore user vote',
    ...omitUndefinedProperties({ scenario: ['S1'] }),
    expectedTamper: true,
  },
  {
    name: 'S2: Tamper claimed tally for your vote',
    ...omitUndefinedProperties({ scenario: ['S2'] }),
    expectedTamper: true,
  },
  {
    name: 'S3: Ignore bot votes',
    ...omitUndefinedProperties({ scenario: ['S3'] }),
    expectedTamper: true,
  },
  {
    name: 'S4: Tamper claimed tally for bot votes',
    ...omitUndefinedProperties({ scenario: ['S4'] }),
    expectedTamper: true,
  },
  {
    name: 'S5: Random errors',
    ...omitUndefinedProperties({ scenario: ['S5'] }),
    expectedTamper: true,
  },
];

function isVoteChoice(value: unknown): value is VoteChoice {
  return value === 'A' || value === 'B' || value === 'C' || value === 'D' || value === 'E';
}

function isBotTamperInfo(
  value: unknown,
): value is { originalChoice: VoteChoice; recountedTo: VoteChoice; count: number } {
  if (!isNonNullObject(value)) {
    return false;
  }
  const originalChoice = value['originalChoice'];
  const recountedTo = value['recountedTo'];
  const count = value['count'];
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
  --skip-build        Reuse existing Vite dist output (skips \`pnpm build:local-mock\`)
  --help, -h          Show this help message

Examples:
  pnpm test:cli -- --user-choice A
  pnpm test:cli:mock -- --user-choice B --all-scenarios
  pnpm test:cli -- --user-choice C --real-zkvm --scenario S0
`);
}

interface CliVoteInclusionInput {
  voteResult: VoteResult;
  userVoteProof: UserVoteProofSummary | null;
  tallyResult: ResolvedTallyResult;
  data: FinalizeScenarioData;
}

interface CliMerkleEvidence {
  merklePathToUse: string[];
  leafIndexToUse: number;
  treeSizeForProof: number;
  proofRoot: string;
}

interface CliScenarioTamperInput {
  data: FinalizeScenarioData;
  tallyResult: ResolvedTallyResult;
  voteResult: VoteResult;
  userVoteProof: UserVoteProofSummary | null;
  testCase: (typeof testCases)[0];
  leafIndexToUse: number;
  treeSizeForProof: number;
}

export class CLIVotingTest {
  private helpers: CLITestHelpers | null;
  private config: CLITestConfig;
  private baseUrl: string | null;
  private serverProcess: ReturnType<typeof spawn> | null = null;
  private fileStoreDirectory: string | null = null;
  private runEvidence: CliRunEvidence | null = null;
  private runResults: TestResult[] = [];

  constructor(config: CLITestConfig, helpers?: CLITestHelpers) {
    this.config = config;
    this.baseUrl = process.env['STARK_BALLOT_CLI_BASE_URL'] ?? null;
    this.helpers = helpers ?? null;
  }

  async execute(): Promise<{ results: TestResult[]; passed: boolean }> {
    let setupComplete = false;
    let result: { results: TestResult[]; passed: boolean };
    try {
      await this.captureRunEvidence();
      await this.setup();
      setupComplete = true;
      result = await this.run();
    } catch (error) {
      await this.saveReport(setupComplete ? 'run_interrupted' : 'setup_failed');
      try {
        await this.teardown();
      } catch {
        this.log('CLI cleanup failed after the original run failure', 'warning');
      }
      throw error;
    }
    await this.teardown();
    return result;
  }

  private selectedCases(): typeof testCases {
    const scenario = this.config.scenario;
    return scenario
      ? testCases.filter((tc) => tc.scenario.includes(scenario) || (scenario === 'S0' && tc.scenario.length === 0))
      : this.config.allScenarios
        ? testCases
        : testCases.slice(0, 2);
  }

  private async captureRunEvidence(): Promise<void> {
    const profile = resolveCliRuntimeProfile(this.config);
    const proofProfile = resolveRuntimeProfile({ RUNTIME_PROFILE: profile }).proof;
    const options = {
      projectRoot,
      profile,
      scenarios: this.selectedCases().map((testCase) => testCase.scenario[0] ?? 'S0'),
      useRealZkVM: this.config.useRealZkVM,
      externalServer: this.baseUrl !== null,
      finalizeTimeoutMs: null,
    };
    this.runEvidence = initialCliRunEvidence(options);
    const finalizeTimeoutMs = getFinalizeTimeoutMs(proofProfile);
    this.runEvidence.runtime.finalizeTimeoutMs.effective = finalizeTimeoutMs;
    try {
      this.runEvidence = await collectCliRunEvidence({ ...options, finalizeTimeoutMs });
    } catch {
      this.log('CLI run metadata unavailable; retaining known initial conditions', 'warning');
    }
  }

  private createHelpers(baseUrl: string): CLITestHelpers {
    const proofProfile = resolveRuntimeProfile({ RUNTIME_PROFILE: resolveCliRuntimeProfile(this.config) }).proof;
    return new CLITestHelpers(baseUrl, undefined, proofProfile);
  }

  async setup(): Promise<void> {
    if (this.helpers) {
      return;
    }

    if (this.baseUrl) {
      this.helpers = this.createHelpers(this.baseUrl);
      return;
    }

    await this.startStaticHonoServer();
  }

  async teardown(): Promise<void> {
    try {
      if (this.serverProcess) {
        const server = this.serverProcess;
        this.serverProcess = null;
        await stopCliServer(server);
      }
    } finally {
      if (this.fileStoreDirectory) {
        const directory = this.fileStoreDirectory;
        this.fileStoreDirectory = null;
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  }

  private async startStaticHonoServer(): Promise<void> {
    const projectDir = projectRoot;

    configureCliRuntimeProfile(this.config);

    if (!this.config.skipBuild) {
      console.log('[CLI] Running pnpm build:local-mock (pass --skip-build to reuse the previous dist output)');
      await runBuildCiCommand(projectDir);
    } else {
      console.log('[CLI] Skipping Vite build (reusing existing dist output)');
    }

    const port = await reservePort();
    const host = '127.0.0.1';
    const cliRuntimeDirectory = path.join(projectDir, '.tmp', 'cli-runtime');
    await fs.mkdir(cliRuntimeDirectory, { recursive: true });
    this.fileStoreDirectory = await fs.mkdtemp(path.join(cliRuntimeDirectory, 'file-store-'));
    process.env['VERIFIER_PUBLIC_BASE_URL'] = `http://${host}:${port}`;

    this.serverProcess = spawn(getTsxBinary(projectDir), ['scripts/dev/static-hono-server.ts'], {
      cwd: projectDir,
      env: {
        ...process.env,
        FILE_MOCK_STORE_DIR: this.fileStoreDirectory,
        PORT: String(port),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    process.once('exit', () => this.serverProcess?.kill());

    process.env['STARK_BALLOT_WASM_BASE_URL'] = `http://${host}:${port}`;

    this.baseUrl = `http://${host}:${port}`;
    await waitForService(this.baseUrl);
    console.log(`[CLI] Started Vite static frontend plus Hono API server on ${this.baseUrl}`);

    this.helpers = this.createHelpers(this.baseUrl);
  }

  private log(message: string, level: 'info' | 'success' | 'error' | 'warning' = 'info') {
    if (!this.config.verbose && level === 'info') return;

    const timestamp = new Date().toISOString();
    const prefix = {
      info: '  ',
      success: '[OK]',
      error: '[ERROR]',
      warning: '[WARN]',
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
      const { sessionId, voteResult } = await this.createVotedSession(helpers);

      // Step 4: Apply tamper scenarios and finalize
      if (testCase.scenario.length > 0) {
        this.log(`Applying tamper scenario: ${testCase.scenario.join(', ')}`);
      }

      const runtimeProfile = this.configureAndDescribeProofProfile();

      const zkStartTime = Date.now();
      const scenarioId = testCase.scenario[0] ?? 'S0';
      const finalizeResult = await helpers.finalizeWithScenarios(sessionId, scenarioId);
      const zkDuration = Date.now() - zkStartTime;
      this.log(`zkVM executed in ${(zkDuration / 1000).toFixed(1)}s`, 'success');

      // Extract results
      const { tallyResult, proofPayload } = requireCliFinalizationPayload(finalizeResult.data);
      const debug = finalizeResult.data.debug;
      const { missingSlots, invalidPresentedSlots, validVotes, excludedSlots } = resolveFinalizationCountDiagnostics(
        finalizeResult.data,
      );
      const userVoteProof = await this.resolveFinalizedVoteProof(helpers, sessionId, voteResult, finalizeResult.data);

      const { finalizationMode, finalizationId, finalizationHistory, finalizationRuntimeDiagnostics } =
        resolveCliFinalizationMetadata(finalizeResult.meta);
      const verificationContractErrors = collectCliVerificationContractErrors(finalizeResult.data, {
        requireRequiredChecksSuccess: !testCase.expectedTamper,
      });

      this.reportFinalizationContractErrors(finalizationId, verificationContractErrors, errors);

      const {
        verificationBundlePath,
        verificationHash,
        verificationBundleDelivery,
        verificationReportHash,
        verificationReportPath,
      } = await this.downloadFinalizationArtifacts(sessionId, finalizationId, errors);
      let bundleExtractionDir: string | undefined;

      // Step 5: Verify STARK proof
      await this.verifyFinalizationReceipt(
        helpers,
        { runtimeProfile, proofPayload, data: finalizeResult.data, verificationBundlePath },
        errors,
      );

      if (verificationBundlePath) {
        bundleExtractionDir = await this.extractFinalizationBundle(
          { sessionId, verificationBundlePath, verificationBundleDelivery, finalizationId },
          errors,
        );
      }

      // Step 6: Verify Merkle inclusion
      const { leafIndexToUse, treeSizeForProof } = this.verifyVoteInclusion(
        helpers,
        { voteResult, userVoteProof, tallyResult, data: finalizeResult.data },
        errors,
      );

      // Step 7: Check tamper detection
      const { tamperDetected, verifiedTallyFromResponse } = await this.checkScenarioTampering(
        {
          data: finalizeResult.data,
          tallyResult,
          voteResult,
          userVoteProof,
          testCase,
          leafIndexToUse,
          treeSizeForProof,
        },
        errors,
      );

      // Display results
      const verifiedTallyForLog = this.displayScenarioResult(
        resolveLoggedCliTally(verifiedTallyFromResponse, debug, tallyResult),
        { ...omitUndefinedProperties({ missingSlots, invalidPresentedSlots, validVotes, excludedSlots }) },
        tamperDetected,
      );

      return {
        name: testCase.name,
        passed: errors.length === 0,
        duration: Date.now() - startTime,
        details: {
          ...omitUndefinedProperties({
            verifiedTally: verifiedTallyForLog,
            missingSlots,
            invalidPresentedSlots,
            validVotes,
            excludedSlots,
            tamperDetected,
            verificationStatus: finalizeResult.data.verificationStatus,
            finalizationId,
            verificationBundleDelivery,
            verificationHash,
            verificationReportHash,
            verificationReportPath,
            bundleExtractionDir,
            errors: errors.length > 0 ? errors : undefined,
            finalizationMode,
            finalizationHistory: nonEmptyFinalizationHistory(finalizationHistory),
            finalizationRuntimeDiagnostics: finalizationRuntimeDiagnostics ?? undefined,
          }),
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

  private async createVotedSession(helpers: CLITestHelpers) {
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

    return { sessionId, voteResult };
  }

  private configureAndDescribeProofProfile(): RuntimeProfileSelector {
    // Set zkVM mode based on config
    const runtimeProfile = configureCliRuntimeProfile(this.config);
    if (!this.config.useRealZkVM) {
      // Use Mock zkVM (JavaScript implementation)
      this.log('Using Mock zkVM (JavaScript, no STARK proofs)');
    } else {
      // Use Real zkVM (Rust binary)
      if (this.config.realMode === 'dev') {
        this.log('Using Real zkVM dev mode (Rust binary, Fake receipts, ~0.04s)');
      } else {
        console.log('[CLI] Production STARK proof enabled; expected duration is about 6 minutes per scenario');
        console.log('─────────────────────────────────────────');
      }

      console.log(`[CLI] Real zkVM profile: ${runtimeProfile}, EXPECTED_IMAGE_ID=${process.env['EXPECTED_IMAGE_ID']}`);
    }

    return runtimeProfile;
  }

  private reportFinalizationContractErrors(
    finalizationId: string | undefined,
    verificationContractErrors: readonly string[],
    errors: string[],
  ): void {
    if (finalizationId) {
      this.log(`Finalization ID: ${finalizationId}`, 'info');
    }

    for (const contractError of verificationContractErrors) {
      errors.push(contractError);
      this.log(contractError, 'error');
    }
  }

  private async extractFinalizationBundle(
    input: {
      sessionId: string;
      verificationBundlePath: string;
      verificationBundleDelivery: typeof AUTHENTICATED_ENDPOINT_DELIVERY | undefined;
      finalizationId: string | undefined;
    },
    errors: string[],
  ): Promise<string | undefined> {
    const { sessionId, verificationBundlePath, verificationBundleDelivery, finalizationId } = input;
    let bundleExtractionDir: string | undefined;
    try {
      bundleExtractionDir = await extractBundleArchive({
        sessionId,
        bundlePath: verificationBundlePath,
        delivery: verificationBundleDelivery ?? AUTHENTICATED_ENDPOINT_DELIVERY,
        ...omitUndefinedProperties({ finalizationId }),
      });
      this.log(`Verification bundle extracted to ${bundleExtractionDir}`);
    } catch (extractError) {
      const message = extractError instanceof Error ? extractError.message : String(extractError);
      errors.push(`Failed to extract verification bundle: ${message}`);
      this.log(`Failed to extract verification bundle: ${message}`, 'error');
    }
    return bundleExtractionDir;
  }

  private async resolveFinalizedVoteProof(
    helpers: CLITestHelpers,
    sessionId: string,
    voteResult: VoteResult,
    data: FinalizeScenarioData,
  ) {
    let userVoteProof = resolveUserVoteProof(data);
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
    return userVoteProof;
  }

  private async downloadFinalizationArtifacts(sessionId: string, finalizationId: string | undefined, errors: string[]) {
    let verificationBundlePath: string | undefined;
    let verificationHash: string | undefined;
    let verificationBundleDelivery: typeof AUTHENTICATED_ENDPOINT_DELIVERY | undefined;
    let verificationReportHash: string | undefined;
    let verificationReportPath: string | undefined;
    if (!finalizationId) {
      const selectorError = 'Finalization response missing a safe finalizationId';
      errors.push(selectorError);
      this.log(selectorError, 'error');
    }
    const authenticatedBundleUrl = buildArtifactUrl(this.baseUrl, sessionId, finalizationId, 'bundle');
    const authenticatedReportUrl = buildArtifactUrl(this.baseUrl, sessionId, finalizationId, 'report');

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

    return {
      verificationBundlePath,
      verificationHash,
      verificationBundleDelivery,
      verificationReportHash,
      verificationReportPath,
    };
  }

  private async verifyFinalizationReceipt(
    helpers: CLITestHelpers,
    input: {
      runtimeProfile: RuntimeProfileSelector;
      proofPayload: ReceiptPayload;
      data: FinalizeScenarioData;
      verificationBundlePath: string | undefined;
    },
    errors: string[],
  ): Promise<void> {
    const { runtimeProfile, proofPayload, data, verificationBundlePath } = input;
    this.log('Verifying STARK proof...');
    const proofProfile = resolveRuntimeProfile({ RUNTIME_PROFILE: runtimeProfile }).proof;
    const starkOptions: NonNullable<Parameters<typeof helpers.verifySTARK>[1]> = {
      proofProfile,
      ...omitUndefinedProperties({ imageId: proofPayload.imageId ?? data.imageId }),
      ...omitUndefinedProperties({ verificationStatus: data.verificationStatus }),
      ...omitUndefinedProperties({ verificationReport: data.verificationReport }),
    };

    if (proofProfile.executor === 'risc0' && verificationBundlePath) {
      starkOptions.verificationBundlePath = verificationBundlePath;
    }

    const starkValid = await helpers.verifySTARK(proofPayload.receipt, starkOptions);

    let mockReceipt = false;
    if (proofProfile.executor === 'mock') {
      const receiptInfo = helpers.describeReceipt(proofPayload.receipt);
      mockReceipt = receiptInfo.kind === 'mock';

      if (mockReceipt) {
        this.log('Using Mock zkVM - STARK proof is simulated');
      } else {
        this.log('Mock proof profile returned a non-mock receipt', 'warning');
      }
    }

    if (starkValid) {
      const suffix = describeVerifiedReceipt(mockReceipt, proofProfile, verificationBundlePath);
      const statusSuffix =
        data.verificationStatus && data.verificationStatus !== 'success' ? ` [status=${data.verificationStatus}]` : '';
      this.log('STARK proof verified' + suffix + statusSuffix, 'success');
    } else {
      errors.push('STARK proof verification failed');
      this.log('STARK proof verification failed', 'error');
    }
  }

  private verifyVoteInclusion(helpers: CLITestHelpers, input: CliVoteInclusionInput, errors: string[]) {
    const { voteResult, userVoteProof, tallyResult, data } = input;
    const finalMerklePath = userVoteProof?.merklePath;
    this.log('Verifying Merkle inclusion...');

    // Use the final Merkle path from finalize response if available
    const merklePathToUse = finalMerklePath && finalMerklePath.length > 0 ? finalMerklePath : voteResult.merklePath;
    const leafIndexFromFinalize = userVoteProof?.leafIndex;
    const leafIndexToUse = typeof leafIndexFromFinalize === 'number' ? leafIndexFromFinalize : voteResult.leafIndex;

    this.logMerkleEvidence(input, { finalMerklePath, merklePathToUse, leafIndexToUse });

    const treeSizeForProof = resolveTreeSizeForProof(userVoteProof, data, tallyResult);
    const proofRoot = userVoteProof?.bulletinRootAtCast ?? tallyResult.merkleRoot;

    const merkleValid = this.verifyMerkleEvidence(helpers, input, {
      merklePathToUse,
      leafIndexToUse,
      treeSizeForProof,
      proofRoot,
    });

    if (merkleValid) {
      this.log('Merkle inclusion verified', 'success');
    } else {
      const merkleError = 'Merkle inclusion verification failed';
      errors.push(merkleError);
      this.log(merkleError, 'error');
    }

    return { leafIndexToUse, treeSizeForProof };
  }

  private logMerkleEvidence(
    input: CliVoteInclusionInput,
    evidence: { finalMerklePath: string[] | undefined; merklePathToUse: string[]; leafIndexToUse: number },
  ): void {
    const { voteResult, tallyResult } = input;
    const { finalMerklePath, merklePathToUse, leafIndexToUse } = evidence;
    if (this.config.verbose) {
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
  }

  private verifyMerkleEvidence(
    helpers: CLITestHelpers,
    input: CliVoteInclusionInput,
    evidence: CliMerkleEvidence,
  ): boolean {
    const { userVoteProof, voteResult } = input;
    const { treeSizeForProof, proofRoot } = evidence;
    if (
      userVoteProof &&
      typeof userVoteProof.leafIndex === 'number' &&
      Array.isArray(userVoteProof.merklePath) &&
      treeSizeForProof > 0
    ) {
      return helpers.verifyMerkle(
        userVoteProof.commitment ?? voteResult.commitment,
        userVoteProof.merklePath,
        userVoteProof.leafIndex,
        proofRoot,
        { treeSize: treeSizeForProof },
      );
    }
    return this.verifyOriginalMerklePath(helpers, input, evidence);
  }

  private verifyOriginalMerklePath(
    helpers: CLITestHelpers,
    input: CliVoteInclusionInput,
    evidence: CliMerkleEvidence,
  ): boolean {
    const { voteResult, tallyResult } = input;
    const { merklePathToUse, leafIndexToUse } = evidence;
    const effectivePath =
      Array.isArray(merklePathToUse) && merklePathToUse.length > 0 ? merklePathToUse : voteResult.merklePath;
    if (Array.isArray(effectivePath) && effectivePath.length > 0) {
      return helpers.verifyMerkle(voteResult.commitment, effectivePath, leafIndexToUse, tallyResult.merkleRoot, {
        treeSize: tallyResult.totalVotes,
      });
    }
    if (this.config.verbose) console.warn('[CLI] No Merkle path available for verification');
    return false;
  }

  private async checkScenarioTampering(input: CliScenarioTamperInput, errors: string[]) {
    const { data, voteResult, userVoteProof, testCase, leafIndexToUse, treeSizeForProof } = input;
    const debug = data.debug;
    const userChoice = this.config.userChoice;
    const diagnostics = resolveFinalizationCountDiagnostics(data);
    if (isCtProofMissing(userVoteProof)) {
      errors.push('Missing CT inclusion proof for user vote');
    }

    const detectionPath = Array.isArray(userVoteProof?.merklePath) ? userVoteProof.merklePath : [];
    const verifiedTallyFromResponse = resolveCliVerifiedTally(data, debug);

    const tamperAnalysis = await detectTampering(
      buildCliDetectionResult(input, diagnostics, verifiedTallyFromResponse),
      {
        commitment: voteResult.commitment,
        path: Array.isArray(detectionPath) ? detectionPath : [],
        leafIndex: leafIndexToUse,
        ...omitUndefinedProperties({ choice: userChoice }),
        random: voteResult.random,
        treeSize: treeSizeForProof,
      },
      {
        ...omitUndefinedProperties({ expectedTotalVotes: data.totalExpected }),
        scenarios: testCase.scenario,
      },
    );

    const tamperDetected = tamperAnalysis.isTampered;
    this.reportScenarioTampering(testCase, tamperAnalysis, errors);

    return { tamperDetected, verifiedTallyFromResponse };
  }

  private reportScenarioTampering(
    testCase: (typeof testCases)[0],
    tamperAnalysis: Awaited<ReturnType<typeof detectTampering>>,
    errors: string[],
  ): void {
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
  }

  private displayScenarioResult(
    verifiedTallyRaw: unknown,
    diagnostics: FinalizationCountDiagnostics,
    tamperDetected: boolean,
  ): number[] | undefined {
    console.log('\nResults:');
    const verifiedTallyForLog: number[] | undefined = Array.isArray(verifiedTallyRaw) ? verifiedTallyRaw : undefined;

    if (verifiedTallyForLog) {
      const verifiedTotal = verifiedTallyForLog.reduce((a: number, b: number) => a + b, 0);
      console.log(`- Verified tally:  [${verifiedTallyForLog.join(', ')}] (total: ${verifiedTotal})`);
    }
    printFinalizationCounts(diagnostics);
    console.log(`- Tamper detected: ${tamperDetected ? 'YES' : 'NO'}`);

    // Check if user vote was affected
    if (tamperDetected && verifiedTallyForLog) {
      const actualUserChoice = this.config.userChoice;
      const userChoiceIndex = actualUserChoice.charCodeAt(0) - 'A'.charCodeAt(0);
      const verifiedCount = verifiedTallyForLog[userChoiceIndex];
      console.log(`- User vote (verified tally): ${actualUserChoice}=${verifiedCount}`);
    }

    return verifiedTallyForLog;
  }

  private async downloadAuthenticatedArtifact(
    sessionId: string,
    candidate: AuthenticatedArtifactCandidate,
  ): Promise<AuthenticatedArtifactDownload> {
    if (!this.helpers) {
      throw new Error('CLI helpers not initialized');
    }

    const buffer =
      candidate.kind === 'bundle'
        ? await this.downloadAuthenticatedBundle(candidate.url)
        : await this.downloadAuthenticatedReport(candidate.url);
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

  private async downloadAuthenticatedReport(url: string): Promise<Buffer> {
    if (!this.helpers) {
      throw new Error('CLI helpers not initialized');
    }
    const response = await fetch(url, {
      method: 'GET',
      headers: this.helpers.getPathSessionAuthHeaders(),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const buffer = await readResponseBufferWithLimit(response, MAX_REPORT_DOWNLOAD_BYTES, 'report');
    try {
      const report: unknown = JSON.parse(buffer.toString('utf-8'));
      parseVerifierServiceWireReport(report);
    } catch {
      throw new Error('report endpoint returned invalid JSON');
    }
    return buffer;
  }

  private async downloadAuthenticatedBundle(url: string): Promise<Buffer> {
    const firstResponse = await this.fetchAuthenticatedBundleRange(url, 0, DEFAULT_BUNDLE_RANGE_CHUNK_BYTES - 1);
    if (firstResponse.status !== 206) {
      if (!firstResponse.ok) {
        throw new Error(`HTTP ${firstResponse.status} ${firstResponse.statusText}`);
      }
      return readResponseBufferWithLimit(firstResponse, MAX_BUNDLE_DOWNLOAD_BYTES, 'bundle');
    }

    const { range: firstRange, representationIdentity } = admitInitialArtifactRange(firstResponse.headers, {
      chunkBytes: DEFAULT_BUNDLE_RANGE_CHUNK_BYTES,
      maxBytes: MAX_BUNDLE_DOWNLOAD_BYTES,
    });
    const chunks: Buffer[] = [await readRangeBuffer(firstResponse, firstRange.advertisedLength)];
    const chunkSize = resolveArtifactChunkSize(
      firstResponse.headers.get(BUNDLE_RANGE_CHUNK_HEADER),
      DEFAULT_BUNDLE_RANGE_CHUNK_BYTES,
    );
    let nextStart = firstRange.end + 1;

    while (nextStart < firstRange.total) {
      const nextEnd = Math.min(nextStart + chunkSize - 1, firstRange.total - 1);
      const response = await this.fetchAuthenticatedBundleRange(url, nextStart, nextEnd);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      if (response.status !== 206) {
        throw new Error('Invalid ranged bundle response');
      }

      const range = admitNextArtifactRange(response.headers, {
        start: nextStart,
        end: nextEnd,
        total: firstRange.total,
        representationIdentity,
      });
      chunks.push(await readRangeBuffer(response, range.advertisedLength));
      nextStart = range.end + 1;
    }

    const bundle = Buffer.concat(chunks, firstRange.total);
    if (bundle.byteLength !== firstRange.total) {
      throw new Error('Invalid ranged bundle response');
    }
    return bundle;
  }

  private async fetchAuthenticatedBundleRange(url: string, start: number, end: number): Promise<Response> {
    if (!this.helpers) {
      throw new Error('CLI helpers not initialized');
    }
    return fetch(url, {
      method: 'GET',
      headers: {
        ...this.helpers.getPathSessionAuthHeaders(),
        Range: `bytes=${start}-${end}`,
      },
    });
  }

  async run(): Promise<{ results: TestResult[]; passed: boolean }> {
    if (!this.runEvidence) await this.captureRunEvidence();
    console.log('=== STARK Ballot Simulator CLI E2E Test ===');
    console.log(`[${this.runEvidence?.capturedAt}] Starting test run...`);

    const results = this.runResults;

    // Determine which test cases to run
    const casesToRun = this.selectedCases();

    // Debug: Show what will be run
    if (this.config.verbose || this.config.allScenarios) {
      console.log(`Running ${casesToRun.length} test cases (allScenarios: ${this.config.allScenarios})`);
    }

    // Run test cases
    for (const testCase of casesToRun) {
      const result = await this.runTestCase(testCase);
      results.push(result);
    }

    await this.saveReport();

    const allPassed = results.every((r) => r.passed);
    return { results, passed: allPassed };
  }

  private async saveReport(runFailure?: CliRunFailure): Promise<void> {
    console.log('\n' + '='.repeat(50));
    const results = this.runResults;
    let report = 'CLI setup failed before any scenario ran.\n';

    const runFinishedAtIso = new Date().toISOString();
    try {
      if (this.helpers) report = await this.helpers.generateReport(results, this.config.outputFormat);
      const runStartedAtIso = this.runEvidence?.capturedAt ?? runFinishedAtIso;
      const artifactSessionId = `run-${runStartedAtIso.replace(/[.:]/g, '-')}`;
      const artifacts = await persistCliReport({
        sessionId: artifactSessionId,
        outputFormat: this.config.outputFormat,
        reportContent: report,
        results,
        startedAt: runStartedAtIso,
        finishedAt: runFinishedAtIso,
        ...omitUndefinedProperties({ evidence: this.runEvidence ?? undefined, runFailure }),
      });
      console.log(artifacts.content);
      this.log(`CLI report saved to ${artifacts.jsonPath}`, 'success');
      if (artifacts.formattedPath && artifacts.formattedPath !== artifacts.jsonPath) {
        this.log(`Formatted report saved to ${artifacts.formattedPath}`, 'success');
      }
    } catch (artifactError) {
      const message = artifactError instanceof Error ? artifactError.message : String(artifactError);
      console.log(report);
      this.log(`Failed to persist CLI report: ${message}`, 'warning');
    }
  }
}

/** Allow the server's six-second host shutdown, then bound escalation and exit collection. */
export function stopCliServer(
  server: ReturnType<typeof spawn>,
  shutdownTimeoutMs = 7000,
  killWaitMs = 1000,
): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null || server.pid === undefined) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let finalWait: ReturnType<typeof setTimeout> | undefined;
    function finish(error?: Error): void {
      clearTimeout(escalation);
      clearTimeout(finalWait);
      server.removeListener('exit', onExit);
      server.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    }
    function onExit(): void {
      finish();
    }
    function onError(): void {
      finish(new Error('CLI server termination failed'));
    }
    // Register before signaling: a fast exit must not be missed.
    server.once('exit', onExit);
    server.once('error', onError);
    const escalation = setTimeout(() => {
      finalWait = setTimeout(() => finish(new Error('CLI server exit could not be confirmed')), killWaitMs);
      try {
        server.kill('SIGKILL');
      } catch {
        onError();
      }
    }, shutdownTimeoutMs);
    try {
      server.kill('SIGTERM');
    } catch {
      onError();
    }
  });
}

async function readRangeBuffer(response: Response, expectedLength: number): Promise<Buffer> {
  const body = await readResponseBufferBounded(response, expectedLength, 'Invalid ranged bundle response');
  if (body.byteLength !== expectedLength) {
    throw new Error('Invalid ranged bundle response');
  }
  return body;
}

async function readResponseBufferWithLimit(
  response: Response,
  maxBytes: number,
  artifactName: 'bundle' | 'report',
): Promise<Buffer> {
  return readResponseBufferBounded(response, maxBytes, `${artifactName} response exceeds size limit`);
}

async function readResponseBufferBounded(response: Response, maxBytes: number, limitMessage: string): Promise<Buffer> {
  const declaredBytes = readArtifactContentLength(response.headers, maxBytes, limitMessage);

  if (!response.body) {
    if (declaredBytes !== undefined && declaredBytes !== 0) {
      throw new Error(limitMessage);
    }
    return Buffer.alloc(0);
  }

  const { chunks, totalBytes } = await readBoundedBufferChunks(response.body, maxBytes, limitMessage);

  if (declaredBytes !== undefined && declaredBytes !== totalBytes) {
    throw new Error(limitMessage);
  }

  return Buffer.concat(chunks, totalBytes);
}

async function readBoundedBufferChunks(
  body: NonNullable<Response['body']>,
  maxBytes: number,
  limitMessage: string,
): Promise<{ chunks: Uint8Array[]; totalBytes: number }> {
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  let totalBytes = 0;
  try {
    let result = await reader.read();
    while (!result.done) {
      const chunk: unknown = result.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new Error(limitMessage);
      }
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(limitMessage);
      }
      chunks.push(chunk);
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }

  return { chunks, totalBytes };
}

type CliFinalizationMetadata = Awaited<ReturnType<CLITestHelpers['finalizeWithScenarios']>>['meta'];

function requireCliFinalizationPayload(data: FinalizeScenarioData) {
  const tallyResult = resolveTallyResult(data);
  if (!tallyResult) {
    throw new Error('Finalization response missing tally data');
  }
  const proofPayload = resolveReceiptPayload(data);
  if (!proofPayload) {
    throw new Error('Finalization response missing receipt payload');
  }
  return { tallyResult, proofPayload };
}

function resolveCliFinalizationId(meta: CliFinalizationMetadata): string | undefined {
  return meta?.finalizationId && isSafeVerifierSegment(meta.finalizationId) ? meta.finalizationId : undefined;
}

function resolveCliFinalizationMetadata(meta: CliFinalizationMetadata) {
  const finalizationMode: 'sync' | 'async' = meta?.mode === 'async' ? 'async' : 'sync';
  return {
    finalizationMode,
    finalizationId: resolveCliFinalizationId(meta),
    finalizationHistory: meta?.finalizationHistory,
    finalizationRuntimeDiagnostics: meta?.runtimeDiagnostics,
  };
}

function nonEmptyFinalizationHistory(history: NonNullable<CliFinalizationMetadata>['finalizationHistory']) {
  return history && history.length > 0 ? history : undefined;
}

function resolveLoggedCliTally(
  verifiedTally: ReturnType<typeof resolveCliVerifiedTally>,
  debug: FinalizeScenarioData['debug'],
  tally: ResolvedTallyResult,
) {
  return verifiedTally ?? debug?.verifiedTally ?? tally.counts;
}

function resolveCliVerifiedTally(data: FinalizeScenarioData, debug: FinalizeScenarioData['debug']) {
  const apiTally = data.verifiedTally;
  if (Array.isArray(apiTally)) {
    return apiTally;
  }
  const journalTally = data.journal?.verifiedTally;
  if (Array.isArray(journalTally)) {
    return journalTally;
  }
  const debugTally = debug?.verifiedTally;
  if (Array.isArray(debugTally)) {
    return debugTally;
  }
  return undefined;
}

function resolveCliBotTamperInfo(data: FinalizeScenarioData) {
  const proof = data.proof;
  if (!proof || !isBotTamperInfo(proof.recountedBotInfo)) return undefined;
  return proof.recountedBotInfo;
}

function buildCliDetectionResult(
  input: Pick<CliScenarioTamperInput, 'data' | 'tallyResult' | 'userVoteProof'>,
  diagnostics: FinalizationCountDiagnostics,
  verifiedTallyFromResponse: ReturnType<typeof resolveCliVerifiedTally>,
) {
  const { data, tallyResult, userVoteProof } = input;
  const { missingSlots, invalidPresentedSlots, validVotes, excludedSlots } = diagnostics;
  return {
    tally: tallyResult.counts,
    bulletinRoot: userVoteProof?.bulletinRootAtCast ?? tallyResult.merkleRoot,
    totalVotes: tallyResult.totalVotes,
    tamperedCount: tallyResult.tamperedCount,
    missingSlots: missingSlots ?? 0,
    invalidPresentedSlots: invalidPresentedSlots ?? 0,
    validVotes: validVotes ?? 0,
    excludedSlots: excludedSlots ?? 0,
    ...omitUndefinedProperties({ verifiedTally: verifiedTallyFromResponse }),
    ...omitUndefinedProperties({
      botTamperInfo: resolveCliBotTamperInfo(data),
      randomError: typeof data.proof?.randomError === 'boolean' ? data.proof.randomError : undefined,
    }),
  };
}

function resolveTreeSizeForProof(
  userVoteProof: UserVoteProofSummary | null,
  data: FinalizeScenarioData,
  tallyResult: ResolvedTallyResult,
): number {
  if (typeof userVoteProof?.treeSize === 'number' && userVoteProof.treeSize > 0) return userVoteProof.treeSize;
  if (typeof data.treeSize === 'number' && data.treeSize > 0) return data.treeSize;
  return tallyResult.totalVotes;
}

function describeVerifiedReceipt(
  mockReceipt: boolean,
  proofProfile: ReturnType<typeof resolveRuntimeProfile>['proof'],
  verificationBundlePath: string | undefined,
): string {
  if (mockReceipt) return ' (mock)';
  if (proofProfile.executor !== 'risc0') return '';
  return verificationBundlePath
    ? ` (authenticated ${proofProfile.evidence} RISC Zero receipt)`
    : ` (${proofProfile.evidence} RISC Zero receipt)`;
}

function printFinalizationCounts(diagnostics: FinalizationCountDiagnostics): void {
  const { missingSlots, invalidPresentedSlots, validVotes, excludedSlots } = diagnostics;
  if ([missingSlots, invalidPresentedSlots, validVotes, excludedSlots].some((value) => typeof value === 'number')) {
    console.log(
      `- Counts: missingSlots=${missingSlots ?? 'n/a'}, invalidPresentedSlots=${
        invalidPresentedSlots ?? 'n/a'
      }, validVotes=${validVotes ?? 'n/a'}, excludedSlots=${excludedSlots ?? 'n/a'}`,
    );
  }
}

function getPnpmBinary(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function getTsxBinary(projectDir: string): string {
  return path.join(projectDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
}

export async function runBuildCiCommand(
  projectDir: string,
  spawnImpl: CommandSpawner = spawn,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runCommand(getPnpmBinary(), ['build:local-mock'], projectDir, createCliBuildEnvironment(sourceEnv), spawnImpl);
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  spawnImpl: CommandSpawner,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnImpl(command, args, { cwd, stdio: 'inherit', env });
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
  const limit =
    retries === Number.POSITIVE_INFINITY
      ? { deadlineMs: Number.POSITIVE_INFINITY, clock: Date.now }
      : { maxAttempts: Number.isNaN(retries) ? 0 : Math.max(0, Math.ceil(retries)) };

  await pollUntil({
    ...limit,
    operation: async () => {
      try {
        const response = await fetch(baseUrl, { method: 'GET' });
        return response.status < 500;
      } catch {
        return false;
      }
    },
    isTerminal: (ready) => ready,
    delay: async () => {
      await delay(1000);
    },
    createTimeoutError: () => new Error(`Vite static frontend plus Hono API server did not become ready at ${baseUrl}`),
  });
}

// Parse command line arguments
function parseCliUserChoice(rawUserChoice: string | undefined): VoteChoice {
  if (!rawUserChoice) {
    console.error('Error: --user-choice option is required.');
    console.error('Usage: pnpm test:cli -- --user-choice <A|B|C|D|E>');
    console.error('Example: pnpm test:cli:mock -- --user-choice A');
    process.exit(1);
  }
  const choice = rawUserChoice.toUpperCase();
  if (!isVoteChoice(choice)) {
    console.error(`Invalid user choice: ${rawUserChoice}. Must be A, B, C, D, or E.`);
    process.exit(1);
  }
  return choice;
}

function parseCliProofMode(useRealZkVM: boolean, mode: string | undefined): 'dev' | 'prod' {
  if (!useRealZkVM) {
    if (mode) console.warn('[CLI] Ignoring --zkvm-mode because --real-zkvm was not provided.');
    return 'dev';
  }
  const rawMode = mode ? String(mode).toLowerCase() : undefined;
  if (rawMode === 'prod' || rawMode === 'production') return 'prod';
  if (rawMode === 'dev' || rawMode === 'development' || rawMode === undefined) return 'dev';
  console.error(`Invalid --zkvm-mode value: ${mode}. Use 'dev' or 'prod'.`);
  process.exit(1);
}

function shouldSkipCliBuild(flag: boolean | undefined, positionals: readonly string[]): boolean {
  const skipBuildFromPositionals = Array.isArray(positionals) ? positionals.includes('--skip-build') : false;
  return Boolean(
    flag ||
    skipBuildFromPositionals ||
    process.env['STARK_BALLOT_CLI_SKIP_BUILD'] === 'true' ||
    process.env['CLI_SKIP_BUILD'] === 'true',
  );
}

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

  const userChoice = parseCliUserChoice(values['user-choice']);
  const useRealZkVM = values['real-zkvm'] || false;
  const realMode = parseCliProofMode(useRealZkVM, values['zkvm-mode']);

  return {
    scenarios: [],
    ...omitUndefinedProperties({ scenario: values.scenario }),
    allScenarios: values['all-scenarios'] || false,
    useRealZkVM,
    realMode,
    verbose: values.verbose || false,
    outputFormat: typeof values.output === 'string' ? (values.output as 'json' | 'table' | 'markdown') : 'table',
    userChoice,
    skipBuild: shouldSkipCliBuild(values['skip-build'], positionals),
  };
}

// Main entry point
async function main() {
  try {
    const config = parseConfig();
    const test = new CLIVotingTest(config);
    const { passed } = await test.execute();
    process.exit(passed ? 0 : 1);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (isCliEntrypoint) {
  void main();
}
