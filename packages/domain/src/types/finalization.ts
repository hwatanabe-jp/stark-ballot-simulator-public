/**
 * Neutral persisted session-extension values.
 *
 * Domain sessions may carry opaque persisted extension branches so store
 * adapters can hydrate application-owned state. The domain package does not
 * own finalization lifecycle, verifier-result, or delivery-locator schemas.
 */
export type SessionExtensionPrimitive = string | number | boolean | null;

export type SessionExtensionValue =
  SessionExtensionPrimitive | SessionExtensionRecord | readonly SessionExtensionValue[];

export type SessionExtensionRecord = {
  readonly [key: string]: SessionExtensionValue | undefined;
};

declare const persistedOpaqueFinalizationBranchBrand: unique symbol;

export type PersistedOpaqueFinalizationBranch<TBranch extends string> = {
  readonly [persistedOpaqueFinalizationBranchBrand]: TBranch;
};

export type PersistedFinalizationResultBranch = PersistedOpaqueFinalizationBranch<'finalizationResult'>;
export type PersistedFinalizationStateBranch = PersistedOpaqueFinalizationBranch<'finalizationState'>;

export type FinalizationResultPersistence = PersistedFinalizationResultBranch;
export type FinalizationStatePersistence = PersistedFinalizationStateBranch;
