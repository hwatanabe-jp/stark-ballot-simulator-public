import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { invokeVerifierService, type SpawnImpl } from '../verifier-service-client';
import type { VerifierInvocationOptions } from '../verifier-service-client';

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
        bundle_path: bundlePath,
        receipt_path: path.join(bundlePath, 'receipt.json'),
        dev_mode_receipt: false,
        errors: [],
      };

      const mockChild = createMockChild();

      let spawnCalled = false;
      const spawnImpl: SpawnImpl = (...args) => {
        spawnCalled = true;
        void args;
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
      expect(spawnCalled).toBe(true);
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
        bundle_path: bundlePath,
        receipt_path: path.join(bundlePath, 'receipt.json'),
        dev_mode_receipt: true,
        errors: [],
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
        bundle_path: bundlePath,
        receipt_path: path.join(bundlePath, 'receipt.json'),
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

      const spawnImpl: SpawnImpl = (...args) => {
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
      await expect(invokeVerifierService({ ...options, spawnImpl })).rejects.toThrow('invalid arguments');
    });

    it('should throw error when binary not found', async () => {
      // Arrange
      delete process.env.VERIFIER_SERVICE_BIN;

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
