import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useDockingPanel } from './useDockingPanel';

describe('useDockingPanel', () => {
  const observeMock = vi.fn();
  const disconnectMock = vi.fn();
  const resizeObserveMock = vi.fn();
  const resizeDisconnectMock = vi.fn();

  let lastOptions: IntersectionObserverInit | undefined;
  let intersectionCallback: IntersectionObserverCallback | null = null;
  let originalIntersectionObserver: typeof globalThis.IntersectionObserver | undefined;
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;

  const createRect = (top: number, bottom: number): DOMRectReadOnly => ({
    top,
    bottom,
    left: 0,
    right: 0,
    width: 0,
    height: bottom - top,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });

  const createEntry = (overrides: Partial<IntersectionObserverEntry>): IntersectionObserverEntry => ({
    boundingClientRect: createRect(0, 0),
    intersectionRect: createRect(0, 0),
    rootBounds: createRect(0, 100),
    isIntersecting: false,
    intersectionRatio: 0,
    target: document.createElement('div'),
    time: 0,
    ...overrides,
  });

  beforeEach(() => {
    lastOptions = undefined;
    intersectionCallback = null;
    observeMock.mockClear();
    disconnectMock.mockClear();
    resizeObserveMock.mockClear();
    resizeDisconnectMock.mockClear();

    originalIntersectionObserver = globalThis.IntersectionObserver;
    originalResizeObserver = globalThis.ResizeObserver;

    class MockIntersectionObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        intersectionCallback = callback;
        lastOptions = options;
      }

      observe = observeMock;
      disconnect = disconnectMock;
      unobserve = vi.fn();
      takeRecords = vi.fn();
    }

    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        void callback;
      }

      observe = resizeObserveMock;
      disconnect = resizeDisconnectMock;
      unobserve = vi.fn();
    }

    globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
    globalThis.ResizeObserver = MockResizeObserver;
  });

  afterEach(() => {
    if (originalIntersectionObserver) {
      globalThis.IntersectionObserver = originalIntersectionObserver;
    } else {
      delete (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
    }

    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    }
  });

  it('offsets rootMargin by the floating panel height + offset', async () => {
    const { result } = renderHook(() => useDockingPanel({ enabled: true, offsetPx: 16 }));

    act(() => {
      result.current.dockZoneRef(document.createElement('div'));
    });

    const panel = document.createElement('div');
    panel.getBoundingClientRect = () => ({
      height: 120,
      width: 0,
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    act(() => {
      result.current.panelRef(panel);
    });

    await waitFor(() => {
      expect(lastOptions?.rootMargin).toBe('0px 0px -136px 0px');
    });
  });

  it('remains floating when IntersectionObserver is unavailable', async () => {
    delete (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;

    const { result } = renderHook(() => useDockingPanel({ enabled: true }));

    act(() => {
      result.current.dockZoneRef(document.createElement('div'));
    });

    await waitFor(() => {
      expect(result.current.isDocked).toBe(false);
      expect(result.current.isFloating).toBe(true);
    });
  });

  it('stays floating at scroll top even if sentinel intersects', async () => {
    Object.defineProperty(window, 'scrollY', {
      value: 0,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useDockingPanel({ enabled: true }));

    act(() => {
      result.current.dockZoneRef(document.createElement('div'));
    });

    act(() => {
      intersectionCallback?.(
        [
          createEntry({
            isIntersecting: true,
            boundingClientRect: createRect(20, 21),
            rootBounds: createRect(0, 100),
          }),
        ],
        {} as IntersectionObserver,
      );
    });

    await waitFor(() => {
      expect(result.current.isDocked).toBe(false);
      expect(result.current.isFloating).toBe(true);
    });
  });

  it('stays floating until scroll exceeds minDockScrollPx', async () => {
    Object.defineProperty(window, 'scrollY', {
      value: 40,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useDockingPanel({ enabled: true, minDockScrollPx: 80 }));

    act(() => {
      result.current.dockZoneRef(document.createElement('div'));
    });

    act(() => {
      intersectionCallback?.(
        [
          createEntry({
            isIntersecting: true,
            boundingClientRect: createRect(20, 21),
            rootBounds: createRect(0, 100),
          }),
        ],
        {} as IntersectionObserver,
      );
    });

    await waitFor(() => {
      expect(result.current.isDocked).toBe(false);
      expect(result.current.isFloating).toBe(true);
    });
  });

  it('docks when scrolled and sentinel intersects', async () => {
    Object.defineProperty(window, 'scrollY', {
      value: 120,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useDockingPanel({ enabled: true }));

    act(() => {
      result.current.dockZoneRef(document.createElement('div'));
    });

    act(() => {
      intersectionCallback?.(
        [
          createEntry({
            isIntersecting: true,
            boundingClientRect: createRect(20, 21),
            rootBounds: createRect(0, 100),
          }),
        ],
        {} as IntersectionObserver,
      );
    });

    await waitFor(() => {
      expect(result.current.isDocked).toBe(true);
      expect(result.current.isFloating).toBe(false);
    });
  });

  it('keeps docked when the sentinel moves above the viewport', async () => {
    Object.defineProperty(window, 'scrollY', {
      value: 140,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useDockingPanel({ enabled: true }));

    act(() => {
      result.current.dockZoneRef(document.createElement('div'));
    });

    act(() => {
      intersectionCallback?.(
        [
          createEntry({
            isIntersecting: true,
            boundingClientRect: createRect(10, 11),
            rootBounds: createRect(0, 100),
          }),
        ],
        {} as IntersectionObserver,
      );
    });

    await waitFor(() => {
      expect(result.current.isDocked).toBe(true);
    });

    act(() => {
      intersectionCallback?.(
        [
          createEntry({
            isIntersecting: false,
            boundingClientRect: createRect(-40, -39),
            rootBounds: createRect(0, 100),
          }),
        ],
        {} as IntersectionObserver,
      );
    });

    await waitFor(() => {
      expect(result.current.isDocked).toBe(true);
      expect(result.current.isFloating).toBe(false);
    });
  });
});
