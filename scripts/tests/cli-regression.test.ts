import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { CLITestHelpers } from '@stark-ballot/test-support/testing/cli-test-helpers';
import { buildCliVerificationPresentationFixture } from '@stark-ballot/test-support/testing/cli-verification-fixtures';
import type { CLITestConfig, CommandSpawner } from './cli-e2e-voting-flow';
import {
  CLIVotingTest,
  configureCliRuntimeProfile,
  resolveDefaultCliExpectedImageId,
  runBuildCiCommand,
} from './cli-e2e-voting-flow';
import { getStringProperty, requireRecord } from '@stark-ballot/validation/unknown-value-guards';
import { parseImageIdMapping } from '@stark-ballot/validation/image-id-mapping';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import imageIdMappingJson from '../../public/imageId-mapping.json';
import packageJson from '../../package.json';
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
        finalizationId: 'finalization-1',
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
        ...buildCliVerificationPresentationFixture({
          steps: [
            { id: 'counted_as_recorded', status: 'success' },
            { id: 'stark_verification', status: 'success' },
          ],
          checks: [
            { id: 'counted_expected_vs_tree_size', status: 'success' },
            { id: 'counted_election_manifest_consistent', status: 'success' },
            { id: 'counted_close_statement_consistent', status: 'success' },
            { id: 'stark_receipt_verify', status: 'success' },
          ],
        }),
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
      meta: {
        mode: 'sync',
        finalizationId: 'finalization-1',
      },
    }),
    verifySTARK: vi.fn().mockResolvedValue(true),
    describeReceipt: vi.fn().mockReturnValue({ kind: 'mock' }),
    verifyMerkle: vi.fn().mockResolvedValue(true),
    generateReport: vi.fn().mockResolvedValue(''),
    executeZkVM: vi.fn(),
    getPathSessionAuthHeaders: vi.fn().mockReturnValue({
      'X-Session-Capability': 'capability-token',
    }),
    ...overrides,
  } as unknown as CLITestHelpers;

  return helpers;
}

type VerifyStark = CLITestHelpers['verifySTARK'];

const trackedEnvVars = ['RUNTIME_PROFILE', 'VITE_RUNTIME_PROFILE', 'STARK_BALLOT_CLI_BASE_URL'];
const originalFetch = global.fetch;
const imageIdMapping = parseImageIdMapping(imageIdMappingJson);
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

function verifierWireReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const imageId = `0x${'1'.repeat(64)}`;
  return {
    status: 'success',
    verifier_version: '0.1.0',
    verified_at: '2025-10-16T00:00:00Z',
    duration_ms: 1,
    expected_image_id: imageId,
    receipt_image_id: imageId,
    bundle_path: 'bundle.zip',
    receipt_path: 'receipt.json',
    dev_mode_receipt: false,
    ...overrides,
  };
}

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
        new Response(JSON.stringify(verifierWireReport()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
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
            ETag: '"bundle-etag"',
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

interface CliArtifactDownloadHarness {
  downloadAuthenticatedBundle(url: string): Promise<Buffer>;
  downloadAuthenticatedReport(url: string): Promise<Buffer>;
}

function createCliArtifactDownloadHarness(): CliArtifactDownloadHarness {
  const config: CLITestConfig = {
    scenarios: [],
    allScenarios: false,
    useRealZkVM: false,
    realMode: 'dev',
    verbose: false,
    outputFormat: 'table',
    userChoice: 'A',
    skipBuild: true,
  };
  return new CLIVotingTest(config, createHelpers()) as unknown as CliArtifactDownloadHarness;
}

describe('CLIVotingTest regression coverage', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    global.fetch = createAuthenticatedDownloadFetch(await createBundleZipBuffer());
    trackedEnvVars.forEach((key) => {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    });
    process.env['STARK_BALLOT_CLI_BASE_URL'] = 'http://localhost';
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    const describeReceipt = vi.fn().mockReturnValue({ kind: 'mock' });
    const helpers = createHelpers({ verifySTARK, describeReceipt, verifyMerkle });
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
        proofProfile: {
          executor: 'mock',
          evidence: 'mock',
        },
        verificationStatus: 'success',
      }),
    );
    const verifyCall = vi.mocked(verifySTARK).mock.calls[0];
    const verifyOptions = requireRecord(strictDefined(verifyCall)[1], 'verifySTARK options');
    expect(verifyOptions).not.toHaveProperty('verificationBundlePath');

    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(global.fetch).mock.calls.map((call) => call[0])).toEqual([
      'http://localhost/api/sessions/session-123/finalizations/finalization-1/artifacts/bundle',
      'http://localhost/api/sessions/session-123/finalizations/finalization-1/artifacts/report',
    ]);
    for (const fetchCall of vi.mocked(global.fetch).mock.calls) {
      const requestOptions = requireRecord(fetchCall[1], 'fetch request init');
      expect(getStringProperty(requestOptions, 'method')).toBe('GET');
      const requestHeaders = requireRecord(requestOptions['headers'], 'fetch request headers');
      expect(getStringProperty(requestHeaders, 'X-Session-ID')).toBeUndefined();
      expect(getStringProperty(requestHeaders, 'X-Session-Capability')).toBe('capability-token');
    }

    expect(result.details.verificationBundleDelivery).toBe('authenticated-endpoint');
    expect(result.details.verificationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.details.verificationReportHash).toMatch(/^[0-9a-f]{64}$/);
    expect(describeReceipt).toHaveBeenCalledWith(JSON.stringify({ mock: true }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[OK] STARK proof verified (mock)'));
    expect(verifyMerkle).toHaveBeenCalledTimes(1);
    expect(strictDefined(process.env['RUNTIME_PROFILE'])).toBe('static-mock-e2e');
    expect(strictDefined(process.env['VITE_RUNTIME_PROFILE'])).toBe('static-mock-e2e');
  });

  it.each([
    {
      name: 'an oversized advertised total',
      response: new Response('0123', {
        status: 206,
        headers: { 'Content-Range': `bytes 0-3/${256 * 1024 * 1024 + 1}` },
      }),
    },
    {
      name: 'a malformed content range',
      response: new Response('0123', {
        status: 206,
        headers: { 'Content-Range': 'bytes invalid' },
      }),
    },
    {
      name: 'a body shorter than its advertised range',
      response: new Response('012', {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-3/4', ETag: '"bundle-etag"' },
      }),
    },
    {
      name: 'a body longer than its advertised range',
      response: new Response('01234', {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-3/4', ETag: '"bundle-etag"' },
      }),
    },
    {
      name: 'a response without a representation identity',
      response: new Response('0123', {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-3/4' },
      }),
    },
  ])('rejects $name while downloading a CLI bundle', async ({ response }) => {
    global.fetch = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(
      createCliArtifactDownloadHarness().downloadAuthenticatedBundle('http://localhost/artifacts/bundle'),
    ).rejects.toThrow('Invalid ranged bundle response');
  });

  it('rejects a later CLI range that does not exactly match the requested interval', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('0123', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 0-3/8',
            'X-Stark-Bundle-Range-Chunk-Size': '4',
            ETag: '"bundle-etag"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response('456', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 4-6/8',
            'X-Stark-Bundle-Range-Chunk-Size': '4',
            ETag: '"bundle-etag"',
          },
        }),
      );
    global.fetch = fetchMock;

    await expect(
      createCliArtifactDownloadHarness().downloadAuthenticatedBundle('http://localhost/artifacts/bundle'),
    ).rejects.toThrow('Invalid ranged bundle response');
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('range')).toBe('bytes=4-7');
  });

  it('rejects a representation identity change between CLI bundle ranges', async () => {
    global.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('0123', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 0-3/8',
            'X-Stark-Bundle-Range-Chunk-Size': '4',
            ETag: '"bundle-etag"',
            'X-Amz-Version-Id': 'version-1',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response('4567', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 4-7/8',
            'X-Stark-Bundle-Range-Chunk-Size': '4',
            ETag: '"bundle-etag"',
            'X-Amz-Version-Id': 'version-2',
          },
        }),
      );

    await expect(
      createCliArtifactDownloadHarness().downloadAuthenticatedBundle('http://localhost/artifacts/bundle'),
    ).rejects.toThrow('Bundle representation changed during download');
  });

  it('caps an oversized CLI server-advertised chunk size at the local 4 MiB request bound', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('0123', {
          status: 206,
          headers: {
            'Content-Range': `bytes 0-3/${8 * 1024 * 1024}`,
            'X-Stark-Bundle-Range-Chunk-Size': String(64 * 1024 * 1024),
            ETag: '"bundle-etag"',
          },
        }),
      )
      .mockResolvedValueOnce(new Response('range unavailable', { status: 416 }));
    global.fetch = fetchMock;

    await expect(
      createCliArtifactDownloadHarness().downloadAuthenticatedBundle('http://localhost/artifacts/bundle'),
    ).rejects.toThrow('HTTP 416');
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('range')).toBe('bytes=4-4194307');
  });

  it('rejects a full CLI bundle whose declared size exceeds the client bound', async () => {
    global.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('bundle', {
        status: 200,
        headers: { 'Content-Length': String(256 * 1024 * 1024 + 1) },
      }),
    );

    await expect(
      createCliArtifactDownloadHarness().downloadAuthenticatedBundle('http://localhost/artifacts/bundle'),
    ).rejects.toThrow('bundle response exceeds size limit');
  });

  it('rejects a protected CLI report whose declared size exceeds 4 MiB', async () => {
    global.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"status":"success"}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(4 * 1024 * 1024 + 1),
        },
      }),
    );

    await expect(
      createCliArtifactDownloadHarness().downloadAuthenticatedReport('http://localhost/artifacts/report'),
    ).rejects.toThrow('report response exceeds size limit');
  });

  it('rejects a protected CLI report whose received body exceeds 4 MiB without a content length', async () => {
    global.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('x'.repeat(4 * 1024 * 1024 + 1), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      createCliArtifactDownloadHarness().downloadAuthenticatedReport('http://localhost/artifacts/report'),
    ).rejects.toThrow('report response exceeds size limit');
  });

  it.each([
    {
      name: 'an unknown key',
      report: verifierWireReport({ private_path: '/tmp/private' }),
    },
    {
      name: 'a missing required path',
      report: (() => {
        const report = verifierWireReport();
        delete report['receipt_path'];
        return report;
      })(),
    },
    {
      name: 'an incoherent success status',
      report: verifierWireReport({ dev_mode_receipt: true }),
    },
  ])('rejects a protected CLI report with $name', async ({ report }) => {
    global.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(report), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      createCliArtifactDownloadHarness().downloadAuthenticatedReport('http://localhost/artifacts/report'),
    ).rejects.toThrow('report endpoint returned invalid JSON');
  });

  it('fails closed when the default variant awaits accepted managed Prover evidence', () => {
    const method = strictDefined(imageIdMapping.mappings[imageIdMapping.current]);
    const unconfirmed = {
      ...imageIdMapping,
      mappings: {
        ...imageIdMapping.mappings,
        [imageIdMapping.current]: {
          ...method,
          variants: {
            ...method.variants,
            default: { state: 'unconfirmed', requiredEvidence: 'accepted-prover-release' },
          },
        },
      },
    };
    expect(() => resolveDefaultCliExpectedImageId(unconfirmed, 'default')).toThrow(
      expect.objectContaining({ name: 'ImageIdVariantResolutionError', reason: 'variant_unconfirmed' }),
    );
  });

  it('admits the CLI ImageID mapping before reading its current method', () => {
    expect(() => resolveDefaultCliExpectedImageId(null, 'default')).toThrow('ImageID mapping must be an object');
  });

  it('resolves the x86_64 variant when explicitly requested', () => {
    const resolved = resolveDefaultCliExpectedImageId(imageIdMapping, 'x86_64');
    const current = imageIdMapping.mappings[imageIdMapping.current];
    const x86 = strictDefined(current).variants.x86_64;
    if (x86.state !== 'confirmed') {
      throw new Error('x86_64 test mapping must be confirmed');
    }

    expect(resolved.variant).toBe('x86_64');
    expect(resolved.imageId).toBe(x86.imageId);
  });

  it('selects one semantic runtime profile and removes retired selector inputs before server start', () => {
    const environment: NodeJS.ProcessEnv = {
      S3_PROOF_PREFIX: 'sessions/',
      USE_MOCK_ZKVM: 'true',
      RISC0_DEV_MODE: '1',
    };

    configureCliRuntimeProfile({ useRealZkVM: true, realMode: 'prod' }, environment);
    expect(environment['RUNTIME_PROFILE']).toBe('local-proof-production');
    expect(environment['VITE_RUNTIME_PROFILE']).toBe('local-proof-production');
    expect(environment['USE_MOCK_ZKVM']).toBeUndefined();
    expect(environment['RISC0_DEV_MODE']).toBeUndefined();
    expect(environment['S3_PROOF_PREFIX']).toBeUndefined();

    environment['USE_MOCK_ZKVM'] = 'true';
    configureCliRuntimeProfile({ useRealZkVM: true, realMode: 'dev' }, environment);
    expect(environment['RUNTIME_PROFILE']).toBe('local-proof-development');
    expect(environment['VITE_RUNTIME_PROFILE']).toBe('local-proof-development');
    expect(environment['USE_MOCK_ZKVM']).toBeUndefined();
    expect(environment['RISC0_DEV_MODE']).toBeUndefined();
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

  it('runs the local-profile artifact build without server secrets or retired selectors', async () => {
    const sourceEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'development',
      PATH: '/usr/bin',
      HOME: '/home/tester',
      CI: 'true',
      VITE_API_BASE_URL: 'https://api.example.com',
      VITE_RUNTIME_PROFILE: 'local-proof-development',
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
      expect(args).toEqual(['build:local-mock']);
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
      VITE_RUNTIME_PROFILE: 'local-proof-development',
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
        proofProfile: {
          executor: 'risc0',
          evidence: 'production',
        },
        verificationStatus: 'success',
      }),
    );
    expect(describeReceipt).not.toHaveBeenCalled();

    const verifyCall = vi.mocked(verifySTARK).mock.calls[0];
    const verifyOptions = requireRecord(strictDefined(verifyCall)[1], 'verifySTARK options');
    const bundlePath = getStringProperty(verifyOptions, 'verificationBundlePath');
    expect(bundlePath).toBeDefined();
    expect(bundlePath).toContain('bundle');

    expect(result.passed).toBe(false);
    expect(result.details.errors).toEqual(expect.arrayContaining(['STARK proof verification failed']));
    expect(result.details.verificationStatus).toBe('success');
    expect(result.details.finalizationId).toBe('finalization-1');
    expect(console.log).toHaveBeenCalledWith(
      '[CLI] Production STARK proof enabled; expected duration is about 6 minutes per scenario',
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[ERROR] STARK proof verification failed'));
    expect(result.details.verificationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.details.verificationReportHash).toMatch(/^[0-9a-f]{64}$/);
    const fetchCall = vi.mocked(global.fetch).mock.calls.at(0);
    expect(fetchCall).toBeDefined();

    expect(fetchCall?.[0]).toBe(
      'http://localhost/api/sessions/session-123/finalizations/finalization-1/artifacts/bundle',
    );

    const requestOptions = requireRecord(fetchCall?.[1], 'fetch request init');
    expect(getStringProperty(requestOptions, 'method')).toBe('GET');

    const requestHeaders = requireRecord(requestOptions['headers'], 'fetch request headers');
    expect(getStringProperty(requestHeaders, 'X-Session-ID')).toBeUndefined();
    expect(getStringProperty(requestHeaders, 'X-Session-Capability')).toBe('capability-token');
    expect(vi.mocked(global.fetch).mock.calls.at(1)?.[0]).toBe(
      'http://localhost/api/sessions/session-123/finalizations/finalization-1/artifacts/report',
    );
    expect(strictDefined(process.env['RUNTIME_PROFILE'])).toBe('local-proof-production');
    expect(strictDefined(process.env['VITE_RUNTIME_PROFILE'])).toBe('local-proof-production');
  });

  it('keeps routine production-proof diagnostics free of stale format warnings', async () => {
    const describeReceipt = vi.fn().mockReturnValue({ kind: 'unknown' });
    const helpers = createHelpers({ describeReceipt });
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

    const result = await new CLIVotingTest(config, helpers).runTestCase({
      name: 'S0: Normal case (no tampering)',
      ...omitUndefinedProperties({ scenario: [] }),
      expectedTamper: false,
    });

    expect(result.passed).toBe(true);
    expect(describeReceipt).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      '[CLI] Production STARK proof enabled; expected duration is about 6 minutes per scenario',
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[OK] STARK proof verified (authenticated production RISC Zero receipt)'),
    );
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('[WARN]'));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Receipt format could not be classified'));
    expect(console.log).not.toHaveBeenCalledWith('[DEBUG] Merkle verification data:');
  });

  it('does not allow deployed dev-mode verification evidence in production real mode used by develop gated smoke', async () => {
    const verifySTARK = vi.fn<VerifyStark>().mockResolvedValue(false);
    const helpers = createHelpers({
      verifySTARK,
      finalizeWithScenarios: vi.fn().mockResolvedValue({
        data: {
          finalizationId: 'finalization-1',
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
          ...buildCliVerificationPresentationFixture({
            steps: [
              { id: 'counted_as_recorded', status: 'success' },
              { id: 'stark_verification', status: 'success' },
            ],
            checks: [
              { id: 'counted_expected_vs_tree_size', status: 'success' },
              { id: 'counted_election_manifest_consistent', status: 'success' },
              { id: 'counted_close_statement_consistent', status: 'success' },
              { id: 'stark_receipt_verify', status: 'success' },
            ],
          }),
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
        meta: {
          mode: 'sync',
          finalizationId: 'finalization-1',
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
      proofProfile: {
        executor: 'risc0',
        evidence: 'production',
      },
      verificationStatus: 'dev_mode',
    });
    expect(result.passed).toBe(false);
    expect(result.details.errors).toEqual(expect.arrayContaining(['STARK proof verification failed']));
    expect(console.log).toHaveBeenCalledWith(
      '[CLI] Production STARK proof enabled; expected duration is about 6 minutes per scenario',
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[ERROR] STARK proof verification failed'));
  });

  it('fails closed when the finalization result omits finalizationId authority', async () => {
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
          ...buildCliVerificationPresentationFixture({
            steps: [
              { id: 'counted_as_recorded', status: 'success' },
              { id: 'stark_verification', status: 'success' },
            ],
            checks: [
              { id: 'counted_expected_vs_tree_size', status: 'success' },
              { id: 'counted_election_manifest_consistent', status: 'success' },
              { id: 'counted_close_statement_consistent', status: 'success' },
              { id: 'stark_receipt_verify', status: 'success' },
            ],
          }),
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
    expect(result.details.finalizationId).toBeUndefined();
    expect(result.details.errors).toEqual(
      expect.arrayContaining(['Finalization response missing a safe finalizationId']),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[ERROR] Finalization response missing a safe finalizationId'),
    );
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
  });

  it('does not trust a stale flat counted stage after manifest consistency fails', async () => {
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
          ...buildCliVerificationPresentationFixture({
            steps: [
              { id: 'counted_as_recorded', status: 'success' },
              { id: 'stark_verification', status: 'success' },
            ],
            checks: [
              { id: 'counted_expected_vs_tree_size', status: 'success' },
              { id: 'counted_election_manifest_consistent', status: 'failed' },
              { id: 'counted_close_statement_consistent', status: 'success' },
              { id: 'stark_receipt_verify', status: 'success' },
            ],
          }),
          journal: createTestJournal({ totalExpected: 64, validVotes: 64 }),
        },
        meta: {
          mode: 'sync',
          finalizationId: 'finalization-1',
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
      expect.arrayContaining(['CLI verification required check counted_election_manifest_consistent was failed']),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        '[ERROR] CLI verification required check counted_election_manifest_consistent was failed',
      ),
    );
    expect(result.details.errors).not.toContain(
      'Verification contract mismatch: counted_as_recorded was success while counted_election_manifest_consistent=failed',
    );
  });
});
