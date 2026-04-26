export const SESSION_STORAGE_KEY = 'starkBallotSession';
export const KNOWLEDGE_STORAGE_KEY = 'stark-ballot-knowledge';
export const SESSION_LOCK_KEY = 'starkBallotSessionLock';
export const SESSION_SCHEMA_VERSION_KEY = 'starkBallotSessionSchemaVersion';
export const SESSION_SCHEMA_VERSION = '2026-03-phase-5c-v1';

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

export function ensureClientStorageSchema(): void {
  if (!hasClientStorageSupport()) {
    return;
  }

  try {
    const currentSchemaVersion = localStorage.getItem(SESSION_SCHEMA_VERSION_KEY);
    if (currentSchemaVersion === SESSION_SCHEMA_VERSION) {
      return;
    }

    // Deterministically reset stale browser-local artifacts on schema changes.
    localStorage.removeItem(SESSION_STORAGE_KEY);
    localStorage.removeItem(KNOWLEDGE_STORAGE_KEY);
    sessionStorage.removeItem(SESSION_LOCK_KEY);
    localStorage.setItem(SESSION_SCHEMA_VERSION_KEY, SESSION_SCHEMA_VERSION);
  } catch {
    // Ignore storage errors (e.g., private mode)
  }
}
