import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  VERIFIER_STDERR_CAPTURE_LIMIT_BYTES,
  VerifierServiceExecutionError,
  invokeVerifierService,
  type SpawnImpl,
} from './verifier-service-client';
import type { VerifierInvocationOptions } from './verifier-service-client';

// Mock child_process spawn
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawnMock = vi.fn();

  return {
    ...actual,
    spawn: spawnMock,
    default: {
      ...actual,
      spawn: spawnMock,
    },
  };
});

describe('verifier-service-client', () => {
  let testWorkDir: string;

  type ProtocolCase = {
    name: string;
    exitCode: number | null;
    reportStatus: 'success' | 'dev_mode' | 'failed' | null;
    expected: 'accept' | 'reject';
  };

  const protocolCases = [
    { name: 'accepts exit 0 with success', exitCode: 0, reportStatus: 'success', expected: 'accept' },
    { name: 'rejects exit 0 with dev_mode', exitCode: 0, reportStatus: 'dev_mode', expected: 'reject' },
    { name: 'rejects exit 0 with failed', exitCode: 0, reportStatus: 'failed', expected: 'reject' },
    { name: 'rejects exit 2 with success', exitCode: 2, reportStatus: 'success', expected: 'reject' },
    { name: 'accepts exit 2 with dev_mode', exitCode: 2, reportStatus: 'dev_mode', expected: 'accept' },
    { name: 'rejects exit 2 with failed', exitCode: 2, reportStatus: 'failed', expected: 'reject' },
    { name: 'rejects exit 3 with success', exitCode: 3, reportStatus: 'success', expected: 'reject' },
    { name: 'rejects exit 3 with dev_mode', exitCode: 3, reportStatus: 'dev_mode', expected: 'reject' },
    { name: 'accepts exit 3 with failed', exitCode: 3, reportStatus: 'failed', expected: 'accept' },
    { name: 'rejects general-error exit 1 without a report', exitCode: 1, reportStatus: null, expected: 'reject' },
    { name: 'rejects a null exit code without a report', exitCode: null, reportStatus: null, expected: 'reject' },
    { name: 'rejects unknown exit 4 with success', exitCode: 4, reportStatus: 'success', expected: 'reject' },
  ] as const satisfies readonly ProtocolCase[];

  const createMockChild = (): ChildProcessWithoutNullStreams => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdio: [PassThrough, PassThrough, PassThrough, null, null] = [stdin, stdout, stderr, null, null];

    return Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      stdio,
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
      spawnargs: [],
      spawnfile: 'verifier-service',
      pid: 1234,
      kill: vi.fn().mockReturnValue(true),
      send: vi.fn(),
      disconnect: vi.fn(),
      unref: vi.fn(),
      ref: vi.fn(),
      [Symbol.dispose]: () => {},
    });
  };

  const IMAGE_ID = `0x${'a'.repeat(64)}`;

  function createSuccessWireReport(bundlePath: string, imageId = IMAGE_ID): Record<string, unknown> {
    return {
      status: 'success',
      verifier_version: '0.1.0',
      verified_at: '2026-08-11T00:00:00Z',
      duration_ms: 1,
      expected_image_id: imageId,
      receipt_image_id: imageId,
      bundle_path: path.basename(bundlePath),
      receipt_path: 'receipt.json',
      dev_mode_receipt: false,
    };
  }

  async function invokeReportFixture(options: {
    name: string;
    report: (bundlePath: string) => Record<string, unknown>;
    exitCode?: number;
    expectedImageId?: string;
    authority?: 'file' | 'stdout';
    trailingWhitespaceBytes?: number;
  }) {
    const bundlePath = path.join(testWorkDir, `bundle-${options.name}`);
    const reportPath = path.join(testWorkDir, `report-${options.name}.json`);
    const mockBinaryPath = path.join(testWorkDir, `verifier-service-${options.name}`);
    await fs.mkdir(bundlePath, { recursive: true });
    await fs.writeFile(mockBinaryPath, '#!/bin/bash\necho test', { mode: 0o755 });

    const mockChild = createMockChild();
    const spawnImpl: SpawnImpl = () => {
      process.nextTick(async () => {
        const content = `${JSON.stringify(options.report(bundlePath))}${' '.repeat(options.trailingWhitespaceBytes ?? 0)}`;
        if (options.authority === 'stdout') {
          mockChild.stdout.emit('data', Buffer.from(content));
        } else {
          await fs.writeFile(reportPath, content, 'utf8');
        }
        mockChild.emit('close', options.exitCode ?? 0);
      });
      return mockChild;
    };

    return invokeVerifierService({
      bundlePath,
      expectedImageId: options.expectedImageId ?? IMAGE_ID,
      reportPath,
      binaryPath: mockBinaryPath,
      spawnImpl,
    });
  }

  beforeEach(async () => {
    // Create temporary directories for test
    testWorkDir = path.join(process.cwd(), '.test-verifier-client');
    await fs.mkdir(testWorkDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup
    try {
      await fs.rm(testWorkDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('invokeVerifierService', () => {
    it.each(protocolCases)('$name', async ({ exitCode, reportStatus, expected }) => {
      const bundlePath = path.join(testWorkDir, 'protocol-bundle');
      const reportPath = path.join(testWorkDir, 'protocol-report.json');
      const mockBinaryPath = path.join(testWorkDir, 'protocol-verifier-service');
      const imageId = `0x${'a'.repeat(64)}`;
      await fs.mkdir(bundlePath, { recursive: true });
      await fs.writeFile(mockBinaryPath, '#!/bin/bash\necho test', { mode: 0o755 });

      const mockChild = createMockChild();
      const spawnImpl: SpawnImpl = () => {
        process.nextTick(async () => {
          if (reportStatus !== null) {
            await fs.writeFile(
              reportPath,
              JSON.stringify({
                status: reportStatus,
                verifier_version: '0.1.0',
                verified_at: '2026-08-11T00:00:00Z',
                duration_ms: 1,
                expected_image_id: imageId,
                receipt_image_id: imageId,
                bundle_path: 'protocol-bundle',
                receipt_path: 'receipt.json',
                dev_mode_receipt: reportStatus === 'dev_mode',
                ...(reportStatus === 'failed' ? { errors: ['verification failed'] } : {}),
              }),
              'utf8',
            );
          }
          mockChild.emit('close', exitCode);
        });
        return mockChild;
      };

      const invocation = invokeVerifierService({
        bundlePath,
        expectedImageId: imageId,
        reportPath,
        binaryPath: mockBinaryPath,
        spawnImpl,
      });

      if (expected === 'accept') {
        const result = await invocation;
        expect(result.status).toBe(reportStatus);
        expect(result.report.status).toBe(reportStatus);
        return;
      }

      await expect(invocation).rejects.toBeInstanceOf(VerifierServiceExecutionError);
    });

    it('should resolve binary path and invoke verifier', async () => {
      // Arrange
      const bundlePath = path.join(testWorkDir, 'bundle');
      const reportPath = path.join(testWorkDir, 'report.json');
      const mockBinaryPath = path.join(testWorkDir, 'verifier-service');

      await fs.mkdir(bundlePath, { recursive: true });
      // Create fake binary file so resolveBinaryPath succeeds
      await fs.writeFile(mockBinaryPath, '#!/bin/bash\necho test', { mode: 0o755 });

      const mockReport = {
        status: 'success' as const,
        verifier_version: '0.1.0',
        verified_at: '2025-10-16T00:00:00Z',
        duration_ms: 42,
        expected_image_id: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d',
        receipt_image_id: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d',
        bundle_path: path.basename(bundlePath),
        receipt_path: 'receipt.json',
        dev_mode_receipt: false,
      };

      const mockChild = createMockChild();

      let spawnCalled = false;
      let spawnArguments: readonly string[] | undefined;
      const spawnImpl: SpawnImpl = (_command, args) => {
        spawnCalled = true;
        spawnArguments = args;
        // Emit events after listeners are registered
        process.nextTick(async () => {
          await fs.writeFile(reportPath, JSON.stringify(mockReport, null, 2), 'utf-8');
          mockChild.stdout.emit('data', Buffer.from(JSON.stringify(mockReport)));
          mockChild.emit('close', 0);
        });
        return mockChild;
      };

      const options: VerifierInvocationOptions = {
        bundlePath,
        expectedImageId: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d',
        reportPath,
        binaryPath: mockBinaryPath,
      };

      // Act
      const result = await invokeVerifierService({ ...options, spawnImpl });

      // Assert
      expect(result.status).toBe('success');
      expect(result.reportPath).toBe(reportPath);
      expect(result.bundlePath).toBe(bundlePath);
      expect(result.report.status).toBe('success');
      expect(result.report).not.toHaveProperty('bundle_path');
      expect(result.report).not.toHaveProperty('receipt_path');
      expect(result.diagnostics).toEqual({ stderrCategory: 'none', stderrBytes: 0, stderrTruncated: false });
      expect(spawnCalled).toBe(true);
      expect(spawnArguments).toEqual([
        'verify',
        '--bundle',
        bundlePath,
        '--image-id',
        options.expectedImageId,
        '--output',
        reportPath,
        '--quiet',
      ]);
    });

    it('bounds success-path stderr during streaming and exposes only closed diagnostics', async () => {
      const bundlePath = path.join(testWorkDir, 'bundle-noisy-success');
      const reportPath = path.join(testWorkDir, 'report-noisy-success.json');
      const mockBinaryPath = path.join(testWorkDir, 'verifier-service-noisy-success');
      const privateStderr = `s3://private-bucket/raw-session/input.json ${'private-receipt-byte'.repeat(1_000)}`;
      await fs.mkdir(bundlePath, { recursive: true });
      await fs.writeFile(mockBinaryPath, '#!/bin/bash\necho test', { mode: 0o755 });

      const mockReport = {
        status: 'success' as const,
        verifier_version: '0.1.0',
        verified_at: '2025-10-16T00:00:00Z',
        duration_ms: 42,
        expected_image_id: `0x${'a'.repeat(64)}`,
        receipt_image_id: `0x${'a'.repeat(64)}`,
        bundle_path: path.basename(bundlePath),
        receipt_path: 'receipt.json',
        dev_mode_receipt: false,
      };
      const mockChild = createMockChild();
      const spawnImpl: SpawnImpl = () => {
        process.nextTick(async () => {
          await fs.writeFile(reportPath, JSON.stringify(mockReport), 'utf8');
          mockChild.stderr.emit('data', Buffer.from(privateStderr));
          mockChild.stderr.emit('data', Buffer.from(privateStderr));
          mockChild.emit('close', 0);
        });
        return mockChild;
      };

      const result = await invokeVerifierService({
        bundlePath,
        expectedImageId: `0x${'a'.repeat(64)}`,
        reportPath,
        binaryPath: mockBinaryPath,
        spawnImpl,
      });

      expect(result.diagnostics).toEqual({
        stderrCategory: 'truncated',
        stderrBytes: VERIFIER_STDERR_CAPTURE_LIMIT_BYTES,
        stderrTruncated: true,
      });
      expect(JSON.stringify(result)).not.toContain(privateStderr);
      expect(JSON.stringify(result)).not.toContain('private-bucket');
      expect(JSON.stringify(result)).not.toContain('private-receipt-byte');
    });

    it('preserves closed stderr diagnostics when report parsing fails without exposing report or stderr text', async () => {
      const bundlePath = path.join(testWorkDir, 'bundle-invalid-report');
      const reportPath = path.join(testWorkDir, 'report-invalid.json');
      const mockBinaryPath = path.join(testWorkDir, 'verifier-service-invalid-report');
      const privateStderr = `s3://private-bucket/raw-session/input.json ${'private-stderr'.repeat(1_000)}`;
      const privateInvalidReport = '{"privateReceipt":"private-report-bytes"';
      await fs.mkdir(bundlePath, { recursive: true });
      await fs.writeFile(mockBinaryPath, '#!/bin/bash\necho test', { mode: 0o755 });

      const mockChild = createMockChild();
      const spawnImpl: SpawnImpl = () => {
        process.nextTick(() => {
          mockChild.stdout.emit('data', Buffer.from(privateInvalidReport));
          mockChild.stderr.emit('data', Buffer.from(privateStderr));
          mockChild.emit('close', 0);
        });
        return mockChild;
      };

      let caught: unknown;
      try {
        await invokeVerifierService({
          bundlePath,
          expectedImageId: `0x${'a'.repeat(64)}`,
          reportPath,
          binaryPath: mockBinaryPath,
          spawnImpl,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        message: 'verifier-service report unavailable or invalid',
        diagnostics: {
          stderrCategory: 'truncated',
          stderrBytes: VERIFIER_STDERR_CAPTURE_LIMIT_BYTES,
          stderrTruncated: true,
        },
      });
      expect(String(caught)).not.toContain('private-bucket');
      expect(String(caught)).not.toContain('private-stderr');
      expect(String(caught)).not.toContain('private-report-bytes');
    });

    it('should handle dev mode receipts (exit code 2)', async () => {
      // Arrange
      const bundlePath = path.join(testWorkDir, 'bundle-dev');
      const reportPath = path.join(testWorkDir, 'report-dev.json');
      const mockBinaryPath = path.join(testWorkDir, 'verifier-service');

      await fs.mkdir(bundlePath, { recursive: true });
      // Create fake binary file so resolveBinaryPath succeeds
      await fs.writeFile(mockBinaryPath, '#!/bin/bash\necho test', { mode: 0o755 });

      const mockReport = {
        status: 'dev_mode' as const,
        verifier_version: '0.1.0',
        verified_at: '2025-10-16T00:00:00Z',
        duration_ms: 2,
        expected_image_id: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d',
        receipt_image_id: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d',
        bundle_path: path.basename(bundlePath),
        receipt_path: 'receipt.json',
        dev_mode_receipt: true,
      };

      // Use real EventEmitter instances
      const mockChild = createMockChild();

      vi.mocked(spawn).mockImplementation(() => {
        void (async () => {
          await fs.writeFile(reportPath, JSON.stringify(mockReport, null, 2), 'utf-8');
          mockChild.stdout.emit('data', Buffer.from(JSON.stringify(mockReport)));
          mockChild.emit('close', 2); // Exit code 2 = dev mode
        })();
        return mockChild;
      });

      const options: VerifierInvocationOptions = {
        bundlePath,
        expectedImageId: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d',
        reportPath,
        binaryPath: mockBinaryPath,
      };

      // Act
      const result = await invokeVerifierService(options);

      // Assert
      expect(result.status).toBe('dev_mode');
      expect(result.report.dev_mode_receipt).toBe(true);
    });

    it('should handle verification failure (exit code 3)', async () => {
      // Arrange
      const bundlePath = path.join(testWorkDir, 'bundle-fail');
      const reportPath = path.join(testWorkDir, 'report-fail.json');
      const mockBinaryPath = path.join(testWorkDir, 'verifier-service');

      await fs.mkdir(bundlePath, { recursive: true });
      // Create fake binary file so resolveBinaryPath succeeds
      await fs.writeFile(mockBinaryPath, '#!/bin/bash\necho test', { mode: 0o755 });

      const mockReport = {
        status: 'failed' as const,
        verifier_version: '0.1.0',
        verified_at: '2025-10-16T00:00:00Z',
        duration_ms: 5,
        expected_image_id: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d',
        receipt_image_id: '0x0000000000000000000000000000000000000000000000000000000000000000',
        bundle_path: path.basename(bundlePath),
        receipt_path: 'receipt.json',
        dev_mode_receipt: false,
        errors: ['ImageID mismatch'],
      };

      const mockChild = createMockChild();

      vi.mocked(spawn).mockImplementation(() => {
        void (async () => {
          await fs.writeFile(reportPath, JSON.stringify(mockReport, null, 2), 'utf-8');
          mockChild.stdout.emit('data', Buffer.from(JSON.stringify(mockReport)));
          mockChild.emit('close', 3); // Exit code 3 = verification failed
        })();
        return mockChild;
      });

      const options: VerifierInvocationOptions = {
        bundlePath,
        expectedImageId: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d',
        reportPath,
        binaryPath: mockBinaryPath,
      };

      // Act
      const result = await invokeVerifierService(options);

      // Assert
      expect(result.status).toBe('failed');
      expect(result.report.errors).toContain('ImageID mismatch');
    });

    it('should throw error for general errors (exit code 1)', async () => {
      // Arrange
      const bundlePath = path.join(testWorkDir, 'bundle-error');
      const reportPath = path.join(testWorkDir, 'report-error.json');
      const mockBinaryPath = path.join(testWorkDir, 'verifier-service-error');

      await fs.mkdir(bundlePath, { recursive: true });
      // Create fake binary file so resolveBinaryPath succeeds
      await fs.writeFile(mockBinaryPath, '#!/bin/bash\necho test', { mode: 0o755 });

      const mockChild = createMockChild();

      const spawnImpl: SpawnImpl = (...args: Parameters<SpawnImpl>) => {
        void args;
        // Emit events after listeners are registered (stderr only for exit code 1)
        process.nextTick(() => {
          mockChild.stderr.emit('data', Buffer.from('invalid arguments'));
          // Do NOT emit to stdout - exit code 1 should only have stderr output
          mockChild.emit('close', 1); // Exit code 1 = general error
        });
        return mockChild;
      };

      const options: VerifierInvocationOptions = {
        bundlePath,
        expectedImageId: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d',
        reportPath,
        binaryPath: mockBinaryPath,
      };

      // Act & Assert
      const invocation = invokeVerifierService({ ...options, spawnImpl });
      await expect(invocation).rejects.toMatchObject({
        message: 'verifier-service exited with status 1',
        diagnostics: {
          stderrCategory: 'present',
          stderrBytes: Buffer.byteLength('invalid arguments'),
          stderrTruncated: false,
        },
      });
      await expect(invocation).rejects.not.toThrow('invalid arguments');
    });

    it('rejects stdout as report authority when the output file is absent', async () => {
      await expect(
        invokeReportFixture({
          name: 'stdout-only',
          report: (bundlePath) => createSuccessWireReport(bundlePath),
          authority: 'stdout',
        }),
      ).rejects.toMatchObject({ message: 'verifier-service report unavailable or invalid' });
    });

    it('rejects an oversized output report before parsing it', async () => {
      await expect(
        invokeReportFixture({
          name: 'oversized',
          report: (bundlePath) => createSuccessWireReport(bundlePath),
          trailingWhitespaceBytes: 1024 * 1024,
        }),
      ).rejects.toMatchObject({ message: 'verifier-service report unavailable or invalid' });
    });

    it.each([
      {
        name: 'expected ImageID',
        expectedImageId: IMAGE_ID,
        report: (bundlePath: string) => createSuccessWireReport(bundlePath, `0x${'b'.repeat(64)}`),
      },
      {
        name: 'bundle basename',
        expectedImageId: IMAGE_ID,
        report: (bundlePath: string) => ({
          ...createSuccessWireReport(bundlePath),
          bundle_path: 'different-bundle',
        }),
      },
    ])('binds the admitted $name to the invocation', async ({ name, expectedImageId, report }) => {
      await expect(
        invokeReportFixture({
          name: `binding-${name}`,
          expectedImageId,
          report,
        }),
      ).rejects.toMatchObject({ message: 'verifier-service report does not match invocation' });
    });

    it('rejects malformed receipt ImageIDs from failed Rust reports', async () => {
      await expect(
        invokeReportFixture({
          name: 'malformed-receipt-id',
          exitCode: 3,
          report: (bundlePath) => ({
            ...createSuccessWireReport(bundlePath),
            status: 'failed',
            receipt_image_id: '0xmalformed',
            errors: ['malformed receipt metadata'],
          }),
        }),
      ).rejects.toMatchObject({ message: 'verifier-service report unavailable or invalid' });
    });

    it('should throw error when binary not found', async () => {
      // Arrange
      delete process.env['VERIFIER_SERVICE_BIN'];

      // Use valid paths but no binary
      const bundlePath = path.join(testWorkDir, 'bundle-no-binary');
      const reportPath = path.join(testWorkDir, 'report-no-binary.json');
      await fs.mkdir(bundlePath, { recursive: true });

      // Mock fs.access to always fail (simulate binary not found)
      const fsAccessSpy = vi.spyOn(fs, 'access').mockRejectedValue(new Error('ENOENT'));

      const options: VerifierInvocationOptions = {
        bundlePath,
        expectedImageId: '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d',
        reportPath,
        binaryPath: path.join(testWorkDir, 'nonexistent-binary'),
      };

      // Act & Assert
      await expect(invokeVerifierService(options)).rejects.toThrow('verifier-service binary not found');

      // Cleanup
      fsAccessSpy.mockRestore();
    });
  });
});
