import { isFailClosedCurrentArtifactState } from '@stark-ballot/web/finalize/currentArtifactState';
import { clearKnowledgeForSession } from '@stark-ballot/web/knowledge';
import {
  clearSession,
  getSessionData,
  saveSessionData,
  saveSessionDataForIdentity,
  type SessionIdentity,
} from '@stark-ballot/web/session';
import type { FinalizationStatusResponse } from '@stark-ballot/web/finalize/finalization-status-client';

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
    clearSession();
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

  clearSession();
}
