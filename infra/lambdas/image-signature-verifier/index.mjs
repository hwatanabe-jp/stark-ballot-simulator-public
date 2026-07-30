import * as ecr from '@aws-sdk/client-ecr';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isImageVerificationReasonCode,
  parseImageSignatureInvocation,
  verifyImageSignature,
} from '../../image-signature-verifier/verifier.mjs';

const { DescribeImageSigningStatusCommand, ECRClient } = ecr;
const cleanupAndSerializationMarginMs = 5_000;
const verifierVersion = 'notation@1.3.2+aws-signer-plugin@1.0.2292';
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
    !expectedInvocation ||
    typeof assetManifestSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(assetManifestSha256) ||
    typeof trustRootSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(trustRootSha256) ||
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
  ) {
    return undefined;
  }
  return {
    expectedInvocation,
    assetManifestSha256,
    trustRootSha256,
    maxStatusAttempts,
    statusAttemptTimeoutMs,
    statusRetryDelayMs,
    verifierTimeoutMs,
    handlerDeadlineMs,
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
 * @returns {result is import('../../image-signature-verifier/verifier.mjs').ImageVerificationResult}
 */
function isInternalVerifierResult(result) {
  if (!isRecord(result) || result['mode'] !== 'cryptographic') {
    return false;
  }
  if (result['result'] === 'VERIFIED') {
    return (
      Object.keys(result).sort().join('\0') ===
        'assetManifestSha256\0mode\0result\0trustPolicySha256\0verifierAssets\0verifierVersion' &&
      result['verifierVersion'] === verifierVersion &&
      /^[0-9a-f]{64}$/.test(String(result['assetManifestSha256'])) &&
      /^[0-9a-f]{64}$/.test(String(result['trustPolicySha256'])) &&
      isRecord(result['verifierAssets']) &&
      Object.keys(result['verifierAssets']).sort().join('\0') ===
        'awsSignerPluginVersion\0ecrCredentialHelperVersion\0notationVersion\0trustRootSha256' &&
      result['verifierAssets']['notationVersion'] === '1.3.2' &&
      result['verifierAssets']['awsSignerPluginVersion'] === '1.0.2292' &&
      result['verifierAssets']['ecrCredentialHelperVersion'] === '0.12.0' &&
      /^[0-9a-f]{64}$/.test(String(result['verifierAssets']['trustRootSha256']))
    );
  }
  return (
    (result['result'] === 'VERIFICATION_FAILED' ||
      result['result'] === 'VERIFIER_TIMEOUT' ||
      result['result'] === 'VERIFIER_ERROR') &&
    Object.keys(result).sort().join('\0') === 'mode\0reasonCode\0result' &&
    typeof result['reasonCode'] === 'string' &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(result['reasonCode'])
  );
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
  if (!isInternalVerifierResult(result)) {
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
  if (!isInternalVerifierResult(result)) {
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

export function createEcrSigningStatusLookup() {
  /** @type {Map<string, InstanceType<typeof ECRClient>>} */
  const clients = new Map();
  /**
   * @param {{
   *   imageRegion: string;
   *   registryId: string;
   *   repositoryName: string;
   *   imageDigest: string;
   * }} invocation
   * @param {AbortSignal} abortSignal
   */
  return async (invocation, abortSignal) => {
    let client = clients.get(invocation.imageRegion);
    if (!client) {
      client = new ECRClient({ region: invocation.imageRegion });
      clients.set(invocation.imageRegion, client);
    }
    const response = await client.send(
      new DescribeImageSigningStatusCommand({
        registryId: invocation.registryId,
        repositoryName: invocation.repositoryName,
        imageId: { imageDigest: invocation.imageDigest },
      }),
      { abortSignal },
    );
    return response.signingStatuses;
  };
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
    const requestId =
      isRecord(context) &&
      typeof context['awsRequestId'] === 'string' &&
      /^[A-Za-z0-9-]{1,128}$/.test(context['awsRequestId'])
        ? context['awsRequestId']
        : undefined;
    safeLog(log, {
      service: 'image-signature-verifier',
      event: 'verification_started',
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
