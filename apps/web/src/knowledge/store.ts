import { isCurrentKnowledgeData } from './admission';
import type { KnowledgeData, KnowledgeItem, KnowledgePhase, KnowledgeUpdateListener } from './types';
import { BOT_KNOWLEDGE_KEYS, KNOWLEDGE_KEYS } from './types';
import { knowledgeItemsFromData } from './items';
import { normalizeKnowledgeData, getPhaseForKey, type KnowledgeCandidate } from './normalizer';
import { getSessionData, isSessionReplaced } from '@stark-ballot/web/session';
import { clearStoredKnowledgeData, KNOWLEDGE_STORAGE_KEY as STORAGE_KEY } from '@stark-ballot/web/session/storage';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

/**
 * Listeners for knowledge updates
 */
const listeners: Set<KnowledgeUpdateListener> = new Set();

/**
 * Track when items were added for animation purposes
 */
const itemTimestamps: Map<keyof KnowledgeData, number> = new Map();

/**
 * New item threshold (ms) - items added within this time are considered "new"
 */
const KNOWLEDGE_NEW_ITEM_THRESHOLD_MS = 2000;
const NEW_ITEM_THRESHOLD_MS = KNOWLEDGE_NEW_ITEM_THRESHOLD_MS;

export interface MergeKnowledgeOptions {
  omitKeys?: ReadonlyArray<keyof KnowledgeData>;
  expectedSessionId?: string;
}

export type KnowledgeDataPatch = {
  [K in keyof KnowledgeData]?: KnowledgeData[K] | undefined;
};

type StoredKnowledgeSnapshot = { kind: 'missing' } | { kind: 'corrupt' } | { kind: 'valid'; data: KnowledgeData };

const KNOWLEDGE_KEY_SET = new Set<string>(KNOWLEDGE_KEYS);
function getSessionIdFromKnowledge(data: KnowledgeCandidate | null | undefined): string | null {
  const sessionId = data?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return null;
  }
  return sessionId;
}

function getActiveSessionId(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return getSessionData()?.sessionId ?? null;
}

function clearKnowledgeStorageSnapshot(): void {
  if (typeof window === 'undefined') {
    return;
  }

  clearStoredKnowledgeData();
  itemTimestamps.clear();
}

function readStoredKnowledgeSnapshot(): StoredKnowledgeSnapshot {
  if (typeof window === 'undefined') {
    return { kind: 'missing' };
  }

  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return { kind: 'missing' };
  }

  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!isCurrentKnowledgeData(parsed)) {
      return { kind: 'corrupt' };
    }
    return { kind: 'valid', data: parsed };
  } catch {
    return { kind: 'corrupt' };
  }
}

function conflictsWithExpectedSession(actual: string | null, expected: string | undefined): boolean {
  return Boolean(expected) && actual !== expected;
}

function bindKnowledgeSession(
  incoming: string | null,
  expected: string | undefined,
  active: string | null,
  existing: string | null,
): string | null {
  return incoming ?? expected ?? active ?? existing;
}

function resolveKnowledgeBase(
  existing: Partial<KnowledgeData>,
  incoming: KnowledgeCandidate,
  expectedSessionId?: string,
): { base: Partial<KnowledgeData>; boundSessionId: string | null; rejected: boolean } {
  const existingSessionId = getSessionIdFromKnowledge(existing);
  const incomingSessionId = getSessionIdFromKnowledge(incoming);
  const activeSessionId = getActiveSessionId();
  if (isSessionReplaced()) {
    return { base: existing, boundSessionId: expectedSessionId ?? existingSessionId, rejected: true };
  }

  if (conflictsWithExpectedSession(activeSessionId, expectedSessionId)) {
    return { base: existing, boundSessionId: expectedSessionId ?? null, rejected: true };
  }

  const boundSessionId = bindKnowledgeSession(incomingSessionId, expectedSessionId, activeSessionId, existingSessionId);

  if (!boundSessionId) {
    return { base: existing, boundSessionId: null, rejected: false };
  }

  if (conflictsWithExpectedSession(boundSessionId, expectedSessionId)) {
    return { base: existing, boundSessionId, rejected: true };
  }

  if (existingSessionId && existingSessionId !== boundSessionId) {
    itemTimestamps.clear();
    return { base: { sessionId: boundSessionId }, boundSessionId, rejected: false };
  }

  return { base: existing, boundSessionId, rejected: false };
}

/**
 * Safely parse stored knowledge data
 */
function safeParseKnowledge(): KnowledgeData | null {
  if (typeof window === 'undefined') {
    return null;
  }

  if (isSessionReplaced()) {
    itemTimestamps.clear();
    return null;
  }
  // Session admission can remove knowledge when the session is invalid or
  // expired. Read its snapshot only after that cleanup has finished.
  const activeSessionId = getActiveSessionId();
  const snapshot = readStoredKnowledgeSnapshot();
  if (snapshot.kind === 'missing') {
    return null;
  }
  if (snapshot.kind === 'corrupt') {
    clearKnowledgeStorageSnapshot();
    return null;
  }

  const knowledgeData = snapshot.data;
  const storedSessionId = getSessionIdFromKnowledge(knowledgeData);

  if (activeSessionId && !storedSessionId) {
    clearKnowledgeStorageSnapshot();
    return null;
  }

  if (activeSessionId && storedSessionId !== activeSessionId) {
    itemTimestamps.clear();
    return null;
  }

  return knowledgeData;
}

/**
 * Write knowledge data to localStorage
 */
function writeKnowledgeData(data: KnowledgeData): void {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/**
 * Notify all listeners of knowledge updates
 */
function notifyListeners(items: readonly KnowledgeItem[], phase: KnowledgePhase): void {
  for (const listener of listeners) {
    try {
      listener(items, phase);
    } catch (error) {
      console.error('Knowledge listener error:', error);
    }
  }
}

/**
 * Get all knowledge data
 */
export function getKnowledgeData(): KnowledgeData | null {
  return safeParseKnowledge();
}

/**
 * Get a single knowledge value
 */
export function getKnowledgeValue<K extends keyof KnowledgeData>(key: K): KnowledgeData[K] | undefined {
  const data = safeParseKnowledge();
  if (!data) {
    return undefined;
  }
  return data[key];
}

/**
 * Save partial knowledge data (merge with existing)
 */
export function saveKnowledgeData(data: KnowledgeDataPatch, options?: MergeKnowledgeOptions): readonly KnowledgeItem[] {
  return saveKnowledgeCandidate(data, options);
}

function mergeKnowledgeCandidate(
  base: Partial<KnowledgeData>,
  payload: KnowledgeCandidate,
): {
  candidate: Record<string, unknown>;
  changedKeys: string[];
} {
  const candidate: Record<string, unknown> = { ...base };
  const changedKeys: string[] = [];

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (JSON.stringify(candidate[key]) !== JSON.stringify(value)) {
      changedKeys.push(key);
    }
    candidate[key] = value;
  }
  return { candidate, changedKeys };
}

function saveKnowledgeCandidate(data: KnowledgeCandidate, options?: MergeKnowledgeOptions): readonly KnowledgeItem[] {
  const existing = safeParseKnowledge() ?? {};
  const { base, boundSessionId, rejected } = resolveKnowledgeBase(existing, data, options?.expectedSessionId);
  if (rejected) {
    return [];
  }
  const payload: KnowledgeCandidate =
    boundSessionId && !getSessionIdFromKnowledge(data) ? { sessionId: boundSessionId, ...data } : data;
  const now = Date.now();
  const { candidate, changedKeys } = mergeKnowledgeCandidate(base, payload);

  if (!isCurrentKnowledgeData(candidate)) {
    return [];
  }

  // Construct typed notification items only after admitting the complete state.
  const newItems = knowledgeItemsFromData(
    candidate,
    () => ({ isNew: true, addedAt: now }),
    changedKeys.filter((key): key is keyof KnowledgeData => KNOWLEDGE_KEY_SET.has(key)),
  );

  for (const item of newItems) {
    itemTimestamps.set(item.key, now);
  }

  writeKnowledgeData(candidate);

  // Notify listeners if there are new items
  if (newItems.length > 0) {
    const phase = getPhaseForKey(strictDefined(newItems[0]).key) as KnowledgePhase;
    notifyListeners(newItems, phase);
  }

  return newItems;
}

/**
 * Merge API response data into knowledge store
 * Applies normalization rules before storing
 */
function omitKnowledgeKeys(
  data: KnowledgeCandidate,
  omitKeys: ReadonlyArray<keyof KnowledgeData> | undefined,
): KnowledgeCandidate {
  if (!omitKeys || omitKeys.length === 0) {
    return data;
  }
  const filtered: KnowledgeCandidate = { ...data };
  for (const key of omitKeys) {
    delete filtered[key];
  }
  return filtered;
}

export function mergeKnowledgeFromApi(
  apiData: Record<string, unknown>,
  options?: MergeKnowledgeOptions,
): readonly KnowledgeItem[] {
  const normalized = normalizeKnowledgeData(apiData);
  const filtered = omitKnowledgeKeys(normalized, options?.omitKeys);
  return saveKnowledgeCandidate(filtered, options);
}

/**
 * Clear all bot-scoped knowledge (when switching bot or resetting)
 */
export function clearBotKnowledge(): void {
  const existing = safeParseKnowledge();
  if (!existing || !BOT_KNOWLEDGE_KEYS.some((key) => key in existing)) {
    return;
  }

  for (const key of BOT_KNOWLEDGE_KEYS) {
    delete (existing as Record<string, unknown>)[key];
    itemTimestamps.delete(key);
  }

  writeKnowledgeData(existing);
  notifyListeners([], 'verify');
}

/**
 * Clear all knowledge data
 */
export function clearKnowledge(): void {
  if (typeof window === 'undefined') {
    return;
  }

  clearKnowledgeStorageSnapshot();
  notifyListeners([], 'session');
}

export function clearKnowledgeForSession(expectedSessionId: string | null | undefined): void {
  if (typeof window === 'undefined') {
    return;
  }
  if (typeof expectedSessionId !== 'string' || expectedSessionId.length === 0) {
    return;
  }

  const snapshot = readStoredKnowledgeSnapshot();
  if (snapshot.kind === 'missing') {
    return;
  }
  if (snapshot.kind === 'corrupt') {
    return;
  }

  const storedSessionId = getSessionIdFromKnowledge(snapshot.data);
  if (!storedSessionId || storedSessionId === expectedSessionId) {
    clearKnowledgeStorageSnapshot();
    notifyListeners([], 'session');
  }
}

/**
 * Subscribe to knowledge updates
 * Returns unsubscribe function
 */
export function subscribeToKnowledge(listener: KnowledgeUpdateListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Get all knowledge items for display
 */
export function getKnowledgeItems(): readonly KnowledgeItem[] {
  const data = safeParseKnowledge();
  if (!data) {
    return [];
  }

  const now = Date.now();
  return knowledgeItemsFromData(data, (key) => {
    const addedAt = itemTimestamps.get(key) ?? 0;
    const isNew = now - addedAt < NEW_ITEM_THRESHOLD_MS;
    return { isNew, addedAt };
  });
}

/**
 * Get knowledge items filtered by phase
 */
/**
 * Set proof bundle download status
 */
export function setProofBundleStatus(status: 'not_downloaded' | 'downloaded'): void {
  saveKnowledgeData({ proofBundleStatus: status });
}
