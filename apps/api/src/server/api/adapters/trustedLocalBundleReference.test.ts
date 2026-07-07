import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTrustedLocalBundleReference } from './trustedLocalBundleReference';
import type { AwsPersistedFinalizationResult } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';

describe('resolveTrustedLocalBundleReference', () => {
  it('derives trusted local bundle references from scoped session and execution identity', async () => {
    const verifierWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trusted-local-bundle-reference-'));

    try {
      const bundlePath = path.join(verifierWorkDir, 'session-123', 'exec-1');
      await fs.mkdir(bundlePath, { recursive: true });
      await fs.writeFile(path.join(bundlePath, 'public-input.json'), '{}', 'utf-8');

      const reference = resolveTrustedLocalBundleReference(
        'session-123',
        {
          verificationExecutionId: 'exec-1',
          verificationResult: {
            status: 'success',
            executionId: 'exec-1',
          },
        } satisfies Pick<AwsPersistedFinalizationResult, 'verificationExecutionId' | 'verificationResult'>,
        {
          verifierWorkDir,
        },
      );

      expect(reference).toEqual({
        bundlePath,
        sessionId: 'session-123',
        executionId: 'exec-1',
        reportPath: path.join(bundlePath, 'verification.json'),
        bundleKey: undefined,
      });
    } finally {
      await fs.rm(verifierWorkDir, { recursive: true, force: true });
    }
  });

  it('does not derive trusted local bundle references in target runtime', async () => {
    const verifierWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trusted-local-bundle-target-reference-'));

    try {
      const bundlePath = path.join(verifierWorkDir, 'session-123', 'exec-1');
      await fs.mkdir(bundlePath, { recursive: true });
      await fs.writeFile(path.join(bundlePath, 'public-input.json'), '{}', 'utf-8');

      const reference = resolveTrustedLocalBundleReference(
        'session-123',
        {
          verificationExecutionId: 'exec-1',
          verificationResult: {
            status: 'success',
            executionId: 'exec-1',
          },
        } satisfies Pick<AwsPersistedFinalizationResult, 'verificationExecutionId' | 'verificationResult'>,
        {
          targetAwsRuntime: true,
          verifierWorkDir,
        },
      );

      expect(reference).toBeUndefined();
    } finally {
      await fs.rm(verifierWorkDir, { recursive: true, force: true });
    }
  });
});
