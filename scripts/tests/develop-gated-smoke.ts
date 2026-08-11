#!/usr/bin/env tsx
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { parseContentRange, type SatisfiedContentRange } from '@stark-ballot/api-contract/http/content-range';
import { API_ROUTES, buildApiRouteUrl } from '@stark-ballot/api-contract/routes';
import {
  VerificationResourceResponseSchema,
  VerificationRunResponseSchema,
  type AvailableVerificationResource,
  type VerificationResource,
} from '@stark-ballot/api-contract/schemas/verification';
import {
  CLITestHelpers,
  type FinalizeScenarioData,
  type FinalizeWithScenariosResult,
  type VoteResult,
} from '@stark-ballot/test-support/testing/cli-test-helpers';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import { isRecord, getRecordProperty, getStringProperty } from '@stark-ballot/validation/unknown-value-guards';
import { listZipEntryNamesFromBuffer, readZipEntriesFromBuffer } from '@stark-ballot/node-adapters/zip';
import { resolveExpectedImageIdFromMapping, type ImageIdMapping } from '@stark-ballot/validation/image-id-policy';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckDefinition,
  type VerificationCheckId,
} from '@stark-ballot/verification/checks';
import {
  evaluateLocalCastChecks,
  LOCAL_CAST_CHECK_IDS,
  overlayLocalCastChecks,
} from '@stark-ballot/verification/local-cast-checks';
import { deriveVerificationPresentationPolicy } from '@stark-ballot/verification/presentation-policy';
import imageIdMappingJson from '../../public/imageId-mapping.json';
import { CLIVotingTest, type CLITestConfig } from './cli-e2e-voting-flow';
import { pollUntil } from '@stark-ballot/test-support/testing/poll';

const imageIdMapping = imageIdMappingJson as ImageIdMapping;

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
const MAX_PUBLIC_RECEIPT_BYTES = 16 * 1024 * 1024;
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
  finalizationId: string;
  expectedImageId: string;
  expectedTerminalVerificationStatus: ExpectedTerminalVerificationStatus;
  authHeaders: Record<string, string>;
  pollDelayMs?: number;
  maxPollAttempts?: number;
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
  expectedFinalizationId: string;
  expectedStatus: ExpectedTerminalVerificationStatus;
}

interface FinalizedVerificationAcceptanceOptions {
  baseUrl: string;
  sessionId: string;
  finalizationId: string;
  expectedImageId: string;
  expectedTerminalVerificationStatus: ExpectedTerminalVerificationStatus;
  expectedOverallVerdict: ExpectedOverallVerdict;
  scenario: GatedSmokeScenario;
  authHeaders: Record<string, string>;
  localVote: VoteResult;
}

type IncludedVerificationJournal = Extract<AvailableVerificationResource['journal'], { representation: 'included' }>;
type AvailableVoterEvidence = Extract<AvailableVerificationResource['voterEvidence'], { availability: 'available' }>;
type CompleteAvailableVerificationResource = Omit<AvailableVerificationResource, 'journal' | 'voterEvidence'> & {
  journal: IncludedVerificationJournal;
  voterEvidence: AvailableVoterEvidence;
};

interface VerificationAcceptanceResult {
  resource: CompleteAvailableVerificationResource;
  publicReceipt?: unknown;
}

type VerificationAcceptanceRunner = (options: VerificationAcceptanceOptions) => Promise<VerificationAcceptanceResult>;

const VERIFICATION_CHECK_DEFINITION_BY_ID = new Map<string, VerificationCheckDefinition>(
  VERIFICATION_CHECK_DEFINITIONS.map((definition): [string, VerificationCheckDefinition] => [
    definition.id,
    definition,
  ]),
);

const LOCAL_CAST_CHECK_ID_SET = new Set<VerificationCheckId>(LOCAL_CAST_CHECK_IDS);

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

function projectVerificationChecks(resource: AvailableVerificationResource): VerificationCheck[] {
  return resource.verification.checks.map((check) => ({
    id: check.id,
    status: check.status,
    evidence: check.evidence,
    inputs: [...check.inputs],
    ...(check.noteKey ? { noteKey: check.noteKey } : {}),
    ...(check.derivedFrom ? { derivedFrom: check.derivedFrom } : {}),
  }));
}

function mergeLocallyVerifiedCastChecks(
  resource: AvailableVerificationResource,
  localVote: VoteResult,
): VerificationCheck[] {
  const serverChecks = projectVerificationChecks(resource);
  for (const check of serverChecks) {
    if (LOCAL_CAST_CHECK_ID_SET.has(check.id) && check.status !== 'not_run') {
      throw new Error(`Server-projected ${check.id} must remain not_run, received ${check.status}.`);
    }
  }

  if (resource.voterEvidence.availability !== 'available') {
    throw new Error('Fresh verifier result is missing exact voter evidence required for local cast verification.');
  }

  const receipt = resource.voterEvidence.voteReceipt;
  const localResults = evaluateLocalCastChecks({
    electionId: resource.proofAuthority.electionId,
    voteReceipt: {
      voteId: receipt.voteId,
      commitment: receipt.commitment,
      bulletinIndex: receipt.bulletinIndex,
      bulletinRootAtCast: receipt.bulletinRootAtCast,
      timestamp: receipt.castAtMs,
      ...(receipt.inputCommitment ? { inputCommitment: receipt.inputCommitment } : {}),
    },
    choice: localVote.choice,
    random: localVote.random,
  });
  const overlaid = overlayLocalCastChecks(serverChecks, localResults);
  if (!overlaid) {
    throw new Error('Fresh verifier result has an incomplete or duplicate verification check inventory.');
  }
  return overlaid;
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
  const expectedDisposition = `inline; filename="${options.expectedFinalizationId}-verification.json"`;
  if (headers.get('content-disposition') !== expectedDisposition) {
    throw new Error(
      `Authenticated verification report Content-Disposition did not bind finalization ${options.expectedFinalizationId}.`,
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

export function resolveGatedSmokeExpectedImageId(mapping: ImageIdMapping = imageIdMapping): string {
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
  const context = { sthSourcesConfigured: true } as {
    sthSourcesConfigured: boolean;
    missingSlots?: number;
    invalidPresentedSlots?: number;
    rejectedRecords?: number;
    excludedSlots?: number;
  };
  for (const field of ['missingSlots', 'invalidPresentedSlots', 'rejectedRecords', 'excludedSlots'] as const) {
    const value = data[field];
    if (typeof value === 'number') {
      context[field] = value;
    }
  }
  const policy = deriveVerificationPresentationPolicy({
    availability: 'available',
    ...(data.verificationChecks ? { checks: data.verificationChecks } : {}),
    context,
    ...(data.verificationStatus ? { verificationStatus: data.verificationStatus } : {}),
    ...(data.verificationReport?.status ? { verificationReportStatus: data.verificationReport.status } : {}),
  });
  if (!policy.summary) {
    throw new Error('Verification payload is missing the checks required to derive an overall verdict.');
  }
  if (expectedVerdict === 'fully_verified') {
    if (!policy.fullyVerifiedLabelEligible) {
      throw new Error(
        `Expected a fully verified overall verdict, received ${policy.summary.status}/${policy.summary.tone}.`,
      );
    }
    return;
  }
  if (policy.display.renderedStatus !== 'failed') {
    throw new Error(
      `Tamper scenario expected a failed overall verdict, received ${policy.summary.status}/${policy.summary.tone}.`,
    );
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
  return getStringProperty(getRecordProperty(payload, 'error'), 'code') ?? null;
}

async function readJsonRecord(response: Response, label: string): Promise<Record<string, unknown>> {
  const payload = await readJsonValue(response, label);
  if (!isRecord(payload)) {
    throw new Error(`${label} returned a non-object JSON payload.`);
  }
  return payload;
}

async function readJsonValue(response: Response, label: string): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  return payload;
}

function firstSchemaIssue(parsed: { success: false; error: { issues: ReadonlyArray<{ message: string }> } }): string {
  return parsed.error.issues[0]?.message ?? 'schema validation failed';
}

function requireAvailableVerificationResource(
  resource: VerificationResource,
  expectedFinalizationId: string,
  label: string,
): CompleteAvailableVerificationResource {
  if (resource.finalizationId !== expectedFinalizationId) {
    throw new Error(
      `${label} finalizationId mismatch: expected ${expectedFinalizationId}, received ${resource.finalizationId}.`,
    );
  }
  if (resource.availability !== 'available') {
    throw new Error(`${label} returned fail-closed verification availability ${resource.availability}.`);
  }
  if (resource.journal.representation !== 'included') {
    throw new Error(`${label} omitted the requested verification journal representation.`);
  }
  if (resource.voterEvidence.availability !== 'available') {
    throw new Error(`${label} omitted exact voter evidence.`);
  }
  return resource as CompleteAvailableVerificationResource;
}

function requireIndependentImageId(data: Record<string, unknown>, expectedImageId: string, label: string): void {
  const actualImageId = getStringProperty(data, 'imageId');
  if (actualImageId !== expectedImageId) {
    throw new Error(`${label} ImageID mismatch: expected ${expectedImageId}, received ${actualImageId ?? '<none>'}.`);
  }
}

function requireIndependentVerificationResourceImageId(
  resource: AvailableVerificationResource,
  expectedImageId: string,
  label: string,
): void {
  const actualImageId = resource.proofAuthority.imageId;
  if (actualImageId !== expectedImageId) {
    throw new Error(`${label} ImageID mismatch: expected ${expectedImageId}, received ${actualImageId}.`);
  }
}

function projectAcceptedVerificationData(
  result: VerificationAcceptanceResult,
  verificationChecks: VerificationCheck[],
): FinalizeScenarioData {
  const resource = result.resource;
  const authority = resource.proofAuthority;
  const presentation = resource.presentation;
  const journal = resource.journal.value;
  const voterEvidence = resource.voterEvidence;
  return {
    finalizationId: resource.finalizationId,
    electionId: authority.electionId,
    electionConfigHash: authority.electionConfigHash,
    imageId: authority.imageId,
    bulletinRoot: authority.bulletinRoot,
    tally: {
      counts: { ...presentation.tally.counts },
      bulletinRoot: authority.bulletinRoot,
      totalVotes: presentation.tally.totalVotes,
      tamperedCount: presentation.tally.tamperedCount ?? 0,
    },
    totalVotes: presentation.tally.totalVotes,
    scenarioId: presentation.scenarioId,
    ...('tamperDetected' in presentation ? { tamperDetected: presentation.tamperDetected } : {}),
    verificationStatus: resource.verifierResult.status,
    ...(resource.verifierResult.report ? { verificationReport: resource.verifierResult.report } : {}),
    verificationSteps: resource.verification.steps.map((step) => ({
      id: step.id,
      status: step.status,
    })),
    verificationChecks,
    journal,
    voteReceipt: {
      voteId: voterEvidence.voteReceipt.voteId,
      commitment: voterEvidence.voteReceipt.commitment,
      bulletinIndex: voterEvidence.voteReceipt.bulletinIndex,
      bulletinRootAtCast: voterEvidence.voteReceipt.bulletinRootAtCast,
      timestamp: voterEvidence.voteReceipt.castAtMs,
      ...(voterEvidence.voteReceipt.inputCommitment
        ? { inputCommitment: voterEvidence.voteReceipt.inputCommitment }
        : {}),
    },
    userVote: {
      commitment: voterEvidence.userVote.commitment,
      voteId: voterEvidence.userVote.voteId,
      proof: {
        leafIndex: voterEvidence.userVote.proof.leafIndex,
        merklePath: [...voterEvidence.userVote.proof.merklePath],
        treeSize: voterEvidence.userVote.proof.treeSize,
        bulletinRootAtCast: voterEvidence.userVote.proof.bulletinRootAtCast,
      },
    },
    missingSlots: authority.missingSlots,
    invalidPresentedSlots: authority.invalidPresentedSlots,
    rejectedRecords: authority.rejectedRecords,
    validVotes: journal.validVotes,
    totalExpected: authority.totalExpected,
    treeSize: authority.treeSize,
    excludedSlots: authority.excludedSlots,
    verifiedTally: [...authority.verifiedTally],
    sthDigest: authority.sthDigest,
    seenBitmapRoot: authority.seenBitmapRoot,
    includedBitmapRoot: authority.includedBitmapRoot,
    inputCommitment: authority.inputCommitment,
    seenIndicesCount: authority.seenIndicesCount,
    ...(result.publicReceipt === undefined ? {} : { receipt: result.publicReceipt }),
  };
}

function buildVerificationArtifactUrl(
  baseUrl: string,
  sessionId: string,
  finalizationId: string,
  report = false,
): string {
  const artifact = report ? 'report' : 'bundle';
  return new URL(
    `/api/sessions/${encodeURIComponent(sessionId)}/finalizations/${encodeURIComponent(finalizationId)}/artifacts/${artifact}`,
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
    etag: headers.get('etag')?.trim() || null,
    versionId: headers.get('x-amz-version-id')?.trim() || null,
  };
}

function assertPresentBundleRepresentationIdentity(identity: BundleRepresentationIdentity): void {
  if (!identity.etag && !identity.versionId) {
    throw new Error('verification bundle range response has no representation identity.');
  }
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

async function readBundleRangeBody(response: Response, range: SatisfiedContentRange): Promise<Buffer> {
  const body = Buffer.from(await response.arrayBuffer());
  const expectedLength = range.advertisedLength;
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
  if (firstRange?.kind !== 'satisfied' || firstRange.start !== 0) {
    throw new Error('verification bundle returned an invalid initial Content-Range.');
  }
  if (firstRange.end >= BUNDLE_RANGE_CHUNK_BYTES) {
    throw new Error('verification bundle initial Content-Range exceeded the requested range.');
  }
  if (firstRange.total > maxTotalBytes) {
    throw new Error(`verification bundle exceeds the ${maxTotalBytes}-byte download limit.`);
  }
  const representationIdentity = readBundleRepresentationIdentity(firstResponse.headers);
  assertPresentBundleRepresentationIdentity(representationIdentity);
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
    if (
      range?.kind !== 'satisfied' ||
      range.start !== nextStart ||
      range.end !== nextEnd ||
      range.total !== firstRange.total
    ) {
      throw new Error(`verification bundle returned a non-contiguous Content-Range at byte ${nextStart}.`);
    }
    const nextRepresentationIdentity = readBundleRepresentationIdentity(response.headers);
    assertPresentBundleRepresentationIdentity(nextRepresentationIdentity);
    assertBundleRepresentationIdentity(representationIdentity, nextRepresentationIdentity);
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
): Promise<VerificationAcceptanceResult> {
  const verificationPath = buildApiRouteUrl(API_ROUTES.runVerification, {
    params: {
      sessionId: options.sessionId,
      finalizationId: options.finalizationId,
    },
  });
  const runResponse = await fetch(new URL(verificationPath, options.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.authHeaders },
    body: '{}',
    redirect: 'manual',
  });
  if (!runResponse.ok) {
    throw new Error(`POST ${verificationPath} returned HTTP ${runResponse.status}.`);
  }
  const runPayload = await readJsonValue(runResponse, `POST ${verificationPath}`);
  const parsedRun = VerificationRunResponseSchema.safeParse(runPayload);
  if (!parsedRun.success) {
    throw new Error(`POST ${verificationPath} returned an invalid response: ${firstSchemaIssue(parsedRun)}.`);
  }
  const runData = parsedRun.data.data;
  if (runData.finalizationId !== options.finalizationId) {
    throw new Error(
      `POST ${verificationPath} finalizationId mismatch: expected ${options.finalizationId}, received ${runData.finalizationId}.`,
    );
  }
  if (runData.verificationStatus !== 'running' || runData.idempotent !== false) {
    throw new Error(`POST ${verificationPath} did not start new durable verification queue work.`);
  }

  const pollPath = buildApiRouteUrl(API_ROUTES.verification, {
    params: {
      sessionId: options.sessionId,
      finalizationId: options.finalizationId,
    },
    query: { include: 'journal' },
  });
  const pollUrl = new URL(pollPath, options.baseUrl).toString();
  const maxPollAttempts = options.maxPollAttempts ?? VERIFICATION_POLL_ATTEMPTS;
  const pollDelayMs = options.pollDelayMs ?? VERIFICATION_POLL_DELAY_MS;
  const limit =
    maxPollAttempts === Number.POSITIVE_INFINITY
      ? { deadlineMs: Number.POSITIVE_INFINITY, clock: Date.now }
      : { maxAttempts: Number.isNaN(maxPollAttempts) ? 0 : Math.max(0, Math.ceil(maxPollAttempts)) };
  const verifiedResource = await pollUntil({
    ...limit,
    operation: async () => {
      const response = await fetch(pollUrl, { method: 'GET', headers: options.authHeaders, redirect: 'manual' });
      if (!response.ok) {
        throw new Error(`GET ${pollPath} polling returned HTTP ${response.status}.`);
      }
      const payload = await readJsonValue(response, `GET ${pollPath} polling`);
      const parsedResource = VerificationResourceResponseSchema.safeParse(payload);
      if (!parsedResource.success) {
        throw new Error(`GET ${pollPath} polling returned an invalid response: ${firstSchemaIssue(parsedResource)}.`);
      }
      const resource = requireAvailableVerificationResource(
        parsedResource.data.data,
        options.finalizationId,
        `GET ${pollPath} polling`,
      );
      const status = resource.verifierResult.status;
      if (status === options.expectedTerminalVerificationStatus) {
        requireIndependentVerificationResourceImageId(resource, options.expectedImageId, `GET ${pollPath} polling`);
        requireFreshVerificationChecks({
          verificationChecks: projectVerificationChecks(resource),
        });
        return resource;
      }
      if (status !== 'running' && status !== 'not_run') {
        throw new Error(
          `GET ${pollPath} polling reached ${status}; expected ${options.expectedTerminalVerificationStatus}.`,
        );
      }
      return null;
    },
    isTerminal: (resource): resource is CompleteAvailableVerificationResource => resource !== null,
    delay: async () => delay(pollDelayMs),
    createTimeoutError: () =>
      new Error(`GET ${pollPath} polling did not reach success after ${maxPollAttempts} attempts.`),
  });
  if (!verifiedResource) {
    throw new Error(`GET ${pollPath} polling did not reach success after ${maxPollAttempts} attempts.`);
  }

  const bundleUrl = buildVerificationArtifactUrl(options.baseUrl, options.sessionId, options.finalizationId);
  const reportUrl = buildVerificationArtifactUrl(options.baseUrl, options.sessionId, options.finalizationId, true);
  const artifactAuthHeaders = options.authHeaders;
  const wrongCapabilityHeaders = {
    ...artifactAuthHeaders,
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

  const bundle = await downloadAuthenticatedBundle(bundleUrl, artifactAuthHeaders);
  const privateBundleFilenames = new Set<string>(PRIVATE_BUNDLE_FILENAMES);
  const privateEntries = (await listZipEntryNamesFromBuffer(bundle)).filter((entryName) =>
    privateBundleFilenames.has(path.posix.basename(entryName)),
  );
  if (privateEntries.length > 0) {
    throw new Error(`Public verification bundle contains private artifacts: ${privateEntries.join(', ')}.`);
  }
  const receiptEntry = (
    await readZipEntriesFromBuffer(bundle, ['receipt.json'], { maxEntryBytes: MAX_PUBLIC_RECEIPT_BYTES })
  ).get('receipt.json');
  let publicReceipt: unknown;
  if (receiptEntry) {
    try {
      publicReceipt = JSON.parse(receiptEntry.toString('utf8')) as unknown;
    } catch {
      throw new Error('Public verification bundle receipt.json is not valid JSON.');
    }
    if (publicReceipt === null) {
      throw new Error('Public verification bundle receipt.json must not be null.');
    }
  }

  const reportResponse = await fetchAuthenticatedArtifact('verification report', reportUrl, artifactAuthHeaders);
  const report = await readJsonRecord(reportResponse, 'verification report');
  assertAuthenticatedVerificationReport(report, reportResponse.headers, {
    expectedImageId: options.expectedImageId,
    expectedFinalizationId: options.finalizationId,
    expectedStatus: options.expectedTerminalVerificationStatus,
  });

  return {
    resource: verifiedResource,
    ...(publicReceipt === undefined ? {} : { publicReceipt }),
  };
}

export async function completeFinalizedVerificationAcceptance(
  result: FinalizeWithScenariosResult,
  options: FinalizedVerificationAcceptanceOptions,
  runAcceptance: VerificationAcceptanceRunner = runVerificationAcceptance,
): Promise<FinalizeWithScenariosResult> {
  assertIndependentFinalizationImageId(result.data, options.expectedImageId);
  const acceptance = await runAcceptance({
    baseUrl: options.baseUrl,
    sessionId: options.sessionId,
    finalizationId: options.finalizationId,
    expectedImageId: options.expectedImageId,
    expectedTerminalVerificationStatus: options.expectedTerminalVerificationStatus,
    authHeaders: options.authHeaders,
  });
  requireIndependentVerificationResourceImageId(acceptance.resource, options.expectedImageId, 'fresh verifier result');
  const freshStatus = acceptance.resource.verifierResult.status;
  if (freshStatus !== options.expectedTerminalVerificationStatus) {
    throw new Error(
      `Fresh verifier result status mismatch: expected ${options.expectedTerminalVerificationStatus}, received ${freshStatus}.`,
    );
  }
  const verificationChecks = mergeLocallyVerifiedCastChecks(acceptance.resource, options.localVote);
  const verifiedData = projectAcceptedVerificationData(acceptance, verificationChecks);
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
  await expectCloudFrontGateRejected('unauthenticated POST /api/sessions', `${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const verificationPath = buildApiRouteUrl(API_ROUTES.verification, {
    params: { sessionId: 'gate-probe', finalizationId: 'gate-probe' },
  });
  await expectCloudFrontGateRejected(
    `unauthenticated GET ${verificationPath}`,
    new URL(verificationPath, baseUrl).toString(),
  );
}

export async function runWrongCapabilityCheck(baseUrl: string, headers: Record<string, string>): Promise<void> {
  const helper = new CLITestHelpers(baseUrl, headers);
  const sessionId = await helper.createSession();
  await expectJsonErrorCodeRejected(
    'wrong capability GET /api/sessions/:sessionId/progress',
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/progress`,
    ErrorCode.SESSION_CAPABILITY_INVALID,
    {
      method: 'GET',
      headers: {
        ...headers,
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
    'direct-origin POST /api/sessions',
    `${origin}/api/sessions`,
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
  private readonly localVotes = new Map<string, VoteResult>();

  constructor(
    baseUrl: string,
    operatorAuthHeaders: Record<string, string>,
    private readonly expectedImageId: string,
  ) {
    super(baseUrl, operatorAuthHeaders);
  }

  override async submitVote(sessionId: string, choice: VoteResult['choice']): Promise<VoteResult> {
    const vote = await super.submitVote(sessionId, choice);
    this.localVotes.set(sessionId, vote);
    return vote;
  }

  override async finalizeWithScenarios(sessionId: string, scenarioId: string): Promise<FinalizeWithScenariosResult> {
    if (!isGatedSmokeScenario(scenarioId)) {
      throw new Error(`Unsupported gated smoke scenario ${scenarioId}.`);
    }
    const localVote = this.localVotes.get(sessionId);
    if (!localVote) {
      throw new Error('Local vote evidence is unavailable for cast verification.');
    }
    this.localVotes.delete(sessionId);
    const expectation = resolveGatedSmokeScenarioExpectation(scenarioId);
    const result = await super.finalizeWithScenarios(sessionId, scenarioId);
    const finalizationId = result.meta?.finalizationId;
    if (!finalizationId) {
      throw new Error('Finalization result is missing finalizationId authority.');
    }
    return await completeFinalizedVerificationAcceptance(result, {
      baseUrl: resolveBaseUrl(),
      sessionId,
      finalizationId,
      expectedImageId: this.expectedImageId,
      expectedTerminalVerificationStatus: expectation.terminalVerificationStatus,
      expectedOverallVerdict: expectation.overallVerdict,
      scenario: scenarioId,
      authHeaders: this.getPathSessionAuthHeaders(),
      localVote,
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
