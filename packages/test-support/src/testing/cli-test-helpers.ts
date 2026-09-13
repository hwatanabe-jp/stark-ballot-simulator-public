/**
 * CLI Test Helpers for STARK Ballot Simulator
 * Provides utilities for testing the complete voting flow without a browser
 */

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
import { getVerificationStepInputs, type VerificationCheck } from '@stark-ballot/verification/checks';
import {
  deriveVerificationPresentationPolicy,
  type VerificationPresentationPolicyResult,
} from '@stark-ballot/verification/presentation-policy';
import {
  getNumberProperty,
  getRecordProperty,
  getStringArrayProperty,
  getStringProperty,
  isRecord,
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

function projectFinalizationResource(
  sessionId: string,
  resource: Extract<FinalizationResource, { status: 'succeeded' }>,
): FinalizeScenarioData {
  const { authority, presentation, voterEvidence } = resource.result;
  const userVote =
    voterEvidence.state === 'available'
      ? {
          commitment: voterEvidence.userVote.commitment,
          voteId: voterEvidence.userVote.voteId,
          leafIndex: voterEvidence.userVote.proof.leafIndex,
          merklePath: [...voterEvidence.userVote.proof.merklePath],
          treeSize: voterEvidence.userVote.proof.treeSize,
          proof: {
            ...voterEvidence.userVote.proof,
            merklePath: [...voterEvidence.userVote.proof.merklePath],
          },
        }
      : undefined;

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

const VERIFICATION_STEP_IDS = [
  'cast_as_intended',
  'recorded_as_cast',
  'counted_as_recorded',
  'stark_verification',
] as const;

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

function projectVerificationSteps(
  resource: AvailableVerificationResource,
  policy: VerificationPresentationPolicyResult,
): VerificationStep[] {
  const serverSteps = new Map(resource.verification.steps.map((step) => [step.id, step] as const));
  return VERIFICATION_STEP_IDS.map((id) => {
    const serverStep = serverSteps.get(id);
    return {
      id,
      status: policy.stageStatuses[id],
      inputs: serverStep?.inputs ? [...serverStep.inputs] : getVerificationStepInputs(id),
      ...(serverStep?.error ? { error: serverStep.error } : {}),
    };
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
  const userVote =
    voterEvidence.availability === 'available'
      ? {
          commitment: voterEvidence.userVote.commitment,
          voteId: voterEvidence.userVote.voteId,
          leafIndex: voterEvidence.userVote.proof.leafIndex,
          merklePath: [...voterEvidence.userVote.proof.merklePath],
          treeSize: voterEvidence.userVote.proof.treeSize,
          proof: {
            ...voterEvidence.userVote.proof,
            merklePath: [...voterEvidence.userVote.proof.merklePath],
          },
        }
      : voterEvidence.reason === 'exact_proof_unavailable'
        ? {
            commitment: voterEvidence.userVote.commitment,
            voteId: voterEvidence.userVote.voteId,
          }
        : {
            commitment: voterEvidence.userVote.commitment,
          };

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
    verificationSteps: projectVerificationSteps(resource, policy),
    verificationChecks,
    verificationReport: verifierReport
      ? verifierReport.status === 'success'
        ? { ...verifierReport }
        : {
            ...verifierReport,
            ...omitUndefinedProperties({ errors: verifierReport.errors ? [...verifierReport.errors] : undefined }),
          }
      : undefined,
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
    botVotesSummary: presentation.botVotesSummary
      ? {
          ...presentation.botVotesSummary,
          ...omitUndefinedProperties({
            affectedBotIds: presentation.botVotesSummary.affectedBotIds
              ? [...presentation.botVotesSummary.affectedBotIds]
              : undefined,
          }),
        }
      : undefined,
    tamperSummary: presentation.tamperSummary
      ? {
          ...presentation.tamperSummary,
          ...omitUndefinedProperties({
            affectedBotIds: presentation.tamperSummary.affectedBotIds
              ? [...presentation.tamperSummary.affectedBotIds]
              : undefined,
          }),
        }
      : undefined,
    debug: {
      verifiedTally: [...proof.verifiedTally],
      missingSlots: proof.missingSlots,
      invalidPresentedSlots: proof.invalidPresentedSlots,
      ...omitUndefinedProperties({ validVotes: journal?.validVotes }),
      excludedSlots: proof.excludedSlots,
    },
  });
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
    sessionId: finalizeData.sessionId ?? verificationData.sessionId,
    tally: finalizeData.tally ?? verificationData.tally,
    result: finalizeData.result ?? verificationData.result,
    bulletinRoot: finalizeData.bulletinRoot ?? verificationData.bulletinRoot,
    totalVotes: finalizeData.totalVotes ?? verificationData.totalVotes,
    tamperedCount: finalizeData.tamperedCount ?? verificationData.tamperedCount,
    totalExpected: finalizeData.totalExpected ?? verificationData.totalExpected,
    treeSize: finalizeData.treeSize ?? verificationData.treeSize,
    userMerklePath: finalizeData.userMerklePath ?? verificationData.userMerklePath,
    userVote: finalizeData.userVote ?? verificationData.userVote,
    receipt: finalizeData.receipt ?? verificationData.receipt,
    receiptRaw: finalizeData.receiptRaw ?? verificationData.receiptRaw,
    receiptEncoded: finalizeData.receiptEncoded ?? verificationData.receiptEncoded,
    journal: verificationData.journal ?? finalizeData.journal,
    imageId: finalizeData.imageId ?? verificationData.imageId,
    proof: finalizeData.proof ?? verificationData.proof,
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
    const timestamps: string[] = [];
    timestamps.push(`queuedAtMs=${toIso(latestState.queuedAtMs) ?? 'n/a'}`);
    if ('startedAtMs' in latestState && typeof latestState.startedAtMs === 'number') {
      timestamps.push(`startedAtMs=${toIso(latestState.startedAtMs) ?? 'n/a'}`);
    }
    if (latestState.status === 'succeeded') {
      timestamps.push(`completedAtMs=${toIso(latestState.completedAtMs) ?? 'n/a'}`);
    } else if (latestState.status === 'failed') {
      const failedAtMs =
        'failedAtMs' in latestState && typeof latestState.failedAtMs === 'number' ? latestState.failedAtMs : undefined;
      timestamps.push(`failedAtMs=${toIso(failedAtMs) ?? 'n/a'}`);
    } else if (latestState.status === 'timeout') {
      const timeoutAtMs =
        'timeoutAtMs' in latestState && typeof latestState.timeoutAtMs === 'number'
          ? latestState.timeoutAtMs
          : undefined;
      timestamps.push(`timeoutAtMs=${toIso(timeoutAtMs) ?? 'n/a'}`);
    }
    const joined = timestamps.join(', ');
    lines.push(`${prefix}Finalization state: ${latestState.status.toUpperCase()} (${joined})`);
  }

  const orchestrator = details.finalizationRuntimeDiagnostics?.orchestrator;
  if (orchestrator) {
    const status = orchestrator.status ?? 'UNKNOWN';
    const parts = [`status=${status}`];
    lines.push(`${prefix}Step Functions: ${parts.join(' · ')}`);
  }

  return lines;
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

    if (!response.ok) {
      let errorPayload: unknown;
      try {
        errorPayload = await response.json();
      } catch {
        errorPayload = null;
      }
      const errorCode = getApiErrorCode(errorPayload);
      throw new Error(`Failed to fetch vote proof: ${errorCode ?? 'Unknown error'}`);
    }

    const payload = await readJsonRecord(response, 'vote proof');
    const data = getRecordProperty(payload, 'data');
    const proof = getRecordProperty(data, 'proof');
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
    const data = getRecordProperty(payload, 'data');
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

    if (!response.ok) {
      let errorPayload: unknown;
      try {
        errorPayload = await response.json();
      } catch {
        errorPayload = null;
      }
      const errorCode = getApiErrorCode(errorPayload);
      throw new Error(`Failed to submit vote: ${errorCode ?? 'Unknown error'}`);
    }

    const payload = await readJsonRecord(response, 'submit vote');
    const data = getRecordProperty(payload, 'data');
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
          const data = getRecordProperty(payload, 'data');
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

      const initialResource = parsed.data.data;
      this.logFinalizationTransition(initialResource);
      if (initialResource.status === 'failed') {
        throw new Error(
          `Finalization failed (code=${initialResource.error.code}, message=${initialResource.error.message})`,
        );
      }
      if (initialResource.status === 'timeout') {
        throw new Error('Finalization timed out before completion');
      }

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
          if (error instanceof CurrentFinalizationError) {
            if (error.status === 404) {
              const reason = getApiErrorCode(error.responseBody) ?? 'Session not found';
              throw new Error(`Current finalization endpoint returned 404: ${reason}`);
            }
            if (error.status >= 500) {
              console.warn(`[CLI] Current finalization request failed with ${error.status}, retrying...`);
              delayMs = Math.min(delayMs * 1.5, POLL_MAX_DELAY_MS);
              return null;
            }
            throw new Error(`Current finalization request failed with ${error.status}`);
          }
          throw error;
        }

        const runtimeDiagnostics = nextState?.runtimeDiagnostics ?? null;
        const currentSnapshot = JSON.stringify(runtimeDiagnostics);
        if (currentSnapshot !== lastRuntimeDiagnosticsSnapshot) {
          console.log('[CLI] Finalization runtime diagnostics updated:', runtimeDiagnostics);
          lastRuntimeDiagnosticsSnapshot = currentSnapshot;
        }
        history.push({
          state: nextState,
          receivedAt: Date.now(),
          runtimeDiagnostics,
        });

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

        switch (nextState.status) {
          case 'succeeded':
            return nextState;
          case 'failed':
            throw new Error(`Finalization failed (code=${nextState.error.code}, message=${nextState.error.message})`);
          case 'timeout':
            throw new Error('Finalization timed out before completion');
          case 'pending':
          case 'running':
            delayMs = Math.min(delayMs * 1.5, POLL_MAX_DELAY_MS);
            return null;
        }
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
          return { data: projectVerificationResource(resource) };
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

    if (options.verificationBundlePath) {
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
          bundlePath: options.verificationBundlePath,
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

    if (options.verificationStatus) {
      if (options.verificationStatus === 'success') {
        return true;
      }

      if (options.verificationStatus === 'dev_mode') {
        if (acceptsDevelopmentEvidence) {
          console.warn('[STARK Verifier] Dev mode receipt detected by verifier-service (accepted)');
          return true;
        }
        console.warn('[STARK Verifier] Dev mode receipt detected by verifier-service');
      }

      return false;
    }

    return this.verifyReceiptStructurally(receipt);
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
        case 'modern': {
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
        case 'unknown':
          console.error('[STARK Verifier] Unknown receipt format');
          return false;
      }
    } catch (error) {
      console.error('[STARK Verifier] Failed to interpret receipt:', error);
      return false;
    }
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

    if (!isRecord(parsed)) {
      return { kind: 'unknown' };
    }

    if (parsed['mock'] === true) {
      return { kind: 'mock', data: parsed };
    }

    if (typeof parsed['seal'] === 'string' && typeof parsed['journal'] === 'string') {
      let sealLength: number | undefined;
      try {
        sealLength = Buffer.from(parsed['seal'], 'base64').length;
      } catch {
        // ignore base64 errors here; verification will handle it
      }
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
    const totalTests = results.length;
    const passedTests = results.filter((r) => r.passed).length;
    const failedTests = totalTests - passedTests;
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

    if (format === 'json') {
      return Promise.resolve(
        JSON.stringify(
          {
            summary: {
              total: totalTests,
              passed: passedTests,
              failed: failedTests,
              duration: totalDuration,
            },
            results,
          },
          null,
          2,
        ),
      );
    }

    if (format === 'markdown') {
      let report = `# STARK Ballot Simulator CLI Test Report\n\n`;
      report += `## Summary\n\n`;
      report += `- Total tests: ${totalTests}\n`;
      report += `- Passed: ${passedTests}\n`;
      report += `- Failed: ${failedTests}\n`;
      report += `- Duration: ${(totalDuration / 1000).toFixed(2)}s\n\n`;
      report += `## Results\n\n`;

      for (const result of results) {
        const status = result.passed ? 'PASS' : 'FAIL';
        report += `### ${status} ${result.name}\n\n`;
        report += `- Duration: ${(result.duration / 1000).toFixed(2)}s\n`;

        const diagLines = formatFinalizationDiagnostics(result.details, 'markdown');
        if (diagLines.length > 0) {
          diagLines.forEach((line) => {
            report += `${line}\n`;
          });
        }

        if (result.details.verifiedTally) {
          report += `- Verified tally: [${result.details.verifiedTally.join(', ')}]\n`;
        }
        if (result.details.verificationStatus) {
          report += `- Verification status: ${result.details.verificationStatus}\n`;
        }
        if (result.details.finalizationId && !result.details.finalizationMode) {
          report += `- Finalization ID: ${result.details.finalizationId}\n`;
        }
        if (result.details.verificationBundleDelivery) {
          report += `- Verification bundle delivery: ${result.details.verificationBundleDelivery}\n`;
        }
        if (result.details.bundleExtractionDir) {
          report += `- Bundle extraction: ${result.details.bundleExtractionDir}\n`;
        }
        if (result.details.verificationHash) {
          report += `- Verification hash: ${result.details.verificationHash}\n`;
        }
        if (result.details.verificationReportHash) {
          report += `- Verification report hash: ${result.details.verificationReportHash}\n`;
        }
        if (result.details.verificationReportPath) {
          report += `- Verification report path: ${result.details.verificationReportPath}\n`;
        }
        if (
          typeof result.details.missingSlots === 'number' ||
          typeof result.details.invalidPresentedSlots === 'number' ||
          typeof result.details.validVotes === 'number' ||
          typeof result.details.excludedSlots === 'number'
        ) {
          report += `- Counts: missingSlots=${result.details.missingSlots ?? 'n/a'}, invalidPresentedSlots=${
            result.details.invalidPresentedSlots ?? 'n/a'
          }, validVotes=${result.details.validVotes ?? 'n/a'}, excludedSlots=${
            result.details.excludedSlots ?? 'n/a'
          }\n`;
        }
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
      }

      return Promise.resolve(report);
    }

    // Default: table format
    let report = '=== STARK Ballot Simulator CLI Test Report ===\n\n';
    report += `Total tests: ${totalTests}\n`;
    report += `Passed: ${passedTests}\n`;
    report += `Failed: ${failedTests}\n`;
    report += `Duration: ${(totalDuration / 1000).toFixed(2)}s\n\n`;

    report += 'Test Results:\n';
    report += '─────────────────────────────────────────\n';

    for (const result of results) {
      const status = result.passed ? 'PASS' : 'FAIL';
      report += `${status} ${result.name}\n`;
      report += `   Duration: ${(result.duration / 1000).toFixed(2)}s\n`;

      const diagLines = formatFinalizationDiagnostics(result.details, 'table');
      if (diagLines.length > 0) {
        diagLines.forEach((line) => {
          report += `${line}\n`;
        });
      }

      if (result.details.tamperDetected !== undefined) {
        report += `   Tamper detected: ${result.details.tamperDetected ? 'YES' : 'NO'}\n`;
      }
      if (result.details.verificationStatus) {
        report += `   Verification status: ${result.details.verificationStatus}\n`;
      }
      if (result.details.finalizationId && !result.details.finalizationMode) {
        report += `   Finalization ID: ${result.details.finalizationId}\n`;
      }
      if (result.details.verificationBundleDelivery) {
        report += `   Verification bundle delivery: ${result.details.verificationBundleDelivery}\n`;
      }
      if (result.details.bundleExtractionDir) {
        report += `   Bundle extraction: ${result.details.bundleExtractionDir}\n`;
      }
      if (result.details.verificationHash) {
        report += `   Verification hash: ${result.details.verificationHash}\n`;
      }
      if (result.details.verificationReportHash) {
        report += `   Verification report hash: ${result.details.verificationReportHash}\n`;
      }
      if (result.details.verificationReportPath) {
        report += `   Verification report path: ${result.details.verificationReportPath}\n`;
      }

      if (!result.passed && result.details.errors) {
        report += `   Errors:\n`;
        result.details.errors.forEach((error) => {
          report += `     - ${error}\n`;
        });
      }
      report += '\n';
    }

    return Promise.resolve(report);
  }
}
