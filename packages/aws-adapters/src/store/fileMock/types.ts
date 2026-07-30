import type { SessionData, VoteData } from '@stark-ballot/domain/types/server';
import type {
  FinalizationResultAuthority,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';

/**
 * Serializable representation of SessionData for file persistence
 */
export interface SerializableSessionData {
  sessionId: string;
  contractGeneration?: string;
  finalizationContractGeneration?: string;
  electionId?: string;
  electionConfigHash?: string;
  electionConfig?: ElectionConfig;
  logId?: string;
  votes: Array<[number, VoteData]>;
  botCount: number;
  finalized: boolean;
  createdAt: number;
  lastActivity: number;
  finalizationResult?: FinalizationResultAuthority;
  finalizationState?: FinalizationState;
  finalizationScenarioContext?: SessionData['finalizationScenarioContext'];
  finalizationArtifactState?: SessionData['finalizationArtifactState'];
  userVoteIndex?: number;
  bulletinRootHistory?: SessionData['bulletinRootHistory'];
  verificationObservation?: SessionData['verificationObservation'];
}

export interface ReceiptEntry {
  receiptHash: string;
  boardIndex: number;
  receipt: { receipt: string; timestamp: number };
}

export interface BitmapData {
  sessionId: string;
  includedBitmap: boolean[];
  includedBitmapRoot: string;
  seenBitmap?: boolean[];
  seenBitmapRoot?: string;
  treeSize: number;
  finalizedAt: number;
}

export interface FileMockDiagnostics {
  sessionDiskReads: number;
  cacheSize: number;
  cacheEvictions: number;
}
