import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import type { VerificationResultRecord } from '@stark-ballot/application/finalize/finalization-result-store';
import type { Result } from '@stark-ballot/application';
import type {
  SessionVoteMutation,
  SessionVoteCommand,
} from '@stark-ballot/application/session/session-mutation-policy';
import type { SessionVoteStoreError } from '@stark-ballot/application/session/session-vote-store';
import type { AddVoteResult, UserVoteCommand, BotVoteCommand } from '@stark-ballot/domain/types/sessionRecords';
import type { FinalizationId, FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import type { AwsVerificationDeliveryMetadataInput } from '../finalize/finalizationDeliveryMetadataStore';
import { prepareUserVoteWrite, prepareBotVoteWrite, type PreparedVoteWrite } from './session-vote-writes';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type { FinalizationTransitionCommand } from '@stark-ballot/application/finalize/finalization-transition-policy';
import {
  FINALIZATION_QUEUED_PAYLOAD_KEYS,
  FINALIZATION_RUNNING_PAYLOAD_KEYS,
  FINALIZATION_SUCCEEDED_PAYLOAD_KEYS,
  FINALIZATION_FAILED_PAYLOAD_KEYS,
  FINALIZATION_TIMED_OUT_PAYLOAD_KEYS,
  assertAllowedFinalizationPayloadKeys,
  buildFinalizationCommand,
  type FinalizationQueuedPayload,
  type FinalizationRunningPayload,
  type FinalizationSucceededPayload,
  type FinalizationFailedPayload,
  type FinalizationTimedOutPayload,
  type SuccessfulFinalizationCommitInput,
  type SuccessfulFinalizationCommitResult,
} from '@stark-ballot/application/finalize/finalization-store';
import {
  assertDirectSuccessfulFinalizationPayload,
  type SuccessfulFinalizationRecord,
  prepareDirectSuccessfulFinalization,
} from '@stark-ballot/application/finalize/successful-finalization-commit-admission';
import {
  assertNoAwsRuntimeTransitionMetadata,
  admitAwsSuccessInput,
  prepareMappedAwsSuccessfulCommit,
  retainedStateBeforeAwsSuccess,
  type AdmittedAwsSuccessInput,
  type AwsFinalizationSucceededPayload,
  type AwsSucceededTransitionMetadata,
} from '../finalize/finalizationRuntimeStore';

export type VerificationWriteMode = 'start' | 'complete';

/** Shared session commands; adapters own mutation timing, locking, CAS and durable publication. */
export abstract class SessionCommandStore {
  protected abstract applyFinalizationCommand(
    command: FinalizationTransitionCommand,
    observability?: FinalizationQueuedPayload['observability'],
  ): Promise<{ record: FinalizationRecord }> | { record: FinalizationRecord };
  abstract getCurrentFinalizationRecord(sessionId: SessionId): Promise<FinalizationRecord | null>;
  abstract commitSuccessfulFinalization(
    input: SuccessfulFinalizationCommitInput,
  ): Promise<SuccessfulFinalizationCommitResult>;

  protected abstract writeVerificationResult(
    sessionId: SessionId,
    finalizationId: FinalizationId,
    verificationResult: VerificationResult,
    mode: VerificationWriteMode,
  ): Promise<VerificationResultRecord>;

  async markVerificationRunning(
    sessionId: SessionId,
    finalizationId: FinalizationId,
  ): Promise<VerificationResultRecord> {
    return this.writeVerificationResult(sessionId, finalizationId, { status: 'running' }, 'start');
  }

  async completeVerificationResult(
    sessionId: SessionId,
    finalizationId: FinalizationId,
    verificationResult: VerificationResult,
  ): Promise<VerificationResultRecord> {
    return this.writeVerificationResult(sessionId, finalizationId, verificationResult, 'complete');
  }

  async markAwsFinalizationSucceeded(
    sessionId: SessionId,
    payload: AwsFinalizationSucceededPayload,
  ): Promise<FinalizationState> {
    const input = admitAwsSuccessInput(payload);
    const current = await this.getCurrentFinalizationRecord(sessionId);
    return this.commitAwsSuccess(sessionId, input, current);
  }

  protected async commitAwsSuccess(
    sessionId: SessionId,
    input: AdmittedAwsSuccessInput,
    current: FinalizationRecord | null,
  ): Promise<FinalizationState> {
    const retained = retainedStateBeforeAwsSuccess(current, input.payload.finalizationId);
    if (retained) return retained;
    const committed = await this.commitSuccessfulFinalization(this.prepareAwsSuccessCommit(sessionId, input, current));
    return committed.record.state;
  }

  protected prepareAwsSuccessCommit(
    sessionId: SessionId,
    input: AdmittedAwsSuccessInput,
    current: FinalizationRecord | null,
  ) {
    return prepareMappedAwsSuccessfulCommit(
      sessionId,
      input.semanticPayload,
      current,
      input.stepFunctionsArn,
      input.bundleMetadata,
    );
  }

  protected async publishDirectFinalization(
    record: SuccessfulFinalizationRecord,
    payload: Pick<FinalizationSucceededPayload, 'observability'>,
  ): Promise<FinalizationRecord> {
    const committed = await this.commitSuccessfulFinalization({
      record,
      bitmap: { availability: 'unavailable' },
      ...(payload.observability ? { observability: payload.observability } : {}),
    });
    return committed.record;
  }

  protected abstract mutateVotes<T>(
    sessionId: SessionId,
    command: SessionVoteCommand,
    prepareWrite: (mutation: SessionVoteMutation) => PreparedVoteWrite<T>,
  ): Promise<Result<T, SessionVoteStoreError>>;

  abstract recordAwsProofBundlePublication(
    sessionId: SessionId,
    finalizationId: FinalizationId,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void>;

  addVote(sessionId: SessionId, voteData: UserVoteCommand): Promise<Result<AddVoteResult, SessionVoteStoreError>> {
    return this.mutateVotes(sessionId, { kind: 'append_user_vote', vote: voteData }, prepareUserVoteWrite);
  }

  addBotVotes(sessionId: SessionId, votes: readonly BotVoteCommand[]): Promise<Result<void, SessionVoteStoreError>> {
    return this.mutateVotes(sessionId, { kind: 'append_bot_votes', votes }, prepareBotVoteWrite);
  }

  recordAwsVerificationDeliveryMetadata(
    sessionId: SessionId,
    finalizationId: FinalizationId,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void> {
    return this.recordAwsProofBundlePublication(sessionId, finalizationId, metadata);
  }

  async markFinalizationQueued(sessionId: SessionId, payload: FinalizationQueuedPayload): Promise<FinalizationRecord> {
    assertAllowedFinalizationPayloadKeys(payload, FINALIZATION_QUEUED_PAYLOAD_KEYS, 'queued finalization');
    return (
      await this.applyFinalizationCommand(buildFinalizationCommand(sessionId, 'queue', payload), payload.observability)
    ).record;
  }

  async markFinalizationRunning(
    sessionId: SessionId,
    payload: FinalizationRunningPayload,
  ): Promise<FinalizationRecord> {
    assertAllowedFinalizationPayloadKeys(payload, FINALIZATION_RUNNING_PAYLOAD_KEYS, 'running finalization');
    assertNoAwsRuntimeTransitionMetadata(payload as AwsSucceededTransitionMetadata);
    return (
      await this.applyFinalizationCommand(buildFinalizationCommand(sessionId, 'start', payload), payload.observability)
    ).record;
  }

  async markFinalizationSucceeded(
    sessionId: SessionId,
    payload: FinalizationSucceededPayload,
  ): Promise<FinalizationRecord> {
    assertAllowedFinalizationPayloadKeys(payload, FINALIZATION_SUCCEEDED_PAYLOAD_KEYS, 'succeeded finalization');
    assertNoAwsRuntimeTransitionMetadata(payload as AwsSucceededTransitionMetadata);
    assertDirectSuccessfulFinalizationPayload(payload);
    const current = await this.getCurrentFinalizationRecord(sessionId);
    const prepared = prepareDirectSuccessfulFinalization(sessionId, payload, current, Date.now());
    if (prepared.kind === 'transition')
      return (await this.applyFinalizationCommand(prepared.command, payload.observability)).record;
    return this.publishDirectFinalization(prepared.record, payload);
  }

  async markFinalizationFailed(sessionId: SessionId, payload: FinalizationFailedPayload): Promise<FinalizationRecord> {
    assertAllowedFinalizationPayloadKeys(payload, FINALIZATION_FAILED_PAYLOAD_KEYS, 'failed finalization');
    assertNoAwsRuntimeTransitionMetadata(payload as AwsSucceededTransitionMetadata);
    return (
      await this.applyFinalizationCommand(buildFinalizationCommand(sessionId, 'fail', payload), payload.observability)
    ).record;
  }

  async markFinalizationTimedOut(
    sessionId: SessionId,
    payload: FinalizationTimedOutPayload,
  ): Promise<FinalizationRecord> {
    assertAllowedFinalizationPayloadKeys(payload, FINALIZATION_TIMED_OUT_PAYLOAD_KEYS, 'timed-out finalization');
    assertNoAwsRuntimeTransitionMetadata(payload as AwsSucceededTransitionMetadata);
    return (
      await this.applyFinalizationCommand(
        buildFinalizationCommand(sessionId, 'time_out', payload),
        payload.observability,
      )
    ).record;
  }
}
