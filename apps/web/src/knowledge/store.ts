import type { KnowledgeData, KnowledgeItem, KnowledgePhase, KnowledgeUpdateListener } from './types';
import { KNOWLEDGE_KEYS } from './types';
import { normalizeKnowledgeData, getPhaseForKey } from './normalizer';
import { toCanonicalRfc6962Proof } from '@stark-ballot/merkle/rfc6962-proof';
import { isValidHexString } from '@stark-ballot/crypto-primitives';
import { getSessionData, isSessionReplaced } from '@stark-ballot/web/session';
import { clearStoredKnowledgeData, KNOWLEDGE_STORAGE_KEY as STORAGE_KEY } from '@stark-ballot/web/session/storage';
import { isRecord } from '@stark-ballot/validation/unknown-value-guards';

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
export const KNOWLEDGE_NEW_ITEM_THRESHOLD_MS = 2000;
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
const STRING_KNOWLEDGE_KEYS = new Set<keyof KnowledgeData>([
  'sessionId',
  'electionId',
  'electionConfigHash',
  'logId',
  'user.random',
  'user.commitment',
  'user.voteId',
  'user.bulletinRootAtCast',
  'bulletinRoot',
  'sthDigest',
  'seenBitmapRoot',
  'includedBitmapRoot',
  'inputCommitment',
  'imageId',
  'bot.random',
  'bot.commitment',
  'bot.voteId',
  'bot.bulletinRootAtCast',
]);
const COUNT_KNOWLEDGE_KEYS = new Set<keyof KnowledgeData>([
  'user.bulletinIndex',
  'user.castAtMs',
  'tally.totalVotes',
  'tally.tamperedCount',
  'missingSlots',
  'invalidPresentedSlots',
  'rejectedRecords',
  'validVotes',
  'excludedSlots',
  'totalExpected',
  'treeSize',
  'bot.id',
  'bot.bulletinIndex',
  'bot.voteTimestamp',
]);
const VERIFICATION_STEP_IDS = new Set([
  'cast_as_intended',
  'recorded_as_cast',
  'counted_as_recorded',
  'stark_verification',
]);
const VERIFICATION_STEP_STATUSES = new Set(['pending', 'running', 'success', 'failed', 'not_run']);

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && keys.every((key) => allowed.has(key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalInclusionProof(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['leafIndex', 'treeSize', 'merklePath', 'bulletinRootAtCast'])) {
    return false;
  }
  const leafIndex = value['leafIndex'];
  const treeSize = value['treeSize'];
  const merklePath = value['merklePath'];
  const bulletinRootAtCast = value['bulletinRootAtCast'];
  if (
    !Number.isSafeInteger(leafIndex) ||
    typeof leafIndex !== 'number' ||
    leafIndex < 0 ||
    !Number.isSafeInteger(treeSize) ||
    typeof treeSize !== 'number' ||
    treeSize <= 0 ||
    leafIndex >= treeSize ||
    !Array.isArray(merklePath) ||
    !merklePath.every((node) => typeof node === 'string' && isValidHexString(node, 32)) ||
    typeof bulletinRootAtCast !== 'string' ||
    !isValidHexString(bulletinRootAtCast, 32)
  ) {
    return false;
  }
  const proof = toCanonicalRfc6962Proof(value);
  if (!proof) {
    return false;
  }
  return (
    proof.leafIndex === value['leafIndex'] &&
    proof.treeSize === value['treeSize'] &&
    proof.bulletinRootAtCast === value['bulletinRootAtCast'] &&
    proof.merklePath.length === merklePath.length &&
    proof.merklePath.every((node, index) => node === merklePath[index])
  );
}

function isVerificationStep(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'status', 'inputs'], ['error'])) {
    return false;
  }
  return (
    typeof value['id'] === 'string' &&
    VERIFICATION_STEP_IDS.has(value['id']) &&
    typeof value['status'] === 'string' &&
    VERIFICATION_STEP_STATUSES.has(value['status']) &&
    Array.isArray(value['inputs']) &&
    value['inputs'].every((input) => typeof input === 'string') &&
    (value['error'] === undefined || typeof value['error'] === 'string')
  );
}

function isCurrentKnowledgeData(value: Record<string, unknown>): value is Record<string, unknown> & KnowledgeData {
  for (const [rawKey, entry] of Object.entries(value)) {
    if (!KNOWLEDGE_KEY_SET.has(rawKey) || entry === null || entry === undefined) {
      return false;
    }
    const key = rawKey as keyof KnowledgeData;
    if (STRING_KNOWLEDGE_KEYS.has(key) && (typeof entry !== 'string' || entry.length === 0)) {
      return false;
    }
    if (COUNT_KNOWLEDGE_KEYS.has(key) && !isNonNegativeSafeInteger(entry)) {
      return false;
    }
  }

  const choiceValues = [value['user.choice'], value['bot.choice']].filter((entry) => entry !== undefined);
  if (choiceValues.some((entry) => !['A', 'B', 'C', 'D', 'E'].includes(entry as string))) {
    return false;
  }
  if (
    value['scenarioId'] !== undefined &&
    !['S0', 'S1', 'S2', 'S3', 'S4', 'S5'].includes(value['scenarioId'] as string)
  ) {
    return false;
  }
  if (
    value['proofBundleStatus'] !== undefined &&
    !['not_downloaded', 'downloaded'].includes(value['proofBundleStatus'] as string)
  ) {
    return false;
  }

  const botVotesStatus = value['botVotesStatus'];
  if (
    botVotesStatus !== undefined &&
    !(
      botVotesStatus === 'pending' ||
      botVotesStatus === 'completed' ||
      (isRecord(botVotesStatus) &&
        hasExactKeys(botVotesStatus, ['status'], ['total']) &&
        (botVotesStatus['status'] === 'pending' || botVotesStatus['status'] === 'completed') &&
        (botVotesStatus['total'] === undefined || isNonNegativeSafeInteger(botVotesStatus['total'])))
    )
  ) {
    return false;
  }

  const tally = value['tally.counts'];
  if (
    tally !== undefined &&
    (!isRecord(tally) ||
      !hasExactKeys(tally, ['A', 'B', 'C', 'D', 'E']) ||
      Object.values(tally).some((count) => !isNonNegativeSafeInteger(count)))
  ) {
    return false;
  }
  for (const key of ['user.merklePath', 'bot.merklePath'] as const) {
    if (value[key] !== undefined && !isCanonicalInclusionProof(value[key])) {
      return false;
    }
  }
  for (const key of ['verification.steps', 'bot.verification.steps'] as const) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || !value[key].every(isVerificationStep))) {
      return false;
    }
  }

  const receipt = value['user.voteReceipt'];
  if (
    receipt !== undefined &&
    (!isRecord(receipt) ||
      !hasExactKeys(
        receipt,
        ['voteId', 'commitment', 'bulletinIndex', 'bulletinRootAtCast', 'timestamp'],
        ['inputCommitment'],
      ) ||
      !['voteId', 'commitment', 'bulletinRootAtCast'].every((key) => typeof receipt[key] === 'string') ||
      !isNonNegativeSafeInteger(receipt['bulletinIndex']) ||
      !isNonNegativeSafeInteger(receipt['timestamp']) ||
      (receipt['inputCommitment'] !== undefined && typeof receipt['inputCommitment'] !== 'string'))
  ) {
    return false;
  }

  const publication = value['receiptPublication'];
  if (
    publication !== undefined &&
    (!isRecord(publication) ||
      !hasExactKeys(publication, ['receiptHash', 'boardIndex'], ['timestamp']) ||
      typeof publication['receiptHash'] !== 'string' ||
      !isValidHexString(publication['receiptHash'], 32) ||
      !isNonNegativeSafeInteger(publication['boardIndex']) ||
      (publication['timestamp'] !== undefined && !isNonNegativeSafeInteger(publication['timestamp'])))
  ) {
    return false;
  }

  const reportSummary = value['verification.reportSummary'];
  if (
    reportSummary !== undefined &&
    (!isRecord(reportSummary) ||
      !hasExactKeys(reportSummary, ['status'], ['duration_ms', 'errors']) ||
      typeof reportSummary['status'] !== 'string' ||
      reportSummary['status'].length === 0 ||
      (reportSummary['duration_ms'] !== undefined && !isNonNegativeSafeInteger(reportSummary['duration_ms'])) ||
      (reportSummary['errors'] !== undefined &&
        (!Array.isArray(reportSummary['errors']) ||
          !reportSummary['errors'].every((error) => typeof error === 'string'))))
  ) {
    return false;
  }
  return true;
}

function getSessionIdFromKnowledge(data: KnowledgeDataPatch | null | undefined): string | null {
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
    if (!isRecord(parsed)) {
      return { kind: 'corrupt' };
    }
    if (!isCurrentKnowledgeData(parsed)) {
      return { kind: 'corrupt' };
    }
    return { kind: 'valid', data: parsed };
  } catch {
    return { kind: 'corrupt' };
  }
}

function resolveKnowledgeBase(
  existing: Partial<KnowledgeData>,
  incoming: KnowledgeDataPatch,
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
  if (isSessionReplaced()) {
    itemTimestamps.clear();
    return null;
  }
  if (snapshot.kind === 'corrupt') {
    clearKnowledgeStorageSnapshot();
    return null;
  }

  const knowledgeData = snapshot.data;
  const activeSessionId = getActiveSessionId();
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
export function saveKnowledgeData(data: KnowledgeDataPatch, options?: MergeKnowledgeOptions): KnowledgeItem[] {
  const existing = safeParseKnowledge() ?? {};
  const { base, boundSessionId, rejected } = resolveKnowledgeBase(existing, data, options?.expectedSessionId);
  if (rejected) {
    return [];
  }
  const payload: KnowledgeDataPatch =
    boundSessionId && !getSessionIdFromKnowledge(data) ? { sessionId: boundSessionId, ...data } : data;
  const now = Date.now();
  const newItems: KnowledgeItem[] = [];
  const candidate: Record<string, unknown> = { ...base };

  const entries = Object.entries(payload) as Array<
    [keyof KnowledgeData, KnowledgeData[keyof KnowledgeData] | undefined]
  >;

  for (const [key, value] of entries) {
    if (value === undefined) {
      continue;
    }
    const existingValue = candidate[key];

    // Check if this is a new or updated value
    const isNewOrUpdated = JSON.stringify(existingValue) !== JSON.stringify(value);

    if (isNewOrUpdated) {
      newItems.push({
        key,
        value,
        isNew: true,
        addedAt: now,
      });
    }

    candidate[key] = value;
  }

  if (!isCurrentKnowledgeData(candidate)) {
    return [];
  }

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
