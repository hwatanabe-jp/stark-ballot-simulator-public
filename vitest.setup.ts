import '@testing-library/jest-dom/vitest';
import path from 'path';

function configureDefaultTestImageIdVariant(): void {
  if (!process.env['EXPECTED_IMAGE_ID'] && !process.env['EXPECTED_IMAGE_ID_VARIANT']) {
    process.env['EXPECTED_IMAGE_ID_VARIANT'] = 'x86_64';
  }
}

// Setup environment variables for tests (allow explicit overrides)
configureDefaultTestImageIdVariant();
if (!process.env['SESSION_CAPABILITY_SECRET']) {
  process.env['SESSION_CAPABILITY_SECRET'] = 'test-session-capability-secret-0123456789abcdef';
}
if (!process.env['FILE_MOCK_STORE_DIR'] && process.env['VITEST_WORKER_ID']) {
  process.env['FILE_MOCK_STORE_DIR'] = path.join(
    process.cwd(),
    '.tmp',
    `mock-sessions-${process.env['VITEST_WORKER_ID']}`,
  );
}

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
  configureDefaultTestImageIdVariant();
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
