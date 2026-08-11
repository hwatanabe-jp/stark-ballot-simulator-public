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
  updateLastActivity,
  updateLastActivityForIdentity,
  SESSION_HEARTBEAT_INTERVAL_MS,
  SESSION_STORAGE_KEY,
} from './client';

export type { SessionIdentity } from './client';
export type { ServerIssuedSessionIdentity, SessionData, SessionPhase, VoteChoice } from './types';
