/**
 * CLI Test Helpers for STARK Ballot Simulator
 * Provides utilities for testing the complete voting flow without a browser
 */

import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { createZkVMExecutor } from '@/lib/zkvm/executor-factory';
import { verifyCTMerkleInclusion } from '@/lib/verification/merkle';
import type { ZkVMInput, ZkVMJournal } from '@/lib/zkvm/types';
import { computeCommitment } from '@/lib/zkvm/types';
import type { VoteChoice } from '@/shared/constants';
import { BOT_COUNT } from '@/shared/constants';
import { Agent, setGlobalDispatcher } from 'undici';
import type { FinalizationState, VerificationReport, VerificationStatus } from '@/types/server';
import { invokeVerifierService } from '@/lib/verification/verifier-service-client';
import { resolveExpectedImageId } from '@/lib/verification/expected-image-id';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import type { VerificationStep } from '@/lib/knowledge';
import type { VerificationCheck } from '@/lib/verification/verification-checks';
import {
  getNumberProperty,
  getRecordProperty,
  getStringArrayProperty,
  getStringProperty,
  isRecord,
} from '@/lib/utils/guards';
import { isFailClosedFinalizationErrorCode, isSessionUnavailableErrorCode } from '@/lib/errors/apiErrorGuards';
import {
  fetchFinalizationStatus,
  FinalizationStatusError,
  type FinalizationStatusResponse,
} from '@/lib/finalize/finalization-status-client';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';

const DEFAULT_HEADERS_TIMEOUT_MS = 0; // 0 disables timeout in undici
const DEFAULT_BODY_TIMEOUT_MS = 0;

const headersTimeout = Number(process.env.CLI_HEADERS_TIMEOUT_MS ?? DEFAULT_HEADERS_TIMEOUT_MS);
const bodyTimeout = Number(process.env.CLI_BODY_TIMEOUT_MS ?? DEFAULT_BODY_TIMEOUT_MS);

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

function getFinalizeTimeoutMs(): number {
  const explicit = Number(process.env.CLI_FINALIZE_TIMEOUT_MS);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }

  const isRealZkVM = process.env.USE_MOCK_ZKVM === 'false';
  return isRealZkVM ? 15 * 60 * 1000 : 2 * 60 * 1000;
}

const POLL_MIN_DELAY_MS = 750;
const POLL_MAX_DELAY_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    setTimeout(resolve, ms);
  });
}

export interface SessionData {
  sessionId: string;
  userVoteIndex?: number;
  botCount: number;
  finalized: boolean;
  votes: Map<number, unknown>;
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
    verificationExecutionId?: string;
    verificationBundleDelivery?: VerificationBundleDelivery;
    verificationHash?: string;
    verificationReportHash?: string;
    verificationReportPath?: string;
    bundleExtractionDir?: string;
    errors?: string[];
    finalizationMode?: 'sync' | 'async';
    finalizationExecutionId?: string;
    finalizationHistory?: FinalizationStatusSample[];
    finalizationStepFunctions?: FinalizationStatusResponse['stepFunctions'];
  };
}

export interface FinalizationStatusSample {
  state: FinalizationState | null;
  receivedAt: number;
  stepFunctions: FinalizationStatusResponse['stepFunctions'];
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
  journal?: ZkVMJournal;
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
  verificationReport?: VerificationReport;
  verificationExecutionId?: string;
  verificationResult?: {
    executionId?: string;
  };
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
    executionId?: string;
    finalizationState?: FinalizationState | null;
    finalizationHistory?: FinalizationStatusSample[];
    stepFunctions?: FinalizationStatusResponse['stepFunctions'];
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
    missingSlots,
    invalidPresentedSlots,
    validVotes,
    excludedSlots,
  };
}

function getLatestNonNullState(samples: FinalizationStatusSample[] | undefined): FinalizationState | null {
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

function isFinalizationState(value: unknown): value is FinalizationState {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.status !== 'string' || typeof value.executionId !== 'string' || typeof value.queuedAt !== 'number') {
    return false;
  }
  switch (value.status) {
    case 'pending':
      return true;
    case 'running':
      return typeof value.startedAt === 'number';
    case 'succeeded':
      return typeof value.startedAt === 'number' && typeof value.completedAt === 'number';
    case 'failed': {
      if (typeof value.failedAt !== 'number') {
        return false;
      }
      const error = value.error;
      return isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string';
    }
    case 'timeout':
      return typeof value.timeoutAt === 'number';
    default:
      return false;
  }
}

function asFinalizeScenarioData(value: unknown): FinalizeScenarioData {
  return isRecord(value) ? value : {};
}

function mergeFinalizeScenarioData(
  finalizeData: FinalizeScenarioData,
  verificationData: FinalizeScenarioData,
): FinalizeScenarioData {
  const finalizeCounts = resolveFinalizationCountDiagnostics(finalizeData);
  const verificationCounts = resolveFinalizationCountDiagnostics(verificationData);

  return {
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
    verificationStatus: verificationData.verificationStatus ?? finalizeData.verificationStatus,
    verificationSteps: verificationData.verificationSteps ?? finalizeData.verificationSteps,
    verificationChecks: verificationData.verificationChecks ?? finalizeData.verificationChecks,
    verificationReport: verificationData.verificationReport ?? finalizeData.verificationReport,
    verificationExecutionId: verificationData.verificationExecutionId ?? finalizeData.verificationExecutionId,
    verificationResult: verificationData.verificationResult ?? finalizeData.verificationResult,
    debug: finalizeData.debug ?? verificationData.debug,
    missingSlots: finalizeCounts.missingSlots ?? verificationCounts.missingSlots,
    invalidPresentedSlots: finalizeCounts.invalidPresentedSlots ?? verificationCounts.invalidPresentedSlots,
    validVotes: finalizeCounts.validVotes ?? verificationCounts.validVotes,
    excludedSlots: finalizeCounts.excludedSlots ?? verificationCounts.excludedSlots,
    verifiedTally: finalizeData.verifiedTally ?? verificationData.verifiedTally,
  };
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
    const execution = details.finalizationExecutionId ? ` (executionId=${details.finalizationExecutionId})` : '';
    lines.push(`${prefix}Finalization mode: ${modeLabel}${execution}`);
  }

  const latestState = getLatestNonNullState(details.finalizationHistory);
  if (latestState) {
    const timestamps: string[] = [];
    timestamps.push(`queuedAt=${toIso(latestState.queuedAt) ?? 'n/a'}`);
    if ('startedAt' in latestState && typeof latestState.startedAt === 'number') {
      timestamps.push(`startedAt=${toIso(latestState.startedAt) ?? 'n/a'}`);
    }
    if (latestState.status === 'succeeded') {
      timestamps.push(`completedAt=${toIso(latestState.completedAt) ?? 'n/a'}`);
    } else if (latestState.status === 'failed') {
      const failedAt =
        'failedAt' in latestState && typeof latestState.failedAt === 'number' ? latestState.failedAt : undefined;
      timestamps.push(`failedAt=${toIso(failedAt) ?? 'n/a'}`);
    } else if (latestState.status === 'timeout') {
      const timeoutAt =
        'timeoutAt' in latestState && typeof latestState.timeoutAt === 'number' ? latestState.timeoutAt : undefined;
      timestamps.push(`timeoutAt=${toIso(timeoutAt) ?? 'n/a'}`);
    }
    const joined = timestamps.join(', ');
    lines.push(`${prefix}Finalization state: ${latestState.status.toUpperCase()} (${joined})`);
  }

  const stepFunctions = details.finalizationStepFunctions;
  if (stepFunctions) {
    const status = stepFunctions.status ?? 'UNKNOWN';
    const parts = [`status=${status}`];
    if (stepFunctions.error) {
      parts.push(`error=${stepFunctions.error}`);
    }
    if (stepFunctions.cause) {
      parts.push(`cause=${stepFunctions.cause}`);
    }
    lines.push(`${prefix}Step Functions: ${parts.join(' · ')}`);
  }

  return lines;
}

export class CLITestHelpers {
  private baseUrl: string;
  private electionId: string | null = null;
  private sessionCapabilityToken: string | null = null;

  constructor(baseUrl = 'http://localhost:3000') {
    this.baseUrl = baseUrl;
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
    const response = await fetch(`${baseUrl}/api/bulletin/${voteId}/proof`, {
      method: 'GET',
      headers: this.getSensitiveAuthHeaders(sessionId),
    });

    if (!response.ok) {
      let errorPayload: unknown = null;
      try {
        errorPayload = await response.json();
      } catch {
        errorPayload = null;
      }
      const errorCode = getStringProperty(errorPayload, 'error');
      throw new Error(`Failed to fetch vote proof: ${errorCode ?? 'Unknown error'}`);
    }

    const payload = await readJsonRecord(response, 'vote proof');
    const proof = getRecordProperty(payload, 'proof');
    const leafIndex = getNumberProperty(proof, 'leafIndex');
    const merklePath = getStringArrayProperty(proof, 'merklePath');
    const treeSize = getNumberProperty(proof, 'treeSize');
    const bulletinRootAtCast = getStringProperty(proof, 'bulletinRootAtCast');
    if (leafIndex === undefined || !merklePath) {
      throw new Error('Invalid vote proof response');
    }

    return { leafIndex, merklePath, treeSize, bulletinRootAtCast };
  }

  /**
   * Create a new session
   */
  async createSession(): Promise<string> {
    const baseUrl = this.requireBaseUrl();
    const response = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
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
    const response = await fetch(`${baseUrl}/api/vote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getSensitiveAuthHeaders(sessionId),
      },
      body: JSON.stringify({
        commitment,
        vote: choice,
        rand: random,
      }),
    });

    if (!response.ok) {
      let errorPayload: unknown = null;
      try {
        errorPayload = await response.json();
      } catch {
        errorPayload = null;
      }
      const errorCode = getStringProperty(errorPayload, 'error');
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
      voteId,
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

    let attempts = 0;
    const maxAttempts = 70; // 70 seconds max wait

    while (attempts < maxAttempts) {
      const baseUrl = this.requireBaseUrl();
      const response = await fetch(`${baseUrl}/api/progress`, {
        method: 'GET',
        headers: this.getSensitiveAuthHeaders(sessionId),
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
          return;
        }

        if (attempts % 10 === 0) {
          console.log(`[CLITest] Bot voting progress: ${botCount}/${BOT_COUNT}`);
        }
      } else {
        let errorPayload: unknown = null;
        try {
          errorPayload = await response.json();
        } catch {
          errorPayload = null;
        }
        const errorCode = getStringProperty(errorPayload, 'error');
        if (isSessionUnavailableErrorCode(errorCode)) {
          throw new Error(
            `Bot voting progress became unavailable (${errorCode}). Create a fresh session before retrying.`,
          );
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;
    }

    throw new Error(`Bot voting did not complete after ${maxAttempts} seconds`);
  }

  /**
   * Finalize session with a specific tamper scenario
   */
  async finalizeWithScenarios(sessionId: string, scenarioId: string): Promise<FinalizeWithScenariosResult> {
    const timeoutMs = getFinalizeTimeoutMs();
    const controller = new AbortController();
    const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const baseUrl = this.requireBaseUrl();

    try {
      const response = await fetch(`${baseUrl}/api/finalize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.getSensitiveAuthHeaders(sessionId),
        },
        body: JSON.stringify({
          scenarioId,
        }),
        signal: controller.signal,
      });

      if (response.status === 202) {
        const payload = await readJsonRecord(response, 'finalize async');
        const executionId = getStringProperty(payload, 'executionId');
        if (!executionId) {
          throw new Error('Async finalization response missing executionId');
        }

        const initialState = isFinalizationState(payload.state) ? payload.state : null;

        if (initialState) {
          this.logFinalizationTransition(executionId, initialState);
        } else {
          console.log(`[CLI] Finalization job enqueued (executionId=${executionId})`);
        }

        const pollResult = await this.pollFinalizationStatus(sessionId, {
          executionId,
          timeoutMs,
          initialState,
          baseUrl,
        });

        const verificationResponse = await this.fetchVerificationResult(sessionId, {
          includeJournal: true,
          baseUrl,
        });

        return {
          data: verificationResponse.data,
          meta: {
            mode: 'async',
            executionId,
            finalizationState: pollResult.state,
            finalizationHistory: pollResult.history,
            stepFunctions: pollResult.stepFunctions,
          },
        };
      }

      if (!response.ok) {
        let errorPayload: unknown = null;
        try {
          errorPayload = await response.json();
        } catch {
          errorPayload = null;
        }
        const errorCode = getStringProperty(errorPayload, 'error');
        throw new Error(`Failed to finalize: ${errorCode ?? 'Unknown error'}`);
      }

      const result = await readJsonRecord(response, 'finalize sync');
      const data = getRecordProperty(result, 'data');
      const scenarioData = data ? asFinalizeScenarioData(data) : {};
      const verificationResponse = await this.fetchVerificationResult(sessionId, {
        includeJournal: true,
        baseUrl,
      });
      return {
        data: mergeFinalizeScenarioData(scenarioData, verificationResponse.data),
        meta: {
          mode: 'sync',
        },
      };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private logFinalizationTransition(executionId: string, state: FinalizationState) {
    switch (state.status) {
      case 'pending':
        console.log(`[CLI] Finalization queued (executionId=${executionId})`);
        break;
      case 'running': {
        const startedAt = new Date(state.startedAt).toISOString();
        console.log(`[CLI] Finalization running since ${startedAt} (executionId=${executionId})`);
        break;
      }
      case 'succeeded': {
        const completedAt = new Date(state.completedAt).toISOString();
        console.log(`[CLI] Finalization succeeded at ${completedAt} (executionId=${executionId})`);
        break;
      }
      case 'failed':
        console.log(
          `[CLI] Finalization failed (executionId=${executionId}, code=${state.error.code}, message=${state.error.message})`,
        );
        break;
      case 'timeout':
        console.log(`[CLI] Finalization timed out (executionId=${executionId})`);
        break;
    }
  }

  private async pollFinalizationStatus(
    sessionId: string,
    options: {
      executionId: string;
      timeoutMs: number;
      initialState: FinalizationState | null;
      baseUrl: string;
    },
  ): Promise<{
    state: FinalizationState;
    history: FinalizationStatusSample[];
    stepFunctions: FinalizationStatusResponse['stepFunctions'];
  }> {
    const history: FinalizationStatusSample[] = [];
    let lastLoggedStatus = options.initialState?.status ?? null;
    const deadline = options.timeoutMs > 0 ? Date.now() + options.timeoutMs : Number.POSITIVE_INFINITY;
    let delayMs = POLL_MIN_DELAY_MS;
    let stepFunctionsDetails: FinalizationStatusResponse['stepFunctions'] = null;
    let lastStepFunctionsSnapshot: string | null = null;

    if (options.initialState) {
      history.push({
        state: options.initialState,
        receivedAt: Date.now(),
        stepFunctions: null,
      });
      if (options.initialState.status === 'succeeded' || options.initialState.status === 'failed') {
        return {
          state: options.initialState,
          history,
          stepFunctions: null,
        };
      }
    }

    for (;;) {
      if (Date.now() > deadline) {
        throw new Error('Finalization status polling exceeded configured timeout');
      }

      await sleep(delayMs);

      let statusResponse: FinalizationStatusResponse;
      try {
        statusResponse = await fetchFinalizationStatus(sessionId, {
          baseUrl: options.baseUrl,
          authHeaders: this.getSensitiveAuthHeaders(sessionId),
        });
      } catch (error) {
        if (error instanceof FinalizationStatusError) {
          if (error.status === 404) {
            const responseBody = error.responseBody;
            const reason =
              isRecord(responseBody) && typeof responseBody.error === 'string'
                ? responseBody.error
                : 'Session not found';
            // 404 はセッションが存在しない／非同期モードが無効化されたことを示すため、再試行せず即座に失敗扱いとする。
            throw new Error(`Status endpoint returned 404: ${reason}`);
          }
          if (error.status >= 500) {
            console.warn(`[CLI] Status request failed with ${error.status}, retrying...`);
            delayMs = Math.min(delayMs * 1.5, POLL_MAX_DELAY_MS);
            continue;
          }
          throw new Error(`Status request failed with ${error.status}`);
        }
        throw error;
      }

      stepFunctionsDetails = statusResponse.stepFunctions ?? null;
      const currentSnapshot = stepFunctionsDetails ? JSON.stringify(stepFunctionsDetails) : null;
      if (currentSnapshot !== lastStepFunctionsSnapshot) {
        console.log('[CLI] Step Functions updated:', stepFunctionsDetails);
        lastStepFunctionsSnapshot = currentSnapshot;
      }
      const state = statusResponse.finalizationState;
      history.push({
        state,
        receivedAt: Date.now(),
        stepFunctions: stepFunctionsDetails,
      });

      if (!state) {
        delayMs = Math.min(delayMs * 1.5, POLL_MAX_DELAY_MS);
        continue;
      }

      if (state.executionId !== options.executionId) {
        console.warn(
          `[CLI] Finalization state executionId mismatch (expected ${options.executionId}, received ${state.executionId}). Continuing polling.`,
        );
      }

      if (state.status !== lastLoggedStatus) {
        this.logFinalizationTransition(options.executionId, state);
        lastLoggedStatus = state.status;
      }

      switch (state.status) {
        case 'succeeded':
          return { state, history, stepFunctions: stepFunctionsDetails };
        case 'failed':
          throw new Error(`Finalization failed (code=${state.error.code}, message=${state.error.message})`);
        case 'timeout':
          throw new Error('Finalization timed out before completion');
        case 'pending':
        case 'running':
          delayMs = Math.min(delayMs * 1.5, POLL_MAX_DELAY_MS);
          break;
      }
    }
  }

  private async fetchVerificationResult(
    sessionId: string,
    options: { includeJournal?: boolean; baseUrl?: string; retries?: number } = {},
  ): Promise<{ data: FinalizeScenarioData }> {
    const baseUrl = options.baseUrl ?? this.requireBaseUrl();
    const queryParams = new URLSearchParams();
    if (options.includeJournal !== false) {
      queryParams.set('includeJournal', '1');
    }
    const query = queryParams.size > 0 ? `?${queryParams.toString()}` : '';
    const attempts = Math.max(1, options.retries ?? 4);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/verify${query}`, {
        method: 'GET',
        headers: this.getSensitiveAuthHeaders(sessionId),
      });

      const payload = await readJsonRecord(response, 'verification result');
      if (response.ok) {
        const errorCode = getStringProperty(payload, 'error');
        if (isFailClosedFinalizationErrorCode(errorCode)) {
          throw new Error(`Failed to retrieve verification result: ${errorCode}`);
        }
        const data = getRecordProperty(payload, 'data');
        const scenarioData = data ? asFinalizeScenarioData(data) : {};
        return { data: scenarioData };
      }

      const reason = getStringProperty(payload, 'error') ?? response.statusText;

      if (reason === 'SESSION_NOT_FINALIZED' && attempt < attempts - 1) {
        await sleep(POLL_MIN_DELAY_MS);
        continue;
      }

      throw new Error(`Failed to retrieve verification result: ${reason}`);
    }

    throw new Error('Failed to retrieve verification result after multiple attempts');
  }

  getSensitiveAuthHeaders(sessionId: string): Record<string, string> {
    if (!this.sessionCapabilityToken) {
      throw new Error('Session capability token is not initialized. Call createSession first.');
    }
    return {
      'X-Session-ID': sessionId,
      [SESSION_CAPABILITY_HEADER]: this.sessionCapabilityToken,
    };
  }

  /**
   * Execute zkVM directly
   */
  async executeZkVM(input: ZkVMInput, useMock?: boolean): Promise<ZkVMJournal> {
    const executor = await createZkVMExecutor({ useMock });
    console.log(`[CLITest] Using ${executor.type} zkVM executor`);
    return await executor.execute(input);
  }

  /**
   * Verify STARK proof
   * Supports both dev mode (Fake) and production mode (Composite) receipts
   */
  async verifySTARK(
    receipt: unknown,
    options?: {
      useRealZkVM?: boolean;
      imageId?: string;
      verificationStatus?: VerificationStatus;
      verificationReport?: unknown;
      verificationBundlePath?: string;
      allowDevMode?: boolean;
    },
  ): Promise<boolean> {
    const useRealZkVM = options?.useRealZkVM ?? false;
    const allowDevMode = options?.allowDevMode ?? false;

    if (!useRealZkVM) {
      return this.verifyReceiptStructurally(receipt, false);
    }

    if (options?.verificationBundlePath) {
      const expectedImageId = options.imageId ?? (await resolveExpectedImageId());
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
          if (allowDevMode) {
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

    if (options?.verificationStatus) {
      if (options.verificationStatus === 'success') {
        return true;
      }

      if (options.verificationStatus === 'dev_mode') {
        if (allowDevMode) {
          console.warn('[STARK Verifier] Dev mode receipt detected by verifier-service (accepted)');
          return true;
        }
        console.warn('[STARK Verifier] Dev mode receipt detected by verifier-service');
      }

      return false;
    }

    return this.verifyReceiptStructurally(receipt, true);
  }

  private buildVerifierReportPath(): string {
    const baseDir = process.env.CLI_VERIFIER_TMP_DIR ?? os.tmpdir();
    return path.join(baseDir, `verifier-report-${randomUUID()}.json`);
  }

  private async tryRemoveFile(filePath: string): Promise<void> {
    try {
      await fs.rm(filePath, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }

  private verifyReceiptStructurally(receipt: unknown, useRealZkVM: boolean): boolean {
    try {
      const { kind, data } = this.describeReceipt(receipt);
      const isDevMode = process.env.RISC0_DEV_MODE === '1' || process.env.FORCE_DEV_MODE === 'true';

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

          if (useRealZkVM && isDevMode) {
            console.warn('[STARK Verifier] Real zkVM requested but RISC0_DEV_MODE=1; treating receipt as dev-mode.');
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

    if (parsed.mock === true) {
      return { kind: 'mock', data: parsed };
    }

    if (typeof parsed.seal === 'string' && typeof parsed.journal === 'string') {
      let sealLength: number | undefined;
      try {
        sealLength = Buffer.from(parsed.seal, 'base64').length;
      } catch {
        // ignore base64 errors here; verification will handle it
      }
      return { kind: 'modern', data: parsed, sealLength };
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
        const status = result.passed ? '✅' : '❌';
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
        if (result.details.verificationExecutionId) {
          report += `- Verification executionId: ${result.details.verificationExecutionId}\n`;
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
      const status = result.passed ? '✅' : '❌';
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
      if (result.details.verificationExecutionId) {
        report += `   Verification executionId: ${result.details.verificationExecutionId}\n`;
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
