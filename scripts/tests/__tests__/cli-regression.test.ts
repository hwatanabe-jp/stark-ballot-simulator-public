import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { CLITestHelpers } from '@stark-ballot/test-support/testing/cli-test-helpers';
import type { ImageIdMapping } from '@stark-ballot/verification/image-id-types';
import type { CLITestConfig, CommandSpawner } from '../cli-e2e-voting-flow';
import { CLIVotingTest, resolveDefaultCliExpectedImageId, runBuildCiCommand } from '../cli-e2e-voting-flow';
import { getStringProperty, requireRecord } from '@stark-ballot/domain/utils/guards';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import imageIdMappingJson from '../../../public/imageId-mapping.json';
import packageJson from '../../../package.json';
import * as yazl from 'yazl';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

const MAINTAINED_CLI_PACKAGE_SCRIPTS = [
  'test:cli',
  'test:cli:mock',
  'test:cli:real-dev',
  'test:cli:real-prod:s0',
  'test:cli:real-prod:all',
] as const;
const CLI_HARNESS_COMMAND = 'pnpm tsx scripts/tests/cli-e2e-voting-flow.ts';
const ACTIVE_LOCAL_IMAGE_ID_VARIANT_ASSIGNMENT = 'EXPECTED_IMAGE_ID_VARIANT=x86_64';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

vi.mock('@stark-ballot/verification/tamper-detection', () => ({
  detectTampering: vi.fn().mockResolvedValue({
    isTampered: false,
    detectedScenarios: [],
    details: {},
  }),
}));

function createHelpers(overrides: Partial<CLITestHelpers> = {}): CLITestHelpers {
  const helpers: CLITestHelpers = {
    createSession: vi.fn().mockResolvedValue('session-123'),
    submitVote: vi.fn().mockResolvedValue({
      leafIndex: 0,
      merklePath: ['0xabc', '0xdef'],
      commitment: '0xcommit',
      choice: 'A',
      random: '0xrand',
    }),
    generateBotVotes: vi.fn().mockResolvedValue(undefined),
    finalizeWithScenarios: vi.fn().mockResolvedValue({
      data: {
        tally: {
          counts: [64, 0, 0, 0, 0],
          merkleRoot: '0xroot',
          totalVotes: 64,
          tamperedCount: 0,
        },
        proof: {
          receipt: JSON.stringify({ mock: true }),
          imageId: '0ximage',
        },
        debug: {
          verifiedTally: [64, 0, 0, 0, 0],
          missingSlots: 0,
          invalidPresentedSlots: 0,
        },
        userMerklePath: ['0xabc', '0xdef'],
        userVote: {
          commitment: '0xcommit',
          merklePath: ['0xabc', '0xdef'],
          leafIndex: 0,
          treeSize: 64,
        },
        treeSize: 64,
        totalExpected: 64,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        sthDigest: '0xsth',
        includedBitmapRoot: '0xbitmap',
        inputCommitment: '0xinput',
        verificationStatus: 'success',
        verificationSteps: [
          {
            id: 'counted_as_recorded',
            status: 'success',
            inputs: [],
          },
          {
            id: 'stark_verification',
            status: 'success',
            inputs: [],
          },
        ],
        verificationChecks: [
          {
            id: 'counted_expected_vs_tree_size',
            status: 'success',
            evidence: 'public',
            inputs: ['totalExpected', 'treeSize'],
          },
          {
            id: 'counted_election_manifest_consistent',
            status: 'success',
            evidence: 'public',
            inputs: ['electionManifest'],
          },
          {
            id: 'counted_close_statement_consistent',
            status: 'success',
            evidence: 'public',
            inputs: ['closeStatement'],
          },
          {
            id: 'stark_receipt_verify',
            status: 'success',
            evidence: 'zk',
            inputs: ['proofBundleStatus'],
          },
        ],
        verificationExecutionId: 'exec-1',
        journal: createTestJournal({ totalExpected: 64, validVotes: 64 }),
        verificationReport: {
          status: 'success',
          verifier_version: '0.1.0',
          verified_at: '2025-10-16T00:00:00Z',
          duration_ms: 1,
          expected_image_id: '0ximage',
          receipt_image_id: '0ximage',
          bundle_path: 'bundle',
          receipt_path: 'receipt.json',
          dev_mode_receipt: false,
          errors: [],
        },
      },
    }),
    verifySTARK: vi.fn().mockResolvedValue(true),
    describeReceipt: vi.fn().mockReturnValue({ kind: 'mock' }),
    verifyMerkle: vi.fn().mockResolvedValue(true),
    generateReport: vi.fn().mockResolvedValue(''),
    executeZkVM: vi.fn(),
    getSensitiveAuthHeaders: vi.fn().mockReturnValue({
      'X-Session-ID': 'session-123',
      'X-Session-Capability': 'capability-token',
    }),
    ...overrides,
  } as unknown as CLITestHelpers;

  return helpers;
}

type VerifyStark = CLITestHelpers['verifySTARK'];

const trackedEnvVars = ['USE_MOCK_ZKVM', 'RISC0_DEV_MODE', 'STARK_BALLOT_CLI_BASE_URL'];
const originalFetch = global.fetch;
const imageIdMapping = imageIdMappingJson as ImageIdMapping;
const BUILD_ENV_DENYLIST = [
  'SESSION_CAPABILITY_SECRET',
  'S3_PROOF_PREFIX',
  'USE_MOCK_ZKVM',
  'RISC0_DEV_MODE',
  'TURNSTILE_BYPASS',
  'VITE_USE_MOCK_API',
  'VITE_TURNSTILE_BYPASS',
  'VITE_USE_MOCK_API',
  'VITE_TURNSTILE_BYPASS',
] as const;

async function createBundleZipBuffer(): Promise<Buffer> {
  const zipfile = new yazl.ZipFile();
  const chunks: Buffer[] = [];

  zipfile.addBuffer(Buffer.from('{"ok":true}', 'utf-8'), 'public-input.json', {
    mtime: new Date(0),
    compress: false,
  });
  zipfile.addBuffer(Buffer.from('{"entries":[]}', 'utf-8'), 'journal.json', {
    mtime: new Date(0),
    compress: false,
  });

  zipfile.outputStream.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  const completed = new Promise<Buffer>((resolve, reject) => {
    zipfile.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zipfile.outputStream.on('error', reject);
  });

  zipfile.end();
  return completed;
}

function createAuthenticatedDownloadFetch(bundleZip: Buffer): typeof fetch {
  const fetchMock: typeof fetch = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = resolveFetchInputUrl(input);
    if (url.endsWith('/report')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'success',
            verifier_version: '0.1.0',
            verified_at: '2025-10-16T00:00:00Z',
            duration_ms: 1,
            expected_image_id: '0ximage',
            receipt_image_id: '0ximage',
            dev_mode_receipt: false,
            errors: [],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
    }

    const rangeHeader = new Headers(init?.headers).get('range');
    if (rangeHeader) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
      if (!match) {
        return Promise.resolve(new Response('invalid range', { status: 416 }));
      }
      const start = Number(strictDefined(match[1]));
      const requestedEnd = Number(strictDefined(match[2]));
      const end = Math.min(requestedEnd, bundleZip.byteLength - 1);
      return Promise.resolve(
        new Response(Uint8Array.from(bundleZip.subarray(start, end + 1)), {
          status: 206,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Range': `bytes ${start}-${end}/${bundleZip.byteLength}`,
            'Accept-Ranges': 'bytes',
            'X-Stark-Bundle-Range-Chunk-Size': String(4 * 1024 * 1024),
          },
        }),
      );
    }

    return Promise.resolve(
      new Response(Uint8Array.from(bundleZip), {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
      }),
    );
  });

  return fetchMock;
}

function resolveFetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

describe('CLIVotingTest regression coverage', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    global.fetch = createAuthenticatedDownloadFetch(await createBundleZipBuffer());
    trackedEnvVars.forEach((key) => {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    });
    process.env['STARK_BALLOT_CLI_BASE_URL'] = 'http://localhost';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    trackedEnvVars.forEach((key) => {
      const savedValue = savedEnv[key];
      if (savedValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedValue;
      }
    });
  });

  it('passes the happy path in mock mode and reports Recorded-as-Cast success', async () => {
    const verifySTARK = vi.fn<VerifyStark>().mockResolvedValue(true);
    const verifyMerkle = vi.fn().mockResolvedValue(true);
    const helpers = createHelpers({ verifySTARK, verifyMerkle });
    const config: CLITestConfig = {
      scenarios: [],
      ...omitUndefinedProperties({ scenario: undefined }),
      allScenarios: false,
      useRealZkVM: false,
      realMode: 'dev',
      verbose: false,
      outputFormat: 'table',
      userChoice: 'A',
      skipBuild: true,
    };

    const cliTest = new CLIVotingTest(config, helpers);
    const result = await cliTest.runTestCase({
      name: 'S0: Normal case (no tampering)',
      ...omitUndefinedProperties({ scenario: [] }),
      expectedTamper: false,
    });

    expect(result.passed).toBe(true);
    expect(result.details.tamperDetected).toBe(false);
    expect(result.details.errors).toBeUndefined();

    expect(verifySTARK).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        useRealZkVM: false,
        verificationStatus: 'success',
      }),
    );
    const verifyCall = vi.mocked(verifySTARK).mock.calls[0];
    const verifyOptions = requireRecord(strictDefined(verifyCall)[1], 'verifySTARK options');
    expect(verifyOptions).not.toHaveProperty('verificationBundlePath');

    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(global.fetch).mock.calls.map((call) => call[0])).toEqual([
      'http://localhost/api/verification/bundles/session-123/exec-1',
      'http://localhost/api/verification/bundles/session-123/exec-1/report',
    ]);
    for (const fetchCall of vi.mocked(global.fetch).mock.calls) {
      const requestOptions = requireRecord(fetchCall[1], 'fetch request init');
      expect(getStringProperty(requestOptions, 'method')).toBe('GET');
      const requestHeaders = requireRecord(requestOptions['headers'], 'fetch request headers');
      expect(getStringProperty(requestHeaders, 'X-Session-ID')).toBe('session-123');
      expect(getStringProperty(requestHeaders, 'X-Session-Capability')).toBe('capability-token');
    }

    expect(result.details.verificationBundleDelivery).toBe('authenticated-endpoint');
    expect(result.details.verificationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.details.verificationReportHash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyMerkle).toHaveBeenCalledTimes(1);
    expect(strictDefined(process.env['USE_MOCK_ZKVM'])).toBe('true');
    expect(strictDefined(process.env['RISC0_DEV_MODE'])).toBe('1');
  });

  it('resolves the default ARM64 ImageID variant', () => {
    const resolved = resolveDefaultCliExpectedImageId(imageIdMapping, 'default');
    const current = imageIdMapping.mappings[imageIdMapping.current];

    expect(resolved.variant).toBe('default');
    expect(resolved.imageId).toBe(strictDefined(current).expectedImageID);
  });

  it('resolves the x86_64 variant when explicitly requested', () => {
    const resolved = resolveDefaultCliExpectedImageId(imageIdMapping, 'x86_64');
    const current = imageIdMapping.mappings[imageIdMapping.current];

    expect(resolved.variant).toBe('x86_64');
    expect(resolved.imageId).toBe(strictDefined(current).expectedImageID_x86_64);
  });

  it('sets the active x86_64 ImageID variant on maintained CLI package scripts', () => {
    for (const scriptName of MAINTAINED_CLI_PACKAGE_SCRIPTS) {
      const script = packageJson.scripts[scriptName];

      expect(script).toContain(ACTIVE_LOCAL_IMAGE_ID_VARIANT_ASSIGNMENT);
      expect(script).toContain(CLI_HARNESS_COMMAND);
      expect(script.indexOf(ACTIVE_LOCAL_IMAGE_ID_VARIANT_ASSIGNMENT)).toBeLessThan(
        script.indexOf(CLI_HARNESS_COMMAND),
      );
    }
  });

  it('runs the target artifact build without server secrets or mock bypass flags', async () => {
    const sourceEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'development',
      PATH: '/usr/bin',
      HOME: '/home/tester',
      CI: 'true',
      VITE_API_BASE_URL: 'https://api.example.com',
      VITE_STH_SOURCES: 'https://auditor.example/sth',
      SESSION_CAPABILITY_SECRET: 'test-capability-secret-0123456789abcdef',
      S3_PROOF_PREFIX: 'sessions/',
      USE_MOCK_ZKVM: 'true',
      RISC0_DEV_MODE: '1',
      TURNSTILE_BYPASS: '1',
      VITE_USE_MOCK_API: 'true',
      VITE_TURNSTILE_BYPASS: '1',
    };
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    const spawnImpl = ((command: string, args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      expect(command).toMatch(/^pnpm(?:\.cmd)?$/);
      expect(args).toEqual(['build:ci']);
      capturedEnv = options?.env;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    }) as CommandSpawner;

    await runBuildCiCommand('/repo', spawnImpl, sourceEnv);

    expect(capturedEnv).toMatchObject({
      NODE_ENV: 'production',
      PATH: '/usr/bin',
      HOME: '/home/tester',
      CI: 'true',
      VITE_API_BASE_URL: 'https://api.example.com',
      VITE_STH_SOURCES: 'https://auditor.example/sth',
    });
    for (const key of BUILD_ENV_DENYLIST) {
      expect(capturedEnv).not.toHaveProperty(key);
    }
  });

  it('treats STARK verification failure as a hard error in real mode', async () => {
    const verifySTARK = vi.fn<VerifyStark>().mockResolvedValue(false);
    const describeReceipt = vi.fn().mockReturnValue({ kind: 'modern', sealLength: 12345 });
    const helpers = createHelpers({ verifySTARK, describeReceipt });

    const config: CLITestConfig = {
      scenarios: [],
      ...omitUndefinedProperties({ scenario: 'S0' }),
      allScenarios: false,
      useRealZkVM: true,
      realMode: 'prod',
      verbose: false,
      outputFormat: 'table',
      userChoice: 'A',
      skipBuild: true,
    };

    const cliTest = new CLIVotingTest(config, helpers);
    const result = await cliTest.runTestCase({
      name: 'S0: Normal case (no tampering)',
      ...omitUndefinedProperties({ scenario: [] }),
      expectedTamper: false,
    });

    expect(verifySTARK).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        useRealZkVM: true,
        verificationStatus: 'success',
      }),
    );

    const verifyCall = vi.mocked(verifySTARK).mock.calls[0];
    const verifyOptions = requireRecord(strictDefined(verifyCall)[1], 'verifySTARK options');
    const bundlePath = getStringProperty(verifyOptions, 'verificationBundlePath');
    expect(bundlePath).toBeDefined();
    expect(bundlePath).toContain('bundle');

    expect(result.passed).toBe(false);
    expect(result.details.errors).toEqual(expect.arrayContaining(['STARK proof verification failed']));
    expect(result.details.verificationStatus).toBe('success');
    expect(result.details.verificationExecutionId).toBe('exec-1');
    expect(result.details.verificationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.details.verificationReportHash).toMatch(/^[0-9a-f]{64}$/);
    const fetchCall = vi.mocked(global.fetch).mock.calls.at(0);
    expect(fetchCall).toBeDefined();

    expect(fetchCall?.[0]).toBe('http://localhost/api/verification/bundles/session-123/exec-1');

    const requestOptions = requireRecord(fetchCall?.[1], 'fetch request init');
    expect(getStringProperty(requestOptions, 'method')).toBe('GET');

    const requestHeaders = requireRecord(requestOptions['headers'], 'fetch request headers');
    expect(getStringProperty(requestHeaders, 'X-Session-ID')).toBe('session-123');
    expect(getStringProperty(requestHeaders, 'X-Session-Capability')).toBe('capability-token');
    expect(vi.mocked(global.fetch).mock.calls.at(1)?.[0]).toBe(
      'http://localhost/api/verification/bundles/session-123/exec-1/report',
    );
    expect(strictDefined(process.env['USE_MOCK_ZKVM'])).toBe('false');
    expect(process.env['RISC0_DEV_MODE']).toBeUndefined();
  });

  it('does not allow deployed dev-mode verification evidence in production real mode used by develop gated smoke', async () => {
    const verifySTARK = vi.fn<VerifyStark>().mockResolvedValue(false);
    const helpers = createHelpers({
      verifySTARK,
      finalizeWithScenarios: vi.fn().mockResolvedValue({
        data: {
          tally: {
            counts: [64, 0, 0, 0, 0],
            merkleRoot: '0xroot',
            totalVotes: 64,
            tamperedCount: 0,
          },
          proof: {
            receipt: JSON.stringify({ mock: true }),
            imageId: '0ximage',
          },
          debug: {
            verifiedTally: [64, 0, 0, 0, 0],
            missingSlots: 0,
            invalidPresentedSlots: 0,
          },
          userMerklePath: ['0xabc', '0xdef'],
          userVote: {
            commitment: '0xcommit',
            merklePath: ['0xabc', '0xdef'],
            leafIndex: 0,
            treeSize: 64,
          },
          treeSize: 64,
          totalExpected: 64,
          missingSlots: 0,
          invalidPresentedSlots: 0,
          sthDigest: '0xsth',
          includedBitmapRoot: '0xbitmap',
          inputCommitment: '0xinput',
          verificationStatus: 'dev_mode',
          verificationSteps: [
            {
              id: 'counted_as_recorded',
              status: 'success',
              inputs: [],
            },
            {
              id: 'stark_verification',
              status: 'success',
              inputs: [],
            },
          ],
          verificationChecks: [
            {
              id: 'counted_expected_vs_tree_size',
              status: 'success',
              evidence: 'public',
              inputs: ['totalExpected', 'treeSize'],
            },
            {
              id: 'counted_election_manifest_consistent',
              status: 'success',
              evidence: 'public',
              inputs: ['electionManifest'],
            },
            {
              id: 'counted_close_statement_consistent',
              status: 'success',
              evidence: 'public',
              inputs: ['closeStatement'],
            },
            {
              id: 'stark_receipt_verify',
              status: 'success',
              evidence: 'zk',
              inputs: ['proofBundleStatus'],
            },
          ],
          verificationExecutionId: 'exec-1',
          journal: createTestJournal({ totalExpected: 64, validVotes: 64 }),
          verificationReport: {
            status: 'dev_mode',
            verifier_version: '0.1.0',
            verified_at: '2025-10-16T00:00:00Z',
            duration_ms: 1,
            expected_image_id: '0ximage',
            receipt_image_id: null,
            bundle_path: 'bundle',
            receipt_path: 'receipt.json',
            dev_mode_receipt: true,
            errors: [],
          },
        },
      }),
    });
    const config: CLITestConfig = {
      scenarios: [],
      ...omitUndefinedProperties({ scenario: 'S0' }),
      allScenarios: false,
      useRealZkVM: true,
      realMode: 'prod',
      verbose: false,
      outputFormat: 'table',
      userChoice: 'A',
      skipBuild: true,
    };

    const cliTest = new CLIVotingTest(config, helpers);
    const result = await cliTest.runTestCase({
      name: 'S0: Normal case (no tampering)',
      ...omitUndefinedProperties({ scenario: [] }),
      expectedTamper: false,
    });

    const verifyCall = vi.mocked(verifySTARK).mock.calls[0];
    const verifyOptions = requireRecord(strictDefined(verifyCall)[1], 'verifySTARK options');
    expect(verifyOptions).toMatchObject({
      useRealZkVM: true,
      verificationStatus: 'dev_mode',
      allowDevMode: false,
    });
    expect(result.passed).toBe(false);
    expect(result.details.errors).toEqual(expect.arrayContaining(['STARK proof verification failed']));
  });

  it('fails closed when the finalized payload omits the top-level verificationExecutionId', async () => {
    const verifySTARK = vi.fn<VerifyStark>().mockResolvedValue(true);
    const helpers = createHelpers({
      verifySTARK,
      finalizeWithScenarios: vi.fn().mockResolvedValue({
        data: {
          tally: {
            counts: [64, 0, 0, 0, 0],
            merkleRoot: '0xroot',
            totalVotes: 64,
            tamperedCount: 0,
          },
          proof: {
            receipt: JSON.stringify({ mock: true }),
            imageId: '0ximage',
          },
          debug: {
            verifiedTally: [64, 0, 0, 0, 0],
            missingSlots: 0,
            invalidPresentedSlots: 0,
          },
          userMerklePath: ['0xabc', '0xdef'],
          userVote: {
            commitment: '0xcommit',
            merklePath: ['0xabc', '0xdef'],
            leafIndex: 0,
            treeSize: 64,
          },
          treeSize: 64,
          totalExpected: 64,
          missingSlots: 0,
          invalidPresentedSlots: 0,
          sthDigest: '0xsth',
          includedBitmapRoot: '0xbitmap',
          inputCommitment: '0xinput',
          verificationStatus: 'success',
          verificationSteps: [
            {
              id: 'counted_as_recorded',
              status: 'success',
              inputs: [],
            },
            {
              id: 'stark_verification',
              status: 'success',
              inputs: [],
            },
          ],
          verificationChecks: [
            {
              id: 'counted_expected_vs_tree_size',
              status: 'success',
              evidence: 'public',
              inputs: ['totalExpected', 'treeSize'],
            },
            {
              id: 'counted_election_manifest_consistent',
              status: 'success',
              evidence: 'public',
              inputs: ['electionManifest'],
            },
            {
              id: 'counted_close_statement_consistent',
              status: 'success',
              evidence: 'public',
              inputs: ['closeStatement'],
            },
            {
              id: 'stark_receipt_verify',
              status: 'success',
              evidence: 'zk',
              inputs: ['proofBundleStatus'],
            },
          ],
          verificationResult: {
            executionId: 'exec-1',
          },
          journal: createTestJournal({ totalExpected: 64, validVotes: 64 }),
          verificationReport: {
            status: 'success',
            verifier_version: '0.1.0',
            verified_at: '2025-10-16T00:00:00Z',
            duration_ms: 1,
            expected_image_id: '0ximage',
            receipt_image_id: '0ximage',
            bundle_path: 'bundle',
            receipt_path: 'receipt.json',
            dev_mode_receipt: false,
            errors: [],
          },
        },
      }),
    });

    const config: CLITestConfig = {
      scenarios: [],
      ...omitUndefinedProperties({ scenario: 'S0' }),
      allScenarios: false,
      useRealZkVM: true,
      realMode: 'prod',
      verbose: false,
      outputFormat: 'table',
      userChoice: 'A',
      skipBuild: true,
    };

    const cliTest = new CLIVotingTest(config, helpers);
    const result = await cliTest.runTestCase({
      name: 'S0: Normal case (no tampering)',
      ...omitUndefinedProperties({ scenario: [] }),
      expectedTamper: false,
    });

    expect(result.passed).toBe(false);
    expect(result.details.verificationExecutionId).toBeUndefined();
    expect(result.details.errors).toEqual(
      expect.arrayContaining(['Finalized response missing top-level verificationExecutionId']),
    );
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
  });

  it('fails when counted stage stays green after manifest consistency fails', async () => {
    const helpers = createHelpers({
      finalizeWithScenarios: vi.fn().mockResolvedValue({
        data: {
          tally: {
            counts: [64, 0, 0, 0, 0],
            merkleRoot: '0xroot',
            totalVotes: 64,
            tamperedCount: 0,
          },
          proof: {
            receipt: JSON.stringify({ mock: true }),
            imageId: '0ximage',
          },
          debug: {
            verifiedTally: [64, 0, 0, 0, 0],
            missingSlots: 0,
            invalidPresentedSlots: 0,
          },
          userMerklePath: ['0xabc', '0xdef'],
          userVote: {
            commitment: '0xcommit',
            merklePath: ['0xabc', '0xdef'],
            leafIndex: 0,
            treeSize: 64,
          },
          treeSize: 64,
          totalExpected: 64,
          missingSlots: 0,
          invalidPresentedSlots: 0,
          sthDigest: '0xsth',
          includedBitmapRoot: '0xbitmap',
          inputCommitment: '0xinput',
          verificationStatus: 'success',
          verificationSteps: [
            {
              id: 'counted_as_recorded',
              status: 'success',
              inputs: [],
            },
            {
              id: 'stark_verification',
              status: 'success',
              inputs: [],
            },
          ],
          verificationChecks: [
            {
              id: 'counted_expected_vs_tree_size',
              status: 'success',
              evidence: 'public',
              inputs: ['totalExpected', 'treeSize'],
            },
            {
              id: 'counted_election_manifest_consistent',
              status: 'failed',
              evidence: 'public',
              inputs: ['electionManifest'],
            },
            {
              id: 'counted_close_statement_consistent',
              status: 'success',
              evidence: 'public',
              inputs: ['closeStatement'],
            },
            {
              id: 'stark_receipt_verify',
              status: 'success',
              evidence: 'zk',
              inputs: ['proofBundleStatus'],
            },
          ],
          journal: createTestJournal({ totalExpected: 64, validVotes: 64 }),
        },
      }),
    });
    const config: CLITestConfig = {
      scenarios: [],
      ...omitUndefinedProperties({ scenario: undefined }),
      allScenarios: false,
      useRealZkVM: false,
      realMode: 'dev',
      verbose: false,
      outputFormat: 'table',
      userChoice: 'A',
      skipBuild: true,
    };

    const cliTest = new CLIVotingTest(config, helpers);
    const result = await cliTest.runTestCase({
      name: 'S0: Normal case (no tampering)',
      ...omitUndefinedProperties({ scenario: [] }),
      expectedTamper: false,
    });

    expect(result.passed).toBe(false);
    expect(result.details.errors).toEqual(
      expect.arrayContaining([
        'CLI verification required check counted_election_manifest_consistent was failed',
        'Verification contract mismatch: counted_as_recorded was success while counted_election_manifest_consistent=failed',
      ]),
    );
  });
});
