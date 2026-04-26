import type { KnowledgeData, KnowledgeItem, KnowledgePhase, KnowledgeUpdateListener } from './types';
import { KNOWLEDGE_KEYS } from './types';
import { normalizeKnowledgeData, normalizeBotData, getPhaseForKey } from './normalizer';
import { toCanonicalRfc6962Proof } from '@/lib/merkle/rfc6962-proof';
import { getSessionData, isSessionReplaced } from '@/lib/session';
import {
  clearStoredKnowledgeData,
  ensureClientStorageSchema,
  KNOWLEDGE_STORAGE_KEY as STORAGE_KEY,
} from '@/lib/session/storageSchema';
import { isRecord } from '@/lib/utils/guards';

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
export const KNOWLEDGE_NEW_ITEM_THRESHOLD_MS = 2000;
const NEW_ITEM_THRESHOLD_MS = KNOWLEDGE_NEW_ITEM_THRESHOLD_MS;

export interface MergeKnowledgeOptions {
  omitKeys?: ReadonlyArray<keyof KnowledgeData>;
  expectedSessionId?: string;
}

type StoredKnowledgeSnapshot = { kind: 'missing' } | { kind: 'corrupt' } | { kind: 'valid'; data: KnowledgeData };

const KNOWLEDGE_KEY_SET = new Set<string>(KNOWLEDGE_KEYS);
const RETIRED_KNOWLEDGE_KEYS = [
  'missingIndices',
  'invalidIndices',
  'countedIndices',
  'excludedCount',
  's3BundleUrl',
  's3BundleExpiresAt',
  'proofMode',
] as const;

function migrateStoredKnowledgeData(data: KnowledgeData): { data: KnowledgeData; changed: boolean } {
  const migrated = { ...(data as Record<string, unknown>) };
  let changed = false;

  for (const key of RETIRED_KNOWLEDGE_KEYS) {
    if (key in migrated) {
      delete migrated[key];
      changed = true;
    }
  }

  for (const key of ['user.merklePath', 'bot.merklePath'] as const) {
    const proof = toCanonicalRfc6962Proof(migrated[key] as Record<string, unknown> | undefined);
    if (proof) {
      if (JSON.stringify(migrated[key]) !== JSON.stringify(proof)) {
        migrated[key] = proof;
        changed = true;
      }
      continue;
    }
    if (migrated[key] !== undefined) {
      delete migrated[key];
      changed = true;
    }
  }

  for (const key of Object.keys(migrated)) {
    if (!KNOWLEDGE_KEY_SET.has(key)) {
      delete migrated[key];
      changed = true;
    }
  }

  return { data: migrated, changed };
}

function getSessionIdFromKnowledge(data: Partial<KnowledgeData> | null | undefined): string | null {
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

  ensureClientStorageSchema();

  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return { kind: 'missing' };
  }

  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!isRecord(parsed)) {
      return { kind: 'corrupt' };
    }
    const migrated = migrateStoredKnowledgeData(parsed);
    if (migrated.changed) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated.data));
    }
    return { kind: 'valid', data: migrated.data };
  } catch {
    return { kind: 'corrupt' };
  }
}

function resolveKnowledgeBase(
  existing: Partial<KnowledgeData>,
  incoming: Partial<KnowledgeData>,
  expectedSessionId?: string,
): { base: Partial<KnowledgeData>; boundSessionId: string | null; rejected: boolean } {
  const existingSessionId = getSessionIdFromKnowledge(existing);
  const incomingSessionId = getSessionIdFromKnowledge(incoming);
  const activeSessionId = getActiveSessionId();
  if (isSessionReplaced()) {
    return { base: existing, boundSessionId: expectedSessionId ?? existingSessionId, rejected: true };
  }

  if (expectedSessionId && activeSessionId !== expectedSessionId) {
    return { base: existing, boundSessionId: expectedSessionId, rejected: true };
  }

  const boundSessionId = incomingSessionId ?? expectedSessionId ?? activeSessionId ?? existingSessionId;

  if (!boundSessionId) {
    return { base: existing, boundSessionId: null, rejected: false };
  }

  if (expectedSessionId && boundSessionId !== expectedSessionId) {
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

  const snapshot = readStoredKnowledgeSnapshot();
  if (snapshot.kind === 'missing') {
    return null;
  }
  if (snapshot.kind === 'corrupt') {
    clearKnowledgeStorageSnapshot();
    return null;
  }

  const knowledgeData = snapshot.data;
  const activeSessionId = getActiveSessionId();
  const storedSessionId = getSessionIdFromKnowledge(knowledgeData);

  if (isSessionReplaced()) {
    itemTimestamps.clear();
    return null;
  }

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

  ensureClientStorageSchema();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/**
 * Notify all listeners of knowledge updates
 */
function notifyListeners(items: KnowledgeItem[], phase: KnowledgePhase): void {
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
export function saveKnowledgeData(data: Partial<KnowledgeData>, options?: MergeKnowledgeOptions): KnowledgeItem[] {
  const existing = safeParseKnowledge() ?? {};
  const { base, boundSessionId, rejected } = resolveKnowledgeBase(existing, data, options?.expectedSessionId);
  if (rejected) {
    return [];
  }
  const payload: Partial<KnowledgeData> =
    boundSessionId && !getSessionIdFromKnowledge(data) ? { sessionId: boundSessionId, ...data } : data;
  const now = Date.now();
  const newItems: KnowledgeItem[] = [];

  const entries = Object.entries(payload) as Array<
    [keyof KnowledgeData, KnowledgeData[keyof KnowledgeData] | undefined]
  >;

  for (const [key, value] of entries) {
    if (value === undefined) {
      continue;
    }
    const existingValue = base[key];

    // Check if this is a new or updated value
    const isNewOrUpdated = JSON.stringify(existingValue) !== JSON.stringify(value);

    if (isNewOrUpdated) {
      itemTimestamps.set(key, now);
      newItems.push({
        key,
        value,
        isNew: true,
        addedAt: now,
      });
    }

    (base as Record<string, unknown>)[key] = value;
  }

  writeKnowledgeData(base);

  // Notify listeners if there are new items
  if (newItems.length > 0) {
    const phase = getPhaseForKey(newItems[0].key) as KnowledgePhase;
    notifyListeners(newItems, phase);
  }

  return newItems;
}

/**
 * Merge API response data into knowledge store
 * Applies normalization rules before storing
 */
function omitKnowledgeKeys(
  data: Partial<KnowledgeData>,
  omitKeys: ReadonlyArray<keyof KnowledgeData> | undefined,
): Partial<KnowledgeData> {
  if (!omitKeys || omitKeys.length === 0) {
    return data;
  }
  const filtered: Partial<KnowledgeData> = { ...data };
  for (const key of omitKeys) {
    delete (filtered as Record<string, unknown>)[key];
  }
  return filtered;
}

export function mergeKnowledgeFromApi(
  _phase: KnowledgePhase,
  apiData: Record<string, unknown>,
  options?: MergeKnowledgeOptions,
): KnowledgeItem[] {
  const normalized = normalizeKnowledgeData(apiData);
  const filtered = omitKnowledgeKeys(normalized, options?.omitKeys);
  return saveKnowledgeData(filtered, options);
}

/**
 * Merge bot data from /api/botdata/:id
 */
export function mergeBotKnowledge(botData: Record<string, unknown>): KnowledgeItem[] {
  const normalized = normalizeBotData(botData);
  return saveKnowledgeData(normalized);
}

/**
 * Clear all bot-scoped knowledge (when switching bot or resetting)
 */
export function clearBotKnowledge(): void {
  const existing = safeParseKnowledge();
  if (!existing) {
    return;
  }

  const botKeys: (keyof KnowledgeData)[] = [
    'bot.id',
    'bot.choice',
    'bot.random',
    'bot.commitment',
    'bot.voteId',
    'bot.bulletinIndex',
    'bot.bulletinRootAtCast',
    'bot.voteTimestamp',
    'bot.merklePath',
    'bot.verification.steps',
  ];

  for (const key of botKeys) {
    delete (existing as Record<string, unknown>)[key];
    itemTimestamps.delete(key);
  }

  writeKnowledgeData(existing);
}

/**
 * Clear all knowledge data
 */
export function clearKnowledge(): void {
  if (typeof window === 'undefined') {
    return;
  }

  ensureClientStorageSchema();
  clearKnowledgeStorageSnapshot();
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
    clearKnowledgeStorageSnapshot();
    return;
  }

  const storedSessionId = getSessionIdFromKnowledge(snapshot.data);
  if (!storedSessionId || storedSessionId === expectedSessionId) {
    clearKnowledgeStorageSnapshot();
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
export function getKnowledgeItems(): KnowledgeItem[] {
  const data = safeParseKnowledge();
  if (!data) {
    return [];
  }

  const now = Date.now();
  const items: KnowledgeItem[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) {
      continue;
    }

    const typedKey = key as keyof KnowledgeData;
    const addedAt = itemTimestamps.get(typedKey) ?? 0;
    const isNew = now - addedAt < NEW_ITEM_THRESHOLD_MS;

    items.push({
      key: typedKey,
      value,
      isNew,
      addedAt,
    });
  }

  return items;
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
