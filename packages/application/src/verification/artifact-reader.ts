import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';

export const ARTIFACT_DELIVERY_LIMITS = Object.freeze({
  bundleInlineMaxBytes: 4 * 1024 * 1024,
  bundleRangeMaxBytes: 4 * 1024 * 1024,
  reportMaxBytes: 4 * 1024 * 1024,
});

export type ArtifactKind = 'bundle' | 'report';

export type ArtifactRangeRequest =
  | { kind: 'closed'; start: number; end: number }
  | { kind: 'openEnded'; start: number }
  | { kind: 'suffix'; length: number }
  | { kind: 'invalid' };

export interface ArtifactReadRequest {
  artifact: ArtifactKind;
  sessionId: SessionId;
  finalizationId: FinalizationId;
  range?: ArtifactRangeRequest;
}

export interface ArtifactRepresentationIdentity {
  etag?: string;
  versionId?: string;
}

export interface FullArtifactRead {
  kind: 'full';
  bytes: Uint8Array;
  totalBytes: number;
  representation: ArtifactRepresentationIdentity;
}

export interface RangedArtifactRead {
  kind: 'range';
  bytes: Uint8Array;
  totalBytes: number;
  start: number;
  end: number;
  representation: ArtifactRepresentationIdentity;
}

export type ArtifactReadFailureKind = 'accessDenied' | 'timeout' | 'throttled' | 'unknown';

export type ArtifactReadResult =
  | FullArtifactRead
  | RangedArtifactRead
  | { kind: 'notFound' }
  | { kind: 'invalidRange'; totalBytes: number }
  | { kind: 'tooLarge'; totalBytes: number }
  | { kind: 'unavailable'; failureKind: ArtifactReadFailureKind };

export interface ArtifactReader {
  read: (request: ArtifactReadRequest) => Promise<ArtifactReadResult>;
}
