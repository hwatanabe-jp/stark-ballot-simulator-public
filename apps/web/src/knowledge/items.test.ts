import { describe, expect, it } from 'vitest';
import { knowledgeItemsFromData } from './items';

describe('knowledgeItemsFromData', () => {
  it('takes values from their data keys even when metadata includes unrelated properties', () => {
    const items = knowledgeItemsFromData({ 'user.choice': 'A' }, () => ({
      key: 'receiptPublication',
      value: { receiptHash: 123 },
      isNew: true,
      addedAt: 42,
    }));

    expect(items).toEqual([{ key: 'user.choice', value: 'A', isNew: true, addedAt: 42 }]);
  });
});
