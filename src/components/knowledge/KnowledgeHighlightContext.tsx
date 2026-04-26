'use client';

import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

interface KnowledgeHighlightContextValue {
  highlightedKeys: string[];
  setHighlightedKeys: (keys: string[]) => void;
}

const KnowledgeHighlightContext = createContext<KnowledgeHighlightContextValue | null>(null);

export function KnowledgeHighlightProvider({
  children,
  initialKeys = [],
}: {
  children: ReactNode;
  initialKeys?: string[];
}): ReactElement {
  const [highlightedKeys, setHighlightedKeys] = useState<string[]>(initialKeys);

  const value = useMemo(
    () => ({
      highlightedKeys,
      setHighlightedKeys,
    }),
    [highlightedKeys],
  );

  return <KnowledgeHighlightContext.Provider value={value}>{children}</KnowledgeHighlightContext.Provider>;
}

export function useKnowledgeHighlight(): KnowledgeHighlightContextValue {
  const context = useContext(KnowledgeHighlightContext);
  if (!context) {
    return {
      highlightedKeys: [],
      setHighlightedKeys: () => undefined,
    };
  }
  return context;
}
