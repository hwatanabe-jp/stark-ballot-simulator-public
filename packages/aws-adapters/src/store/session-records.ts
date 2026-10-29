import { buildSessionRecords } from '@stark-ballot/application/session/session-mutation-policy';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { generateLogId } from '@stark-ballot/zkvm-contract/zkvm/log-id';
import { createElectionId } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { AwsFinalizationRuntimeMetadata } from '../finalize/finalizationRuntimeStore';
import type { SessionIdentityRecord, SessionVotingRecord } from '@stark-ballot/domain/types/sessionRecords';

export function cloneSessionIdentity(identity: SessionIdentityRecord): SessionIdentityRecord {
  return {
    ...identity,
    electionConfig: { ...identity.electionConfig, choices: [...identity.electionConfig.choices] },
  };
}

/** Copy mutable record values; the adapter owns the bulletin's lifetime. */
export function cloneSessionVoting(record: SessionVotingRecord): SessionVotingRecord {
  return {
    ...record,
    votes: new Map(Array.from(record.votes, ([index, vote]) => [index, { ...vote }])),
    bulletinRootHistory: record.bulletinRootHistory.map((snapshot) => ({ ...snapshot })),
    userParticipation: { ...record.userParticipation },
  };
}

export function createDefaultSessionRecords(sessionId: SessionId, logName: string, createdAtMs: number) {
  return buildSessionRecords({
    sessionId,
    electionId: createElectionId(),
    electionConfigHash: getDefaultElectionConfigHash(),
    electionConfig: buildDefaultElectionConfig(),
    logId: generateLogId(logName),
    createdAtMs,
    lastActivityMs: createdAtMs,
  });
}

export function cloneRuntimeMetadata(metadata: AwsFinalizationRuntimeMetadata): AwsFinalizationRuntimeMetadata {
  return {
    ...metadata,
    ...(metadata.bundleMetadata ? { bundleMetadata: { ...metadata.bundleMetadata } } : {}),
  };
}
