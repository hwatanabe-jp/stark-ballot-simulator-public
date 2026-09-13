import type {
  CurrentZkVMJournal,
  VerificationProofAuthority,
  VERIFICATION_JOURNAL_PROOF_AUTHORITY_SHARED_FIELDS,
} from './verification';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Expect<Value extends true> = Value;

export type JournalProofSharedFieldAssertion = Expect<
  Equal<
    (typeof VERIFICATION_JOURNAL_PROOF_AUTHORITY_SHARED_FIELDS)[number],
    keyof CurrentZkVMJournal & keyof VerificationProofAuthority
  >
>;
