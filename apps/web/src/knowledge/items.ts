import { KNOWLEDGE_KEYS, type KnowledgeData, type KnowledgeItem } from './types';

const knownKeys: ReadonlySet<string> = new Set(KNOWLEDGE_KEYS);
const defaultMetadata = () => ({ isNew: false, addedAt: 0 });

/** Project typed data after admission, or an explicitly typed component fixture. */
export function knowledgeItemsFromData(
  data: KnowledgeData,
  metadata: (key: keyof KnowledgeData) => Pick<KnowledgeItem, 'isNew' | 'addedAt'> = defaultMetadata,
  keys: readonly (keyof KnowledgeData)[] = Object.keys(data).filter((key): key is keyof KnowledgeData =>
    knownKeys.has(key),
  ),
): readonly KnowledgeItem[] {
  // Each value is read through its own key. TypeScript's array projection loses
  // that correlation, so restore it only at this typed-data boundary.
  return keys.flatMap((key) => {
    const value = data[key];
    if (value === undefined || value === null) return [];
    const { isNew, addedAt } = metadata(key);
    return [{ key, value, isNew, addedAt }];
  }) as readonly KnowledgeItem[];
}
