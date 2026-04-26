import type { FinalizationResultAuthority, SessionData, VoteData } from '@/types/server';
import type { ElectionConfig } from '@/lib/zkvm/election-config';

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
  finalizationState?: SessionData['finalizationState'];
  finalizationScenarioContext?: SessionData['finalizationScenarioContext'];
  finalizationArtifactState?: SessionData['finalizationArtifactState'];
  userVoteIndex?: number;
  bulletinRootHistory?: SessionData['bulletinRootHistory'];
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
