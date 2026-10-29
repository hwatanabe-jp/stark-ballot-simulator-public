import { isSha256 } from '../../image-signature-verifier/asset-files.mjs';
import { createEcrSigningStatusLookup } from '../../image-signature-verifier/signing-status.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isImageVerificationReasonCode,
  isImageVerificationResult,
  parseImageSignatureInvocation,
  verifyImageSignature,
} from '../../image-signature-verifier/verifier.mjs';

const cleanupAndSerializationMarginMs = 5_000;
const preservedRejectionReasons = new Set([
  'SIGNING_NOT_READY',
  'SIGNING_FAILED',
  'EXPECTED_PROFILE_MISSING',
  'EXPECTED_PROFILE_AMBIGUOUS',
  'UNEXPECTED_PROFILE',
]);

/**
 * @param {string | undefined} value
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number | undefined}
 */
function parseBoundedInteger(value, minimum, maximum) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

/**
 * @param {Record<string, string | undefined>} environment
 * @returns {undefined | {
 *   expectedInvocation: import('../../image-signature-verifier/verifier.mjs').ImageSignatureInvocation;
 *   assetManifestSha256: string;
 *   trustRootSha256: string;
 *   maxStatusAttempts: number;
 *   statusAttemptTimeoutMs: number;
 *   statusRetryDelayMs: number;
 *   verifierTimeoutMs: number;
 *   handlerDeadlineMs: number;
 * }}
 */
function parseConfiguration(environment) {
  const expectedInvocation = parseImageSignatureInvocation({
    imageUri: `${environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGISTRY_ID']}.dkr.ecr.${environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGION']}.amazonaws.com/${environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_REPOSITORY_NAME']}@${environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST']}`,
    registryId: environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGISTRY_ID'],
    imageRegion: environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGION'],
    repositoryName: environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_REPOSITORY_NAME'],
    imageDigest: environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST'],
    signingProfileArn: environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_SIGNING_PROFILE_ARN'],
  });
  const assetManifestSha256 = environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256'];
  const trustRootSha256 = environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256'];
  const timing = parseHandlerTiming(environment);
  if (!expectedInvocation || !isSha256(assetManifestSha256) || !isSha256(trustRootSha256) || !timing) return undefined;
  return {
    expectedInvocation,
    assetManifestSha256,
    trustRootSha256,
    ...timing,
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} result
 * @param {{ assetManifestSha256: string; trustRootSha256: string }} configuration
 * @returns {{
 *   result: 'VERIFIED';
 *   mode: 'cryptographic';
 *   verifierVersion: string;
 *   trustPolicySha256: string;
 * } | {
 *   result: 'REJECTED';
 *   mode: 'cryptographic';
 *   reasonCode: 'SIGNING_NOT_READY' | 'SIGNING_FAILED' | 'EXPECTED_PROFILE_MISSING' |
 *     'EXPECTED_PROFILE_AMBIGUOUS' | 'UNEXPECTED_PROFILE' | 'VERIFICATION_FAILED' |
 *     'VERIFIER_TIMEOUT' | 'VERIFIER_ERROR';
 * }}
 */
function normalizeLambdaResult(result, configuration) {
  if (!isImageVerificationResult(result)) {
    return {
      result: 'REJECTED',
      mode: 'cryptographic',
      reasonCode: 'VERIFIER_ERROR',
    };
  }
  if (result.result === 'VERIFIED') {
    if (
      result.assetManifestSha256 !== configuration.assetManifestSha256 ||
      result.verifierAssets?.trustRootSha256 !== configuration.trustRootSha256
    ) {
      return {
        result: 'REJECTED',
        mode: 'cryptographic',
        reasonCode: 'VERIFIER_ERROR',
      };
    }
    return {
      result: 'VERIFIED',
      mode: 'cryptographic',
      verifierVersion: result.verifierVersion,
      trustPolicySha256: result.trustPolicySha256,
    };
  }
  if (preservedRejectionReasons.has(result.reasonCode)) {
    return {
      result: 'REJECTED',
      mode: 'cryptographic',
      reasonCode:
        /** @type {'SIGNING_NOT_READY' | 'SIGNING_FAILED' | 'EXPECTED_PROFILE_MISSING' | 'EXPECTED_PROFILE_AMBIGUOUS' | 'UNEXPECTED_PROFILE'} */ (
          result.reasonCode
        ),
    };
  }
  if (result.result === 'VERIFIER_TIMEOUT') {
    return {
      result: 'REJECTED',
      mode: 'cryptographic',
      reasonCode: 'VERIFIER_TIMEOUT',
    };
  }
  if (result.result === 'VERIFIER_ERROR') {
    return {
      result: 'REJECTED',
      mode: 'cryptographic',
      reasonCode: 'VERIFIER_ERROR',
    };
  }
  return {
    result: 'REJECTED',
    mode: 'cryptographic',
    reasonCode: 'VERIFICATION_FAILED',
  };
}

/**
 * @param {unknown} result
 * @param {{ assetManifestSha256: string; trustRootSha256: string }} configuration
 * @returns {string}
 */
function selectInternalDiagnosticReason(result, configuration) {
  if (!isImageVerificationResult(result)) {
    return 'VERIFIER_RESULT_INVALID';
  }
  if (result.result === 'VERIFIED') {
    return result.assetManifestSha256 === configuration.assetManifestSha256 &&
      result.verifierAssets?.trustRootSha256 === configuration.trustRootSha256
      ? 'VERIFIED'
      : 'VERIFIER_EVIDENCE_MISMATCH';
  }
  return isImageVerificationReasonCode(result.reasonCode) ? result.reasonCode : 'VERIFIER_REASON_INVALID';
}

/**
 * @param {unknown} event
 * @param {import('../../image-signature-verifier/verifier.mjs').ImageSignatureInvocation} expected
 */
function eventMatchesAuthority(event, expected) {
  const parsed = parseImageSignatureInvocation(event);
  return (
    parsed !== undefined &&
    parsed.imageUri === expected.imageUri &&
    parsed.registryId === expected.registryId &&
    parsed.imageRegion === expected.imageRegion &&
    parsed.repositoryName === expected.repositoryName &&
    parsed.imageDigest === expected.imageDigest &&
    parsed.signingProfileArn === expected.signingProfileArn
  );
}

/**
 * @param {number} milliseconds
 */
function durationBucket(milliseconds) {
  if (milliseconds < 250) return 'under_250ms';
  if (milliseconds < 1_000) return 'under_1s';
  if (milliseconds < 5_000) return 'under_5s';
  return 'at_least_5s';
}

/**
 * @param {(record: Record<string, unknown>) => void} log
 * @param {Record<string, unknown>} record
 */
function safeLog(log, record) {
  try {
    log(record);
  } catch {
    // Logging must not change the cryptographic decision.
  }
}

/**
 * @typedef {{
 *   environment: Record<string, string | undefined>;
 *   assetRoot: string;
 *   temporaryRoot: string;
 *   verify?: typeof verifyImageSignature;
 *   describeSigningStatus?: ReturnType<typeof createEcrSigningStatusLookup>;
 *   now?: () => number;
 *   log?: (record: Record<string, unknown>) => void;
 * }} HandlerOptions
 */

/**
 * @param {HandlerOptions} options
 */
export function createImageSignatureVerifierHandler(options) {
  const configuration = parseConfiguration(options.environment);
  const verify = options.verify ?? verifyImageSignature;
  const describeSigningStatus = options.describeSigningStatus ?? createEcrSigningStatusLookup();
  const now = options.now ?? Date.now;
  const log =
    options.log ??
    ((record) => {
      console.log(record);
    });

  /**
   * @param {unknown} event
   * @param {unknown} [context]
   */
  const imageSignatureVerifierHandler = async (event, context = {}) => {
    const startedAt = now();
    const requestId = verifierRequestId(context);
    safeLog(log, {
      service: 'image-signature-verifier',
      event: 'verification_started',
      node_version: process.versions.node,
      openssl_version: process.versions.openssl,
      undici_version: process.versions['undici'],
      ...(requestId ? { requestId } : {}),
    });

    let result;
    let internalReasonCode;
    if (!configuration) {
      result = {
        result: 'REJECTED',
        mode: 'cryptographic',
        reasonCode: 'VERIFIER_ERROR',
      };
      internalReasonCode = 'CONFIGURATION_INVALID';
    } else if (!eventMatchesAuthority(event, configuration.expectedInvocation)) {
      result = {
        result: 'REJECTED',
        mode: 'cryptographic',
        reasonCode: 'VERIFICATION_FAILED',
      };
      internalReasonCode = 'INVOCATION_AUTHORITY_MISMATCH';
    } else {
      let internalResult;
      try {
        internalResult = await verify(event, {
          assetRoot: options.assetRoot,
          temporaryRoot: options.temporaryRoot,
          expectedArchitecture: 'amd64',
          sourceEnvironment: options.environment,
          maxStatusAttempts: configuration.maxStatusAttempts,
          statusAttemptTimeoutMs: configuration.statusAttemptTimeoutMs,
          statusRetryDelayMs: configuration.statusRetryDelayMs,
          verifierTimeoutMs: configuration.verifierTimeoutMs,
          expectedAssetManifestSha256: configuration.assetManifestSha256,
          expectedTrustRootSha256: configuration.trustRootSha256,
          describeSigningStatus,
        });
      } catch {
        internalResult = undefined;
        internalReasonCode = 'VERIFIER_INVOCATION_ERROR';
      }
      internalReasonCode ??= selectInternalDiagnosticReason(internalResult, configuration);
      result = normalizeLambdaResult(internalResult, configuration);
    }

    safeLog(log, {
      service: 'image-signature-verifier',
      event: 'verification_completed',
      result: result.result,
      ...(result.result === 'REJECTED' && internalReasonCode ? { internalReasonCode } : {}),
      durationBucket: durationBucket(Math.max(0, now() - startedAt)),
      ...(requestId ? { requestId } : {}),
    });
    return result;
  };
  return imageSignatureVerifierHandler;
}

const defaultAssetRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'image-signature-verifier');

export const handler = createImageSignatureVerifierHandler({
  environment: process.env,
  assetRoot: defaultAssetRoot,
  temporaryRoot: '/tmp',
});

/** @param {Record<string,string|undefined>} environment */
function parseHandlerTiming(environment) {
  const maxStatusAttempts = parseBoundedInteger(environment['IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPTS'], 1, 10);
  const statusAttemptTimeoutMs = parseBoundedInteger(
    environment['IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPT_TIMEOUT_MS'],
    250,
    15_000,
  );
  const statusRetryDelayMs = parseBoundedInteger(
    environment['IMAGE_SIGNATURE_VERIFIER_STATUS_RETRY_DELAY_MS'],
    0,
    5_000,
  );
  const verifierTimeoutMs = parseBoundedInteger(environment['IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS'], 1_000, 60_000);
  const handlerDeadlineMs = parseBoundedInteger(
    environment['IMAGE_SIGNATURE_VERIFIER_HANDLER_DEADLINE_MS'],
    10_000,
    120_000,
  );
  if (
    maxStatusAttempts === undefined ||
    statusAttemptTimeoutMs === undefined ||
    statusRetryDelayMs === undefined ||
    verifierTimeoutMs === undefined ||
    handlerDeadlineMs === undefined ||
    verifierTimeoutMs +
      maxStatusAttempts * statusAttemptTimeoutMs +
      (maxStatusAttempts - 1) * statusRetryDelayMs +
      cleanupAndSerializationMarginMs >
      handlerDeadlineMs
  )
    return undefined;
  return { maxStatusAttempts, statusAttemptTimeoutMs, statusRetryDelayMs, verifierTimeoutMs, handlerDeadlineMs };
}

/** @param {unknown} context */
function verifierRequestId(context) {
  return isRecord(context) &&
    typeof context['awsRequestId'] === 'string' &&
    /^[A-Za-z0-9-]{1,128}$/.test(context['awsRequestId'])
    ? context['awsRequestId']
    : undefined;
}
