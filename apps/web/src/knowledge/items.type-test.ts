import type { KnowledgeItem } from './types';
import { knowledgeItemsFromData } from './items';
import type { useKnowledgeItems } from '../components/knowledge/useKnowledgeItems';

const choice: KnowledgeItem = { key: 'user.choice', value: 'A', isNew: false, addedAt: 0 };
// @ts-expect-error A vote choice cannot carry a receipt publication object.
const mismatchedValue: KnowledgeItem = {
  key: 'user.choice',
  value: { receiptHash: 'hash', boardIndex: 0 },
  isNew: false,
  addedAt: 0,
};
const malformedPublication: KnowledgeItem = {
  key: 'receiptPublication',
  // @ts-expect-error A receipt publication requires a string receipt hash.
  value: { receiptHash: 123, boardIndex: 0 },
  isNew: false,
  addedAt: 0,
};
// @ts-expect-error Fixture projection preserves the same key/value contract.
knowledgeItemsFromData({ 'user.choice': 'Z' });

function checkSnapshotReadonly(items: ReturnType<typeof useKnowledgeItems>): void {
  // @ts-expect-error Consumers cannot append to the shared snapshot.
  items.push(choice);
  const item = items[0];
  if (!item) return;
  // @ts-expect-error Display metadata is read-only too.
  item.isNew = true;
  if (item.key === 'tally.counts') {
    // @ts-expect-error Nested display values cannot be changed in place.
    item.value.A = 100;
  }
  if (item.key === 'user.merklePath') {
    // @ts-expect-error Proof nodes remain read-only through the display projection.
    item.value.merklePath.push('changed');
  }
  // @ts-expect-error Shared snapshots cannot replace a value.
  item.value = 'changed';
  // @ts-expect-error Shared snapshots cannot replace a key.
  item.key = 'electionId';
}

void choice;
void mismatchedValue;
void malformedPublication;
void checkSnapshotReadonly;
