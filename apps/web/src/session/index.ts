export {
  clearSession,
  captureSessionIdentity,
  generateSessionId,
  getSessionData,
  getSessionDataForIdentity,
  getSessionAuthHeaders,
  isSessionReplaced,
  isSessionReplacedForIdentity,
  saveSessionData,
  saveSessionDataForIdentity,
  updateLastActivity,
  updateLastActivityForIdentity,
  SESSION_HEARTBEAT_INTERVAL_MS,
  SESSION_STORAGE_KEY,
} from './client';

export type { SessionIdentity } from './client';
