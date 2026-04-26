import type { CurrentArtifactState } from '@/lib/contract';
import { ErrorCode } from '@/lib/errors/apiErrors';

type UnsupportedArtifactState = Exclude<CurrentArtifactState, 'supported'>;

export function resolveCurrentArtifactErrorCode(state: UnsupportedArtifactState): ErrorCode {
  return state === 'unsupported_current_artifact'
    ? ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT
    : ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE;
}

export function describeCurrentArtifactError(state: UnsupportedArtifactState): string {
  return state === 'unsupported_current_artifact'
    ? 'Finalized state is unsupported for the current contract generation'
    : 'Finalized state is corrupt or unreadable';
}
