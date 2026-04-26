'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * useDockingPanel - ドッキング浮遊パネル用カスタムフック
 *
 * 動作:
 * 1. 通常時: パネルは画面下部に固定（position: fixed）
 * 2. ドックゾーンが画面内に入ると: ドキュメントフローに合流（position: relative）
 * 3. フッターが見えるようになる
 *
 * Intersection Observerを使用してパフォーマンスを最適化
 */

export interface UseDockingPanelOptions {
  /** ドッキング機能を有効にするか（モバイルでは無効） */
  enabled?: boolean;
  /** 浮遊時の下端オフセット(px) */
  offsetPx?: number;
  /** ドッキング開始に必要なスクロール量(px) */
  minDockScrollPx?: number;
}

export interface UseDockingPanelResult {
  /** パネルがドッキング状態かどうか */
  isDocked: boolean;
  /** ドックゾーン要素へのref */
  dockZoneRef: React.RefCallback<HTMLDivElement>;
  /** パネルコンテナへのref */
  panelRef: React.RefCallback<HTMLDivElement>;
  /** 浮遊状態かどうか（!isDocked && enabled） */
  isFloating: boolean;
  /** 浮遊パネルの高さ（スペーサー用） */
  floatingPanelHeight: number;
}

export function useDockingPanel(options: UseDockingPanelOptions = {}): UseDockingPanelResult {
  const { enabled = true, offsetPx: offsetPxRaw = 0, minDockScrollPx: minDockScrollPxRaw = 0 } = options;
  const offsetPx = Math.max(offsetPxRaw, 0);
  const minDockScrollPx = Math.max(minDockScrollPxRaw, 0);

  const [isDockZoneVisible, setIsDockZoneVisible] = useState(false);
  const [scrollTop, setScrollTop] = useState(() => (typeof window !== 'undefined' ? window.scrollY : 0));
  const [dockZoneNode, setDockZoneNode] = useState<HTMLDivElement | null>(null);
  const [panelNode, setPanelNode] = useState<HTMLDivElement | null>(null);
  const [floatingPanelHeight, setFloatingPanelHeight] = useState(0);

  const dockZoneRef = useCallback((node: HTMLDivElement | null) => {
    setDockZoneNode(node);
  }, []);

  const panelRef = useCallback((node: HTMLDivElement | null) => {
    setPanelNode(node);
    if (!node) {
      setFloatingPanelHeight(0);
      return;
    }
    const height = node.getBoundingClientRect().height;
    setFloatingPanelHeight(Math.ceil(height));
  }, []);

  // Intersection Observerでドックゾーンの可視性を監視
  useEffect(() => {
    if (!enabled || !dockZoneNode || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const rootBounds = entry.rootBounds;
        const fallbackRootBottom = typeof window !== 'undefined' ? window.innerHeight : 0;
        const rootBottom = rootBounds ? rootBounds.bottom : fallbackRootBottom;
        const entryTop = entry.boundingClientRect.top;
        // ドックゾーンが画面内に入ったらドッキング
        // 通過後もドック状態を維持し、スクロールで戻った時に解除する
        setIsDockZoneVisible(entryTop <= rootBottom);
      },
      {
        // rootMargin: パネル高さ + 余白分だけ下端を縮める
        // コンテンツ終端が十分上がった時だけドッキングする
        rootMargin: `0px 0px -${Math.max(floatingPanelHeight + offsetPx, 0)}px 0px`,
        threshold: 0,
      },
    );

    observer.observe(dockZoneNode);

    return () => {
      observer.disconnect();
    };
  }, [dockZoneNode, enabled, floatingPanelHeight, offsetPx]);

  // スクロール位置を監視（最上部ではドッキングしない）
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return;
    }

    const updateScroll = () => {
      const scrollTop = window.scrollY;
      setScrollTop(Math.max(scrollTop, 0));
    };

    const rafId = window.requestAnimationFrame(updateScroll);
    window.addEventListener('scroll', updateScroll, { passive: true });

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('scroll', updateScroll);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !panelNode || typeof ResizeObserver === 'undefined') {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      const height = panelNode.getBoundingClientRect().height;
      setFloatingPanelHeight(Math.ceil(height));
    });

    resizeObserver.observe(panelNode);

    return () => {
      resizeObserver.disconnect();
    };
  }, [enabled, panelNode]);

  // ドックゾーンが見えていても、スクロール最上部ではドッキングしない
  const effectiveDockZoneVisible = enabled && dockZoneNode ? isDockZoneVisible : false;
  const effectiveScrollTop = enabled ? scrollTop : 0;
  const effectiveFloatingPanelHeight = enabled ? floatingPanelHeight : 0;
  const isAtTop = effectiveScrollTop <= 0;
  const canDockByScroll = effectiveScrollTop >= minDockScrollPx;
  const shouldDock = enabled && !isAtTop && canDockByScroll && effectiveDockZoneVisible;
  // 有効でない場合は常にドッキング状態（=インライン表示）
  const effectiveIsDocked = !enabled || shouldDock;
  const isFloating = enabled && !shouldDock;

  return {
    isDocked: effectiveIsDocked,
    dockZoneRef,
    panelRef,
    isFloating,
    floatingPanelHeight: effectiveFloatingPanelHeight,
  };
}
