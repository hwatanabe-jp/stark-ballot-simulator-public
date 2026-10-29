/**
 * CLI Test Helpers for STARK Ballot Simulator
 * Provides utilities for testing the complete voting flow without a browser
 */

import { formatCliCountDiagnostics } from './cli-report-fields';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { createZkVMExecutor, type ZkVMProofProfile } from '@stark-ballot/node-adapters/zkvm/executor-factory';
import { HOST_RESPONSE_TIMEOUT_MS } from '@stark-ballot/node-adapters/zkvm/executor';
import { verifyCTMerkleInclusion } from '@stark-ballot/verification/merkle';
import type { ZkVMInput, ZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/types';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { VoteChoice } from '@stark-ballot/domain/shared/constants';
import { BOT_COUNT } from '@stark-ballot/domain/shared/constants';
import { Agent, setGlobalDispatcher } from 'undici';
import type { TestFinalizationState } from '@stark-ballot/test-support/testing/finalization-state';
import type { VerificationStatus } from '@stark-ballot/verification/shared/types';
import { invokeVerifierService } from '@stark-ballot/node-adapters/verifier-service-client';
import { loadPublicImageIdMapping } from '@stark-ballot/node-adapters/image-id-mapping';
import { resolveExpectedImageId } from '@stark-ballot/verification/image-id';
import { getApiErrorCode, readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { type VerificationCheck } from '@stark-ballot/verification/checks';
import {
  deriveVerificationPresentationPolicy,
  projectVerificationPresentationSteps,
  type VerificationPresentationPolicyResult,
} from '@stark-ballot/verification/presentation-policy';
import {
  getNumberProperty,
  getObjectProperty,
  getStringArrayProperty,
  getStringProperty,
  isNonNullObject,
} from '@stark-ballot/validation/unknown-value-guards';
import { isSessionUnavailableErrorCode } from '@stark-ballot/api-contract/errors/apiErrorGuards';
import { API_ROUTES, buildApiRouteUrl } from '@stark-ballot/api-contract/routes';
import {
  FinalizationResponseSchema,
  type FinalizationResource,
} from '@stark-ballot/api-contract/schemas/finalizations';
import type {
  AvailableVerificationResource,
  CurrentZkVMJournal as ContractCurrentZkVMJournal,
} from '@stark-ballot/api-contract/schemas/verification';
import { VerificationResourceResponseSchema } from '@stark-ballot/api-contract/schemas/verification';
import type { PublicVerificationReport } from '@stark-ballot/verification/public-result';
import { fetchCurrentFinalization, CurrentFinalizationError } from './finalization-status-client';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { pollUntil } from '@stark-ballot/test-support/testing/poll';

type VerificationStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'not_run';
type VerificationStep = {
  id: string;
  status: VerificationStepStatus;
  inputs?: string[];
  error?: string;
};

const DEFAULT_HEADERS_TIMEOUT_MS = 0; // 0 disables timeout in undici
const DEFAULT_BODY_TIMEOUT_MS = 0;

const headersTimeout = Number(process.env['CLI_HEADERS_TIMEOUT_MS'] ?? DEFAULT_HEADERS_TIMEOUT_MS);
const bodyTimeout = Number(process.env['CLI_BODY_TIMEOUT_MS'] ?? DEFAULT_BODY_TIMEOUT_MS);

try {
  setGlobalDispatcher(
    new Agent({
      headersTimeout: Number.isFinite(headersTimeout) ? headersTimeout : DEFAULT_HEADERS_TIMEOUT_MS,
      bodyTimeout: Number.isFinite(bodyTimeout) ? bodyTimeout : DEFAULT_BODY_TIMEOUT_MS,
    }),
  );
} catch {
  // setGlobalDispatcher can only be called once per process; ignore if already set.
}

export function getFinalizeTimeoutMs(proofProfile?: ZkVMProofProfile): number {
  const explicit = Number(process.env['CLI_FINALIZE_TIMEOUT_MS']);
  const timeout =
    Number.isFinite(explicit) && explicit > 0
      ? explicit
      : proofProfile?.executor === 'mock'
        ? 2 * 60 * 1000
        : 15 * 60 * 1000;
  if (!Number.isSafeInteger(timeout) || timeout > 2_147_483_647) {
    throw new Error('CLI_FINALIZE_TIMEOUT_MS must be a positive bounded integer.');
  }
  return proofProfile?.executor === 'risc0' ? Math.max(timeout, HOST_RESPONSE_TIMEOUT_MS) : timeout;
}

const POLL_MIN_DELAY_MS = 750;
const POLL_MAX_DELAY_MS = 5000;
const OPERATOR_AUTH_HEADER_NAME_ENV = 'STARK_BALLOT_OPERATOR_AUTH_HEADER';
const OPERATOR_AUTH_HEADER_VALUE_ENV = 'STARK_BALLOT_OPERATOR_AUTH_VALUE';
const TURNSTILE_TOKEN_ENV_BY_ACTION = {
  session: 'STARK_BALLOT_SESSION_TURNSTILE_TOKEN',
  vote: 'STARK_BALLOT_VOTE_TURNSTILE_TOKEN',
  finalize: 'STARK_BALLOT_FINALIZE_TURNSTILE_TOKEN',
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    setTimeout(resolve, ms);
  });
}

function resolveOperatorAuthHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headerName = env[OPERATOR_AUTH_HEADER_NAME_ENV]?.trim();
  const headerValue = env[OPERATOR_AUTH_HEADER_VALUE_ENV]?.trim();
  if (!headerName && !headerValue) {
    return {};
  }
  if (!headerName || !headerValue) {
    throw new Error(`${OPERATOR_AUTH_HEADER_NAME_ENV} and ${OPERATOR_AUTH_HEADER_VALUE_ENV} must be set together.`);
  }
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName)) {
    throw new Error(`${OPERATOR_AUTH_HEADER_NAME_ENV} must be a valid HTTP header name.`);
  }
  const normalized = headerName.toLowerCase();
  if (normalized === SESSION_CAPABILITY_HEADER.toLowerCase()) {
    throw new Error(`${OPERATOR_AUTH_HEADER_NAME_ENV} must not override the session capability header.`);
  }
  return { [headerName]: headerValue };
}

function readOptionalTurnstileToken(
  action: keyof typeof TURNSTILE_TOKEN_ENV_BY_ACTION,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const specific = env[TURNSTILE_TOKEN_ENV_BY_ACTION[action]]?.trim();
  if (specific) {
    return specific;
  }
  const shared = env['STARK_BALLOT_TURNSTILE_TOKEN']?.trim();
  return shared && shared.length > 0 ? shared : undefined;
}

export interface VoteResult {
  voteId?: string;
  leafIndex: number;
  merklePath: string[];
  commitment: string;
  choice: VoteChoice;
  random: string;
}

export type VerificationBundleDelivery = 'authenticated-endpoint';

export interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  details: {
    verifiedTally?: number[];
    missingSlots?: number;
    invalidPresentedSlots?: number;
    validVotes?: number;
    excludedSlots?: number;
    tamperDetected?: boolean;
    verificationStatus?: VerificationStatus;
    finalizationId?: string;
    verificationBundleDelivery?: VerificationBundleDelivery;
    verificationHash?: string;
    verificationReportHash?: string;
    verificationReportPath?: string;
    bundleExtractionDir?: string;
    errors?: string[];
    finalizationMode?: 'sync' | 'async';
    finalizationHistory?: FinalizationStatusSample[];
    finalizationRuntimeDiagnostics?: FinalizationResource['runtimeDiagnostics'];
  };
}

export interface FinalizationStatusSample {
  state: FinalizationResource | TestFinalizationState | null;
  receivedAt: number;
  runtimeDiagnostics: FinalizationResource['runtimeDiagnostics'] | null;
}

export interface FinalizeScenarioData {
  sessionId?: string;
  tally?:
    | {
        counts: Record<string, number>;
        bulletinRoot: string;
        totalVotes?: number;
        tamperedCount?: number;
      }
    | Record<string, number>;
  result?: {
    counts?: Record<string, number>;
    bulletinRoot?: string;
    totalVotes?: number;
    tamperedCount?: number;
  };
  bulletinRoot?: string;
  totalVotes?: number;
  tamperedCount?: number;
  totalExpected?: number;
  treeSize?: number;
  userMerklePath?: string[];
  userVote?: {
    commitment?: string;
    voteId?: string;
    leafIndex?: number;
    merklePath?: string[];
    treeSize?: number;
    proof?: {
      leafIndex?: number;
      merklePath?: string[];
      treeSize?: number;
      bulletinRootAtCast?: string;
    };
  };
  receipt?: unknown;
  receiptRaw?: unknown;
  receiptEncoded?: string;
  journal?: ZkVMJournal | ContractCurrentZkVMJournal;
  imageId?: string;
  proof?: {
    tamperDetected?: boolean;
    receipt?: unknown;
    imageId?: string;
    merkleVerified?: boolean;
    receiptObject?: unknown;
    recountedBotInfo?: unknown;
    randomError?: unknown;
  };
  verificationStatus?: VerificationStatus;
  verificationSteps?: VerificationStep[];
  verificationChecks?: VerificationCheck[];
  verificationReport?: PublicVerificationReport;
  presentationPolicy?: VerificationPresentationPolicyResult;
  finalizationId?: string;
  debug?: {
    verifiedTally?: number[];
    missingSlots?: number;
    invalidPresentedSlots?: number;
    validVotes?: number;
    excludedSlots?: number;
  };
  missingSlots?: number;
  invalidPresentedSlots?: number;
  validVotes?: number;
  excludedSlots?: number;
  verifiedTally?: number[];
  [key: string]: unknown;
}

export interface FinalizeWithScenariosResult {
  data: FinalizeScenarioData;
  meta?: {
    mode: 'sync' | 'async';
    finalizationId: string;
    finalizationState: FinalizationResource;
    finalizationHistory?: FinalizationStatusSample[];
    runtimeDiagnostics: FinalizationResource['runtimeDiagnostics'];
  };
}

export interface FinalizationCountDiagnostics {
  missingSlots?: number;
  invalidPresentedSlots?: number;
  validVotes?: number;
  excludedSlots?: number;
}

// Canonicalize current route/debug count projections at the CLI boundary.
export function resolveFinalizationCountDiagnostics(data: FinalizeScenarioData): FinalizationCountDiagnostics {
  const debug = data.debug;
  const journal = data.journal;
  const missingSlots = journal?.missingSlots ?? data.missingSlots ?? debug?.missingSlots;
  const invalidPresentedSlots =
    journal?.invalidPresentedSlots ?? data.invalidPresentedSlots ?? debug?.invalidPresentedSlots;
  const validVotes = journal?.validVotes ?? data.validVotes ?? debug?.validVotes;
  const excludedSlots =
    journal?.excludedSlots ??
    data.excludedSlots ??
    debug?.excludedSlots ??
    (typeof missingSlots === 'number' && typeof invalidPresentedSlots === 'number'
      ? missingSlots + invalidPresentedSlots
      : undefined);

  return {
    ...omitUndefinedProperties({ missingSlots, invalidPresentedSlots, validVotes, excludedSlots }),
  };
}

function getLatestNonNullState(
  samples: FinalizationStatusSample[] | undefined,
): FinalizationResource | TestFinalizationState | null {
  if (!samples || samples.length === 0) {
    return null;
  }
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const candidate = samples[index]?.state ?? null;
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function projectAvailableUserVote(
  userVote: Extract<AvailableVerificationResource['voterEvidence'], { availability: 'available' }>['userVote'],
) {
  return {
    commitment: userVote.commitment,
    voteId: userVote.voteId,
    leafIndex: userVote.proof.leafIndex,
    merklePath: [...userVote.proof.merklePath],
    treeSize: userVote.proof.treeSize,
    proof: { ...userVote.proof, merklePath: [...userVote.proof.merklePath] },
  };
}

function projectVerificationUserVote(voterEvidence: AvailableVerificationResource['voterEvidence']) {
  if (voterEvidence.availability === 'available') return projectAvailableUserVote(voterEvidence.userVote);
  if (voterEvidence.reason === 'exact_proof_unavailable')
    return { commitment: voterEvidence.userVote.commitment, voteId: voterEvidence.userVote.voteId };
  return { commitment: voterEvidence.userVote.commitment };
}

function cloneAffectedBotIds<T extends { affectedBotIds?: number[] | undefined }>(summary: T | undefined) {
  if (!summary) return undefined;
  return {
    ...summary,
    ...omitUndefinedProperties({ affectedBotIds: summary.affectedBotIds ? [...summary.affectedBotIds] : undefined }),
  };
}

function cloneCliVerificationReport(report: AvailableVerificationResource['verifierResult']['report']) {
  if (!report) return undefined;
  if (report.status === 'success') return { ...report };
  return { ...report, ...omitUndefinedProperties({ errors: report.errors ? [...report.errors] : undefined }) };
}

function projectFinalizationResource(
  sessionId: string,
  resource: Extract<FinalizationResource, { status: 'succeeded' }>,
): FinalizeScenarioData {
  const { authority, presentation, voterEvidence } = resource.result;
  const userVote = voterEvidence.state === 'available' ? projectAvailableUserVote(voterEvidence.userVote) : undefined;

  return omitUndefinedProperties({
    sessionId,
    finalizationId: resource.finalizationId,
    tally: omitUndefinedProperties({
      counts: { ...presentation.tally.counts },
      bulletinRoot: presentation.bulletinRoot,
      totalVotes: presentation.tally.totalVotes,
      tamperedCount: presentation.tally.tamperedCount,
    }),
    result: omitUndefinedProperties({
      counts: { ...presentation.tally.counts },
      bulletinRoot: presentation.bulletinRoot,
      totalVotes: presentation.tally.totalVotes,
      tamperedCount: presentation.tally.tamperedCount,
    }),
    bulletinRoot: presentation.bulletinRoot,
    totalVotes: presentation.tally.totalVotes,
    tamperedCount: presentation.tally.tamperedCount,
    totalExpected: presentation.totalExpected,
    treeSize: presentation.treeSize,
    userVote,
    voteReceipt: voterEvidence.state === 'available' ? voterEvidence.voteReceipt : undefined,
    receipt: authority.receipt,
    journal: authority.journal,
    imageId: authority.imageId,
    proof: omitUndefinedProperties({
      tamperDetected: presentation.tamperDetected,
      receipt: authority.receipt,
      imageId: authority.imageId,
    }),
    verificationStatus: presentation.verificationStatus,
    verificationReport: presentation.verificationReport,
    missingSlots: presentation.missingSlots,
    invalidPresentedSlots: presentation.invalidPresentedSlots,
    validVotes: authority.journal.validVotes,
    excludedSlots: presentation.excludedSlots,
    verifiedTally: [...presentation.verifiedTally],
    debug: {
      verifiedTally: [...presentation.verifiedTally],
      missingSlots: presentation.missingSlots,
      invalidPresentedSlots: presentation.invalidPresentedSlots,
      validVotes: authority.journal.validVotes,
      excludedSlots: presentation.excludedSlots,
    },
  });
}

function deriveCliVerificationPresentationPolicy(
  resource: AvailableVerificationResource,
  checks: readonly VerificationCheck[],
): VerificationPresentationPolicyResult {
  const input = {
    availability: 'available' as const,
    checks,
    context: {
      missingSlots: resource.proofAuthority.missingSlots,
      invalidPresentedSlots: resource.proofAuthority.invalidPresentedSlots,
      rejectedRecords: resource.proofAuthority.rejectedRecords,
      excludedSlots: resource.proofAuthority.excludedSlots,
      devModeEvidence: resource.verifierResult.report?.dev_mode_receipt === true,
    },
    verificationStatus: resource.verifierResult.status,
    ...omitUndefinedProperties({
      verificationReportStatus: resource.verifierResult.report?.status,
    }),
  };
  const withoutConfiguredSth = deriveVerificationPresentationPolicy({
    ...input,
    context: {
      ...input.context,
      sthSourcesConfigured: false,
    },
  });
  const thirdPartyCheck = checks.find((check) => check.id === 'recorded_sth_third_party');
  const sthSourcesConfigured =
    (thirdPartyCheck !== undefined && thirdPartyCheck.status !== 'not_run') ||
    resource.presentation.policy.stageStatuses.recorded_as_cast !== withoutConfiguredSth.stageStatuses.recorded_as_cast;

  return deriveVerificationPresentationPolicy({
    ...input,
    context: {
      ...input.context,
      sthSourcesConfigured,
    },
  });
}

function projectVerificationChecks(resource: AvailableVerificationResource): VerificationCheck[] {
  return resource.verification.checks.map((check): VerificationCheck => {
    const base = {
      id: check.id,
      evidence: check.evidence,
      inputs: [...check.inputs],
      ...omitUndefinedProperties({ derivedFrom: check.derivedFrom }),
    };
    if ((check.status === 'failed' || check.status === 'not_run') && 'noteKey' in check) {
      return { ...base, status: check.status, noteKey: check.noteKey };
    }
    return { ...base, status: check.status };
  });
}

function projectVerificationResource(resource: AvailableVerificationResource): FinalizeScenarioData {
  const proof = resource.proofAuthority;
  const presentation = resource.presentation;
  const verifierReport = resource.verifierResult.report;
  const journal = resource.journal.representation === 'included' ? resource.journal.value : undefined;
  const verificationChecks = projectVerificationChecks(resource);
  const policy = deriveCliVerificationPresentationPolicy(resource, verificationChecks);
  const voterEvidence = resource.voterEvidence;
  const userVote = projectVerificationUserVote(voterEvidence);

  return omitUndefinedProperties({
    finalizationId: resource.finalizationId,
    electionId: proof.electionId,
    electionConfigHash: proof.electionConfigHash,
    logId: proof.logId,
    tally: {
      counts: { ...presentation.tally.counts },
      bulletinRoot: proof.bulletinRoot,
      totalVotes: presentation.tally.totalVotes,
      tamperedCount: presentation.tally.tamperedCount,
    },
    result: {
      counts: { ...presentation.tally.counts },
      bulletinRoot: proof.bulletinRoot,
      totalVotes: presentation.tally.totalVotes,
      tamperedCount: presentation.tally.tamperedCount,
    },
    bulletinRoot: proof.bulletinRoot,
    totalVotes: presentation.tally.totalVotes,
    tamperedCount: presentation.tally.tamperedCount,
    totalExpected: proof.totalExpected,
    treeSize: proof.treeSize,
    userVote,
    voteReceipt: voterEvidence.availability === 'available' ? voterEvidence.voteReceipt : undefined,
    journal,
    imageId: proof.imageId,
    proof: omitUndefinedProperties({
      tamperDetected: presentation.tamperDetected,
      imageId: proof.imageId,
    }),
    scenarioId: presentation.scenarioId,
    verificationStatus: resource.verifierResult.status,
    verificationSteps: projectVerificationPresentationSteps(resource.verification.steps, policy),
    verificationChecks,
    verificationReport: cloneCliVerificationReport(verifierReport),
    presentationPolicy: policy,
    missingSlots: proof.missingSlots,
    invalidPresentedSlots: proof.invalidPresentedSlots,
    rejectedRecords: proof.rejectedRecords,
    validVotes: journal?.validVotes,
    excludedSlots: proof.excludedSlots,
    verifiedTally: [...proof.verifiedTally],
    sthDigest: proof.sthDigest,
    seenBitmapRoot: proof.seenBitmapRoot,
    includedBitmapRoot: proof.includedBitmapRoot,
    inputCommitment: proof.inputCommitment,
    seenIndicesCount: proof.seenIndicesCount,
    botVotesSummary: cloneAffectedBotIds(presentation.botVotesSummary),
    tamperSummary: cloneAffectedBotIds(presentation.tamperSummary),
    debug: {
      verifiedTally: [...proof.verifiedTally],
      missingSlots: proof.missingSlots,
      invalidPresentedSlots: proof.invalidPresentedSlots,
      ...omitUndefinedProperties({ validVotes: journal?.validVotes }),
      excludedSlots: proof.excludedSlots,
    },
  });
}

function mergeFinalizationPresentation(finalizeData: FinalizeScenarioData, verificationData: FinalizeScenarioData) {
  return {
    sessionId: finalizeData.sessionId ?? verificationData.sessionId,
    tally: finalizeData.tally ?? verificationData.tally,
    result: finalizeData.result ?? verificationData.result,
    bulletinRoot: finalizeData.bulletinRoot ?? verificationData.bulletinRoot,
    totalVotes: finalizeData.totalVotes ?? verificationData.totalVotes,
    tamperedCount: finalizeData.tamperedCount ?? verificationData.tamperedCount,
    totalExpected: finalizeData.totalExpected ?? verificationData.totalExpected,
    treeSize: finalizeData.treeSize ?? verificationData.treeSize,
  };
}

function mergeFinalizationVoteEvidence(finalizeData: FinalizeScenarioData, verificationData: FinalizeScenarioData) {
  return {
    userMerklePath: finalizeData.userMerklePath ?? verificationData.userMerklePath,
    userVote: finalizeData.userVote ?? verificationData.userVote,
    receipt: finalizeData.receipt ?? verificationData.receipt,
    receiptRaw: finalizeData.receiptRaw ?? verificationData.receiptRaw,
    receiptEncoded: finalizeData.receiptEncoded ?? verificationData.receiptEncoded,
    journal: verificationData.journal ?? finalizeData.journal,
    imageId: finalizeData.imageId ?? verificationData.imageId,
    proof: finalizeData.proof ?? verificationData.proof,
  };
}

function mergeFinalizeScenarioData(
  finalizeData: FinalizeScenarioData,
  verificationData: FinalizeScenarioData,
): FinalizeScenarioData {
  const finalizeCounts = resolveFinalizationCountDiagnostics(finalizeData);
  const verificationCounts = resolveFinalizationCountDiagnostics(verificationData);

  return omitUndefinedProperties({
    ...verificationData,
    ...finalizeData,
    ...mergeFinalizationPresentation(finalizeData, verificationData),
    ...mergeFinalizationVoteEvidence(finalizeData, verificationData),
    verificationStatus: verificationData.verificationStatus,
    verificationSteps: verificationData.verificationSteps,
    verificationChecks: verificationData.verificationChecks,
    verificationReport: verificationData.verificationReport,
    presentationPolicy: verificationData.presentationPolicy,
    finalizationId: finalizeData.finalizationId,
    debug: finalizeData.debug ?? verificationData.debug,
    missingSlots: finalizeCounts.missingSlots ?? verificationCounts.missingSlots,
    invalidPresentedSlots: finalizeCounts.invalidPresentedSlots ?? verificationCounts.invalidPresentedSlots,
    validVotes: finalizeCounts.validVotes ?? verificationCounts.validVotes,
    excludedSlots: finalizeCounts.excludedSlots ?? verificationCounts.excludedSlots,
    verifiedTally: finalizeData.verifiedTally ?? verificationData.verifiedTally,
  });
}

function toIso(timestamp?: number): string | undefined {
  if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) {
    return undefined;
  }
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return undefined;
  }
}

const terminalTimestampFields = new Map([
  ['succeeded', 'completedAtMs'],
  ['failed', 'failedAtMs'],
  ['timeout', 'timeoutAtMs'],
]);

function finalizationTimestamps(state: FinalizationResource | TestFinalizationState): string[] {
  const timestamps = [`queuedAtMs=${toIso(state.queuedAtMs) ?? 'n/a'}`];
  if ('startedAtMs' in state && typeof state.startedAtMs === 'number')
    timestamps.push(`startedAtMs=${toIso(state.startedAtMs) ?? 'n/a'}`);
  const terminalField = terminalTimestampFields.get(state.status);
  if (terminalField) timestamps.push(`${terminalField}=${toIso(getNumberProperty(state, terminalField)) ?? 'n/a'}`);
  return timestamps;
}

function formatFinalizationDiagnostics(details: TestResult['details'], format: 'table' | 'markdown'): string[] {
  const lines: string[] = [];
  const prefix = format === 'markdown' ? '- ' : '   ';

  if (details.finalizationMode) {
    const modeLabel = details.finalizationMode.toUpperCase();
    const identity = details.finalizationId ? ` (finalizationId=${details.finalizationId})` : '';
    lines.push(`${prefix}Finalization mode: ${modeLabel}${identity}`);
  }

  const latestState = getLatestNonNullState(details.finalizationHistory);
  if (latestState) {
    const timestamps = finalizationTimestamps(latestState);
    const joined = timestamps.join(', ');
    lines.push(`${prefix}Finalization state: ${latestState.status.toUpperCase()} (${joined})`);
  }

  return lines;
}

function formatArtifactReportFields(details: TestResult['details'], prefix: string): string {
  const fields = [
    ['Verification status', details.verificationStatus],
    ['Finalization ID', details.finalizationMode ? undefined : details.finalizationId],
    ['Verification bundle delivery', details.verificationBundleDelivery],
    ['Bundle extraction', details.bundleExtractionDir],
    ['Verification hash', details.verificationHash],
    ['Verification report hash', details.verificationReportHash],
    ['Verification report path', details.verificationReportPath],
  ] as const;
  return fields
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => `${prefix}${label}: ${value}\n`)
    .join('');
}

function summarizeCliResults(results: TestResult[]) {
  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  return { total, passed, failed: total - passed, duration: results.reduce((sum, result) => sum + result.duration, 0) };
}

function renderMarkdownCliReport(results: TestResult[]): string {
  const {
    total: totalTests,
    passed: passedTests,
    failed: failedTests,
    duration: totalDuration,
  } = summarizeCliResults(results);

  let report = `# STARK Ballot Simulator CLI Test Report\n\n`;
  report += `## Summary\n\n`;
  report += `- Total tests: ${totalTests}\n`;
  report += `- Passed: ${passedTests}\n`;
  report += `- Failed: ${failedTests}\n`;
  report += `- Duration: ${(totalDuration / 1000).toFixed(2)}s\n\n`;
  report += `## Results\n\n`;

  report += results.map(renderMarkdownCliResult).join('');

  return report;
}

function renderTableCliReport(results: TestResult[]): string {
  const {
    total: totalTests,
    passed: passedTests,
    failed: failedTests,
    duration: totalDuration,
  } = summarizeCliResults(results);

  let report = '=== STARK Ballot Simulator CLI Test Report ===\n\n';
  report += `Total tests: ${totalTests}\n`;
  report += `Passed: ${passedTests}\n`;
  report += `Failed: ${failedTests}\n`;
  report += `Duration: ${(totalDuration / 1000).toFixed(2)}s\n\n`;

  report += 'Test Results:\n';
  report += '─────────────────────────────────────────\n';

  report += results.map(renderTableCliResult).join('');

  return report;
}

async function throwCliResponseError(response: Response, action: string): Promise<never> {
  let errorPayload: unknown;
  try {
    errorPayload = await response.json();
  } catch {
    errorPayload = null;
  }
  const errorCode = getApiErrorCode(errorPayload);
  throw new Error(`Failed to ${action}: ${errorCode ?? 'Unknown error'}`);
}

async function readInitialFinalization(response: Response): Promise<FinalizationResource> {
  const payload = await readJsonRecord(response, 'finalization');
  if (!response.ok) {
    const errorCode = getApiErrorCode(payload);
    throw new Error(`Failed to finalize: ${errorCode ?? 'Unknown error'}`);
  }

  const parsed = FinalizationResponseSchema.safeParse(payload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    throw new Error(`Invalid finalization response: ${firstIssue?.message ?? 'schema validation failed'}`);
  }

  return parsed.data.data;
}

function assertFinalizationCanComplete(state: FinalizationResource): void {
  if (state.status === 'failed') {
    throw new Error(`Finalization failed (code=${state.error.code}, message=${state.error.message})`);
  }
  if (state.status === 'timeout') {
    throw new Error('Finalization timed out before completion');
  }
}

function reportRetriableFinalizationError(error: unknown): void {
  if (!(error instanceof CurrentFinalizationError)) throw error;
  if (error.status === 404) {
    const reason = getApiErrorCode(error.responseBody) ?? 'Session not found';
    throw new Error(`Current finalization endpoint returned 404: ${reason}`);
  }
  if (error.status >= 500) {
    console.warn(`[CLI] Current finalization request failed with ${error.status}, retrying...`);
    return;
  }
  throw new Error(`Current finalization request failed with ${error.status}`);
}

function recordFinalizationSample(
  history: FinalizationStatusSample[],
  nextState: FinalizationResource | null,
  previousSnapshot: string,
): string {
  const runtimeDiagnostics = nextState?.runtimeDiagnostics ?? null;
  const currentSnapshot = JSON.stringify(runtimeDiagnostics);
  if (currentSnapshot !== previousSnapshot)
    console.log('[CLI] Finalization runtime diagnostics updated:', runtimeDiagnostics);
  history.push({ state: nextState, receivedAt: Date.now(), runtimeDiagnostics });
  return currentSnapshot;
}

function admitCliVerificationResource(payload: unknown, finalizationId: string): FinalizeScenarioData {
  const parsed = VerificationResourceResponseSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid verification result response: ${issue?.message ?? 'schema validation failed'}`);
  }
  const resource = parsed.data.data;
  if (resource.finalizationId !== finalizationId) {
    throw new Error(
      `Verification finalization identity mismatch (expected ${finalizationId}, received ${resource.finalizationId})`,
    );
  }
  if (resource.availability !== 'available') {
    throw new Error(`Verification result is ${resource.availability}: ${resource.message}`);
  }
  if (resource.journal.representation !== 'included') {
    throw new Error('Verification result omitted the requested journal representation');
  }
  return projectVerificationResource(resource);
}

export class CLITestHelpers {
  private baseUrl: string;
  private electionId: string | null = null;
  private sessionCapabilityToken: string | null = null;
  private operatorAuthHeaders: Record<string, string>;
  private proofProfile: ZkVMProofProfile | undefined;

  constructor(
    baseUrl = 'http://localhost:3000',
    operatorAuthHeaders = resolveOperatorAuthHeaders(),
    proofProfile?: ZkVMProofProfile,
  ) {
    this.baseUrl = baseUrl;
    this.operatorAuthHeaders = operatorAuthHeaders;
    this.proofProfile = proofProfile;
  }

  private requireBaseUrl(): string {
    if (!this.baseUrl) {
      throw new Error('CLI base URL is not configured. Call setup() before running tests.');
    }
    return this.baseUrl;
  }

  async fetchVoteProof(
    voteId: string,
    sessionId: string,
  ): Promise<{
    leafIndex: number;
    merklePath: string[];
    treeSize?: number;
    bulletinRootAtCast?: string;
  }> {
    const baseUrl = this.requireBaseUrl();
    const proofPath = buildApiRouteUrl(API_ROUTES.sessionVoteInclusionProof, {
      params: { sessionId, voteId },
    });
    const response = await fetch(`${baseUrl}${proofPath}`, {
      method: 'GET',
      headers: this.getPathSessionAuthHeaders(),
    });

    if (!response.ok) await throwCliResponseError(response, 'fetch vote proof');

    const payload = await readJsonRecord(response, 'vote proof');
    const data = getObjectProperty(payload, 'data');
    const proof = getObjectProperty(data, 'proof');
    const leafIndex = getNumberProperty(proof, 'leafIndex');
    const merklePath = getStringArrayProperty(proof, 'merklePath');
    const treeSize = getNumberProperty(proof, 'treeSize');
    const bulletinRootAtCast = getStringProperty(proof, 'bulletinRootAtCast');
    if (leafIndex === undefined || !merklePath) {
      throw new Error('Invalid vote proof response');
    }

    return { leafIndex, merklePath, ...omitUndefinedProperties({ treeSize, bulletinRootAtCast }) };
  }

  /**
   * Create a new session
   */
  async createSession(): Promise<string> {
    const baseUrl = this.requireBaseUrl();
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        ...this.getOperatorAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(omitUndefinedProperties({ turnstileToken: readOptionalTurnstileToken('session') })),
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.status}`);
    }

    const payload = await readJsonRecord(response, 'create session');
    const data = getObjectProperty(payload, 'data');
    const electionId = getStringProperty(data, 'electionId');
    const sessionId = getStringProperty(data, 'sessionId');
    const capabilityToken = getStringProperty(data, 'capabilityToken');
    if (!electionId || !sessionId || !capabilityToken) {
      throw new Error('Invalid session response');
    }
    this.electionId = electionId;
    this.sessionCapabilityToken = capabilityToken;
    return sessionId;
  }

  /**
   * Submit a user vote
   */
  async submitVote(sessionId: string, choice: VoteChoice): Promise<VoteResult> {
    // Generate random value (32 bytes)
    if (!this.electionId) {
      throw new Error('Election ID not initialized. Call createSession first.');
    }
    const random = '0x' + randomBytes(32).toString('hex');

    const choiceNum = choice.charCodeAt(0) - 'A'.charCodeAt(0);
    const commitment = computeCommitment(this.electionId, choiceNum, random);

    const baseUrl = this.requireBaseUrl();
    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/votes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getPathSessionAuthHeaders(),
      },
      body: JSON.stringify(
        omitUndefinedProperties({
          commitment,
          vote: choice,
          rand: random,
          turnstileToken: readOptionalTurnstileToken('vote'),
        }),
      ),
    });

    if (!response.ok) await throwCliResponseError(response, 'submit vote');

    const payload = await readJsonRecord(response, 'submit vote');
    const data = getObjectProperty(payload, 'data');
    const voteId = getStringProperty(data, 'voteId');
    let leafIndex = getNumberProperty(data, 'leafIndex') ?? getNumberProperty(data, 'bulletinIndex');
    let merklePath = getStringArrayProperty(data, 'merklePath');

    if (leafIndex === undefined) {
      if (!voteId) {
        throw new Error('Invalid vote response');
      }
      const proof = await this.fetchVoteProof(voteId, sessionId);
      leafIndex = proof.leafIndex;
      merklePath = proof.merklePath;
    } else if (!merklePath) {
      merklePath = [];
    }

    return {
      ...omitUndefinedProperties({ voteId: voteId }),
      leafIndex,
      merklePath,
      commitment,
      choice,
      random,
    };
  }

  /**
   * Generate bot votes
   */
  async generateBotVotes(sessionId: string): Promise<void> {
    // Wait for bot voting to complete using the progress API
    console.log('[CLITest] Waiting for bot votes to be generated...');

    const maxAttempts = 70; // 70 seconds max wait

    await pollUntil<boolean>({
      maxAttempts,
      operation: async ({ attempt }) => {
        const baseUrl = this.requireBaseUrl();
        const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/progress`, {
          method: 'GET',
          headers: this.getPathSessionAuthHeaders(),
        });

        if (response.ok) {
          const payload = await readJsonRecord(response, 'bot progress');
          const data = getObjectProperty(payload, 'data');
          const botCount = getNumberProperty(data, 'count'); // API returns 'count', not 'botCount'
          if (botCount === undefined) {
            throw new Error('Invalid progress response');
          }

          if (botCount >= BOT_COUNT) {
            console.log(`[CLITest] All ${BOT_COUNT} bot votes generated`);
            return true;
          }

          if (attempt % 10 === 0) {
            console.log(`[CLITest] Bot voting progress: ${botCount}/${BOT_COUNT}`);
          }
        } else {
          let errorPayload: unknown;
          try {
            errorPayload = await response.json();
          } catch {
            errorPayload = null;
          }
          const errorCode = getApiErrorCode(errorPayload);
          if (isSessionUnavailableErrorCode(errorCode)) {
            throw new Error(
              `Bot voting progress became unavailable (${errorCode}). Create a fresh session before retrying.`,
            );
          }
        }

        return false;
      },
      isTerminal: (complete) => complete,
      delay: async () => sleep(1000),
      createTimeoutError: () => new Error(`Bot voting did not complete after ${maxAttempts} seconds`),
    });
  }

  /**
   * Finalize session with a specific tamper scenario
   */
  async finalizeWithScenarios(sessionId: string, scenarioId: string): Promise<FinalizeWithScenariosResult> {
    const timeoutMs = getFinalizeTimeoutMs(this.proofProfile);
    const requestedTimeoutMs = Number(process.env['CLI_FINALIZE_TIMEOUT_MS']);
    if (Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 && requestedTimeoutMs < timeoutMs) {
      console.log(
        `[CLI] Finalize HTTP timeout: ${timeoutMs}ms (requested ${requestedTimeoutMs}ms; includes host shutdown and response time)`,
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Finalization HTTP deadline exceeded (${timeoutMs}ms)`)),
      timeoutMs,
    );
    const baseUrl = this.requireBaseUrl();

    try {
      const createPath = buildApiRouteUrl(API_ROUTES.createFinalization, {
        params: { sessionId },
      });
      const response = await fetch(new URL(createPath, baseUrl), {
        method: API_ROUTES.createFinalization.method,
        headers: {
          'Content-Type': 'application/json',
          ...this.getPathSessionAuthHeaders(),
        },
        body: JSON.stringify(
          omitUndefinedProperties({
            scenarioId,
            turnstileToken: readOptionalTurnstileToken('finalize'),
          }),
        ),
        signal: controller.signal,
      });

      const initialResource = await readInitialFinalization(response);
      this.logFinalizationTransition(initialResource);
      assertFinalizationCanComplete(initialResource);

      const pollResult =
        initialResource.status === 'succeeded'
          ? {
              state: initialResource,
              history: [
                {
                  state: initialResource,
                  receivedAt: Date.now(),
                  runtimeDiagnostics: initialResource.runtimeDiagnostics,
                },
              ],
            }
          : await this.pollCurrentFinalization(sessionId, {
              finalizationId: initialResource.finalizationId,
              timeoutMs,
              initialState: initialResource,
              baseUrl,
            });

      const scenarioData = projectFinalizationResource(sessionId, pollResult.state);
      const verificationResponse = await this.fetchVerificationResult(sessionId, pollResult.state.finalizationId, {
        baseUrl,
      });
      if (verificationResponse.data.finalizationId !== pollResult.state.finalizationId) {
        throw new Error(
          `Verification finalization identity mismatch (expected ${pollResult.state.finalizationId}, received ${verificationResponse.data.finalizationId ?? '<none>'})`,
        );
      }
      return {
        data: mergeFinalizeScenarioData(
          {
            ...scenarioData,
            scenarioId,
          },
          verificationResponse.data,
        ),
        meta: {
          mode: response.status === 202 ? 'async' : 'sync',
          finalizationId: pollResult.state.finalizationId,
          finalizationState: pollResult.state,
          finalizationHistory: pollResult.history,
          runtimeDiagnostics: pollResult.state.runtimeDiagnostics,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private logFinalizationTransition(state: FinalizationResource) {
    const { finalizationId } = state;
    switch (state.status) {
      case 'pending':
        console.log(`[CLI] Finalization queued (finalizationId=${finalizationId})`);
        break;
      case 'running': {
        const startedAt = new Date(state.startedAtMs).toISOString();
        console.log(`[CLI] Finalization running since ${startedAt} (finalizationId=${finalizationId})`);
        break;
      }
      case 'succeeded': {
        const completedAt = new Date(state.completedAtMs).toISOString();
        console.log(`[CLI] Finalization succeeded at ${completedAt} (finalizationId=${finalizationId})`);
        break;
      }
      case 'failed':
        console.log(
          `[CLI] Finalization failed (finalizationId=${finalizationId}, code=${state.error.code}, message=${state.error.message})`,
        );
        break;
      case 'timeout':
        console.log(`[CLI] Finalization timed out (finalizationId=${finalizationId})`);
        break;
    }
  }

  private async pollCurrentFinalization(
    sessionId: string,
    options: {
      finalizationId: string;
      timeoutMs: number;
      initialState: FinalizationResource;
      baseUrl: string;
    },
  ): Promise<{
    state: Extract<FinalizationResource, { status: 'succeeded' }>;
    history: FinalizationStatusSample[];
  }> {
    const history: FinalizationStatusSample[] = [];
    let lastLoggedStatus = options.initialState.status;
    const deadline = options.timeoutMs > 0 ? Date.now() + options.timeoutMs : Number.POSITIVE_INFINITY;
    let delayMs = POLL_MIN_DELAY_MS;
    let lastRuntimeDiagnosticsSnapshot = JSON.stringify(options.initialState.runtimeDiagnostics);

    history.push({
      state: options.initialState,
      receivedAt: Date.now(),
      runtimeDiagnostics: options.initialState.runtimeDiagnostics,
    });

    const state = await pollUntil<Extract<FinalizationResource, { status: 'succeeded' }> | null>({
      deadlineMs: deadline,
      clock: Date.now,
      delayPosition: 'before-attempt',
      delay: async () => sleep(delayMs),
      operation: async () => {
        let nextState: FinalizationResource | null;
        try {
          nextState = await fetchCurrentFinalization(sessionId, {
            baseUrl: options.baseUrl,
            authHeaders: this.getPathSessionAuthHeaders(),
          });
        } catch (error) {
          reportRetriableFinalizationError(error);
          delayMs = Math.min(delayMs * 1.5, POLL_MAX_DELAY_MS);
          return null;
        }

        lastRuntimeDiagnosticsSnapshot = recordFinalizationSample(history, nextState, lastRuntimeDiagnosticsSnapshot);

        if (!nextState) {
          delayMs = Math.min(delayMs * 1.5, POLL_MAX_DELAY_MS);
          return null;
        }

        if (nextState.finalizationId !== options.finalizationId) {
          throw new Error(
            `Finalization identity mismatch (expected ${options.finalizationId}, received ${nextState.finalizationId})`,
          );
        }

        if (nextState.status !== lastLoggedStatus) {
          this.logFinalizationTransition(nextState);
          lastLoggedStatus = nextState.status;
        }

        assertFinalizationCanComplete(nextState);
        if (nextState.status === 'succeeded') return nextState;
        delayMs = Math.min(delayMs * 1.5, POLL_MAX_DELAY_MS);
        return null;
      },
      isTerminal: (nextState): nextState is Extract<FinalizationResource, { status: 'succeeded' }> =>
        nextState !== null,
      createTimeoutError: () => new Error('Finalization status polling exceeded configured timeout'),
    });

    if (!state) {
      throw new Error('Finalization status polling exceeded configured timeout');
    }
    return { state, history };
  }

  private async fetchVerificationResult(
    sessionId: string,
    finalizationId: string,
    options: { baseUrl?: string; retries?: number } = {},
  ): Promise<{ data: FinalizeScenarioData }> {
    const baseUrl = options.baseUrl ?? this.requireBaseUrl();
    const verificationPath = buildApiRouteUrl(API_ROUTES.verification, {
      params: { sessionId, finalizationId },
      query: { include: 'journal' },
    });
    const attempts = Math.max(1, options.retries ?? 4);

    const limit: { maxAttempts: number } | { deadlineMs: number; clock: () => number } = Number.isNaN(attempts)
      ? { maxAttempts: 0 }
      : Number.isFinite(attempts)
        ? { maxAttempts: Math.ceil(attempts) }
        : { deadlineMs: Number.POSITIVE_INFINITY, clock: Date.now };

    const result = await pollUntil<{ data: FinalizeScenarioData } | null>({
      ...limit,
      operation: async ({ attempt }) => {
        const response = await fetch(new URL(verificationPath, baseUrl), {
          method: API_ROUTES.verification.method,
          headers: this.getPathSessionAuthHeaders(),
        });

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new Error('Invalid verification result response: response body is not valid JSON');
        }

        if (response.ok) {
          return { data: admitCliVerificationResource(payload, finalizationId) };
        }

        const reason = getApiErrorCode(payload) ?? response.statusText;
        if (reason === 'SESSION_NOT_FINALIZED' && attempt < attempts - 1) {
          return null;
        }

        throw new Error(`Failed to retrieve verification result: ${reason}`);
      },
      isTerminal: (result): result is { data: FinalizeScenarioData } => result !== null,
      delay: async () => sleep(POLL_MIN_DELAY_MS),
      createTimeoutError: () => new Error('Failed to retrieve verification result after multiple attempts'),
    });
    if (!result) {
      throw new Error('Failed to retrieve verification result after multiple attempts');
    }
    return result;
  }

  getPathSessionAuthHeaders(): Record<string, string> {
    if (!this.sessionCapabilityToken) {
      throw new Error('Session capability token is not initialized. Call createSession first.');
    }
    return {
      ...this.getOperatorAuthHeaders(),
      [SESSION_CAPABILITY_HEADER]: this.sessionCapabilityToken,
    };
  }

  getOperatorAuthHeaders(): Record<string, string> {
    return this.operatorAuthHeaders;
  }

  /**
   * Execute zkVM directly
   */
  async executeZkVM(input: ZkVMInput, proofProfile: ZkVMProofProfile): Promise<ZkVMJournal> {
    const executor = await createZkVMExecutor(proofProfile);
    console.log(`[CLITest] Using ${executor.type} zkVM executor`);
    return await executor.execute(input);
  }

  /**
   * Verify STARK proof
   * Supports both dev mode (Fake) and production mode (Composite) receipts
   */
  async verifySTARK(
    receipt: unknown,
    options: {
      proofProfile: ZkVMProofProfile;
      imageId?: string;
      verificationStatus?: VerificationStatus;
      verificationReport?: unknown;
      verificationBundlePath?: string;
    },
  ): Promise<boolean> {
    const { proofProfile } = options;
    const acceptsDevelopmentEvidence = proofProfile.executor === 'risc0' && proofProfile.evidence === 'development';

    if (proofProfile.executor === 'mock') {
      return this.verifyReceiptStructurally(receipt);
    }

    if (options.verificationBundlePath)
      return this.verifyBundleWithService(options.verificationBundlePath, options, acceptsDevelopmentEvidence);

    if (options.verificationStatus)
      return verifyReportedReceiptStatus(options.verificationStatus, acceptsDevelopmentEvidence);

    return this.verifyReceiptStructurally(receipt);
  }

  private async verifyBundleWithService(
    bundlePath: string,
    options: Parameters<CLITestHelpers['verifySTARK']>[1],
    acceptsDevelopmentEvidence: boolean,
  ): Promise<boolean> {
    const expectedImageId =
      options.imageId ??
      (await resolveExpectedImageId(undefined, {
        ...omitUndefinedProperties({ explicitImageId: process.env['EXPECTED_IMAGE_ID'] }),
        ...omitUndefinedProperties({
          variant: process.env['EXPECTED_IMAGE_ID_VARIANT'],
        }),
        loadImageIdMapping: loadPublicImageIdMapping,
      }));
    const reportPath = this.buildVerifierReportPath();

    try {
      const result = await invokeVerifierService({
        bundlePath,
        expectedImageId,
        reportPath,
      });

      if (result.status === 'success') {
        return true;
      }

      if (result.status === 'dev_mode') {
        if (acceptsDevelopmentEvidence) {
          console.warn('[STARK Verifier] verifier-service reported dev mode receipt (accepted)');
          return true;
        }

        console.warn('[STARK Verifier] verifier-service reported dev mode receipt');
      } else {
        console.error(`[STARK Verifier] verifier-service reported ${result.status}`);
      }

      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[STARK Verifier] verifier-service invocation failed: ${message}`);
      return false;
    } finally {
      await this.tryRemoveFile(reportPath);
    }
  }

  private buildVerifierReportPath(): string {
    const baseDir = process.env['CLI_VERIFIER_TMP_DIR'] ?? os.tmpdir();
    return path.join(baseDir, `verifier-report-${randomUUID()}.json`);
  }

  private async tryRemoveFile(filePath: string): Promise<void> {
    try {
      await fs.rm(filePath, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }

  private verifyReceiptStructurally(receipt: unknown): boolean {
    try {
      const { kind, data } = this.describeReceipt(receipt);

      switch (kind) {
        case 'mock':
          console.log('[STARK Verifier] Mock receipt detected');
          return true;
        case 'modern':
          return this.verifyModernReceipt(data);
        case 'unknown':
          console.error('[STARK Verifier] Unknown receipt format');
          return false;
      }
    } catch (error) {
      console.error('[STARK Verifier] Failed to interpret receipt:', error);
      return false;
    }
  }

  private verifyModernReceipt(data: unknown): boolean {
    const modern = data as { seal?: string; journal?: string; imageId?: string };

    if (typeof modern.seal !== 'string' || modern.seal.length === 0) {
      console.error('[STARK Verifier] Modern receipt missing seal string');
      return false;
    }

    if (typeof modern.journal !== 'string' || modern.journal.length === 0) {
      console.error('[STARK Verifier] Modern receipt missing journal string');
      return false;
    }

    try {
      Buffer.from(modern.seal, 'base64');
    } catch (error) {
      console.warn('[STARK Verifier] Modern receipt seal is not valid base64', error);
    }

    return true;
  }

  describeReceipt(receipt: unknown): {
    kind: 'mock' | 'modern' | 'unknown';
    data?: unknown;
    sealLength?: number;
  } {
    if (receipt === undefined || receipt === null) {
      return { kind: 'mock' };
    }

    let parsed: unknown = receipt;

    if (typeof receipt === 'string') {
      try {
        parsed = JSON.parse(receipt);
      } catch (error) {
        console.warn('[STARK Verifier] Failed to parse receipt string', error);
        return { kind: 'unknown' };
      }
    }

    if (!isNonNullObject(parsed)) {
      return { kind: 'unknown' };
    }

    if (parsed['mock'] === true) {
      return { kind: 'mock', data: parsed };
    }

    if (typeof parsed['seal'] === 'string' && typeof parsed['journal'] === 'string') {
      const sealLength = readReceiptSealLength(parsed['seal']);
      return { kind: 'modern', data: parsed, ...omitUndefinedProperties({ sealLength }) };
    }

    return { kind: 'unknown', data: parsed };
  }

  /**
   * Verify Merkle inclusion
   */
  verifyMerkle(
    commitment: string,
    path: string[],
    leafIndex: number,
    root: string,
    options?: { treeSize?: number },
  ): boolean {
    if (options?.treeSize === undefined) {
      throw new Error('treeSize is required for CT merkle verification');
    }
    return verifyCTMerkleInclusion(commitment, path, leafIndex, root, options.treeSize);
  }

  /**
   * Generate test report
   */
  generateReport(results: TestResult[], format: 'json' | 'table' | 'markdown' = 'table'): Promise<string> {
    if (format === 'json') {
      return Promise.resolve(
        JSON.stringify(
          {
            summary: summarizeCliResults(results),
            results,
          },
          null,
          2,
        ),
      );
    }

    return Promise.resolve(format === 'markdown' ? renderMarkdownCliReport(results) : renderTableCliReport(results));
  }
}

function renderCliResultHeading(result: TestResult, format: 'markdown' | 'table'): string {
  const status = result.passed ? 'PASS' : 'FAIL';
  const heading = format === 'markdown' ? `### ${status} ${result.name}\n\n` : `${status} ${result.name}\n`;
  const prefix = format === 'markdown' ? '- ' : '   ';
  const duration = `${prefix}Duration: ${(result.duration / 1000).toFixed(2)}s\n`;
  const diagnostics = formatFinalizationDiagnostics(result.details, format)
    .map((line) => `${line}\n`)
    .join('');
  return heading + duration + diagnostics;
}

function renderMarkdownCliResult(result: TestResult): string {
  let report = renderCliResultHeading(result, 'markdown');

  if (result.details.verifiedTally) {
    report += `- Verified tally: [${result.details.verifiedTally.join(', ')}]\n`;
  }
  report += formatArtifactReportFields(result.details, '- ');

  const counts = formatCliCountDiagnostics(result.details);
  if (counts) report += `- ${counts}\n`;

  if (result.details.tamperDetected !== undefined) {
    report += `- Tamper detected: ${result.details.tamperDetected ? 'YES' : 'NO'}\n`;
  }
  if (result.details.errors && result.details.errors.length > 0) {
    report += `- Errors:\n`;
    result.details.errors.forEach((error) => {
      report += `  - ${error}\n`;
    });
  }
  report += '\n';
  return report;
}

function renderTableCliResult(result: TestResult): string {
  let report = renderCliResultHeading(result, 'table');

  if (result.details.tamperDetected !== undefined) {
    report += `   Tamper detected: ${result.details.tamperDetected ? 'YES' : 'NO'}\n`;
  }
  report += formatArtifactReportFields(result.details, '   ');

  if (!result.passed && result.details.errors) {
    report += `   Errors:\n`;
    result.details.errors.forEach((error) => {
      report += `     - ${error}\n`;
    });
  }
  report += '\n';
  return report;
}

function verifyReportedReceiptStatus(status: VerificationStatus, acceptsDevelopmentEvidence: boolean): boolean {
  if (status === 'success') {
    return true;
  }

  if (status === 'dev_mode') {
    if (acceptsDevelopmentEvidence) {
      console.warn('[STARK Verifier] Dev mode receipt detected by verifier-service (accepted)');
      return true;
    }
    console.warn('[STARK Verifier] Dev mode receipt detected by verifier-service');
  }

  return false;
}

function readReceiptSealLength(seal: string): number | undefined {
  try {
    return Buffer.from(seal, 'base64').length;
  } catch {
    return undefined;
  }
}
