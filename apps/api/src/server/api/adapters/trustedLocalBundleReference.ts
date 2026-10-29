import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashKeyPrefixForLogging, hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';

interface LocalBundleIdentity {
  bundlePath: string;
  sessionId: string;
  finalizationId: string;
  bundleKey?: string;
}

export interface TrustedLocalBundleReference {
  bundlePath: string;
  reportPath: string;
  sessionId: string;
  finalizationId: string;
  bundleKey?: string;
}

interface TrustedLocalBundleOptions {
  runtimeProfile: ResolvedRuntimeProfile;
  verifierWorkDir?: string;
}

function resolveVerifierWorkDirForBundleAuthority(configuredWorkDir?: string): string {
  const workDir = configuredWorkDir?.trim();
  if (workDir) {
    return path.resolve(workDir);
  }

  return path.join(/* turbopackIgnore: true */ process.cwd(), '.verifier-bundles');
}

function resolveScopedVerifierBundlePath(
  sessionId: string,
  finalizationId: string,
  configuredWorkDir?: string,
): string {
  const workDir = configuredWorkDir?.trim();
  if (workDir) {
    return path.join(/* turbopackIgnore: true */ path.resolve(workDir), sessionId, finalizationId);
  }

  return path.join(/* turbopackIgnore: true */ process.cwd(), '.verifier-bundles', sessionId, finalizationId);
}

function resolveRealBundlePath(bundlePath: string): string | undefined {
  let resolvedBundlePath: string;
  try {
    resolvedBundlePath = realpathSync(bundlePath);
  } catch {
    logger.debug('[FinalizationResult] Ignoring missing local bundle path', {
      path_hash: hashKeyPrefixForLogging(bundlePath),
    });
    return undefined;
  }

  return resolvedBundlePath;
}

function admitLocalBundleScope(bundlePath: string, resolvedBaseDir: string, resolvedBundlePath: string) {
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

  const [sessionId, finalizationId] = segments;
  if (!sessionId || !finalizationId) {
    return undefined;
  }
  if (!isSafeVerifierSegment(sessionId) || !isSafeVerifierSegment(finalizationId)) {
    logger.debug('[FinalizationResult] Ignoring local bundle path with unsafe segments', {
      requested_path_hash: hashKeyPrefixForLogging(bundlePath),
      resolved_path_hash: hashKeyPrefixForLogging(resolvedBundlePath),
      session_id_hash: hashSessionIdForLogging(sessionId),
      finalization_id: finalizationId,
    });
    return undefined;
  }

  return { sessionId, finalizationId };
}

function admitBundleAuthority(
  scope: { sessionId: string; finalizationId: string },
  authority: { finalizationId?: string; bundleKey?: string },
  bundlePath: string,
  resolvedBundlePath: string,
): Pick<LocalBundleIdentity, 'bundleKey'> | undefined {
  const { sessionId, finalizationId } = scope;
  if (authority.finalizationId && authority.finalizationId !== finalizationId) {
    logger.debug('[FinalizationResult] Ignoring local bundle path with mismatched finalization identity', {
      requested_path_hash: hashKeyPrefixForLogging(bundlePath),
      resolved_path_hash: hashKeyPrefixForLogging(resolvedBundlePath),
      expectedFinalizationId: authority.finalizationId,
      actualFinalizationId: finalizationId,
    });
    return undefined;
  }

  const expectedBundleIdentity = extractBundleIdentityFromKey(authority.bundleKey);
  if (
    expectedBundleIdentity &&
    (expectedBundleIdentity.sessionId !== sessionId || expectedBundleIdentity.finalizationId !== finalizationId)
  ) {
    logger.debug('[FinalizationResult] Ignoring local bundle path with mismatched bundle key identity', {
      requested_path_hash: hashKeyPrefixForLogging(bundlePath),
      resolved_path_hash: hashKeyPrefixForLogging(resolvedBundlePath),
      expected_session_id_hash: hashSessionIdForLogging(expectedBundleIdentity.sessionId),
      actual_session_id_hash: hashSessionIdForLogging(sessionId),
      expectedFinalizationId: expectedBundleIdentity.finalizationId,
      actualFinalizationId: finalizationId,
    });
    return undefined;
  }

  return expectedBundleIdentity && authority.bundleKey !== undefined ? { bundleKey: authority.bundleKey } : {};
}

function resolveTrustedBundleIdentity(
  bundlePath: string | undefined,
  authority: { finalizationId?: string; bundleKey?: string },
  options: TrustedLocalBundleOptions,
): LocalBundleIdentity | undefined {
  if (!bundlePath || bundlePath.trim().length === 0) return undefined;
  const resolvedBaseDir = resolveVerifierWorkDirForBundleAuthority(options.verifierWorkDir);
  const resolvedBundlePath = resolveRealBundlePath(bundlePath);
  if (!resolvedBundlePath) return undefined;
  const scope = admitLocalBundleScope(bundlePath, resolvedBaseDir, resolvedBundlePath);
  if (!scope) return undefined;
  const admittedAuthority = admitBundleAuthority(scope, authority, bundlePath, resolvedBundlePath);
  if (!admittedAuthority) return undefined;
  if (!existsSync(path.join(resolvedBundlePath, 'public-input.json'))) {
    logger.debug('[FinalizationResult] Ignoring local bundle path without public-input.json', {
      path_hash: hashKeyPrefixForLogging(resolvedBundlePath),
    });
    return undefined;
  }

  return { bundlePath: resolvedBundlePath, ...scope, ...admittedAuthority };
}

export function resolveTrustedLocalBundleReference(
  sessionId: string,
  result: { finalizationId: string; bundleKey?: string },
  options: TrustedLocalBundleOptions,
): TrustedLocalBundleReference | undefined {
  if (options.runtimeProfile.artifacts.kind !== 'local') {
    return undefined;
  }

  const finalizationId = result.finalizationId;
  if (!isSafeVerifierSegment(sessionId) || !isSafeVerifierSegment(finalizationId)) {
    return undefined;
  }

  const scopedBundlePath = resolveScopedVerifierBundlePath(sessionId, finalizationId, options.verifierWorkDir);
  const localBundleIdentity = resolveTrustedBundleIdentity(
    scopedBundlePath,
    {
      finalizationId,
      ...(result.bundleKey ? { bundleKey: result.bundleKey } : {}),
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
): { sessionId: string; finalizationId: string } | undefined {
  if (!bundleKey || bundleKey.trim().length === 0) {
    return undefined;
  }

  const segments = bundleKey.split('/').filter(Boolean);
  if (segments.length < 3 || segments[segments.length - 1] !== 'bundle.zip') {
    return undefined;
  }

  const sessionId = segments[segments.length - 3];
  const finalizationId = segments[segments.length - 2];
  if (!sessionId || !finalizationId) {
    return undefined;
  }
  if (!isSafeVerifierSegment(sessionId) || !isSafeVerifierSegment(finalizationId)) {
    return undefined;
  }

  return { sessionId, finalizationId };
}
