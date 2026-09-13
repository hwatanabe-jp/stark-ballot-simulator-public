export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/** Readonly projection for the plain records, arrays, and ports owned by deployment authority. */
export type ReadonlyData<T> = T extends
  | null
  | undefined
  | boolean
  | number
  | string
  | bigint
  | symbol
  | ((...args: never[]) => unknown)
  ? T
  : T extends object
    ? { readonly [Key in keyof T]: ReadonlyData<T[Key]> }
    : T;
