export {
  clearSession,
  captureSessionIdentity,
  initializeSession,
  getSessionData,
  getSessionDataForIdentity,
  isSessionReplaced,
  isSessionReplacedForIdentity,
  saveSessionData,
  saveSessionDataForIdentity,
  updateLastActivityForIdentity,
  SESSION_HEARTBEAT_INTERVAL_MS,
  SESSION_STORAGE_KEY,
} from './client';

export type { SessionIdentity } from './client';
