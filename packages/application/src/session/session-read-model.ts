import type { SessionIdentityRecord, SessionVotingRecord } from '@stark-ballot/domain/types/sessionRecords';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';

/**
 * Use-case composition of lifecycle-owned records. This shape is never a
 * persistence authority and must not be written as one aggregate.
 */
export interface SessionReadModel {
  identity: SessionIdentityRecord;
  voting: SessionVotingRecord;
  finalization: FinalizationRecord | null;
}
