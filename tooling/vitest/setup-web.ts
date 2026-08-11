import '@testing-library/jest-dom/vitest';
import './setup-node';

const nativeLocalStorage = window.localStorage;
const nativeSessionStorage = window.sessionStorage;
const scrollToMock = vi.fn();

function restoreBrowserStorage(): void {
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

function clearBrowserStorage(): void {
  try {
    window.localStorage.clear();
  } catch {
    // Tests deliberately exercise unavailable storage.
  }

  try {
    window.sessionStorage.clear();
  } catch {
    // Tests deliberately exercise unavailable storage.
  }
}

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

Object.defineProperty(window.navigator, 'language', {
  value: 'en-US',
  configurable: true,
});

beforeEach(() => {
  clearBrowserStorage();
  scrollToMock.mockReset();
});
