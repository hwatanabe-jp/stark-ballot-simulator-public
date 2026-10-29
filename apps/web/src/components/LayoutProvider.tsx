'use client';

import { useEffect, useCallback, useMemo, useRef } from 'react';
import { Header } from '@stark-ballot/web/components/layout/Header';
import { Footer } from '@stark-ballot/web/components/layout/Footer';
import {
  KnowledgeHighlightProvider,
  KnowledgePanel,
  VerificationTabProvider,
  useVerificationTab,
  type VerificationTabId,
} from '@stark-ballot/web/components/knowledge';
import { KNOWLEDGE_GROUPS, type KnowledgeGroupDefinition } from '@stark-ballot/web/components/knowledge/KnowledgeGroup';
import { StepIndicatorHorizontal } from '@stark-ballot/web/components/step';
import { useLanguage } from '@stark-ballot/web/hooks';
import {
  clearKnowledge,
  type KnowledgeData,
  VERIFY_BOT_KNOWLEDGE_KEYS,
  VERIFY_MY_KNOWLEDGE_KEYS,
} from '@stark-ballot/web/knowledge';
import { clearSession } from '@stark-ballot/web/session';
import { useAppPathname, useAppRouter } from '@stark-ballot/web/navigation/appNavigation';
import './LayoutProvider.css';

const ROUTE_GROUPS: Partial<Record<string, Array<KnowledgeGroupDefinition['id']>>> = {
  '/vote': ['session', 'vote'],
  '/aggregate': ['session', 'vote'],
  '/result': ['session', 'vote', 'result', 'public'],
};

function isRouteOrChild(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

function resolveLayoutRoute(pathname: string) {
  if (pathname === '/') return { page: 'home', isLegal: false, showFlowDetails: false };
  if (isRouteOrChild(pathname, '/verify')) return { page: 'verify', isLegal: false, showFlowDetails: true };
  if (isRouteOrChild(pathname, '/privacy') || isRouteOrChild(pathname, '/terms'))
    return { page: 'legal', isLegal: true, showFlowDetails: false };
  return { page: 'flow', isLegal: false, showFlowDetails: true };
}

const getVisibleKeys = (pathname: string, verifyTab: VerificationTabId): Array<keyof KnowledgeData> => {
  if (pathname === '/') {
    return [];
  }
  if (isRouteOrChild(pathname, '/verify')) {
    return verifyTab === 'bot' ? [...VERIFY_BOT_KNOWLEDGE_KEYS] : [...VERIFY_MY_KNOWLEDGE_KEYS];
  }
  const groupIds = ROUTE_GROUPS[pathname];
  if (!groupIds) {
    return KNOWLEDGE_GROUPS.flatMap((group) => group.keys);
  }
  return groupIds.flatMap((id) => KNOWLEDGE_GROUPS.find((group) => group.id === id)?.keys ?? []);
};

function LayoutShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const { language } = useLanguage();
  const router = useAppRouter();
  const pathname = useAppPathname();
  const { activeTab, setActiveTab } = useVerificationTab();
  const prevPathRef = useRef<string | null>(null);

  // Update html lang attribute
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    if (pathname === '/') {
      clearKnowledge();
      setActiveTab('my');
    }
  }, [pathname, setActiveTab]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (prevPathRef.current === null) {
      prevPathRef.current = pathname;
      return;
    }
    if (prevPathRef.current !== pathname) {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      prevPathRef.current = pathname;
    }
  }, [pathname]);

  // Reset handler - clear session and navigate home
  const handleReset = useCallback(() => {
    clearSession();
    // Clear knowledge store
    clearKnowledge();
    setActiveTab('my');
    // Navigate to home
    router.push('/');
  }, [router, setActiveTab]);

  const layout = resolveLayoutRoute(pathname);
  const visibleKeys = useMemo(() => getVisibleKeys(pathname, activeTab), [pathname, activeTab]);

  return (
    <div className="app-layout" data-layout-page={layout.page}>
      <Header onReset={handleReset} showReset={!layout.isLegal} />
      {layout.showFlowDetails && <StepIndicatorHorizontal language={language} onReset={handleReset} />}
      <main className="app-layout__main">
        {children}
        {layout.showFlowDetails && <KnowledgePanel className="app-layout__knowledge" filterKeys={visibleKeys} />}
      </main>
      <Footer />
    </div>
  );
}

export function LayoutProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <KnowledgeHighlightProvider>
      <VerificationTabProvider>
        <LayoutShell>{children}</LayoutShell>
      </VerificationTabProvider>
    </KnowledgeHighlightProvider>
  );
}
