import { types as utilTypes } from 'node:util';

import { captureExactPortRecord, invokeExactPort } from './conditional-object-ledger.js';
import { snapshotExactRecord } from './descriptor-snapshot.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import {
  canonicalRecordJson,
  parseS3VersionId,
  parseSha256,
  requireGroupedLowercaseUuid,
  requireString,
  sha256Text,
} from './internal.js';

const INPUT_KEYS = ['currentBuild', 'key', 'target', 'transport'];
const CURRENT_BUILD_KEYS = ['buildId', 'projectName'];
const TARGET_KEYS = ['accountId', 'partition', 'region'];
const TRANSPORT_KEYS = ['deleteObject', 'getBuild', 'getObject', 'putObject'];
const LEASE_BODY_KEYS = ['buildId', 'leaseType', 'projectName'];
const OBJECT_KEYS = ['body', 'etag', 'sha256', 'versionId'];
const BUILD_KEYS = ['arn', 'buildComplete', 'buildId', 'buildStatus', 'projectName'];
const WRITTEN_KEYS = ['etag', 'sha256', 'status', 'versionId'];
const DELETED_KEYS = ['deleteMarker', 'status', 'versionId'];
const STATUS_ONLY_KEYS = ['status'];
const LEASE_TYPE = 'static-frontend-publication-lease';
const MAXIMUM_LEASE_BYTES = 4096;
const MAXIMUM_ACQUIRE_ATTEMPTS = 4;
const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/u;
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,254}$/u;
const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]+$/u;
const TERMINAL_BUILD_STATUSES = new Set(['FAILED', 'FAULT', 'STOPPED', 'SUCCEEDED', 'TIMED_OUT']);

/** @param {unknown} value @param {readonly string[]} keys @param {string} label */
function exactRecord(value, keys, label) {
  try {
    return snapshotExactRecord(value, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/** @param {unknown} value @param {string} label */
function projectName(value, label) {
  return requireString(value, label, PROJECT_PATTERN);
}

/** @param {unknown} value @param {string} label */
function opaqueEtag(value, label) {
  const etag = requireString(value, label);
  if (etag.trim() !== etag || /\s/u.test(etag) || Buffer.byteLength(etag, 'utf8') > 1024) {
    throw new Error(`${label} is invalid.`);
  }
  return etag;
}

/** @param {unknown} value @param {string} label */
function s3Key(value, label) {
  const key = requireString(value, label);
  if (
    key.startsWith('/') ||
    key.endsWith('/') ||
    Buffer.byteLength(key, 'utf8') > 1024 ||
    key.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return key;
}

/** @param {unknown} value @param {readonly string[]} governedProjects @param {string} label */
function buildIdentity(value, governedProjects, label) {
  const identity = exactRecord(value, CURRENT_BUILD_KEYS, label);
  const admittedProject = projectName(identity['projectName'], `${label} project name`);
  if (!governedProjects.includes(admittedProject)) {
    throw new Error(`${label} project is outside the governed static publishers.`);
  }
  const admittedBuildId = requireString(identity['buildId'], `${label} build ID`);
  const prefix = `${admittedProject}:`;
  if (!admittedBuildId.startsWith(prefix)) {
    throw new Error(`${label} build ID does not match its project.`);
  }
  requireGroupedLowercaseUuid(admittedBuildId.slice(prefix.length), `${label} build UUID`);
  return Object.freeze({ buildId: admittedBuildId, projectName: admittedProject });
}

/** @param {unknown} value @param {ReturnType<typeof resolveAllowedDeploymentTarget>} expected */
function target(value, expected) {
  const record = exactRecord(value, TARGET_KEYS, 'Static frontend lease target');
  const accountId = requireString(record['accountId'], 'Static frontend lease account ID', ACCOUNT_ID_PATTERN);
  const partition = requireString(record['partition'], 'Static frontend lease partition');
  const region = requireString(record['region'], 'Static frontend lease region', REGION_PATTERN);
  if (accountId !== expected.accountId || partition !== expected.partition || region !== expected.region) {
    throw new Error('Static frontend lease coordinates do not match the selected target.');
  }
  return Object.freeze({ accountId, partition, region });
}

/** @param {Readonly<{buildId: string, projectName: string}>} holder */
function leaseBody(holder) {
  return canonicalRecordJson({ buildId: holder.buildId, leaseType: LEASE_TYPE, projectName: holder.projectName });
}

/** @param {unknown} value @param {readonly string[]} governedProjects @param {string} label */
function admitLeaseBody(value, governedProjects, label) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') === 0 ||
    Buffer.byteLength(value, 'utf8') > MAXIMUM_LEASE_BYTES
  ) {
    throw new Error(`${label} bytes are empty or oversized.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} bytes are not JSON.`, { cause: error });
  }
  const record = exactRecord(parsed, LEASE_BODY_KEYS, label);
  if (record['leaseType'] !== LEASE_TYPE) throw new Error(`${label} type is invalid.`);
  const holder = buildIdentity(
    { buildId: record['buildId'], projectName: record['projectName'] },
    governedProjects,
    `${label} holder`,
  );
  if (canonicalRecordJson({ ...holder, leaseType: LEASE_TYPE }) !== value) {
    throw new Error(`${label} bytes are not canonical.`);
  }
  return holder;
}

/** @param {unknown} value @param {readonly string[]} governedProjects @param {string} label */
function objectObservation(value, governedProjects, label) {
  if (value === undefined) return undefined;
  const record = exactRecord(value, OBJECT_KEYS, label);
  const body = record['body'];
  const holder = admitLeaseBody(body, governedProjects, `${label} body`);
  const observedSha256 = parseSha256(record['sha256'], `${label} SHA-256`);
  if (sha256Text(/** @type {string} */ (body)) !== observedSha256) {
    throw new Error(`${label} SHA-256 does not match its exact bytes.`);
  }
  return Object.freeze({
    body: /** @type {string} */ (body),
    etag: opaqueEtag(record['etag'], `${label} ETag`),
    holder,
    sha256: observedSha256,
    versionId: parseS3VersionId(record['versionId'], `${label} VersionId`),
  });
}

/**
 * @param {unknown} value
 * @param {string} expectedSha256
 * @returns {Readonly<{status: 'precondition-failed' | 'conditional-conflict'} | {etag: string, sha256: string, status: 'written', versionId: string}>}
 */
function putResult(value, expectedSha256) {
  const status =
    typeof value === 'object' && value !== null && !utilTypes.isProxy(value)
      ? Reflect.getOwnPropertyDescriptor(value, 'status')?.value
      : undefined;
  if (status === 'precondition-failed' || status === 'conditional-conflict') {
    exactRecord(value, STATUS_ONLY_KEYS, 'Static frontend lease put conflict');
    return Object.freeze({ status: /** @type {'precondition-failed' | 'conditional-conflict'} */ (status) });
  }
  const result = exactRecord(value, WRITTEN_KEYS, 'Static frontend lease put result');
  if (result['status'] !== 'written') throw new Error('Static frontend lease put status is invalid.');
  const observedSha256 = parseSha256(result['sha256'], 'Static frontend lease put SHA-256');
  if (observedSha256 !== expectedSha256) {
    throw new Error('Static frontend lease put SHA-256 does not match its exact bytes.');
  }
  return Object.freeze({
    etag: opaqueEtag(result['etag'], 'Static frontend lease put ETag'),
    sha256: observedSha256,
    status: 'written',
    versionId: parseS3VersionId(result['versionId'], 'Static frontend lease put VersionId'),
  });
}

/**
 * @param {unknown} value
 * @returns {Readonly<{status: 'precondition-failed'} | {deleteMarker: true, status: 'deleted', versionId: string}>}
 */
function deleteResult(value) {
  const status =
    typeof value === 'object' && value !== null && !utilTypes.isProxy(value)
      ? Reflect.getOwnPropertyDescriptor(value, 'status')?.value
      : undefined;
  if (status === 'precondition-failed') {
    exactRecord(value, STATUS_ONLY_KEYS, 'Static frontend lease delete conflict');
    return Object.freeze({ status: /** @type {const} */ ('precondition-failed') });
  }
  const result = exactRecord(value, DELETED_KEYS, 'Static frontend lease delete result');
  if (result['status'] !== 'deleted' || result['deleteMarker'] !== true) {
    throw new Error('Static frontend lease delete result is invalid.');
  }
  return Object.freeze({
    deleteMarker: true,
    status: 'deleted',
    versionId: parseS3VersionId(result['versionId'], 'Static frontend lease delete VersionId'),
  });
}

/**
 * @param {unknown} value
 * @param {Readonly<{accountId: string, partition: string, region: string}>} admittedTarget
 * @param {readonly string[]} governedProjects
 * @param {Readonly<{buildId: string, projectName: string}>} expectedHolder
 */
function buildObservation(value, admittedTarget, governedProjects, expectedHolder) {
  const record = exactRecord(value, BUILD_KEYS, 'Static frontend lease holder build');
  const holder = buildIdentity(
    { buildId: record['buildId'], projectName: record['projectName'] },
    governedProjects,
    'Static frontend lease holder build',
  );
  if (holder.buildId !== expectedHolder.buildId || holder.projectName !== expectedHolder.projectName) {
    throw new Error('Static frontend lease holder build does not match the lease bytes.');
  }
  const expectedArn =
    `arn:${admittedTarget.partition}:codebuild:${admittedTarget.region}:` +
    `${admittedTarget.accountId}:build/${holder.buildId}`;
  if (record['arn'] !== expectedArn || typeof record['buildComplete'] !== 'boolean') {
    throw new Error('Static frontend lease holder build identity is invalid.');
  }
  const buildStatus = requireString(record['buildStatus'], 'Static frontend lease holder build status');
  if (buildStatus === 'IN_PROGRESS' && record['buildComplete'] === false) {
    return Object.freeze({ status: 'active' });
  }
  if (TERMINAL_BUILD_STATUSES.has(buildStatus) && record['buildComplete'] === true) {
    return Object.freeze({ status: 'terminal' });
  }
  throw new Error('Static frontend lease holder build status is inconsistent or unknown.');
}

/** @param {Readonly<Record<string, unknown>>} fields */
function inertRecord(fields) {
  const output = Object.create(null);
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(output, key, {
      configurable: false,
      enumerable: true,
      value,
      writable: false,
    });
  }
  return Object.freeze(output);
}

/**
 * Create a fail-closed, content-bound lease for the target's static frontend
 * publishers. Time and object metadata never authorize takeover: only the
 * exact incumbent CodeBuild execution reaching a complete terminal state can.
 *
 * @param {unknown} value
 * @param {string} expectedTargetKey
 */
export function createStaticFrontendPublicationLease(value, expectedTargetKey) {
  const expectedTarget = resolveAllowedDeploymentTarget(expectedTargetKey);
  const names = resolveDeploymentLaneAuthority(expectedTarget, 'app').names;
  const request = exactRecord(value, INPUT_KEYS, 'Static frontend publication lease');
  const governedProjects = Object.freeze([
    names.appStaticDeployProject,
    ...(names.appStaticFastDeployProject === undefined ? [] : [names.appStaticFastDeployProject]),
  ]);
  const currentBuild = buildIdentity(request['currentBuild'], governedProjects, 'Static frontend current build');
  const admittedTarget = target(request['target'], expectedTarget);
  const key = s3Key(request['key'], 'Static frontend publication lease key');
  if (key !== names.staticFrontendArtifactPrefix) {
    throw new Error('Static frontend publication lease key does not match the selected target.');
  }
  const transport = captureExactPortRecord(
    request['transport'],
    TRANSPORT_KEYS,
    'Static frontend publication lease transport',
  );
  const desiredBody = leaseBody(currentBuild);
  const desiredSha256 = sha256Text(desiredBody);
  /** @type {undefined | Readonly<{body: string, etag: string, sha256: string, versionId: string}>} */
  let owned;
  let released = false;

  async function observe() {
    return invokeExactPort(
      transport['getObject'],
      [inertRecord({ key, maxBytes: MAXIMUM_LEASE_BYTES })],
      'Static frontend publication lease observation',
      (observed) => objectObservation(observed, governedProjects, 'Static frontend publication lease observation'),
    );
  }

  /** @param {Readonly<Record<string, unknown>>} condition */
  async function put(condition) {
    return invokeExactPort(
      transport['putObject'],
      [inertRecord({ body: desiredBody, checksumSha256: desiredSha256, condition, key })],
      'Static frontend publication lease put',
      (result) => putResult(result, desiredSha256),
    );
  }

  async function assertHeld() {
    if (owned === undefined || released) throw new Error('Static frontend publication lease is not held.');
    const observed = await observe();
    if (
      observed === undefined ||
      observed.body !== owned.body ||
      observed.sha256 !== owned.sha256 ||
      observed.etag !== owned.etag ||
      observed.versionId !== owned.versionId
    ) {
      throw new Error('Static frontend publication lease is not held by this build.');
    }
    return Object.freeze({ key, ...owned });
  }

  async function acquire() {
    if (owned !== undefined || released)
      throw new Error('Static frontend publication lease acquisition is not reusable.');
    /** @type {Readonly<Record<string, unknown>>} */
    let condition = inertRecord({ type: 'if-none-match' });
    for (let attempt = 0; attempt < MAXIMUM_ACQUIRE_ATTEMPTS; attempt += 1) {
      const written = await put(condition);
      if (written.status === 'written') {
        owned = Object.freeze({
          body: desiredBody,
          etag: written.etag,
          sha256: written.sha256,
          versionId: written.versionId,
        });
        await assertHeld();
        return Object.freeze({ key, ...owned });
      }

      const incumbent = await observe();
      if (incumbent === undefined) {
        condition = inertRecord({ type: 'if-none-match' });
        continue;
      }
      if (incumbent.body === desiredBody && incumbent.sha256 === desiredSha256) {
        owned = Object.freeze({
          body: incumbent.body,
          etag: incumbent.etag,
          sha256: incumbent.sha256,
          versionId: incumbent.versionId,
        });
        await assertHeld();
        return Object.freeze({ key, ...owned });
      }
      const incumbentBuild = await invokeExactPort(
        transport['getBuild'],
        [inertRecord({ buildId: incumbent.holder.buildId })],
        'Static frontend publication lease holder build observation',
        (observed) => buildObservation(observed, admittedTarget, governedProjects, incumbent.holder),
      );
      if (incumbentBuild.status === 'active') {
        throw new Error('Static frontend publication lease is held by an active governed build.');
      }
      condition = inertRecord({
        etag: incumbent.etag,
        type: 'if-match',
        versionId: incumbent.versionId,
      });
    }
    throw new Error('Static frontend publication lease acquisition conflict budget was exhausted.');
  }

  async function release() {
    await assertHeld();
    const coordinates = /** @type {NonNullable<typeof owned>} */ (owned);
    const deleted = await invokeExactPort(
      transport['deleteObject'],
      [
        inertRecord({
          condition: inertRecord({ etag: coordinates.etag, type: 'if-match', versionId: coordinates.versionId }),
          key,
        }),
      ],
      'Static frontend publication lease delete',
      deleteResult,
    );
    if (deleted.status !== 'deleted') {
      throw new Error('Static frontend publication lease conditional release failed.');
    }
    released = true;
    owned = undefined;
    return Object.freeze({ key, versionId: deleted.versionId });
  }

  return Object.freeze({ acquire, assertHeld, release });
}

/**
 * @template T
 * @param {unknown} lease
 * @param {() => Promise<T> | T} operation
 * @returns {Promise<T>}
 */
export async function withStaticFrontendPublicationLease(lease, operation) {
  const ports = captureExactPortRecord(lease, ['acquire', 'assertHeld', 'release'], 'Static frontend lease capability');
  if (typeof operation !== 'function' || utilTypes.isProxy(operation)) {
    throw new Error('Static frontend lease operation must be an unproxied function.');
  }
  await invokeExactPort(ports['acquire'], [], 'Static frontend lease acquisition', (result) => result);
  let result;
  let operationFailed = false;
  let operationError;
  try {
    result = await Reflect.apply(operation, undefined, []);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await invokeExactPort(ports['release'], [], 'Static frontend lease release', (released) => released);
  } catch (releaseError) {
    if (operationFailed) {
      throw new AggregateError([operationError, releaseError], 'Static frontend publication and lease release failed.');
    }
    throw releaseError;
  }
  if (operationFailed) throw operationError;
  return /** @type {T} */ (result);
}
