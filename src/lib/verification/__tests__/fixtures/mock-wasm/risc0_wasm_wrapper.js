const defaultCalls = [];
const verifyCalls = [];

export default async function initWasm(initArg) {
  defaultCalls.push(initArg ?? null);
  globalThis.__mockWasmInitArgs = defaultCalls;
  return undefined;
}

export function init_panic_hook() {
  globalThis.__mockInitPanicHookCalled = true;
}

export function verify_components(vkBytes, proofBytes, journalBytes) {
  verifyCalls.push({ vkBytes, proofBytes, journalBytes });
  globalThis.__mockVerifyCalls = verifyCalls;
  return {
    is_valid: true,
    error: undefined,
    free: () => {},
  };
}

export function verify_proof() {
  return {
    is_valid: true,
    error: undefined,
  };
}
