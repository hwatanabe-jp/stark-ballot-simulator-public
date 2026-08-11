import type { FinalizationBitmapData } from '@stark-ballot/application/finalize/finalization-store';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type { VerificationResultRecord } from '@stark-ballot/application/finalize/finalization-result-store';
import type { AwsVerificationDeliveryMetadataInput } from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import type { AwsFinalizationRuntimeMetadata } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import type {
  RootSnapshot,
  SessionIdentityRecord,
  UserParticipation,
  StoredVoteRecord,
} from '@stark-ballot/domain/types/sessionRecords';
import type { VerificationObservation } from '@stark-ballot/domain/types/verificationObservation';

export interface SerializableSessionVotingRecord {
  sessionId: string;
  votes: Array<[number, StoredVoteRecord]>;
  bulletinRootHistory: RootSnapshot[];
  botCount: number;
  userParticipation: UserParticipation;
  lastActivityMs: number;
}

export interface VerificationObservationRecord extends VerificationObservation {
  sessionId: string;
}

export interface AwsRuntimeMetadataRecord extends AwsFinalizationRuntimeMetadata {
  sessionId: string;
  finalizationId: string;
}

export interface AwsDeliveryMetadataRecord extends AwsVerificationDeliveryMetadataInput {
  sessionId: string;
  finalizationId: string;
}

export interface ReceiptRecord {
  sessionId: string;
  finalizationId: string;
  receiptHash: string;
  boardIndex: number;
  receipt: {
    receipt: string;
    timestamp: number;
  };
}

/**
 * Exact semantic file layout. Each array represents one lifecycle-owned
 * record family; no aggregate session row is serialized.
 */
export interface FileStoreSnapshot {
  identities: SessionIdentityRecord[];
  voting: SerializableSessionVotingRecord[];
  finalizations: FinalizationRecord[];
  currentFinalizationIds: Array<[string, string]>;
  verificationResults: VerificationResultRecord[];
  verificationObservations: VerificationObservationRecord[];
  bitmaps: FinalizationBitmapData[];
  voteIdIndex: Array<[string, { sessionId: string; index: number }]>;
  runtimeMetadata: AwsRuntimeMetadataRecord[];
  deliveryMetadata: AwsDeliveryMetadataRecord[];
  receipts: ReceiptRecord[];
  receiptCounter: number;
}
