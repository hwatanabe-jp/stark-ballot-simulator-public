import { useLayoutEffect } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearBotKnowledge, saveKnowledgeData, type KnowledgeItem } from '@stark-ballot/web/knowledge';
import { KNOWLEDGE_STORAGE_KEY } from '@stark-ballot/web/session/storage';
import { useKnowledgeItems } from './useKnowledgeItems';

describe('useKnowledgeItems', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
  });

  afterEach(() => vi.restoreAllMocks());

  it('shares a stable admitted snapshot and ignores unchanged storage notifications', () => {
    saveKnowledgeData({ sessionId: 'session-a', 'user.choice': 'A' });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return [useKnowledgeItems(), useKnowledgeItems()];
    });
    const snapshot = result.current[0];
    expect(result.current[1]).toBe(snapshot);
    const initialRenders = renders;

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: KNOWLEDGE_STORAGE_KEY }));
    });
    expect(renders).toBe(initialRenders);
    expect(result.current[0]).toBe(snapshot);

    act(() => {
      saveKnowledgeData({ 'user.choice': 'B' });
    });
    expect(result.current[0]).not.toBe(snapshot);
    expect(result.current[1]).toBe(result.current[0]);
    expect(result.current[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'user.choice', value: 'B' })]),
    );
  });

  it('commits the live snapshot immediately when leaving an isolated fixture', () => {
    saveKnowledgeData({ sessionId: 'session-a', 'user.choice': 'A' });
    const fixture: KnowledgeItem[] = [{ key: 'user.choice', value: 'E', isNew: false, addedAt: 0 }];
    const committed: Array<readonly KnowledgeItem[]> = [];
    function Observer({ items }: { items?: readonly KnowledgeItem[] }): null {
      const snapshot = useKnowledgeItems(items);
      useLayoutEffect(() => {
        committed.push(snapshot);
      });
      return null;
    }
    const { rerender } = render(<Observer items={fixture} />);
    expect(committed.at(-1)).toBe(fixture);
    act(() => {
      saveKnowledgeData({ 'user.choice': 'B' });
    });
    expect(committed).toHaveLength(1);

    committed.length = 0;
    rerender(<Observer />);
    expect(committed.length).toBeGreaterThan(0);
    for (const snapshot of committed) {
      expect(snapshot.find((item) => item.key === 'user.choice')?.value).toBe('B');
    }
  });

  it('refreshes mounted consumers when bot evidence is cleared and retains user evidence', () => {
    saveKnowledgeData({ sessionId: 'session-a', 'user.choice': 'A', 'bot.id': 3, 'bot.choice': 'B' });
    const { result } = renderHook(() => useKnowledgeItems());
    expect(result.current.some((item) => item.key === 'bot.id')).toBe(true);
    act(() => clearBotKnowledge());
    expect(result.current.some((item) => item.key.startsWith('bot.'))).toBe(false);
    expect(result.current.find((item) => item.key === 'user.choice')?.value).toBe('A');
  });
});
