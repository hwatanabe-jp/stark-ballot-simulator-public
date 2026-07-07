/**
 * Type definitions for test-specific global variables
 *
 * These are used in WASM verifier tests to mock and track behavior
 */

declare global {
  /**
   * Mock WASM initialization arguments captured for testing
   */
  var __mockWasmInitArgs: unknown[] | undefined;

  /**
   * Flag indicating whether init_panic_hook was called
   */
  var __mockInitPanicHookCalled: boolean | undefined;

  /**
   * Mock WASM verification calls captured for testing
   */
  var __mockVerifyCalls: unknown[] | undefined;

  /**
   * Override WASM JS module path for testing (browser environment)
   */
  var STARK_BALLOT_WASM_JS_PATH: string | undefined;

  /**
   * Browser window object - made optional for Node.js test environment
   */
  var window: (Window & typeof globalThis) | undefined;
}

export {};
