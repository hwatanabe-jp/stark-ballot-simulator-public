/** Explicit success or expected-failure outcome. Unexpected invariant and I/O failures still throw. */
export type Result<TValue, TError> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: TError };
