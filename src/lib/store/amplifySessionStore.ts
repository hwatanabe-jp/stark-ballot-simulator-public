import type { SignatureV4 } from '@smithy/signature-v4';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createAppSyncSigner, signedAppSyncFetch } from '@/lib/aws/appsyncSignedFetch';
import { resolveAppSyncRegion } from '@/lib/aws/appsyncRegionResolver';
import { generateVoteId } from '@/lib/vote/voteId';
import { createElectionId } from '@/lib/zkvm/types';
import { buildDefaultElectionConfig, getDefaultElectionConfigHash } from '@/lib/zkvm/election-config';
import { generateLogId } from '@/lib/zkvm/log-id';
import { normalizeHex } from '@/lib/utils/hex';
import { logger } from '@/lib/utils/logger';
import { encryptVoteSecret } from '@/lib/security/voteSecretCipher';
import type { SessionSummary, VoteStore } from '@/types/voteStore';
import type {
  AddVoteResult,
  SessionData,
  VoteData,
  RootSnapshot,
  FinalizationResult,
  FinalizationResultAuthority,
  FinalizationState,
} from '@/types/server';
import {
  CREATE_SESSION_MUTATION,
  UPDATE_SESSION_MUTATION,
  GET_SESSION_QUERY,
  LIST_VOTING_SESSIONS_QUERY,
  LIST_VOTES_BY_SESSION_QUERY,
  LIST_VOTES_BY_ID_QUERY,
  CREATE_VOTE_MUTATION,
  type AmplifySessionRecord,
  type AmplifyVoteRecord,
  type GraphQLResponse,
  type ListVotesPage,
  type ListVoteLookupPage,
} from '@/lib/store/amplify/graphql';
import { buildSessionDataFromRecords, buildSessionSummaryFromRecord } from '@/lib/store/amplify/sessionBuilder';
import {
  parseStoredFinalizationEnvelope,
  parseStoredFinalizationPayload,
  serializeFinalizationPayload,
} from '@/lib/store/amplify/finalization';
import { applyVoteToSession, buildTimestamp, formatVoteData } from '@/lib/store/amplify/sessionUtils';
import { stageCtVoteWrites } from '@/lib/store/stagedCtWrite';
import {
  applyCanonicalCtSessionProjection,
  assertCanonicalUserVoteIndexForBotVotes,
  buildCanonicalCtSessionProjection,
} from '@/lib/store/ctSessionState';
import { canonicalizeFinalizationResult, updateFinalizationResultBitmapData } from '@/lib/finalize/finalization-result';
import { deriveExactCtProof, type ExactCtProof } from '@/lib/store/ct-proof';
import {
  assertAdmissibleFinalizationArtifactPatch,
  assertWritableFinalizationArtifact,
  assertWritableBitmapSidecarOwner,
  buildFailClosedFinalizationState,
  canRecoverFinalizationArtifactWithPatch,
  isFinalizationBranchPatch,
  isUnsupportedCurrentFinalizationState,
  resolveFailClosedFinalizationArtifactState,
} from '@/lib/store/finalizationArtifactAdmission';
import {
  buildUnsupportedCurrentArtifactDetails,
  classifyAuthoritativeWriteContract,
  hasSessionFinalizationBranch,
  isFailClosedCurrentArtifactState,
  isRecoverableCurrentLiveSession,
  UnsupportedCurrentArtifactBoundaryError,
  resolveAuthoritativeWriteContractGeneration,
  resolveCurrentContractGeneration,
} from '@/lib/contract';

export class AmplifySessionStore implements VoteStore {
  private readonly endpointUrl: URL;
  private readonly ttlSeconds: number;
  private readonly verificationTtlSeconds: number;
  private readonly region?: string;
  private sigV4Signer: SignatureV4 | null = null;

  constructor() {
    const endpoint = process.env.AMPLIFY_DATA_ENDPOINT;
    if (!endpoint) {
      throw new Error(
        'AMPLIFY_DATA_ENDPOINT is not defined. Set this environment variable to the Amplify Data GraphQL endpoint.',
      );
    }
    this.endpointUrl = new URL(endpoint);
    this.region = resolveAppSyncRegion(this.endpointUrl);
    const ttlEnv = process.env.AMPLIFY_DATA_TTL_SECONDS;
    const ttlParsed = ttlEnv ? Number(ttlEnv) : 1800;
    this.ttlSeconds = Number.isFinite(ttlParsed) && ttlParsed > 0 ? ttlParsed : 1800;

    const verificationTtlEnv = process.env.AMPLIFY_DATA_VERIFICATION_TTL_SECONDS;
    const verificationParsed = verificationTtlEnv ? Number(verificationTtlEnv) : 86400;
    const verificationSeconds =
      Number.isFinite(verificationParsed) && verificationParsed > 0 ? verificationParsed : 86400;
    this.verificationTtlSeconds = Math.max(this.ttlSeconds, verificationSeconds);
  }

  async createSession(): Promise<SessionData> {
    const sessionId = generateVoteId(); // reuse UUID format
    const electionId = createElectionId();
    const electionConfig = buildDefaultElectionConfig();
    const electionConfigHash = getDefaultElectionConfigHash();
    const logId = generateLogId(`amplify-${sessionId}`);
    const now = buildTimestamp();

    const ttl = Math.floor(now / 1000) + this.ttlSeconds;
    const input: Record<string, unknown> = {
      id: sessionId,
      electionId,
      contractGeneration: resolveCurrentContractGeneration(),
      electionConfigHash,
      electionConfigJson: JSON.stringify(electionConfig),
      logId,
      botCount: 0,
      finalized: false,
      userVoteIndex: null,
      ttl,
      createdAt: new Date(now).toISOString(),
      lastActivity: new Date(now).toISOString(),
      finalizationResultJson: null,
      bulletinRootHistoryJson: JSON.stringify([]),
    };

    await this.execute(CREATE_SESSION_MUTATION, { input });

    const sessionData = await this.buildSessionData(
      {
        id: sessionId,
        electionId,
        contractGeneration: resolveCurrentContractGeneration(),
        electionConfigHash,
        electionConfigJson: electionConfig,
        logId,
        botCount: 0,
        finalized: false,
        userVoteIndex: undefined,
        ttl,
        createdAt: now,
        lastActivity: now,
        finalizationResultJson: undefined,
        bulletinRootHistoryJson: JSON.stringify([]),
      },
      [],
    );
    return sessionData;
  }

  private hasContractGenerationMismatch(session: SessionData, contractGeneration: string | undefined): boolean {
    return (
      classifyAuthoritativeWriteContract({
        persistedContractGeneration: resolveAuthoritativeWriteContractGeneration(session),
        carriedContractGeneration: contractGeneration,
      }) !== 'supported'
    );
  }

  private buildFailClosedCurrentState(
    session: SessionData,
    payload: {
      executionId: string;
      queuedAt: number;
      contractGeneration?: string;
      startedAt?: number;
      stepFunctionsArn?: string;
    },
    artifactState: NonNullable<SessionData['finalizationArtifactState']> = 'unsupported_current_artifact',
  ): FinalizationState {
    return buildFailClosedFinalizationState(session, payload, artifactState, buildTimestamp());
  }

  private resolveFinalizationPayloadContractGeneration(
    session: SessionData | null | undefined,
    willPersistFinalizationBranch: boolean,
    carriedContractGeneration?: string | null,
  ): string | undefined {
    const explicitContractGeneration =
      typeof carriedContractGeneration === 'string' && carriedContractGeneration.trim().length > 0
        ? carriedContractGeneration
        : undefined;

    if (explicitContractGeneration) {
      return explicitContractGeneration;
    }

    if (!session) {
      return undefined;
    }

    if (hasSessionFinalizationBranch(session)) {
      return session.finalizationContractGeneration ?? undefined;
    }

    return willPersistFinalizationBranch ? (session.contractGeneration ?? undefined) : undefined;
  }

  private requireFinalizationPayloadContractGeneration(
    session: SessionData | null | undefined,
    willPersistFinalizationBranch: boolean,
    carriedContractGeneration?: string | null,
  ): string {
    const contractGeneration = this.resolveFinalizationPayloadContractGeneration(
      session,
      willPersistFinalizationBranch,
      carriedContractGeneration,
    );
    if (typeof contractGeneration !== 'string' || contractGeneration.trim().length === 0) {
      throw new Error('Finalization writes require an explicit contractGeneration');
    }
    return contractGeneration;
  }

  private resolvePersistedArtifactContractGeneration(session: SessionData): string | undefined {
    const contractGeneration = resolveAuthoritativeWriteContractGeneration(session);
    return typeof contractGeneration === 'string' && contractGeneration.trim().length > 0
      ? contractGeneration
      : undefined;
  }

  private async persistArtifactTombstone(
    sessionId: string,
    session: SessionData,
    options: {
      artifactState: NonNullable<SessionData['finalizationArtifactState']>;
      finalizationState?: SessionData['finalizationState'] | null;
      finalizationResult?: SessionData['finalizationResult'] | null;
      finalizationScenarioContext?: SessionData['finalizationScenarioContext'] | null;
    },
  ): Promise<void> {
    const input: Record<string, unknown> = {
      id: sessionId,
      finalizationArtifactState: options.artifactState,
    };
    const hydratedResult =
      options.finalizationResult !== undefined ? options.finalizationResult : (session.finalizationResult ?? null);
    const hydratedState =
      options.finalizationState !== undefined ? options.finalizationState : (session.finalizationState ?? null);
    const hydratedContext =
      options.finalizationScenarioContext !== undefined
        ? options.finalizationScenarioContext
        : (session.finalizationScenarioContext ?? null);
    const willPersistFinalizationBranch = hydratedResult !== null || hydratedState !== null || hydratedContext !== null;
    const persistedContractGeneration = this.resolvePersistedArtifactContractGeneration(session);

    if (willPersistFinalizationBranch && persistedContractGeneration) {
      input.finalizationResultJson = this.serializeFinalizationPayload(
        hydratedResult,
        hydratedState,
        persistedContractGeneration,
        hydratedContext,
      );
    } else if (willPersistFinalizationBranch) {
      input.finalizationResultJson = null;
    }

    await this.execute(UPDATE_SESSION_MUTATION, { input });
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    const data = await this.execute<{
      getVotingSession: AmplifySessionRecord | null;
    }>(GET_SESSION_QUERY, { id: sessionId });

    const sessionRecord = data.getVotingSession;
    if (!sessionRecord) {
      return null;
    }

    const votes = await this.listVotes(sessionId);
    return await this.buildSessionData(sessionRecord, votes);
  }

  async getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
    const data = await this.execute<{
      getVotingSession: AmplifySessionRecord | null;
    }>(GET_SESSION_QUERY, { id: sessionId });

    const sessionRecord = data.getVotingSession;
    if (!sessionRecord) {
      return null;
    }

    const votes = await this.listVotes(sessionId);
    return buildSessionSummaryFromRecord(sessionId, sessionRecord, votes);
  }

  async addVote(sessionId: string, voteData: VoteData): Promise<AddVoteResult> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.finalized) {
      throw new Error('Session already finalized');
    }
    if (!isRecoverableCurrentLiveSession(session)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const voteIndex = session.votes.size;
    const formattedVote = formatVoteData(session, { ...voteData });
    const updatedSession = applyVoteToSession(session, voteIndex, formattedVote);

    const updatedVote = updatedSession.votes.get(voteIndex);
    const resolvedRootAtCast = updatedVote?.rootAtCast ?? formattedVote.rootAtCast;
    if (!resolvedRootAtCast) {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }
    const isUserVote = voteIndex === updatedSession.userVoteIndex;

    const voteInput = {
      id: formattedVote.voteId,
      sessionId,
      voteIndex,
      choice: encryptVoteSecret(formattedVote.vote),
      random: encryptVoteSecret(formattedVote.rand),
      commitment: formattedVote.commit,
      timestamp: new Date(formattedVote.timestamp ?? buildTimestamp()).toISOString(),
      rootAtCast: resolvedRootAtCast,
      isUserVote,
    };

    await this.execute(CREATE_VOTE_MUTATION, { input: voteInput });

    await this.persistSessionMetadata(sessionId, {
      botCount: updatedSession.botCount,
      userVoteIndex: updatedSession.userVoteIndex,
      bulletinRootHistory: updatedSession.bulletinRootHistory ?? [],
    });

    if (!updatedSession.bulletin || !formattedVote.voteId) {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }

    let ctProof;
    try {
      const ctTreeSize = voteIndex + 1;
      ctProof = updatedSession.bulletin.getInclusionProof(formattedVote.voteId, ctTreeSize);
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        logger.warn('[AmplifyStore] CT proof derivation failed', {
          voteId: formattedVote.voteId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      throw new Error('CT_PROOF_UNAVAILABLE');
    }

    if (!ctProof) {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }

    const merklePath = ctProof.proofNodes.map((node) => normalizeHex(node, { allowEmpty: true }));

    return {
      leafIndex: voteIndex,
      merklePath,
      bulletinRootAtCast: resolvedRootAtCast,
    };
  }

  async addBotVotes(sessionId: string, votes: VoteData[]): Promise<void> {
    if (votes.length === 0) {
      return;
    }

    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.finalized) {
      throw new Error('Session already finalized');
    }
    if (!isRecoverableCurrentLiveSession(session)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!session.electionId) {
      throw new Error('Session missing electionId');
    }

    const canonicalProjection = buildCanonicalCtSessionProjection(session, 'AmplifySessionStore');
    if (session.botCount !== canonicalProjection.botCount) {
      logger.warn('[AmplifySessionStore] Reconciled stale botCount before appending bot votes', {
        sessionId,
        persistedBotCount: session.botCount,
        derivedBotCount: canonicalProjection.botCount,
      });
    }
    if (session.userVoteIndex !== canonicalProjection.userVoteIndex) {
      logger.warn('[AmplifySessionStore] Reconciled stale userVoteIndex before appending bot votes', {
        sessionId,
        persistedUserVoteIndex: session.userVoteIndex,
        derivedUserVoteIndex: canonicalProjection.userVoteIndex,
      });
    }
    applyCanonicalCtSessionProjection(session, canonicalProjection);
    assertCanonicalUserVoteIndexForBotVotes(session.votes, session.userVoteIndex);

    const stagedInputs = votes.map((voteData, offset) => {
      const voteIndex = canonicalProjection.nextIndex + offset;
      const formattedVote = formatVoteData(session, { ...voteData });
      if (!formattedVote.voteId) {
        throw new Error('Vote ID missing after formatting');
      }
      return { index: voteIndex, vote: formattedVote };
    });
    const stagedWrites = stageCtVoteWrites(session, stagedInputs);

    let persistedVotes = 0;

    try {
      for (const stagedWrite of stagedWrites.votes) {
        const storedVote = stagedWrite.storedVote;
        await this.execute(CREATE_VOTE_MUTATION, {
          input: {
            id: stagedWrite.voteId,
            sessionId,
            voteIndex: stagedWrite.index,
            choice: encryptVoteSecret(storedVote.vote),
            random: encryptVoteSecret(storedVote.rand),
            commitment: storedVote.commit,
            timestamp: new Date(storedVote.timestamp ?? buildTimestamp()).toISOString(),
            rootAtCast: storedVote.rootAtCast,
            isUserVote: stagedWrite.index === session.userVoteIndex,
          },
        });
        persistedVotes += 1;
      }
    } catch (error) {
      if (persistedVotes > 0) {
        try {
          await this.persistBotVoteCheckpoint(sessionId, session, stagedWrites.bulletin, persistedVotes);
        } catch (checkpointError) {
          const createVoteMessage = error instanceof Error ? error.message : String(error);
          const checkpointMessage =
            checkpointError instanceof Error ? checkpointError.message : String(checkpointError);
          throw new Error(
            `Bot vote checkpoint failed after ${persistedVotes} successful writes: ${createVoteMessage}; checkpoint: ${checkpointMessage}`,
          );
        }
      }
      throw error;
    }

    await this.persistBotVoteCheckpoint(sessionId, session, stagedWrites.bulletin, persistedVotes);
  }

  private buildBulletinRootHistoryCheckpoint(
    session: SessionData,
    bulletin: NonNullable<SessionData['bulletin']>,
    persistedVotes: number,
  ): RootSnapshot[] {
    return bulletin
      .getRootHistory()
      .slice(0, session.votes.size + persistedVotes)
      .map((snapshot) => ({
        timestamp: snapshot.timestamp,
        root: normalizeHex(snapshot.root, { allowEmpty: true }),
        treeSize: snapshot.treeSize,
        signature: snapshot.signature,
      }));
  }

  private async persistBotVoteCheckpoint(
    sessionId: string,
    session: SessionData,
    bulletin: NonNullable<SessionData['bulletin']>,
    persistedVotes: number,
  ): Promise<void> {
    const botCount = session.botCount + persistedVotes;
    const bulletinRootHistory = this.buildBulletinRootHistoryCheckpoint(session, bulletin, persistedVotes);
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.persistSessionMetadata(
          sessionId,
          {
            botCount,
            userVoteIndex: session.userVoteIndex,
            bulletinRootHistory,
          },
          session,
        );
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          logger.warn('[AmplifySessionStore] Retrying bot vote checkpoint after metadata persistence failure', {
            sessionId,
            persistedVotes,
            attempt,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Failed to persist bot vote checkpoint');
  }

  async updateSession(sessionId: string, data?: Partial<SessionData>): Promise<SessionData | void> {
    if (!data) {
      return;
    }

    await this.persistSessionMetadata(sessionId, {
      botCount: data.botCount,
      userVoteIndex: data.userVoteIndex,
      electionConfig: data.electionConfig,
      finalized: data.finalized,
      finalizationResult: data.finalizationResult,
      finalizationState: data.finalizationState ?? undefined,
      finalizationScenarioContext: data.finalizationScenarioContext ?? undefined,
      finalizationContractGeneration: data.finalizationContractGeneration ?? undefined,
      finalizationArtifactState: data.finalizationArtifactState ?? undefined,
      bulletinRootHistory: data.bulletinRootHistory,
    });

    if (
      data.finalizationResult ||
      data.bulletinRootHistory ||
      data.finalized !== undefined ||
      data.finalizationContractGeneration !== undefined
    ) {
      const refreshed = await this.getSession(sessionId);
      return refreshed ?? undefined;
    }
  }

  async getActiveSessionCount(): Promise<number> {
    let nextToken: string | null | undefined;
    let count = 0;
    const nowSeconds = Math.floor(buildTimestamp() / 1000);

    do {
      const page = await this.execute<{
        listVotingSessions: {
          items: AmplifySessionRecord[] | null;
          nextToken?: string | null;
        };
      }>(LIST_VOTING_SESSIONS_QUERY, { nextToken });

      const items = page.listVotingSessions.items ?? [];
      for (const item of items) {
        const ttl = item.ttl ?? 0;
        const finalized = item.finalized ?? false;
        const envelope = parseStoredFinalizationEnvelope(item.finalizationResultJson);
        const payload = parseStoredFinalizationPayload(item.finalizationResultJson);
        if (
          ttl > nowSeconds &&
          isRecoverableCurrentLiveSession({
            finalized,
            contractGeneration: item.contractGeneration ?? undefined,
            hasPersistedFinalizationBranch: item.finalizationResultJson != null || finalized,
            finalizationContractGeneration: payload?.contractGeneration ?? envelope?.contractGeneration,
            finalizationArtifactState: isFailClosedCurrentArtifactState(item.finalizationArtifactState)
              ? item.finalizationArtifactState
              : undefined,
            finalizationResult: payload?.finalizationResult ?? undefined,
            finalizationState: payload?.finalizationState ?? undefined,
            finalizationScenarioContext: payload?.finalizationScenarioContext ?? undefined,
          })
        ) {
          count += 1;
        }
      }
      nextToken = page.listVotingSessions.nextToken;
    } while (nextToken);

    return count;
  }

  async finalizeSession(
    sessionId: string,
    result: FinalizationResultAuthority,
    contractGeneration: string,
  ): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    assertWritableFinalizationArtifact(session, contractGeneration);
    if (this.hasContractGenerationMismatch(session, contractGeneration)) {
      throw new UnsupportedCurrentArtifactBoundaryError(
        buildUnsupportedCurrentArtifactDetails(session, contractGeneration),
      );
    }
    assertAdmissibleFinalizationArtifactPatch(
      session,
      {
        finalized: true,
        finalizationResult: result,
        finalizationContractGeneration: contractGeneration,
      },
      contractGeneration,
    );
    await this.persistSessionMetadata(
      sessionId,
      {
        finalized: true,
        finalizationResult: result,
        finalizationContractGeneration: contractGeneration,
      },
      session,
    );
  }

  async markFinalizationQueued(
    sessionId: string,
    payload: {
      executionId: string;
      queuedAt: number;
      contractGeneration: string;
      scenarioContext?: SessionData['finalizationScenarioContext'] | null;
    },
  ): Promise<FinalizationState> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const artifactState = resolveFailClosedFinalizationArtifactState(session);
    if (artifactState) {
      const nextState = this.buildFailClosedCurrentState(session, payload, artifactState);
      await this.persistArtifactTombstone(sessionId, session, {
        artifactState,
        finalizationState: nextState,
        finalizationResult: session.finalizationResult ?? null,
        finalizationScenarioContext: payload.scenarioContext ?? session.finalizationScenarioContext ?? null,
      });
      return nextState;
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      const nextState = this.buildFailClosedCurrentState(session, payload);
      await this.persistArtifactTombstone(sessionId, session, {
        artifactState: 'unsupported_current_artifact',
        finalizationState: nextState,
        finalizationResult: session.finalizationResult ?? null,
        finalizationScenarioContext: payload.scenarioContext ?? session.finalizationScenarioContext ?? null,
      });
      return nextState;
    }
    if (session.finalizationState && session.finalizationState.executionId !== payload.executionId) {
      return session.finalizationState;
    }
    assertWritableFinalizationArtifact(session, payload.contractGeneration);

    const nextState: FinalizationState = {
      status: 'pending',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
    };

    await this.persistSessionMetadata(
      sessionId,
      {
        finalizationState: nextState,
        finalizationResult: session.finalizationResult ?? null,
        finalizationScenarioContext: payload.scenarioContext ?? session.finalizationScenarioContext ?? null,
        finalizationContractGeneration: payload.contractGeneration,
      },
      session,
    );

    return nextState;
  }

  async markFinalizationRunning(
    sessionId: string,
    payload: {
      executionId: string;
      queuedAt: number;
      startedAt: number;
      contractGeneration: string;
      stepFunctionsArn?: string;
      scenarioContext?: SessionData['finalizationScenarioContext'] | null;
    },
  ): Promise<FinalizationState> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const artifactState = resolveFailClosedFinalizationArtifactState(session);
    if (artifactState) {
      const nextState = this.buildFailClosedCurrentState(session, payload, artifactState);
      await this.persistArtifactTombstone(sessionId, session, {
        artifactState,
        finalizationState: nextState,
        finalizationResult: session.finalizationResult ?? null,
        finalizationScenarioContext: payload.scenarioContext ?? session.finalizationScenarioContext ?? null,
      });
      return nextState;
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      const nextState = this.buildFailClosedCurrentState(session, payload);
      await this.persistArtifactTombstone(sessionId, session, {
        artifactState: 'unsupported_current_artifact',
        finalizationState: nextState,
        finalizationResult: session.finalizationResult ?? null,
        finalizationScenarioContext: payload.scenarioContext ?? session.finalizationScenarioContext ?? null,
      });
      return nextState;
    }
    if (session.finalizationState && session.finalizationState.executionId !== payload.executionId) {
      return session.finalizationState;
    }
    assertWritableFinalizationArtifact(session, payload.contractGeneration);

    const nextState: FinalizationState = {
      status: 'running',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      startedAt: payload.startedAt,
      stepFunctionsArn: payload.stepFunctionsArn,
    };

    await this.persistSessionMetadata(
      sessionId,
      {
        finalizationState: nextState,
        finalizationResult: session.finalizationResult ?? null,
        finalizationScenarioContext: payload.scenarioContext ?? session.finalizationScenarioContext ?? null,
        finalizationContractGeneration: payload.contractGeneration,
      },
      session,
    );

    return nextState;
  }

  async markFinalizationSucceeded(
    sessionId: string,
    payload: {
      executionId: string;
      queuedAt: number;
      startedAt: number;
      completedAt: number;
      contractGeneration: string;
      bundleMetadata?: Extract<FinalizationState, { status: 'succeeded' }>['bundleMetadata'];
      stepFunctionsArn?: string;
      finalizationResult: FinalizationResultAuthority;
    },
  ): Promise<FinalizationState> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const artifactState = resolveFailClosedFinalizationArtifactState(session);
    if (artifactState) {
      const nextState = this.buildFailClosedCurrentState(session, payload, artifactState);
      await this.persistArtifactTombstone(sessionId, session, {
        artifactState,
        finalizationState: nextState,
        finalizationResult: session.finalizationResult ?? null,
      });
      return nextState;
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      const nextState = this.buildFailClosedCurrentState(session, payload);
      await this.persistArtifactTombstone(sessionId, session, {
        artifactState: 'unsupported_current_artifact',
        finalizationState: nextState,
        finalizationResult: session.finalizationResult ?? null,
      });
      return nextState;
    }
    if (session.finalizationState && session.finalizationState.executionId !== payload.executionId) {
      return session.finalizationState;
    }
    assertWritableFinalizationArtifact(session, payload.contractGeneration);

    const nextState: FinalizationState = {
      status: 'succeeded',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      startedAt: payload.startedAt,
      completedAt: payload.completedAt,
      bundleMetadata: payload.bundleMetadata,
      stepFunctionsArn: payload.stepFunctionsArn,
    };
    assertAdmissibleFinalizationArtifactPatch(
      session,
      {
        finalized: true,
        finalizationState: nextState,
        finalizationResult: payload.finalizationResult,
        finalizationContractGeneration: payload.contractGeneration,
      },
      payload.contractGeneration,
    );

    await this.persistSessionMetadata(
      sessionId,
      {
        finalized: true,
        finalizationState: nextState,
        finalizationResult: payload.finalizationResult,
        finalizationContractGeneration: payload.contractGeneration,
      },
      session,
    );

    return nextState;
  }

  async markFinalizationFailed(
    sessionId: string,
    payload: {
      executionId: string;
      queuedAt: number;
      startedAt?: number;
      failedAt: number;
      contractGeneration: string;
      error: Extract<FinalizationState, { status: 'failed' }>['error'];
      stepFunctionsArn?: string;
    },
  ): Promise<FinalizationState> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const artifactState = resolveFailClosedFinalizationArtifactState(session);
    if (artifactState) {
      const nextState = this.buildFailClosedCurrentState(session, payload, artifactState);
      await this.persistArtifactTombstone(sessionId, session, {
        artifactState,
        finalizationState: nextState,
        finalizationResult: session.finalizationResult ?? null,
      });
      return nextState;
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      const nextState = this.buildFailClosedCurrentState(session, payload);
      await this.persistArtifactTombstone(sessionId, session, {
        artifactState: 'unsupported_current_artifact',
        finalizationState: nextState,
        finalizationResult: session.finalizationResult ?? null,
      });
      return nextState;
    }
    if (session.finalizationState && session.finalizationState.executionId !== payload.executionId) {
      return session.finalizationState;
    }
    assertWritableFinalizationArtifact(session, payload.contractGeneration);

    const nextState: FinalizationState = {
      status: 'failed',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      startedAt: payload.startedAt,
      failedAt: payload.failedAt,
      error: payload.error,
      stepFunctionsArn: payload.stepFunctionsArn,
    };

    await this.persistSessionMetadata(
      sessionId,
      {
        finalizationState: nextState,
        finalizationResult: session.finalizationResult ?? null,
        finalizationContractGeneration: payload.contractGeneration,
      },
      session,
    );

    return nextState;
  }

  async markFinalizationTimedOut(
    sessionId: string,
    payload: {
      executionId: string;
      queuedAt: number;
      startedAt?: number;
      timeoutAt: number;
      contractGeneration: string;
      stepFunctionsArn?: string;
    },
  ): Promise<FinalizationState> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const artifactState = resolveFailClosedFinalizationArtifactState(session);
    if (artifactState) {
      const nextState = this.buildFailClosedCurrentState(session, payload, artifactState);
      await this.persistArtifactTombstone(sessionId, session, {
        artifactState,
        finalizationState: nextState,
        finalizationResult: session.finalizationResult ?? null,
      });
      return nextState;
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      const nextState = this.buildFailClosedCurrentState(session, payload);
      await this.persistArtifactTombstone(sessionId, session, {
        artifactState: 'unsupported_current_artifact',
        finalizationState: nextState,
        finalizationResult: session.finalizationResult ?? null,
      });
      return nextState;
    }
    if (session.finalizationState && session.finalizationState.executionId !== payload.executionId) {
      return session.finalizationState;
    }
    assertWritableFinalizationArtifact(session, payload.contractGeneration);

    const nextState: FinalizationState = {
      status: 'timeout',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      startedAt: payload.startedAt,
      timeoutAt: payload.timeoutAt,
      stepFunctionsArn: payload.stepFunctionsArn,
    };

    await this.persistSessionMetadata(
      sessionId,
      {
        finalizationState: nextState,
        finalizationResult: session.finalizationResult ?? null,
        finalizationContractGeneration: payload.contractGeneration,
      },
      session,
    );

    return nextState;
  }

  async getVoteById(sessionId: string, voteId: string): Promise<{ voteData: VoteData; index: number } | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }
    for (const [index, vote] of session.votes.entries()) {
      if (vote.voteId === voteId) {
        return { voteData: vote, index };
      }
    }
    return null;
  }

  private async getPersistedVoteRecordById(voteId: string): Promise<AmplifyVoteRecord | null> {
    const vote = await this.execute<{ listVoteById: ListVoteLookupPage | null }>(LIST_VOTES_BY_ID_QUERY, {
      id: voteId,
    });
    return vote.listVoteById?.items[0] ?? null;
  }

  private async buildExactProofForPersistedVote(params: {
    sessionId: string;
    voteId: string;
    persistedVote: AmplifyVoteRecord;
    session?: SessionData;
  }): Promise<{
    voteData: VoteData;
    leafIndex: number;
    merklePath: string[];
    bulletinRootAtCast: string;
    treeSize: number;
  } | null> {
    const { sessionId, voteId, persistedVote } = params;
    const session = params.session ?? (await this.getSession(sessionId));
    if (!session) {
      return null;
    }

    const voteData = session.votes.get(persistedVote.voteIndex);
    if (!voteData || voteData.voteId !== voteId) {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }

    const exactCtProof: ExactCtProof = deriveExactCtProof({
      bulletin: session.bulletin,
      voteId,
      leafIndex: persistedVote.voteIndex,
      rootAtCast: persistedVote.rootAtCast ?? undefined,
    });

    return {
      voteData,
      ...exactCtProof,
    };
  }

  async getVoteByIdWithProof(
    sessionId: string,
    voteId: string,
  ): Promise<{
    voteData: VoteData;
    leafIndex: number;
    merklePath: string[];
    bulletinRootAtCast: string;
    treeSize: number;
  } | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    let sessionVoteIndex: number | undefined;
    for (const [index, vote] of session.votes.entries()) {
      if (vote.voteId === voteId) {
        sessionVoteIndex = index;
        break;
      }
    }

    if (sessionVoteIndex === undefined) {
      return null;
    }

    const persistedVote = await this.getPersistedVoteRecordById(voteId);
    if (!persistedVote || persistedVote.sessionId !== sessionId || persistedVote.voteIndex !== sessionVoteIndex) {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }
    return this.buildExactProofForPersistedVote({ sessionId, voteId, persistedVote, session });
  }

  async getVoteProof(voteId: string): Promise<{
    leafIndex: number;
    merklePath: string[];
    bulletinRootAtCast: string;
    treeSize: number;
  } | null> {
    const record = await this.getPersistedVoteRecordById(voteId);
    if (!record) {
      return null;
    }
    return this.buildExactProofForPersistedVote({
      sessionId: record.sessionId,
      voteId,
      persistedVote: record,
    });
  }

  async saveBitmapData(
    sessionId: string,
    bitmapData: {
      includedBitmap: boolean[];
      includedBitmapRoot: string;
      seenBitmap?: boolean[];
      seenBitmapRoot?: string;
      treeSize: number;
      finalizedAt: number;
    },
  ): Promise<void> {
    const session = await this.getSession(sessionId);
    assertWritableBitmapSidecarOwner(session);
    const finalizationResult = canonicalizeFinalizationResult(
      session.finalizationResult,
      session.finalizationScenarioContext,
    );
    if (!finalizationResult) {
      throw new Error('Session finalization wrapper is not available');
    }

    const nextResult = updateFinalizationResultBitmapData(finalizationResult, bitmapData);

    await this.persistSessionMetadata(
      sessionId,
      {
        finalizationResult: nextResult,
        finalized: true,
      },
      session,
    );
  }

  async getBitmapData(sessionId: string): Promise<{
    sessionId: string;
    includedBitmap: boolean[];
    includedBitmapRoot: string;
    seenBitmap?: boolean[];
    seenBitmapRoot?: string;
    treeSize: number;
    finalizedAt: number;
  } | null> {
    const session = await this.getSession(sessionId);
    const bitmapData = session?.finalizationResult?.bitmapData;
    if (!bitmapData) {
      return null;
    }

    return {
      sessionId,
      ...bitmapData,
      includedBitmap: [...bitmapData.includedBitmap],
      ...(bitmapData.seenBitmap ? { seenBitmap: [...bitmapData.seenBitmap] } : {}),
    };
  }

  private async persistSessionMetadata(
    sessionId: string,
    options: {
      botCount?: number;
      userVoteIndex?: number;
      electionConfig?: SessionData['electionConfig'];
      finalized?: boolean;
      finalizationResult?: SessionData['finalizationResult'] | null;
      finalizationState?: FinalizationState | null;
      finalizationScenarioContext?: SessionData['finalizationScenarioContext'] | null;
      finalizationContractGeneration?: SessionData['finalizationContractGeneration'] | null;
      finalizationArtifactState?: SessionData['finalizationArtifactState'] | null;
      bulletinRootHistory?: RootSnapshot[];
    },
    existingSession?: SessionData | null,
  ): Promise<void> {
    const needsBaseSession =
      existingSession !== undefined ||
      options.finalizationResult !== undefined ||
      options.finalizationState !== undefined ||
      options.finalizationScenarioContext !== undefined ||
      options.finalizationContractGeneration !== undefined ||
      options.finalizationArtifactState !== undefined;
    const baseSession =
      existingSession !== undefined ? existingSession : needsBaseSession ? await this.getSession(sessionId) : undefined;
    const effectiveFinalized = options.finalized ?? baseSession?.finalized ?? false;
    const ttlSeconds = effectiveFinalized ? this.verificationTtlSeconds : this.ttlSeconds;
    const now = buildTimestamp();

    const input: Record<string, unknown> = {
      id: sessionId,
      lastActivity: new Date(now).toISOString(),
      ttl: Math.floor(now / 1000) + ttlSeconds,
    };

    if (options.botCount !== undefined) {
      input.botCount = options.botCount;
    }
    if (options.userVoteIndex !== undefined) {
      input.userVoteIndex = options.userVoteIndex;
    }
    if (options.electionConfig !== undefined) {
      input.electionConfigJson = JSON.stringify(options.electionConfig);
    }
    if (options.finalized !== undefined) {
      input.finalized = options.finalized;
    }

    const finalizationPatch: Partial<SessionData> = {};
    if (options.finalized !== undefined) {
      finalizationPatch.finalized = options.finalized;
    }
    if (options.finalizationResult !== undefined) {
      finalizationPatch.finalizationResult = options.finalizationResult ?? undefined;
    }
    if (options.finalizationState !== undefined) {
      finalizationPatch.finalizationState = options.finalizationState ?? undefined;
    }
    if (options.finalizationScenarioContext !== undefined) {
      finalizationPatch.finalizationScenarioContext = options.finalizationScenarioContext ?? undefined;
    }
    if (options.finalizationContractGeneration !== undefined) {
      finalizationPatch.finalizationContractGeneration = options.finalizationContractGeneration ?? undefined;
    }
    if (options.finalizationArtifactState !== undefined) {
      finalizationPatch.finalizationArtifactState = options.finalizationArtifactState ?? undefined;
    }

    if (
      options.finalizationResult !== undefined ||
      options.finalizationState !== undefined ||
      options.finalizationScenarioContext !== undefined ||
      options.finalizationContractGeneration !== undefined
    ) {
      const repairingFailClosedArtifact =
        resolveFailClosedFinalizationArtifactState(baseSession) !== null &&
        isFinalizationBranchPatch(finalizationPatch) &&
        canRecoverFinalizationArtifactWithPatch(baseSession, finalizationPatch);
      if (!repairingFailClosedArtifact) {
        assertWritableFinalizationArtifact(baseSession);
      }
      const hydratedResult =
        options.finalizationResult !== undefined
          ? options.finalizationResult
          : (baseSession?.finalizationResult ?? null);

      const hydratedState =
        options.finalizationState !== undefined
          ? options.finalizationState
          : repairingFailClosedArtifact && isUnsupportedCurrentFinalizationState(baseSession?.finalizationState)
            ? null
            : (baseSession?.finalizationState ?? null);

      const hydratedContext =
        options.finalizationScenarioContext !== undefined
          ? options.finalizationScenarioContext
          : (baseSession?.finalizationScenarioContext ?? null);

      const willPersistFinalizationBranch =
        Boolean(options.finalized) || hydratedResult !== null || hydratedState !== null || hydratedContext !== null;
      let serialized: string | null = null;
      if (willPersistFinalizationBranch) {
        const contractGeneration = this.requireFinalizationPayloadContractGeneration(
          baseSession,
          willPersistFinalizationBranch,
          options.finalizationContractGeneration,
        );
        serialized = this.serializeFinalizationPayload(
          hydratedResult,
          hydratedState,
          contractGeneration,
          hydratedContext,
        );
      }
      input.finalizationResultJson = serialized;
      input.finalizationArtifactState = options.finalizationArtifactState ?? null;
    } else if (options.finalizationArtifactState !== undefined) {
      input.finalizationArtifactState = options.finalizationArtifactState;
    }
    if (options.bulletinRootHistory !== undefined) {
      input.bulletinRootHistoryJson = JSON.stringify(options.bulletinRootHistory);
    }
    await this.execute(UPDATE_SESSION_MUTATION, { input });
  }

  protected serializeFinalizationPayload(
    result: FinalizationResultAuthority | FinalizationResult | null | undefined,
    state: FinalizationState | null | undefined,
    contractGeneration: string,
    scenarioContext?: SessionData['finalizationScenarioContext'] | null,
  ): string | null {
    return serializeFinalizationPayload(result, state, contractGeneration, scenarioContext);
  }

  protected async buildSessionData(session: AmplifySessionRecord, votes: AmplifyVoteRecord[]): Promise<SessionData> {
    return buildSessionDataFromRecords(session, votes);
  }

  private async listVotes(sessionId: string): Promise<AmplifyVoteRecord[]> {
    let nextToken: string | null | undefined;
    const votes: AmplifyVoteRecord[] = [];

    do {
      const response = await this.execute<{
        listVoteBySessionIdAndVoteIndex: ListVotesPage | null;
      }>(LIST_VOTES_BY_SESSION_QUERY, { sessionId, nextToken });

      if (!response.listVoteBySessionIdAndVoteIndex) {
        break;
      }

      votes.push(...response.listVoteBySessionIdAndVoteIndex.items);
      nextToken = response.listVoteBySessionIdAndVoteIndex.nextToken;
    } while (nextToken);

    return votes;
  }

  private async execute<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const requestPayload = JSON.stringify({
      query,
      variables,
    });

    const response = await this.postWithSigV4(requestPayload);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `[AmplifySessionStore] GraphQL request failed: ${response.status} ${response.statusText} - ${text.slice(0, 512)}`,
      );
    }

    const payload = (await response.json()) as GraphQLResponse<T>;
    if (payload.errors && payload.errors.length > 0) {
      const message = payload.errors.map((error) => error.message).join('; ');
      throw new Error(`[AmplifySessionStore] GraphQL error: ${message}`);
    }
    if (!payload.data) {
      throw new Error('[AmplifySessionStore] GraphQL response missing data field');
    }
    return payload.data;
  }

  private async postWithSigV4(body: string): Promise<Response> {
    const signer = await this.getSigV4Signer();
    return signedAppSyncFetch({
      endpoint: this.endpointUrl,
      body,
      signer,
    });
  }

  private getSigV4Signer(): Promise<SignatureV4> {
    if (this.sigV4Signer) {
      return Promise.resolve(this.sigV4Signer);
    }

    const region = this.region;
    if (!region) {
      throw new Error(
        '[AmplifySessionStore] AWS region could not be inferred. Set AMPLIFY_DATA_REGION or AWS_REGION for SigV4 authentication.',
      );
    }

    this.sigV4Signer = createAppSyncSigner({
      credentials: fromNodeProviderChain(),
      region,
    });

    return Promise.resolve(this.sigV4Signer);
  }
}
