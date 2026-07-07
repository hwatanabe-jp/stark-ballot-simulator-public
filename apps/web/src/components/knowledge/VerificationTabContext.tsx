'use client';

import { createContext, useContext, useMemo, useState, type ReactElement, type ReactNode } from 'react';

export type VerificationTabId = 'my' | 'bot';

type VerificationTabContextValue = {
  activeTab: VerificationTabId;
  setActiveTab: (tab: VerificationTabId) => void;
};

const VerificationTabContext = createContext<VerificationTabContextValue | undefined>(undefined);

interface VerificationTabProviderProps {
  children: ReactNode;
  initialTab?: VerificationTabId;
}

export function VerificationTabProvider({ children, initialTab = 'my' }: VerificationTabProviderProps): ReactElement {
  const [activeTab, setActiveTab] = useState<VerificationTabId>(initialTab);
  const value = useMemo(() => ({ activeTab, setActiveTab }), [activeTab]);

  return <VerificationTabContext.Provider value={value}>{children}</VerificationTabContext.Provider>;
}

export function useVerificationTab(): VerificationTabContextValue {
  const context = useContext(VerificationTabContext);
  const [fallbackTab, setFallbackTab] = useState<VerificationTabId>('my');

  return context ?? { activeTab: fallbackTab, setActiveTab: setFallbackTab };
}
