import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { AwsPersistedFinalizationResult } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashKeyPrefixForLogging, hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';

interface LocalBundleIdentity {
  bundlePath: string;
  sessionId: string;
  executionId: string;
  bundleKey?: string;
}

export interface TrustedLocalBundleReference {
  bundlePath: string;
  reportPath: string;
  sessionId: string;
  executionId: string;
  bundleKey?: string;
}

interface TrustedLocalBundleOptions {
  targetAwsRuntime?: boolean;
  verifierWorkDir?: string;
}

const SAFE_BUNDLE_SEGMENT = /^[A-Za-z0-9-]+$/;

function resolveVerifierWorkDirForBundleAuthority(configuredWorkDir?: string): string {
  const workDir = configuredWorkDir?.trim();
  if (workDir) {
    return path.resolve(workDir);
  }

  return path.join(/* turbopackIgnore: true */ process.cwd(), '.verifier-bundles');
}

function resolveScopedVerifierBundlePath(sessionId: string, executionId: string, configuredWorkDir?: string): string {
  const workDir = configuredWorkDir?.trim();
  if (workDir) {
    return path.join(/* turbopackIgnore: true */ path.resolve(workDir), sessionId, executionId);
  }

  return path.join(/* turbopackIgnore: true */ process.cwd(), '.verifier-bundles', sessionId, executionId);
}

function resolveTrustedBundleIdentity(
  bundlePath: string | undefined,
  authority: {
    verificationExecutionId?: string;
    bundleKey?: string;
  },
  options: TrustedLocalBundleOptions = {},
): LocalBundleIdentity | undefined {
  if (!bundlePath || bundlePath.trim().length === 0) {
    return undefined;
  }

  const resolvedBaseDir = resolveVerifierWorkDirForBundleAuthority(options.verifierWorkDir);

  let resolvedBundlePath: string;
  try {
    resolvedBundlePath = realpathSync(bundlePath);
  } catch {
    logger.debug('[FinalizationResult] Ignoring missing local bundle path', {
      path_hash: hashKeyPrefixForLogging(bundlePath),
    });
    return undefined;
  }

  const relative = path.relative(resolvedBaseDir, resolvedBundlePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    logger.debug('[FinalizationResult] Ignoring local bundle path outside verifier work dir', {
      requested_path_hash: hashKeyPrefixForLogging(bundlePath),
      resolved_path_hash: hashKeyPrefixForLogging(resolvedBundlePath),
      base_path_hash: hashKeyPrefixForLogging(resolvedBaseDir),
    });
    return undefined;
  }

  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.length !== 2) {
    logger.debug('[FinalizationResult] Ignoring local bundle path with unexpected layout', {
      requested_path_hash: hashKeyPrefixForLogging(bundlePath),
      resolved_path_hash: hashKeyPrefixForLogging(resolvedBundlePath),
      relative_path_hash: hashKeyPrefixForLogging(relative),
    });
    return undefined;
  }

  const [sessionId, executionId] = segments;
  if (!sessionId || !executionId) {
    return undefined;
  }
  if (!isSafeBundleSegment(sessionId) || !isSafeBundleSegment(executionId)) {
    logger.debug('[FinalizationResult] Ignoring local bundle path with unsafe segments', {
      requested_path_hash: hashKeyPrefixForLogging(bundlePath),
      resolved_path_hash: hashKeyPrefixForLogging(resolvedBundlePath),
      session_id_hash: hashSessionIdForLogging(sessionId),
      executionId,
    });
    return undefined;
  }

  if (authority.verificationExecutionId && authority.verificationExecutionId !== executionId) {
    logger.debug('[FinalizationResult] Ignoring local bundle path with mismatched execution identity', {
      requested_path_hash: hashKeyPrefixForLogging(bundlePath),
      resolved_path_hash: hashKeyPrefixForLogging(resolvedBundlePath),
      expectedExecutionId: authority.verificationExecutionId,
      actualExecutionId: executionId,
    });
    return undefined;
  }

  const expectedBundleIdentity = extractBundleIdentityFromKey(authority.bundleKey);
  if (
    expectedBundleIdentity &&
    (expectedBundleIdentity.sessionId !== sessionId || expectedBundleIdentity.executionId !== executionId)
  ) {
    logger.debug('[FinalizationResult] Ignoring local bundle path with mismatched bundle key identity', {
      requested_path_hash: hashKeyPrefixForLogging(bundlePath),
      resolved_path_hash: hashKeyPrefixForLogging(resolvedBundlePath),
      expected_session_id_hash: hashSessionIdForLogging(expectedBundleIdentity.sessionId),
      actual_session_id_hash: hashSessionIdForLogging(sessionId),
      expectedExecutionId: expectedBundleIdentity.executionId,
      actualExecutionId: executionId,
    });
    return undefined;
  }

  if (!existsSync(path.join(resolvedBundlePath, 'public-input.json'))) {
    logger.debug('[FinalizationResult] Ignoring local bundle path without public-input.json', {
      path_hash: hashKeyPrefixForLogging(resolvedBundlePath),
    });
    return undefined;
  }

  return {
    bundlePath: resolvedBundlePath,
    sessionId,
    executionId,
    ...(expectedBundleIdentity ? { bundleKey: authority.bundleKey } : {}),
  };
}

export function resolveTrustedLocalBundleReference(
  sessionId: string,
  result: Pick<AwsPersistedFinalizationResult, 'verificationExecutionId' | 's3BundleKey' | 'verificationResult'>,
  options: TrustedLocalBundleOptions = {},
): TrustedLocalBundleReference | undefined {
  if (options.targetAwsRuntime ?? false) {
    return undefined;
  }

  const executionId = result.verificationExecutionId;
  if (!isSafeBundleSegment(sessionId) || !executionId || !isSafeBundleSegment(executionId)) {
    return undefined;
  }

  const scopedBundlePath = resolveScopedVerifierBundlePath(sessionId, executionId, options.verifierWorkDir);
  const localBundleIdentity = resolveTrustedBundleIdentity(
    scopedBundlePath,
    {
      verificationExecutionId: executionId,
      ...(result.s3BundleKey ? { bundleKey: result.s3BundleKey } : {}),
    },
    options,
  );
  if (!localBundleIdentity) {
    return undefined;
  }

  if (localBundleIdentity.sessionId !== sessionId) {
    logger.debug('[FinalizationResult] Ignoring local bundle path with mismatched session identity', {
      path_hash: hashKeyPrefixForLogging(localBundleIdentity.bundlePath),
      expected_session_id_hash: hashSessionIdForLogging(sessionId),
      actual_session_id_hash: hashSessionIdForLogging(localBundleIdentity.sessionId),
    });
    return undefined;
  }

  return {
    ...localBundleIdentity,
    reportPath: path.join(localBundleIdentity.bundlePath, 'verification.json'),
  };
}

function extractBundleIdentityFromKey(
  bundleKey: string | undefined,
): { sessionId: string; executionId: string } | undefined {
  if (!bundleKey || bundleKey.trim().length === 0) {
    return undefined;
  }

  const segments = bundleKey.split('/').filter(Boolean);
  if (segments.length < 3 || segments[segments.length - 1] !== 'bundle.zip') {
    return undefined;
  }

  const sessionId = segments[segments.length - 3];
  const executionId = segments[segments.length - 2];
  if (!sessionId || !executionId) {
    return undefined;
  }
  if (!isSafeBundleSegment(sessionId) || !isSafeBundleSegment(executionId)) {
    return undefined;
  }

  return { sessionId, executionId };
}

function isSafeBundleSegment(value: string): boolean {
  return SAFE_BUNDLE_SEGMENT.test(value);
}
