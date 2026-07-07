type UndefinedKeys<T extends object> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];

type DefinedKeys<T extends object> = Exclude<keyof T, UndefinedKeys<T>>;

export type OmitUndefinedProperties<T extends object> = Pick<T, DefinedKeys<T>> & {
  [K in UndefinedKeys<T>]?: Exclude<T[K], undefined>;
};

/**
 * Returns a shallow copy without own properties whose value is `undefined`.
 *
 * Use this when constructing objects with exact optional-property semantics:
 * optional keys are absent unless the runtime contract carries a concrete
 * value.
 */
export function omitUndefinedProperties<T extends object>(value: T): OmitUndefinedProperties<T> {
  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  return Object.fromEntries(entries) as OmitUndefinedProperties<T>;
}
