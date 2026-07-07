export type CurrentArtifactState = 'supported' | 'unsupported_current_artifact' | 'corrupt_or_unreadable';
export type FailClosedCurrentArtifactState = Exclude<CurrentArtifactState, 'supported'>;

export function isSupportedCurrentArtifactState(state: CurrentArtifactState | null | undefined): boolean {
  return state === 'supported';
}

export function isFailClosedCurrentArtifactState(state: unknown): state is FailClosedCurrentArtifactState {
  return state === 'unsupported_current_artifact' || state === 'corrupt_or_unreadable';
}
