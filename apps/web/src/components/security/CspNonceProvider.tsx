'use client';

import { createContext, useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';

const CspNonceContext = createContext<string | null>(null);

export function CspNonceProvider({ nonce, children }: { nonce: string | null; children: ReactNode }): ReactElement {
  return <CspNonceContext.Provider value={nonce}>{children}</CspNonceContext.Provider>;
}

export function useCspNonce(): string | null {
  return useContext(CspNonceContext);
}
