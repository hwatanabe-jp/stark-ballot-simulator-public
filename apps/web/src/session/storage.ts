export const SESSION_STORAGE_KEY = 'starkBallotSession';
export const KNOWLEDGE_STORAGE_KEY = 'stark-ballot-knowledge';
export const SESSION_LOCK_KEY = 'starkBallotSessionLock';

export function clearStoredKnowledgeData(): void {
  if (!hasClientStorageSupport()) {
    return;
  }

  try {
    localStorage.removeItem(KNOWLEDGE_STORAGE_KEY);
  } catch {
    // Ignore storage errors (e.g., private mode)
  }
}

export function clearStoredSessionData(options?: { clearKnowledge?: boolean; clearLock?: boolean }): void {
  if (!hasClientStorageSupport()) {
    return;
  }

  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    if (options?.clearKnowledge) {
      clearStoredKnowledgeData();
    }
    if (options?.clearLock) {
      sessionStorage.removeItem(SESSION_LOCK_KEY);
    }
  } catch {
    // Ignore storage errors (e.g., private mode)
  }
}

export function hasClientStorageSupport(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined' && typeof sessionStorage !== 'undefined';
}
