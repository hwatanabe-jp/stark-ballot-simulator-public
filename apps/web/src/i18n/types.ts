export type TranslationShape<T> = T extends string
  ? string
  : T extends Record<string, unknown>
    ? { [K in keyof T]: TranslationShape<T[K]> }
    : string;
