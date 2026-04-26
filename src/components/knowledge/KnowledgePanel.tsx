'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { Scroll, Bot } from 'lucide-react';
import {
  type KnowledgeData,
  type KnowledgeItem as KnowledgeItemType,
  HIDDEN_KNOWLEDGE_KEYS,
  KNOWLEDGE_NEW_ITEM_THRESHOLD_MS,
  getKnowledgeItems,
  subscribeToKnowledge,
} from '@/lib/knowledge';
import { useTranslation } from '@/lib/hooks/useTranslation';
import { useKnowledgeHighlight } from './KnowledgeHighlightContext';
import { useVerificationTab } from './VerificationTabContext';
import { KnowledgeGroup, type KnowledgeGroupDefinition, KNOWLEDGE_GROUPS } from './KnowledgeGroup';

interface KnowledgePanelProps {
  /** Panel title override */
  title?: string;
  /** Additional CSS classes */
  className?: string;
  /** Explicit keys to display (layout-driven) */
  filterKeys?: ReadonlyArray<keyof KnowledgeData>;
  /** Default expanded groups (layout-driven) */
  defaultExpandedGroups?: Array<KnowledgeGroupDefinition['id']>;
  /**
   * Panel variant
   * - inline: 従来のインライン表示
   * - bottomSheet: モバイル用ボトムシート
   * - floating: デスクトップ用浮遊パネル（ドッキング対応）
   */
  variant?: 'inline' | 'bottomSheet' | 'floating';
  /** Floating variant dock state (layout-driven) */
  dockState?: 'floating' | 'docked';
  /** Floating scroll position (layout-driven) */
  floatingScrollTop?: number;
  /** Floating scroll sync callback */
  onFloatingScrollTopChange?: (scrollTop: number) => void;
  /** Expanded groups sync callback */
  onExpandedGroupsChange?: (groupIds: Array<KnowledgeGroupDefinition['id']>) => void;
  /** Custom items to display (overrides store) */
  items?: KnowledgeItemType[];
}

/**
 * Get localized label for a knowledge key using i18n translations
 */
function getItemLabel(key: keyof KnowledgeData, t: (key: string) => string): string {
  const translationKey = `knowledge.items.${key}`;
  const translated = t(translationKey);
  // Fallback: if translation returns the key itself, use the raw key
  return translated !== translationKey ? translated : key;
}

/**
 * ボトムシート設定
 *
 * @see docs/current/ui-redesign/layout-architecture.md セクション4.7
 */
/** 最小高さ (ヘッダーのみ表示) */
const BOTTOM_SHEET_MIN_HEIGHT = 60;
/** 中間高さ比率 (ビューポート高さの40%) */
const BOTTOM_SHEET_MID_RATIO = 0.4;
/** 最大高さ比率 (ビューポート高さの80%) */
const BOTTOM_SHEET_MAX_RATIO = 0.8;
/** ドラッグ操作とクリック操作を区別するしきい値 (px) */
const BOTTOM_SHEET_DRAG_THRESHOLD = 4;

type BottomSheetState = 'collapsed' | 'mid' | 'expanded';

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const getNearestBottomSheetState = (height: number, snapPoints: Record<BottomSheetState, number>): BottomSheetState => {
  const entries: Array<[BottomSheetState, number]> = [
    ['collapsed', snapPoints.collapsed],
    ['mid', snapPoints.mid],
    ['expanded', snapPoints.expanded],
  ];
  return entries.reduce((closest, [state, point]) => {
    const closestDistance = Math.abs(height - snapPoints[closest]);
    const currentDistance = Math.abs(height - point);
    return currentDistance < closestDistance ? state : closest;
  }, 'collapsed' as BottomSheetState);
};

/**
 * Knowledge Panel - Displays user-known information
 *
 * Design spec (design-spec-transparent-trust.md):
 * - Background: knowledge-bg (#fffef5) - parchment style
 * - Border: knowledge-border (#d4c9a8) - aged paper edge
 * - Left border: sayagata pattern (4px, via CSS utility)
 * - Title: Primary font, semibold, knowledge-accent color
 * - Items: Dashed bottom borders, ink-spread animation for new
 * - ARIA: aria-live="polite" for screen reader updates
 */
export function KnowledgePanel({
  title,
  className = '',
  filterKeys,
  defaultExpandedGroups,
  variant = 'inline',
  items: externalItems,
  dockState,
  floatingScrollTop,
  onFloatingScrollTopChange,
  onExpandedGroupsChange,
}: KnowledgePanelProps): React.ReactElement {
  const { t, language } = useTranslation();
  const { highlightedKeys } = useKnowledgeHighlight();
  const { activeTab } = useVerificationTab();
  const [storeItems, setStoreItems] = useState<KnowledgeItemType[]>(() => getKnowledgeItems());
  const [expandedGroups, setExpandedGroups] = useState<Set<KnowledgeGroupDefinition['id']>>(
    new Set(defaultExpandedGroups ?? []),
  );
  const isBottomSheet = variant === 'bottomSheet';
  const isFloating = variant === 'floating';
  const isFloatingActive = dockState === 'floating';
  const [bottomSheetState, setBottomSheetState] = useState<BottomSheetState>('collapsed');
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [viewportHeight, setViewportHeight] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerHeight : 0,
  );
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const suppressClickRef = useRef(false);
  const itemsContainerRef = useRef<HTMLDivElement | null>(null);
  const prevDockStateRef = useRef<typeof dockState>(undefined);

  useEffect(() => {
    if (!onExpandedGroupsChange) {
      return;
    }
    onExpandedGroupsChange(Array.from(expandedGroups));
  }, [expandedGroups, onExpandedGroupsChange]);

  // Subscribe to knowledge updates
  useEffect(() => {
    if (externalItems) {
      return;
    }

    const unsubscribe = subscribeToKnowledge(() => {
      setStoreItems(getKnowledgeItems());
    });

    return unsubscribe;
  }, [externalItems]);

  // Refresh "new" state after the threshold expires
  useEffect(() => {
    if (externalItems) {
      return;
    }
    const nextExpiry = storeItems
      .filter((item) => item.isNew)
      .map((item) => item.addedAt + KNOWLEDGE_NEW_ITEM_THRESHOLD_MS)
      .reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);

    if (!Number.isFinite(nextExpiry)) {
      return;
    }

    const delay = Math.max(0, nextExpiry - Date.now());
    const timeoutId = window.setTimeout(() => {
      setStoreItems(getKnowledgeItems());
    }, delay);

    return () => window.clearTimeout(timeoutId);
  }, [storeItems, externalItems]);

  useEffect(() => {
    if (!isFloating) {
      prevDockStateRef.current = dockState;
      return;
    }
    if (dockState !== 'floating') {
      prevDockStateRef.current = dockState;
      return;
    }
    if (floatingScrollTop === undefined) {
      prevDockStateRef.current = dockState;
      return;
    }

    const container = itemsContainerRef.current;
    if (!container) {
      prevDockStateRef.current = dockState;
      return;
    }

    const wasDocked = prevDockStateRef.current === 'docked' || prevDockStateRef.current === undefined;
    if (wasDocked) {
      const maxScrollTop = Math.max(container.scrollHeight - container.clientHeight, 0);
      const nextScrollTop = Math.min(Math.max(floatingScrollTop, 0), maxScrollTop);
      if (Math.abs(container.scrollTop - nextScrollTop) > 1) {
        container.scrollTop = nextScrollTop;
      }
    }

    prevDockStateRef.current = dockState;
  }, [dockState, floatingScrollTop, isFloating]);

  useEffect(() => {
    if (!isBottomSheet) {
      return;
    }

    const updateViewportHeight = () => {
      setViewportHeight(window.innerHeight || 0);
    };

    window.addEventListener('resize', updateViewportHeight);
    return () => window.removeEventListener('resize', updateViewportHeight);
  }, [isBottomSheet]);

  const snapPoints = useMemo<Record<BottomSheetState, number>>(() => {
    if (!viewportHeight) {
      return {
        collapsed: BOTTOM_SHEET_MIN_HEIGHT,
        mid: BOTTOM_SHEET_MIN_HEIGHT,
        expanded: BOTTOM_SHEET_MIN_HEIGHT,
      };
    }

    return {
      collapsed: BOTTOM_SHEET_MIN_HEIGHT,
      mid: Math.max(Math.round(viewportHeight * BOTTOM_SHEET_MID_RATIO), BOTTOM_SHEET_MIN_HEIGHT),
      expanded: Math.max(Math.round(viewportHeight * BOTTOM_SHEET_MAX_RATIO), BOTTOM_SHEET_MIN_HEIGHT),
    };
  }, [viewportHeight]);

  const hiddenKeySet = useMemo(() => new Set(HIDDEN_KNOWLEDGE_KEYS), []);

  const items = externalItems ?? storeItems;
  const sheetHeight = dragHeight ?? snapPoints[bottomSheetState];

  const visibleKeys = useMemo<ReadonlyArray<keyof KnowledgeData>>(() => {
    if (filterKeys !== undefined) {
      return filterKeys;
    }
    return KNOWLEDGE_GROUPS.flatMap((group) => group.keys);
  }, [filterKeys]);

  const visibleKeySet = useMemo(() => new Set(visibleKeys), [visibleKeys]);

  const visibleGroups = useMemo(() => {
    if (filterKeys === undefined) {
      return KNOWLEDGE_GROUPS;
    }
    return KNOWLEDGE_GROUPS.filter((group) => group.keys.some((key) => visibleKeySet.has(key)));
  }, [filterKeys, visibleKeySet]);

  // Filter and sort items
  const groupedItems = useMemo(() => {
    const filtered = items.filter((item) => visibleKeySet.has(item.key) && !hiddenKeySet.has(item.key));

    return visibleGroups.map((group) => {
      const order = new Map(group.keys.map((key, index) => [key, index]));
      const groupItems = filtered
        .filter((item) => group.keys.includes(item.key))
        .sort((a, b) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999));
      return { group, items: groupItems };
    });
  }, [items, visibleGroups, visibleKeySet, hiddenKeySet]);

  const hasBotItems = useMemo(() => items.some((item) => item.key.startsWith('bot.')), [items]);
  const isBotView = useMemo(() => (filterKeys ?? []).some((key) => key.startsWith('bot.')), [filterKeys]);
  const panelTitle =
    title ?? (activeTab === 'bot' && hasBotItems && isBotView ? t('knowledge.titleBot') : t('knowledge.title'));
  const emptyLabel = t('knowledge.empty');
  const hasItems = groupedItems.some((group) => group.items.length > 0);
  const currentGroup = useMemo((): KnowledgeGroupDefinition['id'] | undefined => {
    if (filterKeys === undefined) {
      return undefined;
    }
    if (activeTab === 'bot' && visibleKeySet.has('bot.id')) {
      return 'bot';
    }
    if (visibleKeySet.has('user.voteReceipt') || visibleKeySet.has('user.merklePath')) {
      return 'verify';
    }
    if (visibleKeySet.has('proofBundleStatus')) {
      return 'result';
    }
    if (visibleKeySet.has('user.choice') || visibleKeySet.has('botVotesStatus')) {
      return 'vote';
    }
    if (visibleKeySet.has('electionId') || visibleKeySet.has('electionConfigHash') || visibleKeySet.has('logId')) {
      return 'session';
    }
    return undefined;
  }, [activeTab, filterKeys, visibleKeySet]);

  const handleToggleGroup = (groupId: KnowledgeGroupDefinition['id']) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const handleExpandAll = () => {
    const next = new Set(visibleGroups.map((group) => group.id));
    setExpandedGroups(next);
  };

  const handleCollapseAll = () => {
    const next = new Set<KnowledgeGroupDefinition['id']>();
    setExpandedGroups(next);
  };

  const handleBottomSheetPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!isBottomSheet) {
      return;
    }
    suppressClickRef.current = false;
    dragRef.current = { startY: event.clientY, startHeight: sheetHeight };
    setIsDragging(true);
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const handleBottomSheetPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!isBottomSheet || !dragRef.current) {
      return;
    }
    const delta = dragRef.current.startY - event.clientY;
    if (Math.abs(delta) > BOTTOM_SHEET_DRAG_THRESHOLD) {
      suppressClickRef.current = true;
    }
    const nextHeight = clamp(dragRef.current.startHeight + delta, snapPoints.collapsed, snapPoints.expanded);
    setDragHeight(nextHeight);
  };

  const handleBottomSheetPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!isBottomSheet || !dragRef.current) {
      return;
    }
    const delta = dragRef.current.startY - event.clientY;
    const nextHeight = clamp(dragRef.current.startHeight + delta, snapPoints.collapsed, snapPoints.expanded);
    const nextState = getNearestBottomSheetState(nextHeight, snapPoints);
    setBottomSheetState(nextState);
    setDragHeight(null);
    dragRef.current = null;
    setIsDragging(false);
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleBottomSheetHandleClick = () => {
    if (!isBottomSheet) {
      return;
    }
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const nextState: BottomSheetState =
      bottomSheetState === 'collapsed' ? 'mid' : bottomSheetState === 'mid' ? 'expanded' : 'collapsed';
    setBottomSheetState(nextState);
    setDragHeight(null);
  };

  // バリアント別のベーススタイル
  const getVariantStyles = (): string => {
    if (isBottomSheet) {
      return 'fixed inset-x-0 inset-be-0 z-40 flex flex-col bg-[var(--color-knowledge-bg)] border-bs border-[var(--color-knowledge-border)] rounded-t-2xl shadow-lg';
    }
    if (isFloating) {
      // floating: インラインと同じ見た目だが、高さ制限とスクロールはCSSクラスで制御
      return 'bg-[var(--color-knowledge-bg)] border border-[var(--color-knowledge-border)] rounded-xl p-5 relative border-sayagata';
    }
    // inline: 従来のスタイル
    return 'bg-[var(--color-knowledge-bg)] border border-[var(--color-knowledge-border)] rounded-xl p-5 relative border-sayagata';
  };

  const handleFloatingScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!isFloating || !isFloatingActive) {
      return;
    }
    onFloatingScrollTopChange?.(event.currentTarget.scrollTop);
  };

  return (
    <aside
      className={cn(getVariantStyles(), className)}
      style={
        isBottomSheet
          ? {
              height: sheetHeight,
              transition: isDragging ? 'none' : 'height 200ms ease',
            }
          : undefined
      }
      aria-live="polite"
      aria-label={panelTitle}
      data-variant={variant}
      data-testid={isBottomSheet ? 'knowledge-bottom-sheet' : undefined}
    >
      {isBottomSheet && (
        <button
          type="button"
          className="flex items-center justify-center py-2 cursor-grab active:cursor-grabbing"
          style={{ touchAction: 'none' }}
          onPointerDown={handleBottomSheetPointerDown}
          onPointerMove={handleBottomSheetPointerMove}
          onPointerUp={handleBottomSheetPointerUp}
          onPointerCancel={handleBottomSheetPointerUp}
          onClick={handleBottomSheetHandleClick}
          aria-expanded={bottomSheetState !== 'collapsed'}
          data-testid="knowledge-bottom-sheet-handle"
        >
          <span className="h-1.5 w-10 rounded-full bg-ink-200" aria-hidden="true" />
        </button>
      )}

      {/* Panel title */}
      <div className={cn('flex items-center justify-between gap-3', isBottomSheet ? 'px-4 pb-3' : 'mb-4')}>
        {isBottomSheet ? (
          <h3 className="font-primary text-sm font-semibold text-[var(--color-knowledge-accent)]">{panelTitle}</h3>
        ) : (
          <div className="knowledge-panel-title-wrapper flex-1 min-w-0">
            <div
              className={cn('knowledge-panel-title my-knowledge', !isBotView ? 'active' : 'inactive')}
              aria-hidden={isBotView}
            >
              <Scroll className="knowledge-panel-title-icon" aria-hidden="true" />
              {t('knowledge.title')}
            </div>
            <div
              className={cn('knowledge-panel-title bot-knowledge', isBotView ? 'active' : 'inactive')}
              aria-hidden={!isBotView}
            >
              <Bot className="knowledge-panel-title-icon" aria-hidden="true" />
              {t('knowledge.titleBot')}
            </div>
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExpandAll}
            className="text-[0.75rem] text-text-muted hover:text-ink-900 transition-colors"
          >
            {t('knowledge.controls.expand')}
          </button>
          <span className="text-text-muted">/</span>
          <button
            type="button"
            onClick={handleCollapseAll}
            className="text-[0.75rem] text-text-muted hover:text-ink-900 transition-colors"
          >
            {t('knowledge.controls.collapse')}
          </button>
        </div>
      </div>

      {/* Knowledge items */}
      <div
        ref={itemsContainerRef}
        onScroll={isFloating ? handleFloatingScroll : undefined}
        className={cn(isBottomSheet && 'flex-1 overflow-y-auto px-4 pb-4', isFloating && 'knowledge-items-container')}
      >
        {hasItems ? (
          <div className="space-y-2">
            {groupedItems.map(({ group, items: groupItems }) => (
              <KnowledgeGroup
                key={group.id}
                group={group}
                items={groupItems}
                language={language === 'ja' ? 'ja' : 'en'}
                expanded={expandedGroups.has(group.id)}
                onToggle={handleToggleGroup}
                highlightedKeys={highlightedKeys as Array<keyof KnowledgeData>}
                isCurrent={group.id === currentGroup}
                emptyLabel={emptyLabel}
                getLabel={(key) => getItemLabel(key, t)}
              />
            ))}
          </div>
        ) : (
          <p className="text-text-muted text-sm text-center py-4 italic">{t('knowledge.empty')}</p>
        )}
      </div>
    </aside>
  );
}

const cn = (...classes: Array<string | false | undefined>): string => classes.filter(Boolean).join(' ');
