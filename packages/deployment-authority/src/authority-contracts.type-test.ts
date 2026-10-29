import type { ObjectReference, PlanPackage } from './plan-package.js';
import type { RootCheckpoint } from './root-checkpoint.js';
import type { ImageCandidate } from './release-ledger.js';
declare const checkpoint: RootCheckpoint;
declare const plan: PlanPackage;
declare const reference: ObjectReference;
declare const candidate: ImageCandidate;
// @ts-expect-error stored authority is immutable
reference.sha256 = 'changed';
// @ts-expect-error package source is immutable
plan.sourceSha = 'changed';
if (checkpoint.root === 'app') {
  checkpoint.outputs.imageId satisfies string;
  // @ts-expect-error App checkpoints do not own Foundation networks
  void checkpoint.outputs.networking;
}
if (candidate.kind === 'toolchain') {
  // @ts-expect-error unsigned Toolchain is not production Prover evidence
  void candidate.evidence.imageId;
}
