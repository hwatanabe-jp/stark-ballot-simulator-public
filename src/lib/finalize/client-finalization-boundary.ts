import { isFailClosedCurrentArtifactState } from '@/lib/contract';
import { clearKnowledgeForSession } from '@/lib/knowledge';
import {
  clearSessionData,
  getSessionData,
  saveSessionData,
  saveSessionDataForIdentity,
  type SessionIdentity,
} from '@/lib/session';
import type { FinalizationStatusResponse } from './finalization-status-client';

export function hasFailClosedFinalizationStatus(status: Pick<FinalizationStatusResponse, 'artifactState'>): boolean {
  return isFailClosedCurrentArtifactState(status.artifactState);
}

export function clearClientFinalizedProjection(expectedIdentity?: SessionIdentity | null): void {
  const expectedSessionId = expectedIdentity?.sessionId ?? getSessionData()?.sessionId ?? null;
  clearKnowledgeForSession(expectedSessionId);
  const patch = {
    finalizeResult: undefined,
    verificationRequestedAt: undefined,
    phase: 'voting' as const,
  };

  if (expectedIdentity === undefined) {
    saveSessionData(patch);
    return;
  }

  saveSessionDataForIdentity(expectedIdentity, patch);
}

export function clearClientSessionAuthority(expectedIdentity?: SessionIdentity | null): void {
  if (!expectedIdentity) {
    clearSessionData();
    return;
  }

  const currentSession = getSessionData();
  if (!currentSession) {
    return;
  }

  if (
    currentSession.sessionId !== expectedIdentity.sessionId ||
    currentSession.capabilityToken !== expectedIdentity.capabilityToken
  ) {
    return;
  }

  clearSessionData();
}
