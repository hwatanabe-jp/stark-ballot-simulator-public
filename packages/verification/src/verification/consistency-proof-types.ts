export interface ConsistencyProofResponse {
  oldSize: number;
  newSize: number;
  rootAtOldSize: string;
  rootAtNewSize: string;
  proofNodes: string[];
  oldSubtreeHashes?: string[];
  appendSubtreeHashes?: string[];
  timestamp: number;
}
