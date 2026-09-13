export const SESSION_STORAGE_KEY = 'starkBallotSession';
export const KNOWLEDGE_STORAGE_KEY = 'stark-ballot-knowledge';
export const SESSION_LOCK_KEY = 'starkBallotSessionLock';

export function notifyStoredSessionChange(): void {
  // Session admission may remove stale data during render. Defer notification
  // until the complete storage operation, including its tab lock, has finished.
  queueMicrotask(() => window.dispatchEvent(new StorageEvent('storage', { key: SESSION_STORAGE_KEY })));
}

export function clearStoredKnowledgeData(): void {
  if (!hasClientStorageSupport()) {
    return;
  }

  try {
    const hadSnapshot = localStorage.getItem(KNOWLEDGE_STORAGE_KEY) !== null;
    localStorage.removeItem(KNOWLEDGE_STORAGE_KEY);
    if (hadSnapshot) {
      // Admission can clear an invalid snapshot during render. Refresh mounted
      // consumers after that read finishes, using the existing storage channel.
      queueMicrotask(() => window.dispatchEvent(new StorageEvent('storage', { key: KNOWLEDGE_STORAGE_KEY })));
    }
  } catch {
    // Ignore storage errors (e.g., private mode)
  }
}

export function clearStoredSessionData(options?: { clearKnowledge?: boolean; clearLock?: boolean }): void {
  if (!hasClientStorageSupport()) {
    return;
  }

  try {
    const hadSession = localStorage.getItem(SESSION_STORAGE_KEY) !== null;
    localStorage.removeItem(SESSION_STORAGE_KEY);
    if (options?.clearKnowledge) {
      clearStoredKnowledgeData();
    }
    if (options?.clearLock) {
      sessionStorage.removeItem(SESSION_LOCK_KEY);
    }
    if (hadSession) notifyStoredSessionChange();
  } catch {
    // Ignore storage errors (e.g., private mode)
  }
}

export function hasClientStorageSupport(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined' && typeof sessionStorage !== 'undefined';
}
