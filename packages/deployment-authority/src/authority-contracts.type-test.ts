import { deepFreeze } from './internal.js';
import type { AppAcceptance } from './app-acceptance-ledger.js';
import type { AppExecutionAuthority } from './app-execution-authority.js';
import type { LambdaFunctionVersion } from './app-image-signature-verifier-reconciliation.js';
import type {
  ProverAcceptedPointer,
  ProverReleaseRecord,
  ReleaseRecordRead,
  ResolvedReleasePointer,
  ToolchainAcceptedPointer,
} from './release-ledger.js';

declare const authority: AppExecutionAuthority;
// @ts-expect-error Admitted authority is frozen at runtime.
authority.controlSourceSha = 'changed';
// @ts-expect-error Nested admitted authority is frozen too.
authority.releaseAuthority.zkvm.methodVersion = 0;
if (authority.deploymentMode === 'normal') {
  const selection: null = authority.selectedAcceptanceKey;
  void selection;
} else {
  const selection: string = authority.selectedAcceptanceKey;
  void selection;
}

declare const acceptance: AppAcceptance;
const imageId: string = acceptance.verifier.confirmedImageIdMapping.expectedImageId;
const packageVersion: string = acceptance.deployables.lambdaArtifacts.artifacts.public_api.versionId;
void imageId;
void packageVersion;
// @ts-expect-error Admission preserves the exact release-authority field names.
void acceptance.releaseAuthority['proverRelaseKey'];
// @ts-expect-error Admission preserves the closed Lambda artifact inventory.
void acceptance.deployables.lambdaArtifacts.artifacts['unknown_lambda'];

declare const proverRecord: ProverReleaseRecord;
const mismatchedRecord = {
  kind: 'toolchain-candidate' as const,
  key: 'record-key',
  record: proverRecord,
  recordObservation: { etag: 'etag', versionId: 'version' },
};
// @ts-expect-error Kind and record must agree even through a variable.
const invalidRead: ReleaseRecordRead = mismatchedRecord;
void invalidRead;

declare const selected: ReleaseRecordRead;
if (selected.kind === 'prover-release') {
  const record: ProverReleaseRecord = selected.record;
  void record;
}

declare const resolved: ResolvedReleasePointer;
if (resolved.recordKind === 'prover-release') {
  const pointer: ProverAcceptedPointer = resolved.pointer;
  const record: ProverReleaseRecord = resolved.record;
  void pointer;
  void record;
}
declare const toolchainPointer: ToolchainAcceptedPointer;
const mismatchedPointer = { ...resolved, recordKind: 'prover-release' as const, pointer: toolchainPointer };
// @ts-expect-error A Prover selection cannot carry a Toolchain pointer.
const invalidPointer: ResolvedReleasePointer = mismatchedPointer;
void invalidPointer;

declare const version: LambdaFunctionVersion;
const frozen = deepFreeze({ versions: [version], port: (value: string) => value });
const retainedVersion: LambdaFunctionVersion | undefined = frozen.versions[0];
const portResult: string = frozen.port('value');
void retainedVersion;
void portResult;
// @ts-expect-error Frozen authority arrays cannot be extended.
frozen.versions[1] = version;
declare const untrusted: unknown;
// @ts-expect-error Freezing cannot admit an unknown value as a string.
const unvalidated: string = deepFreeze(untrusted);
void unvalidated;
