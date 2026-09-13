import { useSyncExternalStore } from 'react';
import {
  getKnowledgeItems,
  HIDDEN_KNOWLEDGE_KEYS,
  subscribeToKnowledge,
  type KnowledgeData,
  type KnowledgeItem,
} from '@stark-ballot/web/knowledge';
import { KNOWLEDGE_STORAGE_KEY, SESSION_STORAGE_KEY } from '@stark-ballot/web/session/storage';

const hiddenKeys: ReadonlySet<keyof KnowledgeData> = new Set(HIDDEN_KNOWLEDGE_KEYS);
const emptyItems: readonly KnowledgeItem[] = [];
let cachedItems = emptyItems;
let cachedSnapshot = '[]';

function getSnapshot(): readonly KnowledgeItem[] {
  // Admission still runs on every read, including renders without a storage event.
  const items = getKnowledgeItems();
  const snapshot = JSON.stringify(items);
  if (snapshot !== cachedSnapshot) {
    cachedSnapshot = snapshot;
    cachedItems = items;
  }
  return cachedItems;
}

function subscribe(onChange: () => void): () => void {
  const unsubscribe = subscribeToKnowledge(onChange);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === KNOWLEDGE_STORAGE_KEY || event.key === SESSION_STORAGE_KEY) onChange();
  };
  window.addEventListener('storage', handleStorage);
  return () => {
    unsubscribe();
    window.removeEventListener('storage', handleStorage);
  };
}

const getServerSnapshot = () => emptyItems;
const subscribeToFixture = () => () => undefined;

/** Retain only existing, permitted values, in the caller's display order. */
export function selectKnowledgeItems(
  items: readonly KnowledgeItem[],
  filterKeys: ReadonlyArray<keyof KnowledgeData>,
): KnowledgeItem[] {
  const byKey = new Map(items.map((item) => [item.key, item]));
  return [...new Set(filterKeys)].flatMap((key) => {
    // The old label can confuse modified tallies with excluded ballots.
    if (hiddenKeys.has(key) || key === 'tally.tamperedCount') return [];
    const item = byKey.get(key);
    return item && item.value !== undefined && item.value !== null ? [item] : [];
  });
}

/** Every live refresh uses the existing session-bound snapshot admission. */
export function useKnowledgeItems(externalItems?: readonly KnowledgeItem[]): readonly KnowledgeItem[] {
  return useSyncExternalStore(
    externalItems === undefined ? subscribe : subscribeToFixture,
    externalItems === undefined ? getSnapshot : () => externalItems,
    externalItems === undefined ? getServerSnapshot : () => externalItems,
  );
}
