import type { SessionData } from './server';

declare const arbitraryObject: { readonly status: 'succeeded'; readonly executionId: 'exec-1' };
declare const arbitraryRecord: Record<string, unknown>;

// @ts-expect-error - session finalization result persistence must be admitted and branded by an owner boundary.
const rejectedFinalizationResult: NonNullable<SessionData['finalizationResult']> = arbitraryObject;
void rejectedFinalizationResult;

// @ts-expect-error - session finalization state persistence must be admitted and branded by an owner boundary.
const rejectedFinalizationState: NonNullable<SessionData['finalizationState']> = arbitraryObject;
void rejectedFinalizationState;

// @ts-expect-error - broad records are not valid persisted finalization carriers.
const rejectedRecordResult: NonNullable<SessionData['finalizationResult']> = arbitraryRecord;
void rejectedRecordResult;

// @ts-expect-error - broad records are not valid persisted finalization state carriers.
const rejectedRecordState: NonNullable<SessionData['finalizationState']> = arbitraryRecord;
void rejectedRecordState;
