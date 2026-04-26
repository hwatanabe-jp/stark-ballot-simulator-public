import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'fs';
import path from 'path';

type ImageIdMappingEntry = {
  expectedImageID?: string;
  expectedImageID_x86_64?: string;
};

const imageIdMapping = JSON.parse(
  readFileSync(path.join(process.cwd(), 'public', 'imageId-mapping.json'), 'utf-8'),
) as {
  current: string;
  mappings: Partial<Record<string, ImageIdMappingEntry>>;
};
const currentMapping = imageIdMapping.mappings[imageIdMapping.current];
const currentImageId = currentMapping?.expectedImageID ?? currentMapping?.expectedImageID_x86_64;

// Setup environment variables for tests (allow explicit overrides)
if (!process.env.EXPECTED_IMAGE_ID && currentImageId) {
  process.env.EXPECTED_IMAGE_ID = currentImageId;
}
if (!process.env.SESSION_CAPABILITY_SECRET) {
  process.env.SESSION_CAPABILITY_SECRET = 'test-session-capability-secret-0123456789abcdef';
}
if (!process.env.FILE_MOCK_STORE_DIR && process.env.VITEST_WORKER_ID) {
  process.env.FILE_MOCK_STORE_DIR = path.join(process.cwd(), '.tmp', `mock-sessions-${process.env.VITEST_WORKER_ID}`);
}

// Mock Next.js router
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

// Mock Next.js fonts
vi.mock('next/font/google', () => ({
  Inter: () => ({ className: 'inter-font' }),
}));

const nativeLocalStorage = typeof window !== 'undefined' ? window.localStorage : undefined;
const nativeSessionStorage = typeof window !== 'undefined' ? window.sessionStorage : undefined;
const scrollToMock = vi.fn();

function restoreBrowserStorage(): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (nativeLocalStorage) {
    Object.defineProperty(window, 'localStorage', {
      value: nativeLocalStorage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      value: nativeLocalStorage,
      configurable: true,
      writable: true,
    });
  }

  if (nativeSessionStorage) {
    Object.defineProperty(window, 'sessionStorage', {
      value: nativeSessionStorage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: nativeSessionStorage,
      configurable: true,
      writable: true,
    });
  }
}

function clearBrowserStorage(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.clear();
  } catch {
    // Ignore storage errors in tests that deliberately simulate failures.
  }

  try {
    window.sessionStorage.clear();
  } catch {
    // Ignore storage errors in tests that deliberately simulate failures.
  }
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'scrollTo', {
    value: scrollToMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'scrollTo', {
    value: scrollToMock,
    configurable: true,
    writable: true,
  });

  restoreBrowserStorage();
  clearBrowserStorage();
}

beforeEach(() => {
  clearBrowserStorage();
  scrollToMock.mockReset();
});

// Setup navigator.language for tests (browser environment only)
if (typeof window !== 'undefined') {
  Object.defineProperty(window.navigator, 'language', {
    value: 'en-US',
    configurable: true,
  });
}
