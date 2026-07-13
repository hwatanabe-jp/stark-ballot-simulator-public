#!/usr/bin/env tsx
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import {
  CLITestHelpers,
  type FinalizeScenarioData,
  type FinalizeWithScenariosResult,
} from '@stark-ballot/test-support/testing/cli-test-helpers';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@stark-ballot/domain/session/capability';
import { isRecord, getRecordProperty, getStringProperty } from '@stark-ballot/domain/utils/guards';
import { listZipEntryNamesFromBuffer } from '@stark-ballot/node-adapters/zip';
import { resolveExpectedImageIdFromMapping } from '@stark-ballot/verification/image-id-policy';
import type { ImageIdMapping } from '@stark-ballot/verification/image-id-types';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckDefinition,
  type VerificationCheckId,
} from '@stark-ballot/verification/checks';
import { deriveVerificationSummary, type VerificationSummaryContext } from '@stark-ballot/verification/summary';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import imageIdMappingJson from '../../public/imageId-mapping.json';
import { CLIVotingTest, type CLITestConfig } from './cli-e2e-voting-flow';

const OPERATOR_AUTH_HEADER_NAME_ENV = 'STARK_BALLOT_OPERATOR_AUTH_HEADER';
const OPERATOR_AUTH_HEADER_VALUE_ENV = 'STARK_BALLOT_OPERATOR_AUTH_VALUE';
const DEFAULT_GATED_SMOKE_SCENARIOS = ['S0', 'S1', 'S2'] as const;
const GATED_SMOKE_SCENARIOS = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'] as const;
const EXCLUSION_SCENARIOS = new Set<GatedSmokeScenario>(['S1', 'S3', 'S5']);
const CLAIMED_TALLY_SCENARIOS = new Set<GatedSmokeScenario>(['S2', 'S4']);
const PRIVATE_BUNDLE_FILENAMES = [
  'input.json',
  'verification.json',
  'included-bitmap.json',
  'seen-bitmap.json',
] as const;
const BUNDLE_RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
const BUNDLE_RANGE_CHUNK_HEADER = 'x-stark-bundle-range-chunk-size';
const DEFAULT_MAX_BUNDLE_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const VERIFICATION_POLL_ATTEMPTS = 120;
const VERIFICATION_POLL_DELAY_MS = 1000;

export type GatedSmokeScenario = (typeof GATED_SMOKE_SCENARIOS)[number];
export type ExpectedOverallVerdict = 'fully_verified' | 'fail_closed';
type ExpectedTerminalVerificationStatus = 'success' | 'failed' | 'dev_mode';

interface GatedSmokeScenarioExpectation {
  terminalVerificationStatus: ExpectedTerminalVerificationStatus;
  overallVerdict: ExpectedOverallVerdict;
}

interface VerificationAcceptanceOptions {
  baseUrl: string;
  sessionId: string;
  expectedImageId: string;
  expectedTerminalVerificationStatus: ExpectedTerminalVerificationStatus;
  authHeaders: Record<string, string>;
  pollDelayMs?: number;
  maxPollAttempts?: number;
}

interface ParsedContentRange {
  start: number;
  end: number;
  total: number;
}

interface BundleDownloadOptions {
  maxTotalBytes?: number;
}

interface BundleRepresentationIdentity {
  etag: string | null;
  versionId: string | null;
}

interface AuthenticatedVerificationReportOptions {
  expectedImageId: string;
  expectedExecutionId: string;
  expectedStatus: ExpectedTerminalVerificationStatus;
}

interface FinalizedVerificationAcceptanceOptions {
  baseUrl: string;
  sessionId: string;
  expectedImageId: string;
  expectedTerminalVerificationStatus: ExpectedTerminalVerificationStatus;
  expectedOverallVerdict: ExpectedOverallVerdict;
  scenario: GatedSmokeScenario;
  authHeaders: Record<string, string>;
}

type VerificationAcceptanceRunner = (options: VerificationAcceptanceOptions) => Promise<Record<string, unknown>>;

const VERIFICATION_CHECK_DEFINITION_BY_ID = new Map<string, VerificationCheckDefinition>(
  VERIFICATION_CHECK_DEFINITIONS.map((definition): [string, VerificationCheckDefinition] => [
    definition.id,
    definition,
  ]),
);

const EXPECTED_FAILED_CHECKS_BY_SCENARIO: Record<GatedSmokeScenario, readonly VerificationCheckId[]> = {
  S0: [],
  S1: ['counted_missing_indices_zero', 'counted_my_vote_included'],
  S2: ['counted_tally_consistent'],
  S3: ['counted_missing_indices_zero'],
  S4: ['counted_tally_consistent'],
  S5: ['counted_missing_indices_zero'],
};

function isVerificationCheckStatus(value: unknown): value is VerificationCheck['status'] {
  return value === 'not_run' || value === 'pending' || value === 'running' || value === 'success' || value === 'failed';
}

function requireFreshVerificationChecks(data: Record<string, unknown>): VerificationCheck[] {
  const rawChecks: unknown = data['verificationChecks'];
  if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
    throw new Error('Fresh verifier result is missing fresh verificationChecks.');
  }

  const checks: VerificationCheck[] = [];
  const seen = new Set<VerificationCheckId>();
  for (const rawCheck of rawChecks) {
    if (!isRecord(rawCheck)) {
      throw new Error('Fresh verificationChecks contains a non-object check.');
    }
    const rawId = getStringProperty(rawCheck, 'id');
    const definition = rawId ? VERIFICATION_CHECK_DEFINITION_BY_ID.get(rawId) : undefined;
    if (!definition) {
      throw new Error(`Fresh verificationChecks contains an unsupported check ${rawId ?? '<none>'}.`);
    }
    if (seen.has(definition.id)) {
      throw new Error(`Fresh verificationChecks contains duplicate check ${definition.id}.`);
    }
    const status = getStringProperty(rawCheck, 'status');
    if (!isVerificationCheckStatus(status)) {
      throw new Error(`Fresh verificationChecks check ${definition.id} has an invalid status.`);
    }
    seen.add(definition.id);
    checks.push({
      id: definition.id,
      status,
      evidence: definition.evidence,
      inputs: [...definition.inputs],
      ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
    });
  }

  const missing = VERIFICATION_CHECK_DEFINITIONS.filter((definition) => !seen.has(definition.id)).map(
    (definition) => definition.id,
  );
  if (missing.length > 0) {
    throw new Error(`Fresh verificationChecks are missing checks: ${missing.join(', ')}.`);
  }
  return checks;
}

function requireScenarioCount(
  data: FinalizeScenarioData,
  field: 'missingSlots' | 'invalidPresentedSlots' | 'excludedSlots',
): number {
  const value = data[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Gated smoke verification payload has invalid ${field}.`);
  }
  return value;
}

function requireReportString(report: Record<string, unknown>, field: string): string {
  const value = getStringProperty(report, field);
  if (!value?.trim()) {
    throw new Error(`Authenticated verification report ${field} is required.`);
  }
  return value;
}

export function assertAuthenticatedVerificationReport(
  report: Record<string, unknown>,
  headers: Headers,
  options: AuthenticatedVerificationReportOptions,
): void {
  const contentType = headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error('Authenticated verification report returned an invalid Content-Type.');
  }
  const expectedDisposition = `inline; filename="${options.expectedExecutionId}-verification.json"`;
  if (headers.get('content-disposition') !== expectedDisposition) {
    throw new Error(
      `Authenticated verification report Content-Disposition did not bind execution ${options.expectedExecutionId}.`,
    );
  }

  const status = requireReportString(report, 'status');
  if (status !== options.expectedStatus) {
    throw new Error(
      `Authenticated verification report status mismatch: expected ${options.expectedStatus}, got ${status}.`,
    );
  }
  requireReportString(report, 'verifier_version');
  requireReportString(report, 'verified_at');
  const durationMs = report['duration_ms'];
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error('Authenticated verification report duration_ms is invalid.');
  }
  const expectedImageId = requireReportString(report, 'expected_image_id');
  if (expectedImageId !== options.expectedImageId) {
    throw new Error('Authenticated verification report expected_image_id does not match the independent ImageID.');
  }
  const receiptImageId = requireReportString(report, 'receipt_image_id');
  if (receiptImageId !== options.expectedImageId) {
    throw new Error('Authenticated verification report receipt_image_id does not match the independent ImageID.');
  }
  if (report['dev_mode_receipt'] !== false) {
    throw new Error('Authenticated verification report dev_mode_receipt must be false.');
  }
  const errors = report['errors'];
  if (errors !== undefined && (!Array.isArray(errors) || errors.length > 0)) {
    throw new Error('Authenticated verification report errors must be absent or empty.');
  }
}

function isGatedSmokeScenario(value: string): value is GatedSmokeScenario {
  return GATED_SMOKE_SCENARIOS.some((scenario) => scenario === value);
}

export function resolveGatedSmokeExpectedImageId(mapping: ImageIdMapping = imageIdMappingJson): string {
  return resolveExpectedImageIdFromMapping(mapping, Number(mapping.current), 'default');
}

export function assertIndependentFinalizationImageId(data: Record<string, unknown>, expectedImageId: string): void {
  requireIndependentImageId(data, expectedImageId, 'finalization top-level');
  for (const projection of ['proof', 'journal'] as const) {
    const projectionData = getRecordProperty(data, projection);
    const projectedImageId = getStringProperty(projectionData, 'imageId');
    if (projectedImageId !== undefined && projectedImageId !== expectedImageId) {
      throw new Error(
        `finalization ${projection} ImageID mismatch: expected ${expectedImageId}, received ${projectedImageId}.`,
      );
    }
  }
}

export function resolveGatedSmokeScenarioExpectation(scenario: GatedSmokeScenario): GatedSmokeScenarioExpectation {
  return {
    terminalVerificationStatus: 'success',
    overallVerdict: scenario === 'S0' ? 'fully_verified' : 'fail_closed',
  };
}

export function assertExpectedOverallVerdict(
  data: FinalizeScenarioData,
  expectedVerdict: ExpectedOverallVerdict,
): void {
  const context: VerificationSummaryContext = { sthSourcesConfigured: true };
  for (const field of ['missingSlots', 'invalidPresentedSlots', 'rejectedRecords', 'excludedSlots'] as const) {
    const value = data[field];
    if (typeof value === 'number') {
      context[field] = value;
    }
  }
  const summary = deriveVerificationSummary(data.verificationChecks, context);
  if (!summary) {
    throw new Error('Verification payload is missing the checks required to derive an overall verdict.');
  }
  if (expectedVerdict === 'fully_verified') {
    if (summary.status !== 'fully_verified' || summary.tone !== 'verified') {
      throw new Error(`Expected a fully verified overall verdict, received ${summary.status}/${summary.tone}.`);
    }
    return;
  }
  if (summary.tone !== 'failed') {
    throw new Error(`Tamper scenario expected a failed overall verdict, received ${summary.status}/${summary.tone}.`);
  }
}

export function assertGatedSmokeScenarioSemantics(data: FinalizeScenarioData, scenario: GatedSmokeScenario): void {
  const checks = requireFreshVerificationChecks(data);
  const statusById = new Map(checks.map((check) => [check.id, check.status]));
  const expectedFailures = new Set(EXPECTED_FAILED_CHECKS_BY_SCENARIO[scenario]);
  const variableChecks = scenario === 'S5' ? new Set<VerificationCheckId>(['counted_my_vote_included']) : undefined;

  for (const definition of VERIFICATION_CHECK_DEFINITIONS) {
    const status = statusById.get(definition.id);
    if (expectedFailures.has(definition.id)) {
      if (status !== 'failed') {
        throw new Error(`${scenario} requires ${definition.id}=failed, received ${status ?? '<none>'}.`);
      }
      continue;
    }
    if (variableChecks?.has(definition.id)) {
      if (status !== 'success' && status !== 'failed') {
        throw new Error(`${scenario} requires ${definition.id} to reach a terminal result, received ${status}.`);
      }
      continue;
    }
    if (status !== 'success') {
      throw new Error(`${scenario} requires ${definition.id}=success, received ${status ?? '<none>'}.`);
    }
  }

  const missingSlots = requireScenarioCount(data, 'missingSlots');
  const invalidPresentedSlots = requireScenarioCount(data, 'invalidPresentedSlots');
  const excludedSlots = requireScenarioCount(data, 'excludedSlots');
  if (EXCLUSION_SCENARIOS.has(scenario)) {
    if (excludedSlots <= 0 || excludedSlots !== missingSlots + invalidPresentedSlots) {
      throw new Error(
        `${scenario} requires positive excludedSlots equal to missingSlots + invalidPresentedSlots; received ${excludedSlots}, ${missingSlots}, ${invalidPresentedSlots}.`,
      );
    }
  } else if (missingSlots !== 0 || invalidPresentedSlots !== 0 || excludedSlots !== 0) {
    throw new Error(
      `${scenario} requires zero exclusion counts; received ${excludedSlots}, ${missingSlots}, ${invalidPresentedSlots}.`,
    );
  }

  assertExpectedOverallVerdict(
    { ...data, verificationChecks: checks },
    resolveGatedSmokeScenarioExpectation(scenario).overallVerdict,
  );
}

export function resolveGatedSmokeScenarios(
  configured: string | undefined = process.env['STARK_BALLOT_GATED_SMOKE_SCENARIOS'],
): GatedSmokeScenario[] {
  const candidates = configured?.trim()
    ? configured.split(',').map((value) => value.trim())
    : DEFAULT_GATED_SMOKE_SCENARIOS;
  const scenarios: GatedSmokeScenario[] = [];

  for (const candidate of candidates) {
    if (!isGatedSmokeScenario(candidate)) {
      throw new Error(`STARK_BALLOT_GATED_SMOKE_SCENARIOS contains unsupported scenario ${candidate || '<empty>'}.`);
    }
    if (!scenarios.includes(candidate)) {
      scenarios.push(candidate);
    }
  }

  if (!scenarios.includes('S0')) {
    throw new Error('STARK_BALLOT_GATED_SMOKE_SCENARIOS must include S0.');
  }
  if (!scenarios.some((scenario) => EXCLUSION_SCENARIOS.has(scenario))) {
    throw new Error('STARK_BALLOT_GATED_SMOKE_SCENARIOS must include an exclusion scenario (S1, S3, or S5).');
  }
  if (!scenarios.some((scenario) => CLAIMED_TALLY_SCENARIOS.has(scenario))) {
    throw new Error('STARK_BALLOT_GATED_SMOKE_SCENARIOS must include a claimed-tally scenario (S2 or S4).');
  }

  return scenarios;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set.`);
  }
  return value;
}

export function resolveBaseUrl(): string {
  const value = process.env['STARK_BALLOT_DEVELOP_BASE_URL'] ?? process.env['STARK_BALLOT_CLI_BASE_URL'];
  if (!value?.trim()) {
    throw new Error('STARK_BALLOT_DEVELOP_BASE_URL or STARK_BALLOT_CLI_BASE_URL must be set.');
  }
  const parsed = new URL(value);
  if (process.env['STARK_BALLOT_ALLOW_LOCAL_GATED_SMOKE'] !== '1' && isLocalHostname(parsed.hostname)) {
    throw new Error('develop gated smoke refuses localhost unless STARK_BALLOT_ALLOW_LOCAL_GATED_SMOKE=1.');
  }
  return parsed.origin;
}

function isLocalHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '0.0.0.0'].includes(hostname);
}

export function operatorHeaders(): Record<string, string> {
  const name = readRequiredEnv(OPERATOR_AUTH_HEADER_NAME_ENV);
  const value = readRequiredEnv(OPERATOR_AUTH_HEADER_VALUE_ENV);
  return { [name]: value };
}

async function parseErrorCode(response: Response): Promise<string | null> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return null;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  if (!isRecord(payload)) {
    return null;
  }
  return getStringProperty(payload, 'error') ?? null;
}

async function readJsonRecord(response: Response, label: string): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  if (!isRecord(payload)) {
    throw new Error(`${label} returned a non-object JSON payload.`);
  }
  return payload;
}

function requireVerificationExecutionId(
  data: Record<string, unknown>,
  expectedExecutionId: string,
  label: string,
): void {
  const actualExecutionId = getStringProperty(data, 'verificationExecutionId');
  if (actualExecutionId !== expectedExecutionId) {
    throw new Error(
      `${label} verificationExecutionId mismatch: expected ${expectedExecutionId}, received ${actualExecutionId ?? '<none>'}.`,
    );
  }
}

function requireIndependentImageId(data: Record<string, unknown>, expectedImageId: string, label: string): void {
  const actualImageId = getStringProperty(data, 'imageId');
  if (actualImageId !== expectedImageId) {
    throw new Error(`${label} ImageID mismatch: expected ${expectedImageId}, received ${actualImageId ?? '<none>'}.`);
  }
}

function buildVerificationArtifactUrl(baseUrl: string, sessionId: string, executionId: string, report = false): string {
  const suffix = report ? '/report' : '';
  return new URL(
    `/api/verification/bundles/${encodeURIComponent(sessionId)}/${encodeURIComponent(executionId)}${suffix}`,
    baseUrl,
  ).toString();
}

async function fetchAuthenticatedArtifact(
  label: string,
  url: string,
  authHeaders: Record<string, string>,
): Promise<Response> {
  const response = await fetch(url, { method: 'GET', headers: authHeaders, redirect: 'manual' });
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }
  return response;
}

function parseContentRange(value: string | null): ParsedContentRange | null {
  const match = value ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value) : null;
  if (!match) {
    return null;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  ) {
    return null;
  }
  return { start, end, total };
}

function resolveBundleChunkSize(value: string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, BUNDLE_RANGE_CHUNK_BYTES)
    : BUNDLE_RANGE_CHUNK_BYTES;
}

function resolveMaxBundleDownloadBytes(options: BundleDownloadOptions): number {
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_BUNDLE_DOWNLOAD_BYTES;
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new Error('verification bundle maxTotalBytes must be a positive safe integer.');
  }
  return maxTotalBytes;
}

function readBundleRepresentationIdentity(headers: Headers): BundleRepresentationIdentity {
  return {
    etag: headers.get('etag'),
    versionId: headers.get('x-amz-version-id'),
  };
}

function assertBundleRepresentationIdentity(
  expected: BundleRepresentationIdentity,
  actual: BundleRepresentationIdentity,
): void {
  if (expected.etag !== actual.etag) {
    throw new Error('verification bundle representation ETag changed between range responses.');
  }
  if (expected.versionId !== actual.versionId) {
    throw new Error('verification bundle representation version changed between range responses.');
  }
}

async function readBundleRangeBody(response: Response, range: ParsedContentRange): Promise<Buffer> {
  const body = Buffer.from(await response.arrayBuffer());
  const expectedLength = range.end - range.start + 1;
  if (body.byteLength !== expectedLength) {
    throw new Error(
      `verification bundle range body length mismatch: expected ${expectedLength}, received ${body.byteLength}.`,
    );
  }
  return body;
}

function parseContentLength(headers: Headers): number | undefined {
  const rawContentLength = headers.get('content-length');
  if (rawContentLength === null) {
    return undefined;
  }
  if (!/^\d+$/.test(rawContentLength)) {
    throw new Error('verification bundle returned an invalid Content-Length.');
  }
  const contentLength = Number(rawContentLength);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new Error('verification bundle returned an invalid Content-Length.');
  }
  return contentLength;
}

async function readBundleBodyWithLimit(response: Response, maxTotalBytes: number): Promise<Buffer> {
  const declaredLength = parseContentLength(response.headers);
  if (declaredLength !== undefined && declaredLength > maxTotalBytes) {
    throw new Error(`verification bundle exceeds the ${maxTotalBytes}-byte download limit.`);
  }
  if (!response.body) {
    if (declaredLength !== undefined && declaredLength !== 0) {
      throw new Error('verification bundle body length does not match Content-Length.');
    }
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let reading = true;
  try {
    while (reading) {
      const { done, value } = await reader.read();
      if (done) {
        reading = false;
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxTotalBytes) {
        await reader.cancel('verification bundle exceeded download limit');
        throw new Error(`verification bundle exceeds the ${maxTotalBytes}-byte download limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== undefined && totalBytes !== declaredLength) {
    throw new Error('verification bundle body length does not match Content-Length.');
  }
  return Buffer.concat(chunks, totalBytes);
}

async function fetchBundleRange(
  url: string,
  authHeaders: Record<string, string>,
  start: number,
  end: number,
): Promise<Response> {
  return await fetch(url, {
    method: 'GET',
    headers: { ...authHeaders, Range: `bytes=${start}-${end}` },
    redirect: 'manual',
  });
}

export async function downloadAuthenticatedBundle(
  url: string,
  authHeaders: Record<string, string>,
  options: BundleDownloadOptions = {},
): Promise<Buffer> {
  const maxTotalBytes = resolveMaxBundleDownloadBytes(options);
  const firstResponse = await fetchBundleRange(url, authHeaders, 0, BUNDLE_RANGE_CHUNK_BYTES - 1);
  if (firstResponse.status !== 206) {
    if (!firstResponse.ok) {
      throw new Error(`verification bundle returned HTTP ${firstResponse.status}.`);
    }
    return await readBundleBodyWithLimit(firstResponse, maxTotalBytes);
  }

  const firstRange = parseContentRange(firstResponse.headers.get('content-range'));
  if (!firstRange || firstRange.start !== 0) {
    throw new Error('verification bundle returned an invalid initial Content-Range.');
  }
  if (firstRange.end >= BUNDLE_RANGE_CHUNK_BYTES) {
    throw new Error('verification bundle initial Content-Range exceeded the requested range.');
  }
  if (firstRange.total > maxTotalBytes) {
    throw new Error(`verification bundle exceeds the ${maxTotalBytes}-byte download limit.`);
  }
  const representationIdentity = readBundleRepresentationIdentity(firstResponse.headers);
  const chunks = [await readBundleRangeBody(firstResponse, firstRange)];
  const chunkSize = resolveBundleChunkSize(firstResponse.headers.get(BUNDLE_RANGE_CHUNK_HEADER));
  let nextStart = firstRange.end + 1;

  while (nextStart < firstRange.total) {
    const nextEnd = Math.min(nextStart + chunkSize - 1, firstRange.total - 1);
    const response = await fetchBundleRange(url, authHeaders, nextStart, nextEnd);
    if (!response.ok || response.status !== 206) {
      throw new Error(`verification bundle range ${nextStart}-${nextEnd} returned HTTP ${response.status}.`);
    }
    const range = parseContentRange(response.headers.get('content-range'));
    if (!range || range.start !== nextStart || range.end !== nextEnd || range.total !== firstRange.total) {
      throw new Error(`verification bundle returned a non-contiguous Content-Range at byte ${nextStart}.`);
    }
    assertBundleRepresentationIdentity(representationIdentity, readBundleRepresentationIdentity(response.headers));
    chunks.push(await readBundleRangeBody(response, range));
    nextStart = range.end + 1;
  }

  return Buffer.concat(chunks, firstRange.total);
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function runVerificationAcceptance(
  options: VerificationAcceptanceOptions,
): Promise<Record<string, unknown>> {
  const runResponse = await fetch(new URL('/api/verification/run', options.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.authHeaders },
    body: '{}',
    redirect: 'manual',
  });
  if (!runResponse.ok) {
    throw new Error(`POST /api/verification/run returned HTTP ${runResponse.status}.`);
  }
  const runPayload = await readJsonRecord(runResponse, 'POST /api/verification/run');
  const runData = getRecordProperty(runPayload, 'data');
  if (!runData) {
    throw new Error('POST /api/verification/run response is missing data.');
  }
  const executionId = getStringProperty(runData, 'verificationExecutionId');
  if (!executionId || !isSafeVerifierSegment(executionId)) {
    throw new Error('POST /api/verification/run returned an invalid verificationExecutionId.');
  }
  if (getStringProperty(runData, 'verificationStatus') !== 'running' || runData['idempotent'] !== false) {
    throw new Error('POST /api/verification/run did not start new durable verification queue work.');
  }

  const pollUrl = new URL('/api/verify?includeJournal=1', options.baseUrl).toString();
  const maxPollAttempts = options.maxPollAttempts ?? VERIFICATION_POLL_ATTEMPTS;
  const pollDelayMs = options.pollDelayMs ?? VERIFICATION_POLL_DELAY_MS;
  let verifiedData: Record<string, unknown> | undefined;

  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    const response = await fetch(pollUrl, { method: 'GET', headers: options.authHeaders, redirect: 'manual' });
    if (!response.ok) {
      throw new Error(`GET /api/verify polling returned HTTP ${response.status}.`);
    }
    const payload = await readJsonRecord(response, 'GET /api/verify polling');
    const data = getRecordProperty(payload, 'data');
    if (!data) {
      throw new Error('GET /api/verify polling response is missing data.');
    }
    requireVerificationExecutionId(data, executionId, 'GET /api/verify polling');
    const status = getStringProperty(data, 'verificationStatus');
    if (status === options.expectedTerminalVerificationStatus) {
      requireIndependentImageId(data, options.expectedImageId, 'GET /api/verify polling');
      const verificationChecks = requireFreshVerificationChecks(data);
      verifiedData = { ...data, verificationChecks };
      break;
    }
    if (status !== 'running' && status !== 'not_run') {
      throw new Error(
        `GET /api/verify polling reached ${status ?? '<none>'}; expected ${options.expectedTerminalVerificationStatus}.`,
      );
    }
    await delay(pollDelayMs);
  }

  if (!verifiedData) {
    throw new Error(`GET /api/verify polling did not reach success after ${maxPollAttempts} attempts.`);
  }

  const bundleUrl = buildVerificationArtifactUrl(options.baseUrl, options.sessionId, executionId);
  const reportUrl = buildVerificationArtifactUrl(options.baseUrl, options.sessionId, executionId, true);
  const wrongCapabilityHeaders = {
    ...options.authHeaders,
    [SESSION_ID_HEADER]: options.sessionId,
    [SESSION_CAPABILITY_HEADER]: 'wrong-capability-token',
  };
  await expectJsonErrorCodeRejected(
    'wrong capability GET verification bundle',
    bundleUrl,
    ErrorCode.SESSION_CAPABILITY_INVALID,
    { method: 'GET', headers: wrongCapabilityHeaders },
  );
  await expectJsonErrorCodeRejected(
    'wrong capability GET verification report',
    reportUrl,
    ErrorCode.SESSION_CAPABILITY_INVALID,
    { method: 'GET', headers: wrongCapabilityHeaders },
  );

  const bundle = await downloadAuthenticatedBundle(bundleUrl, options.authHeaders);
  const privateBundleFilenames = new Set<string>(PRIVATE_BUNDLE_FILENAMES);
  const privateEntries = (await listZipEntryNamesFromBuffer(bundle)).filter((entryName) =>
    privateBundleFilenames.has(path.posix.basename(entryName)),
  );
  if (privateEntries.length > 0) {
    throw new Error(`Public verification bundle contains private artifacts: ${privateEntries.join(', ')}.`);
  }

  const reportResponse = await fetchAuthenticatedArtifact('verification report', reportUrl, options.authHeaders);
  const report = await readJsonRecord(reportResponse, 'verification report');
  assertAuthenticatedVerificationReport(report, reportResponse.headers, {
    expectedImageId: options.expectedImageId,
    expectedExecutionId: executionId,
    expectedStatus: options.expectedTerminalVerificationStatus,
  });

  return verifiedData;
}

export async function completeFinalizedVerificationAcceptance(
  result: FinalizeWithScenariosResult,
  options: FinalizedVerificationAcceptanceOptions,
  runAcceptance: VerificationAcceptanceRunner = runVerificationAcceptance,
): Promise<FinalizeWithScenariosResult> {
  assertIndependentFinalizationImageId(result.data, options.expectedImageId);
  const verifiedData = await runAcceptance({
    baseUrl: options.baseUrl,
    sessionId: options.sessionId,
    expectedImageId: options.expectedImageId,
    expectedTerminalVerificationStatus: options.expectedTerminalVerificationStatus,
    authHeaders: options.authHeaders,
  });
  requireIndependentImageId(verifiedData, options.expectedImageId, 'fresh verifier result');
  const freshStatus = getStringProperty(verifiedData, 'verificationStatus');
  if (freshStatus !== options.expectedTerminalVerificationStatus) {
    throw new Error(
      `Fresh verifier result status mismatch: expected ${options.expectedTerminalVerificationStatus}, received ${freshStatus ?? '<none>'}.`,
    );
  }
  const verificationChecks = requireFreshVerificationChecks(verifiedData);
  const completedResult = {
    ...result,
    data: {
      ...result.data,
      ...verifiedData,
      verificationChecks,
    },
  };
  const expectedVerdict = resolveGatedSmokeScenarioExpectation(options.scenario).overallVerdict;
  if (expectedVerdict !== options.expectedOverallVerdict) {
    throw new Error(`Gated smoke scenario ${options.scenario} has a mismatched expected overall verdict.`);
  }
  assertGatedSmokeScenarioSemantics(completedResult.data, options.scenario);
  return completedResult;
}

function isCloudFrontGateDenial(response: Response): boolean {
  if (response.status !== 401 && response.status !== 403) {
    return false;
  }

  const server = response.headers.get('server')?.toLowerCase() ?? '';
  const via = response.headers.get('via')?.toLowerCase() ?? '';
  const xCache = response.headers.get('x-cache')?.toLowerCase() ?? '';
  const poweredBy = response.headers.get('x-amz-cf-pop')?.toLowerCase() ?? '';
  return (
    server.includes('cloudfront') || via.includes('cloudfront') || xCache.includes('cloudfront') || poweredBy.length > 0
  );
}

export async function expectCloudFrontGateRejected(label: string, url: string, init: RequestInit = {}): Promise<void> {
  const response = await fetch(url, { redirect: 'manual', ...init });
  if (!isCloudFrontGateDenial(response)) {
    throw new Error(
      `${label} returned ${response.status}; expected a CloudFront signed-cookie gate denial with CloudFront response headers.`,
    );
  }
  console.log(`[develop-gated-smoke] ${label}: CloudFront gate rejected with ${response.status}`);
}

export async function expectJsonErrorCodeRejected(
  label: string,
  url: string,
  expectedErrorCode: ErrorCode,
  init: RequestInit = {},
): Promise<void> {
  const response = await fetch(url, { redirect: 'manual', ...init });
  const actualErrorCode = await parseErrorCode(response);
  if ((response.status >= 200 && response.status < 300) || actualErrorCode !== expectedErrorCode) {
    throw new Error(
      `${label} returned ${response.status} with error ${actualErrorCode ?? '<none>'}; expected JSON error ${expectedErrorCode}.`,
    );
  }
  console.log(`[develop-gated-smoke] ${label}: rejected with ${expectedErrorCode}`);
}

export async function runNegativeGateChecks(baseUrl: string): Promise<void> {
  await expectCloudFrontGateRejected('unauthenticated GET /', `${baseUrl}/`);
  await expectCloudFrontGateRejected('unauthenticated POST /api/session', `${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  await expectCloudFrontGateRejected('unauthenticated GET /api/verify', `${baseUrl}/api/verify`);
}

export async function runWrongCapabilityCheck(baseUrl: string, headers: Record<string, string>): Promise<void> {
  const helper = new CLITestHelpers(baseUrl, headers);
  const sessionId = await helper.createSession();
  await expectJsonErrorCodeRejected(
    'wrong capability GET /api/progress',
    `${baseUrl}/api/progress`,
    ErrorCode.SESSION_CAPABILITY_INVALID,
    {
      method: 'GET',
      headers: {
        ...headers,
        [SESSION_ID_HEADER]: sessionId,
        [SESSION_CAPABILITY_HEADER]: 'wrong-capability-token',
      },
    },
  );
}

function maySkipDirectOriginCheck(baseUrl: string): boolean {
  return process.env['STARK_BALLOT_ALLOW_LOCAL_GATED_SMOKE'] === '1' && isLocalHostname(new URL(baseUrl).hostname);
}

export async function runDirectOriginCheck(headers: Record<string, string>, baseUrl: string): Promise<void> {
  const directOrigin = process.env['STARK_BALLOT_DIRECT_API_ORIGIN']?.trim();
  if (!directOrigin) {
    if (maySkipDirectOriginCheck(baseUrl)) {
      console.log(
        '[develop-gated-smoke] STARK_BALLOT_DIRECT_API_ORIGIN unset; skipping direct-origin rejection probe in explicit local non-acceptance mode.',
      );
      return;
    }
    throw new Error(
      'STARK_BALLOT_DIRECT_API_ORIGIN must be set for develop gated smoke acceptance. Set STARK_BALLOT_ALLOW_LOCAL_GATED_SMOKE=1 only for local non-acceptance runs.',
    );
  }
  const origin = new URL(directOrigin).origin;
  await expectJsonErrorCodeRejected(
    'direct-origin POST /api/session',
    `${origin}/api/session`,
    ErrorCode.SAME_ORIGIN_REQUIRED,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
}

export function createPositiveOwnerFlowConfig(scenario: GatedSmokeScenario = 'S0'): CLITestConfig {
  return {
    scenarios: [],
    useRealZkVM: true,
    realMode: 'prod',
    verbose: false,
    outputFormat: 'table',
    allScenarios: false,
    scenario,
    userChoice: 'A',
    skipBuild: true,
  };
}

export function createPositiveOwnerFlowConfigs(configuredScenarios?: string): CLITestConfig[] {
  return resolveGatedSmokeScenarios(configuredScenarios).map((scenario) => createPositiveOwnerFlowConfig(scenario));
}

class GatedSmokeCLITestHelpers extends CLITestHelpers {
  constructor(
    baseUrl: string,
    operatorAuthHeaders: Record<string, string>,
    private readonly expectedImageId: string,
  ) {
    super(baseUrl, operatorAuthHeaders);
  }

  override async finalizeWithScenarios(sessionId: string, scenarioId: string): Promise<FinalizeWithScenariosResult> {
    if (!isGatedSmokeScenario(scenarioId)) {
      throw new Error(`Unsupported gated smoke scenario ${scenarioId}.`);
    }
    const expectation = resolveGatedSmokeScenarioExpectation(scenarioId);
    const result = await super.finalizeWithScenarios(sessionId, scenarioId);
    return await completeFinalizedVerificationAcceptance(result, {
      baseUrl: resolveBaseUrl(),
      sessionId,
      expectedImageId: this.expectedImageId,
      expectedTerminalVerificationStatus: expectation.terminalVerificationStatus,
      expectedOverallVerdict: expectation.overallVerdict,
      scenario: scenarioId,
      authHeaders: this.getSensitiveAuthHeaders(sessionId),
    });
  }
}

async function runPositiveOwnerFlow(
  baseUrl: string,
  headers: Record<string, string>,
  expectedImageId: string,
  config: CLITestConfig,
): Promise<void> {
  process.env['STARK_BALLOT_CLI_BASE_URL'] = baseUrl;
  process.env['STARK_BALLOT_CLI_SKIP_BUILD'] = 'true';

  const helpers = new GatedSmokeCLITestHelpers(baseUrl, headers, expectedImageId);
  const test = new CLIVotingTest(config, helpers);
  let result: Awaited<ReturnType<CLIVotingTest['run']>>;
  try {
    await test.setup();
    result = await test.run();
  } finally {
    await test.teardown();
  }
  if (!result.passed) {
    throw new Error(`operator-gated ${config.scenario ?? '<unknown>'} owner flow failed.`);
  }
}

export async function main(): Promise<void> {
  const baseUrl = resolveBaseUrl();
  const headers = operatorHeaders();
  const expectedImageId = resolveGatedSmokeExpectedImageId();
  process.env['EXPECTED_IMAGE_ID'] = expectedImageId;
  await runNegativeGateChecks(baseUrl);
  await runWrongCapabilityCheck(baseUrl, headers);
  await runDirectOriginCheck(headers, baseUrl);
  for (const config of createPositiveOwnerFlowConfigs()) {
    await runPositiveOwnerFlow(baseUrl, headers, expectedImageId, config);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
