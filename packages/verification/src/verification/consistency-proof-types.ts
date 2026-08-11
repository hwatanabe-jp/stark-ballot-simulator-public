export interface AdmittedConsistencyProof {
  fromTreeSize: number;
  toTreeSize: number;
  rootAtFromTreeSize: string;
  rootAtToTreeSize: string;
  proofNodes: string[];
  oldSubtreeHashes?: string[];
  appendSubtreeHashes?: string[];
  generatedAtMs: number;
}
