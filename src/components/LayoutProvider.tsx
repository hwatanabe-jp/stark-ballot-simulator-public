'use client';

import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import {
  KnowledgeHighlightProvider,
  KnowledgePanel,
  VerificationTabProvider,
  useVerificationTab,
  type VerificationTabId,
} from '@/components/knowledge';
import { KNOWLEDGE_GROUPS, type KnowledgeGroupDefinition } from '@/components/knowledge/KnowledgeGroup';
import { StepIndicatorHorizontal } from '@/components/step';
import { useLanguage, useMediaQuery, useDockingPanel } from '@/lib/hooks';
import {
  clearKnowledge,
  type KnowledgeData,
  VERIFY_BOT_KNOWLEDGE_KEYS,
  VERIFY_MY_KNOWLEDGE_KEYS,
} from '@/lib/knowledge';
import { clearSessionData } from '@/lib/session';

/**
 * LayoutProvider - 「透明な信頼」デザインシステム
 *
 * グローバルレイアウト:
 * - Header: sticky、ロゴ、言語切替、やり直しボタン
 * - Step Indicator: 横型ステップナビ（sticky）
 * - Main: コンテンツエリア（max-w-2xl / /verify は max-w-4xl）
 * - KnowledgePanel: ドッキング浮遊パネル
 *   - デスクトップ: 画面下部に浮遊、スクロールでドッキング
 *   - モバイル: ボトムシート（従来動作）
 * - Footer: 著作権、利用規約、プライバシーポリシー、GitHub
 *
 * レスポンシブ:
 * - モバイル/デスクトップ共通でシングルカラム
 * - 640px以上: ドッキング浮遊パネル
 * - 640px未満: ボトムシート
 */

const cn = (...classes: Array<string | false | undefined>): string => {
  return classes.filter(Boolean).join(' ');
};

const FOOTER_HEIGHT_FALLBACK_PX = 72;
const FLOATING_PANEL_OFFSET_PADDING_PX = 16;
const FLOATING_PANEL_BOTTOM_GAP_PX = FOOTER_HEIGHT_FALLBACK_PX + FLOATING_PANEL_OFFSET_PADDING_PX;
// Keep in sync with BOTTOM_SHEET_MIN_HEIGHT in KnowledgePanel.
const MOBILE_BOTTOM_SHEET_SPACER_PX = 60;

const ROUTE_GROUPS: Partial<Record<string, Array<KnowledgeGroupDefinition['id']>>> = {
  '/vote': ['session', 'vote'],
  '/aggregate': ['session', 'vote'],
  '/result': ['session', 'vote', 'result', 'public'],
};

const getVisibleKeys = (pathname: string, verifyTab: VerificationTabId): Array<keyof KnowledgeData> => {
  if (pathname === '/') {
    return [];
  }
  if (pathname === '/verify' || pathname.startsWith('/verify/')) {
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
  const router = useRouter();
  const pathname = usePathname();
  const isMobile = useMediaQuery('(max-width: 639px)');
  const { activeTab, setActiveTab } = useVerificationTab();
  const [floatingScrollTop, setFloatingScrollTop] = useState(0);
  const [floatingExpandedGroups, setFloatingExpandedGroups] = useState<Array<KnowledgeGroupDefinition['id']>>([]);
  const prevPathRef = useRef<string | null>(null);

  // ドッキング浮遊パネル: デスクトップのみ有効
  const floatingBottomOffsetPx = FLOATING_PANEL_BOTTOM_GAP_PX;
  const dockingOffsetPx = floatingBottomOffsetPx;
  const { isDocked, dockZoneRef, panelRef, isFloating, floatingPanelHeight } = useDockingPanel({
    enabled: !isMobile,
    offsetPx: dockingOffsetPx,
    minDockScrollPx: dockingOffsetPx,
  });

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
    clearSessionData();
    // Clear knowledge store
    clearKnowledge();
    setActiveTab('my');
    // Navigate to home
    router.push('/');
  }, [router, setActiveTab]);

  const isVerifyRoute = pathname === '/verify' || pathname.startsWith('/verify/');
  const isHomeRoute = pathname === '/';
  const isLegalRoute =
    pathname === '/privacy' ||
    pathname.startsWith('/privacy/') ||
    pathname === '/terms' ||
    pathname.startsWith('/terms/');
  const contentWidthClass = isVerifyRoute
    ? 'max-w-4xl'
    : isLegalRoute
      ? 'max-w-3xl'
      : isHomeRoute
        ? 'max-w-none'
        : 'max-w-2xl';
  const homeBackgroundClass = isHomeRoute ? 'bg-paper-texture' : undefined;
  const homeLayoutClass = isHomeRoute ? 'flex items-center justify-center' : undefined;
  const showKnowledgePanel = pathname !== '/' && !isLegalRoute;
  const showStepIndicator = !isLegalRoute;
  const visibleKeys = useMemo(() => getVisibleKeys(pathname, activeTab), [pathname, activeTab]);
  const floatingSpacerHeight = floatingPanelHeight > 0 ? floatingPanelHeight + floatingBottomOffsetPx : 0;
  const dockedSpacerHeight = floatingBottomOffsetPx;
  const spacerHeight = isFloating ? floatingSpacerHeight : isDocked ? dockedSpacerHeight : 0;

  return (
    <div className="flex flex-col min-h-screen bg-paper-warm">
      {/* Header */}
      <Header onReset={handleReset} showReset={!isLegalRoute} />

      {/* Step indicator */}
      {showStepIndicator && <StepIndicatorHorizontal language={language} onReset={handleReset} />}

      {/* Main content */}
      <main
        className={cn(
          'flex-1 w-full',
          contentWidthClass,
          'mx-auto px-4 py-8 lg:px-8',
          homeBackgroundClass,
          homeLayoutClass,
          isMobile && 'pbe-24',
        )}
      >
        {children}

        {/* モバイル: 従来のボトムシート表示 */}
        {showKnowledgePanel && isMobile && <KnowledgePanel filterKeys={visibleKeys} variant="bottomSheet" />}

        {/* デスクトップ: メイン終端のドッキング判定用センチネル */}
        {showKnowledgePanel && !isMobile && (
          <div
            ref={dockZoneRef}
            aria-hidden="true"
            data-testid="knowledge-dock-sentinel"
            className="h-px w-full pointer-events-none"
          />
        )}

        {/* デスクトップ: ドックゾーン（ドッキング時のパネル配置場所） */}
        {showKnowledgePanel && !isMobile && (
          <div className="mt-8">
            {isDocked && (
              <KnowledgePanel
                className="knowledge-docked"
                filterKeys={visibleKeys}
                variant="floating"
                dockState="docked"
                defaultExpandedGroups={floatingExpandedGroups}
              />
            )}
          </div>
        )}

        {/* デスクトップ: スクロール余白（浮遊時はパネル分、ドッキング時は下端余白分） */}
        {showKnowledgePanel && !isMobile && spacerHeight > 0 && (
          <div
            aria-hidden="true"
            data-testid="knowledge-panel-spacer"
            className="pointer-events-none"
            style={{ height: `${spacerHeight}px` }}
          />
        )}
      </main>

      {/* デスクトップ: 浮遊パネル（画面下部に固定） */}
      {showKnowledgePanel && !isMobile && isFloating && (
        <div
          ref={panelRef}
          className={cn(
            'knowledge-floating-container',
            'fixed inset-x-0 z-30',
            'flex justify-center',
            'pointer-events-none',
          )}
          style={
            {
              '--knowledge-floating-offset': `${floatingBottomOffsetPx}px`,
            } as CSSProperties
          }
        >
          <div className={cn('w-full px-4 lg:px-8', contentWidthClass, 'pointer-events-auto')}>
            <KnowledgePanel
              className="knowledge-floating"
              filterKeys={visibleKeys}
              variant="floating"
              dockState="floating"
              floatingScrollTop={floatingScrollTop}
              onFloatingScrollTopChange={setFloatingScrollTop}
              onExpandedGroupsChange={setFloatingExpandedGroups}
            />
          </div>
        </div>
      )}

      {/* Footer */}
      <Footer />
      {showKnowledgePanel && isMobile && (
        <div
          aria-hidden="true"
          data-testid="knowledge-bottom-sheet-spacer"
          className="pointer-events-none"
          style={{ height: `calc(${MOBILE_BOTTOM_SHEET_SPACER_PX}px + env(safe-area-inset-bottom, 0px))` }}
        />
      )}
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
