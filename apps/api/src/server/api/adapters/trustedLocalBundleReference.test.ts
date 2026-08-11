import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
} from '@stark-ballot/runtime-config/env/__tests__/runtimeProfileFixtures';
import { resolveTrustedLocalBundleReference } from './trustedLocalBundleReference';

describe('resolveTrustedLocalBundleReference', () => {
  it('derives trusted local bundle references from scoped session and finalization identity', async () => {
    const verifierWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trusted-local-bundle-reference-'));

    try {
      const bundlePath = path.join(verifierWorkDir, 'session-123', 'exec-1');
      await fs.mkdir(bundlePath, { recursive: true });
      await fs.writeFile(path.join(bundlePath, 'public-input.json'), '{}', 'utf-8');

      const reference = resolveTrustedLocalBundleReference(
        'session-123',
        {
          finalizationId: 'exec-1',
        },
        {
          runtimeProfile: localRuntimeProfile(),
          verifierWorkDir,
        },
      );

      expect(reference).toEqual({
        bundlePath,
        sessionId: 'session-123',
        finalizationId: 'exec-1',
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
          finalizationId: 'exec-1',
        },
        {
          runtimeProfile: targetRuntimeProfile(),
          verifierWorkDir,
        },
      );

      expect(reference).toBeUndefined();
    } finally {
      await fs.rm(verifierWorkDir, { recursive: true, force: true });
    }
  });
});
